import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import { test } from "node:test";

const ts = createRequire(import.meta.url)("typescript") as typeof import("typescript");
const source = await fs.readFile(new URL("../server.ts", import.meta.url), "utf8");
const ast = ts.createSourceFile("server.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const isolated = ts.createPrinter().printFile(ts.factory.updateSourceFile(ast, ast.statements.filter(node => !ts.isImportDeclaration(node))));
const code = ts.transpileModule(isolated, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;

for (const gate of ["disabled", "workers-disabled", "enabled", "not-configured"] as const) {
    test(`Coaching starts independently while preserving the ${gate} general worker gate`, async () => {
        let coaching = 0, otherWorkers = 0;
        const noop = () => undefined;
        await runInNewContext(`(async()=>{${code}\n})()`, {
            exports: {}, process: { env: gate === "not-configured" ? {} : { CRM_LEAD_WORKSPACE_SWITCH_FILE: "synthetic-private-gate" }, on: noop },
            assertAttendanceFlagConfiguration: noop, assertCredentialEncryptionConfiguration: noop, connectDatabase: async () => undefined,
            refreshConfiguredBusinessesFromStore: async () => undefined, ensureEmployeeIndexes: async () => undefined,
            createApp: () => ({}), createServer: () => ({ listen: noop }), createSocketServer: noop,
            startAttendanceCoachingWorker: () => { coaching++; },
            startLeadAutoAssignmentScheduler: () => { otherWorkers++; }, startHempSurveyLeadQueueWorker: () => { otherWorkers++; },
            startAttendanceReconciliationWorker: () => { otherWorkers++; }, startAttendanceIntegrityWorker: () => { otherWorkers++; },
            startPayrollGenerationWorker: () => { otherWorkers++; },
            applyLeadWorkspaceSwitch: async (start: () => void) => { if (gate === "enabled") start(); },
        });
        assert.equal(coaching, 1, "Coaching must start even when the unrelated general worker group is disabled");
        assert.equal(otherWorkers, gate === "enabled" || gate === "not-configured" ? 5 : 0, "Do not enable other workers to start Coaching");
    });
}
