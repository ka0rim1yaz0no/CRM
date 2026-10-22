import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";

function module(path, imports = {}) {
    const exports = {};
    const source = readFileSync(new URL(path, import.meta.url), "utf8");
    const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
    runInNewContext(js, { exports, require: name => imports[name] || {}, WeakSet });
    return exports;
}
function callback(path, name, property) {
    const source = readFileSync(new URL(path, import.meta.url), "utf8");
    const ast = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    let node;
    function visit(value) {
        if (ts.isVariableDeclaration(value) && value.name.getText(ast) === name) {
            node = property ? value.initializer.arguments[0].properties.find(p => p.name?.getText(ast) === property)?.initializer : value.initializer;
        }
        ts.forEachChild(value, visit);
    }
    visit(ast); assert.ok(node, `${name}.${property || "callback"}`);
    return scope => {
        const exports = {};
        runInNewContext(ts.transpileModule(`exports.callback = ${ts.createPrinter().printNode(ts.EmitHint.Expression, node, ast)}`, {
            compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
        }).outputText, { exports, URLSearchParams, ...scope });
        return exports.callback;
    };
}
const employeePage = "../src/pages/leads/index.tsx", adminPage = "../src/pages/admin/leads/index.tsx";

test("one shared recipient policy includes Active/Training Sales, never arbitrary Agents, Paused or Archived", () => {
    const { isEligibleLeadRecipient } = module("../shared/leadAssignmentPolicy.ts");
    for (const status of ["Active", "Training"]) {
        assert.equal(isEligibleLeadRecipient({ status, role: "Sales Agent" }), true);
        assert.equal(isEligibleLeadRecipient({ status, role: "Representative", team: "Sales" }), true);
    }
    for (const status of ["Paused", "Archived", "", "active"]) assert.equal(isEligibleLeadRecipient({ role: "Sales", status }), false);
    assert.equal(isEligibleLeadRecipient({ role: "Support Agent", team: "Operations", status: "Active" }), false);
});

test("explicit owner IDs override stale names in employee socket updates", () => {
    const { leadBelongsToEmployee } = module("../shared/leadAssignmentPolicy.ts");
    for (const assignedAgent of ["new-owner", { _id: "new-owner" }]) {
        assert.equal(leadBelongsToEmployee({ assignedAgent, assignedAgentName: "Old name" }, "old-owner", ["Old name"]), false);
    }
    assert.equal(leadBelongsToEmployee({ assignedAgent: { _id: "new-owner" } }, "new-owner", []), true);
});

test("API interceptor and assignment mutation report one accurate error, including expired sessions", () => {
    const notices = [];
    const errors = module("../src/lib/requestErrorToast.ts", { "./toast": { emitToast: value => notices.push(value) } });
    const backend = { response: { data: { message: "Synthetic recipient no longer has access." } } };
    errors.reportRequestError(backend, "Unable to save changes.");
    callback(employeePage, "passLeadMutation", "onError")({ reportRequestError: errors.reportRequestError, invalidateEmployeeLeads() {} })(backend);
    assert.equal(notices.length, 1); assert.equal(notices[0].message, backend.response.data.message);
    const expired = {};
    errors.reportSessionExpiry(expired);
    errors.reportRequestError(expired, "Could not reassign.");
    assert.equal(notices.length, 2); assert.match(notices[1].message, /session has expired/);
    const network = new Error("Synthetic network failure");
    errors.reportRequestError(network, "Could not reassign the lead.");
    assert.equal(notices.length, 3);
});

test("confirmed employee handoff removes transferred cache/holds/history/route instead of reinserting it", () => {
    let rows = [{ _id: "transferred" }, { _id: "remaining" }], holds = [...rows], history = ["transferred", "remaining"], selected = "transferred", confirm = true, agent = "recipient", route;
    const invalidations = [], notices = [];
    const run = callback(employeePage, "passLeadMutation", "onSuccess")({
        queryClient: { invalidateQueries: value => invalidations.push(value.queryKey), removeQueries() {} },
        getActiveBusinessId: () => "business-a", getAuthUser: () => ({ attendanceHubSession: "signed-test" }),
        updateCachedLeadPage: update => { rows = update(rows); }, setWorkedLeadHolds: update => { holds = update(holds); },
        setLeadHistoryIds: update => { history = update(history); }, setSelectedLeadId: value => { selected = value; },
        searchParams: new URLSearchParams("lead=transferred"), setSearchParams: value => { route = value.toString(); },
        setPassAgentId: value => { agent = value; }, setPassConfirm: value => { confirm = value; },
        invalidateEmployeeLeads() {}, showToast: value => notices.push(value),
    });
    run({ _id: "transferred", assignedAgentName: "Synthetic Training" }, { businessId: "business-a", employeeSession: "signed-test" });
    assert.deepEqual(rows.map(l => l._id), ["remaining"]); assert.deepEqual(holds.map(l => l._id), ["remaining"]);
    assert.deepEqual(history, ["remaining"]); assert.equal(selected, null); assert.equal(route, ""); assert.equal(agent, ""); assert.equal(confirm, null);
    assert.equal(notices.length, 1); assert.ok(invalidations.some(key => key[0] === "calling-queue" && key[1] === "business-a"));
});

