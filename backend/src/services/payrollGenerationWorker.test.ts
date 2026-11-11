import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import { test } from "node:test";
const ts = createRequire(import.meta.url)("typescript") as typeof import("typescript");
const source = await fs.readFile(new URL("./payrollGenerationWorker.ts", import.meta.url), "utf8"), ast = ts.createSourceFile("worker.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const code = ts.transpileModule(ts.createPrinter().printFile(ts.factory.updateSourceFile(ast, ast.statements.filter(node => !ts.isImportDeclaration(node)))), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
function fixture(options: { accuracy?: boolean; integrity?: boolean; forEach?: (work: () => Promise<void>) => Promise<void>; generate?: () => Promise<unknown> } = {}) {
    const exports = {} as { startPayrollGenerationWorker: () => void; runPayrollGeneration: () => Promise<void> };
    let generated = 0, registered = 0, unreferenced = 0, errors = 0, started = 0, completed = 0, interval = 0, tick: (() => void) | undefined;
    runInNewContext(code, { exports, payrollAccuracyEnabled: () => options.accuracy !== false, attendanceIntegrityEnabled: () => options.integrity !== false,
        runForEachBusiness: options.forEach || (async (work: () => Promise<void>) => { for (let i = 0; i < 7; i++) await work(); }),
        generateFutureMissingPayroll: async () => { generated++; return options.generate?.(); },
        setInterval: (work: () => void, ms: number) => { registered++; interval = ms; tick = work; return { unref: () => { unreferenced++; } }; },
        console: { error: () => { errors++; }, info: (message: string) => { if (message === "PAYROLL_GENERATION_PASS_COMPLETED") completed++; else { assert.equal(message, "PAYROLL_GENERATION_WORKER_STARTED"); started++; } } },
    });
    return { exports, state: () => ({ generated, registered, unreferenced, errors, started, completed, interval }), tick: () => tick?.() };
}
test("the independent scheduler starts once, performs one pass and uses the existing five-minute interval", async () => {
    const f = fixture(); f.exports.startPayrollGenerationWorker(); f.exports.startPayrollGenerationWorker(); await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(f.state(), { generated: 7, registered: 1, unreferenced: 1, errors: 0, started: 1, completed: 1, interval: 300000 });
    f.tick(); await new Promise(resolve => setImmediate(resolve)); assert.equal(f.state().generated, 14);
});
for (const feature of ["accuracy", "integrity"] as const) test(`the scheduler performs no generation when ${feature} is disabled`, async () => {
    const f = fixture({ [feature]: false }); await f.exports.runPayrollGeneration(); assert.equal(f.state().generated, 0);
});
test("a timer tick or second invocation cannot overlap a running generation pass", async () => {
    let release: (() => void) | undefined, passes = 0;
    const gate = new Promise<void>(resolve => { release = resolve; }), f = fixture({ forEach: async work => { passes++; await gate; await work(); } });
    const first = f.exports.runPayrollGeneration(); await f.exports.runPayrollGeneration(); assert.equal(passes, 1); release!(); await first;
    await f.exports.runPayrollGeneration(); assert.equal(passes, 2);
});
test("a held or failed business does not block other businesses or create a tight retry loop", async () => {
    let calls = 0;
    const f = fixture({ generate: async () => { if (++calls === 1) throw Error("Synthetic held generation"); } });
    await f.exports.runPayrollGeneration(); assert.equal(f.state().generated, 7); assert.equal(f.state().errors, 1); assert.equal(f.state().registered, 0);
    await f.exports.runPayrollGeneration(); assert.equal(f.state().generated, 14);
});
test("an outer tenancy failure releases the running latch for the next scheduled pass", async () => {
    let passes = 0;
    const f = fixture({ forEach: async work => { if (++passes === 1) throw Error("Synthetic tenancy failure"); await work(); } });
    await f.exports.runPayrollGeneration(); assert.equal(f.state().errors, 1); assert.equal(f.state().completed, 0);
    await f.exports.runPayrollGeneration(); assert.equal(f.state().generated, 1); assert.equal(f.state().completed, 1);
});
