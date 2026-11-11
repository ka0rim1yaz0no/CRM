import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import { test } from "node:test";
const ts = createRequire(import.meta.url)("typescript") as typeof import("typescript");
const source = await fs.readFile(new URL("../server.ts", import.meta.url), "utf8"), ast = ts.createSourceFile("server.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const isolated = ts.createPrinter().printFile(ts.factory.updateSourceFile(ast, ast.statements.filter(node => !ts.isImportDeclaration(node))));
const code = ts.transpileModule(isolated, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
for (const gate of ["disabled", "workers-disabled", "enabled", "not-configured", "invalid"] as const) test(`payroll starts independently and preserves the ${gate} runtime gate`, async () => {
    let payroll = 0, otherWorkers = 0, coaching = 0;
    const noop = () => undefined, handlers: Record<string, () => void> = {};
    const run = () => runInNewContext(`(async()=>{${code}\n})()`, {
        exports: {}, console: { log: noop, error: noop }, process: { env: gate === "not-configured" ? {} : { CRM_LEAD_WORKSPACE_SWITCH_FILE: "synthetic-private-gate" }, on: (name: string, handler: () => void) => { handlers[name] = handler; } },
        assertAttendanceFlagConfiguration: noop, assertCredentialEncryptionConfiguration: noop, connectDatabase: async () => undefined,
        refreshConfiguredBusinessesFromStore: async () => undefined, ensureEmployeeIndexes: async () => undefined,
        createApp: () => ({}), createServer: () => ({ listen: noop }), createSocketServer: noop,
        startAttendanceCoachingWorker: () => { coaching++; }, startPayrollGenerationWorker: () => { payroll++; },
        startLeadAutoAssignmentScheduler: () => { otherWorkers++; }, startHempSurveyLeadQueueWorker: () => { otherWorkers++; },
        startAttendanceReconciliationWorker: () => { otherWorkers++; }, startAttendanceIntegrityWorker: () => { otherWorkers++; },
        applyLeadWorkspaceSwitch: async (start: () => void) => { if (gate === "invalid") throw Error("Synthetic invalid gate"); if (gate === "enabled") start(); },
    });
    if (gate === "invalid") { await assert.rejects(run(), /Synthetic invalid gate/); assert.equal(payroll, 0); assert.equal(otherWorkers, 0); return; }
    await run(); assert.equal(payroll, 1); assert.equal(coaching, 1); assert.equal(otherWorkers, ["enabled", "not-configured"].includes(gate) ? 4 : 0);
    if (handlers.SIGUSR2) { handlers.SIGUSR2(); handlers.SIGUSR2(); await new Promise(resolve => setImmediate(resolve)); assert.equal(payroll, 1); assert.equal(otherWorkers, gate === "enabled" ? 4 : 0); }
});
