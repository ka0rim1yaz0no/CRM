import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";

const source = readFileSync(new URL("../src/pages/settings/index.tsx", import.meta.url), "utf8");
const ast = ts.createSourceFile("settings.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const declarations = new Map();
function visit(node) {
    if (ts.isVariableDeclaration(node)) declarations.set(node.name.getText(ast), node.initializer);
    ts.forEachChild(node, visit);
}
visit(ast);
const compile = expression => ts.transpileModule(`exports.value = ${expression};`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
const displayCode = compile(declarations.get("autoCallDisplay").getText(ast));
const clockCode = compile(declarations.get("estimatedServerNow").getText(ast));
const base = Date.parse("2026-10-22T17:00:00Z");
function display(overrides = {}) {
    const exports = {};
    runInNewContext(displayCode, { exports, Date, Math, bridgeStatusLoading: false, currentEmployeeLoading: false,
        callTimingV2Enabled: true, providerName: "Nextiva", availabilityStatus: "ONLINE", availabilityLabel: status => status,
        bridgeStatus: { connected: true, nextivaProcessDetected: true, ready: true, state: "idle" }, estimatedServerNow: base,
        withinAutoCallWindow: true, autoCallLeadLoading: false, autoCallLeadError: false, nextAutoCallLead: { queue: "NEW", reason: "NEW" }, ...overrides });
    return exports.value;
}

test("Settings distinguishes call-end cooldown, unconfirmed retry, unknown provider, attendance and due callbacks", () => {
    const idle = { connected: true, nextivaProcessDetected: true, state: "idle", ready: false, serverTime: new Date(base).toISOString(), nextCallAllowedAt: new Date(base + 30000).toISOString() };
    assert.equal(display({ bridgeStatus: { ...idle, waitCode: "POST_CALL_COOLDOWN" } }).label, "Next call in 30s");
    assert.equal(display({ bridgeStatus: { ...idle, waitCode: "DIAL_RETRY_WAIT" } }).label, "Retry eligible in 30s");
    assert.equal(display({ bridgeStatus: { ...idle, state: "unknown", reason: "Previous end unconfirmed" } }).label, "Waiting for confirmation");
    assert.equal(display({ bridgeStatus: { ...idle, state: "active" } }).label, "On a call");
    assert.equal(display({ bridgeStatus: { ...idle, state: "calling" } }).label, "Dial unconfirmed");
    assert.equal(display({ availabilityStatus: "OFFLINE", bridgeStatus: { ...idle, state: "active" } }).label, "OFFLINE");
    assert.equal(display({ callTimingV2Enabled: false }).label, "Configuration required");
    assert.equal(display({ nextAutoCallLead: { queue: "Follow up", reason: "SCHEDULED_DUE" } }).label, "Ready: Scheduled follow-up");
});

test("Settings countdown uses the received server instant and monotonic elapsed time, not a wrong client date", () => {
    const exports = {};
    runInNewContext(clockCode, { exports, Date, Math, autoCallClock: { monotonic: 5000 }, autoCallNow: new Date("2099-01-01T00:00:00Z"),
        bridgeStatus: { serverTime: new Date(base).toISOString(), clientReceivedAtMonotonic: 1000 } });
    assert.equal(exports.value, base + 4000);
});

test("the Settings next-lead adapter preserves the server reason and captured scope", async () => {
    const leadSource = readFileSync(new URL("../src/api/leads.ts", import.meta.url), "utf8");
    const leadAst = ts.createSourceFile("leads.ts", leadSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const declaration = leadAst.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "getNextAutoCallLead");
    const exports = {}, requests = [];
    const code = ts.transpileModule(declaration.getText(leadAst), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
    runInNewContext(code, { exports, getMyLeads: async (params, options) => {
        requests.push(JSON.parse(JSON.stringify({ params, options })));
        return { callingQueue: { nextLead: { _id: "synthetic-due", status: "Follow up" }, nextReason: "SCHEDULED_DUE", nextDecision: { normalizedPhone: "+12025550121" } } };
    } });
    const result = await exports.getNextAutoCallLead({ employeeId: "synthetic-person", employeeNames: [], excludedLeadIds: ["synthetic-due"] }, { businessId: "synthetic-a", employeeSession: "synthetic-session" });
    assert.equal(result.reason, "SCHEDULED_DUE");
    assert.equal(result.lead._id, "synthetic-due", "an old browser exclusion cannot redefine the next lead");
    assert.equal(requests[0].params.callingQueue, true);
    assert.deepEqual(requests[0].options, { businessId: "synthetic-a", employeeSession: "synthetic-session" });
});