test("late employee assignment response cannot change a different business's selected lead", () => {
    let touched = false;
    const run = callback(employeePage, "passLeadMutation", "onSuccess")({ queryClient: { invalidateQueries() {} },
        getActiveBusinessId: () => "business-b", getAuthUser: () => ({ attendanceHubSession: "signed-test" }),
        updateCachedLeadPage: () => { touched = true; },
    });
    run({ _id: "transferred" }, { businessId: "business-a", employeeSession: "signed-test" });
    assert.equal(touched, false);
});

test("assignment adapters send captured tenant/session/revision instead of depending on current browser context", async () => {
    const requests = [];
    const api = { patch: async (...args) => { requests.push(JSON.parse(JSON.stringify(args))); return { data: {} }; } };
    const adapters = module("../src/api/leads.ts", { "../lib/api": { api } });
    const scope = { businessId: "business-a", employeeSession: "signed-employee", adminSession: "signed-admin" };
    await adapters.assignLead("lead", { assignedAgent: "local-recipient-id", expectedAssignmentRevision: 7 }, scope);
    await adapters.bulkAssignLeads({ leadIds: ["lead"], assignedAgent: "local-recipient-id", assignedAgentName: "Synthetic", expectedAssignmentRevisions: { lead: 7 } }, scope);
    await adapters.reassignNewLeads(scope);
    for (const [, , options] of requests) {
        assert.equal(options.headers["X-Business-Id"], "business-a"); assert.equal(options.headers["X-CRM-Attendance-Session"], "signed-employee"); assert.equal(options.headers["X-CRM-Admin-Session"], "signed-admin");
    }
    assert.equal(requests[0][1].expectedAssignmentRevision, 7);
});

test("admin bulk handoff snapshots selected IDs/revisions and goes through the required-note action guard", async () => {
    let deferred, submitted;
    const input = { leadIds: ["lead"], assignedAgent: "recipient", assignedAgentName: "Synthetic Training" };
    const run = callback(adminPage, "handleBulkAssignment")({ bulkAssignLeadsMutation: { isPending: false, mutateAsync: value => { submitted = value; } },
        leads: [{ _id: "lead", assignmentRevision: 3 }], selectedLead: { _id: "lead" },
        runLeadActionAfterComment: (_id, name, action) => { assert.equal(name, "assignment"); deferred = action; },
    });
    run(input); assert.equal(submitted, undefined);
    input.leadIds.push("late-unselected"); await deferred();
    assert.deepEqual(Array.from(submitted.leadIds), ["lead"]); assert.equal(submitted.expectedAssignmentRevisions.lead, 3);
});

for (const path of [employeePage, adminPage]) test(`${path}: save required notes first, reject duplicates, preserve failed notes, stop after a business switch`, async () => {
    for (const outcome of ["success", "failure", "switch"]) {
        let finish, actions = 0, saves = 0, business = "business-a";
        const gate = new Promise(resolve => { finish = resolve; });
        const ref = { current: null };
        const run = callback(path, "runLeadActionAfterComment")({
            leadActionPendingRef: ref, pendingCommentSaveRef: { current: null }, selectedLead: { _id: "lead" }, commentDraft: "Synthetic unsaved note",
            callingScope: { businessId: "business-a" }, callingWorkOwner: { current: Symbol() }, employeeCode: "employee", setCallingWork() {}, setActiveLeadAction() {},
            startCommentSave: async () => { saves++; await gate; if (outcome === "failure") throw new Error("Synthetic failed note"); },
            getActiveBusinessId: () => business, getAuthUser: () => ({ user: { employeeCode: "employee" } }), trackCallingSave() {},
            assignmentScopeIsCurrent: () => business === "business-a",
        });
        const first = run("lead", "assignment", async () => { actions++; });
        const duplicate = run("lead", "assignment", async () => { actions++; });
        assert.equal(actions, 0); assert.equal(saves, 1);
        if (outcome === "switch") business = "business-b";
        finish(); await Promise.all([first, duplicate]);
        assert.equal(actions, outcome === "success" ? 1 : 0);
        assert.equal(ref.current, null);
    }
});
