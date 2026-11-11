import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";
import { QueryClient, QueryObserver } from "@tanstack/react-query";

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
const detailGuard = (businessId = "business-a") => module("../src/lib/leadDetailReadGuard.ts").createLeadDetailReadGuard({ businessId, employeeId: "owner", employeeSession: "signed-test" });

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

test("employee handoff blocks and cancels only its detail read before ownership changes, including route-cleanup races", async () => {
    const leadDetailReadGuard = detailGuard(), cancelled = [];
    let requests = 0, finishCancellation;
    const cancellation = new Promise(resolve => { finishCancellation = resolve; });
    const scope = { leadDetailReadGuard, refreshLeadDetailAccess() {},
        queryClient: { cancelQueries: options => { cancelled.push(options); return cancellation; } } };
    const begin = callback(employeePage, "passLeadMutation", "onMutate")(scope);
    const detailScope = { leadDetailReadGuard, requestedLeadId: "transferred", employeeId: "owner", displayedBusinessId: "business-a",
        authUser: { attendanceHubSession: "signed-test" }, getLead: async () => { requests++; return { _id: "transferred" }; } };
    const read = callback(employeePage, "{ data: requestedLead }", "queryFn")(detailScope);
    const enabled = callback(employeePage, "{ data: requestedLead }", "enabled")(detailScope);
    const pending = begin({ lead: { _id: "transferred", assignmentRevision: 7 }, businessId: "business-a", employeeSession: "signed-test" });
    assert.equal(leadDetailReadGuard.canRead("transferred"), false);
    assert.equal(enabled({ state: { error: null } }), false);
    assert.equal(await read({ signal: new AbortController().signal }), null);
    assert.equal(requests, 0);
    assert.deepEqual(Array.from(cancelled[0].queryKey), ["lead", "business-a", "transferred"]);
    assert.equal(cancelled[0].exact, true);
    finishCancellation(); const context = await pending;
    assert.equal(context.guard, leadDetailReadGuard);
    // Removing/recreating the active observer before the router commits cannot
    // issue a GET as the previous owner, even if a caller forces a refetch.
    assert.equal(await read({ signal: new AbortController().signal }), null);
    assert.equal(requests, 0);
});

test("failed employee handoff restores only its captured detail guard without changing another login/business", () => {
    const previous = detailGuard(), current = detailGuard("business-b"), notices = [];
    const ticket = previous.block("transferred", 7); current.block("transferred", 9);
    const fail = callback(employeePage, "passLeadMutation", "onError")({
        leadDetailReadGuard: current, refreshLeadDetailAccess() {}, reportRequestError: error => notices.push(error), invalidateEmployeeLeads() {},
    });
    const error = { response: { status: 409 } };
    fail(error, { lead: { _id: "transferred" } }, { guard: previous, ticket });
    assert.equal(previous.canRead("transferred"), true); assert.equal(current.canRead("transferred"), false); assert.equal(notices.length, 1);
    previous.block("transferred", 6);
    const repeated = previous.block("transferred", 7);
    fail(error, { lead: { _id: "transferred" } }, { guard: previous, ticket: repeated });
    assert.equal(previous.canRead("transferred"), false);
    assert.equal(previous.ownedAgain("transferred", 7), true);
});

test("the real query observer aborts a pending detail GET before the assignment mutation proceeds", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } }), leadDetailReadGuard = detailGuard();
    let signal, started;
    const began = new Promise(resolve => { started = resolve; });
    const observer = new QueryObserver(client, { queryKey: ["lead", "business-a", "transferred"], queryFn: ({ signal: requestSignal }) => {
        signal = requestSignal; started();
        return new Promise((_resolve, reject) => requestSignal.addEventListener("abort", () => reject(new Error("Synthetic cancelled detail")), { once: true }));
    } });
    const unsubscribe = observer.subscribe(() => {});
    try {
        await began;
        const begin = callback(employeePage, "passLeadMutation", "onMutate")({ leadDetailReadGuard, refreshLeadDetailAccess() {}, queryClient: client });
        await begin({ lead: { _id: "transferred", assignmentRevision: 7 }, businessId: "business-a", employeeSession: "signed-test" });
        assert.equal(signal.aborted, true);
        assert.equal(client.isFetching({ queryKey: ["lead", "business-a", "transferred"], exact: true }), 0);
        assert.equal(leadDetailReadGuard.canRead("transferred"), false);
    } finally { unsubscribe(); client.clear(); }
});

test("terminal detail denials never retry automatically, while transient reads retain bounded recovery", () => {
    const retry = callback(employeePage, "{ data: requestedLead }", "retry")({});
    const enabled = callback(employeePage, "{ data: requestedLead }", "enabled")({
        employeeId: "owner", requestedLeadId: "transferred", leadDetailReadGuard: detailGuard(),
    });
    for (const status of [401, 403, 404]) assert.equal(retry(0, { response: { status } }), false);
    for (const status of [403, 404]) assert.equal(enabled({ state: { error: { response: { status } } } }), false);
    assert.equal(retry(0, { response: { status: 503 } }), true);
    assert.equal(retry(2, { response: { status: 503 } }), false);
    assert.equal(enabled({ state: { error: null } }), true);
});

test("a delayed handoff cannot suspend another business or replacement login's detail observer", async () => {
    const leadDetailReadGuard = detailGuard(); let cancellations = 0;
    const begin = callback(employeePage, "passLeadMutation", "onMutate")({ leadDetailReadGuard, refreshLeadDetailAccess() {},
        queryClient: { cancelQueries() { cancellations++; } } });
    for (const [businessId, employeeSession] of [["business-b", "signed-test"], ["business-a", "replacement-session"]]) {
        await assert.rejects(begin({ lead: { _id: "transferred", assignmentRevision: 7 }, businessId, employeeSession }), /workspace changed/);
        assert.equal(leadDetailReadGuard.canRead("transferred"), true);
    }
    assert.equal(cancellations, 0);
});

test("a newer confirmed assignment back to this employee reopens details; stale ownership events do not", () => {
    const policy = module("../shared/leadAssignmentPolicy.ts"), leadDetailReadGuard = detailGuard();
    leadDetailReadGuard.block("transferred", 7);
    const event = callback(employeePage, "handleLeadChanged")({
        employeeId: "owner", employeeLeadNames: ["Synthetic Owner"], displayedBusinessId: "business-a", leadDetailReadGuard,
        queryClient: { getQueriesData: () => [], getQueryData: () => undefined, invalidateQueries() {} }, callingQueueKey: () => ["calling-queue", "business-a", "owner"],
        leadBelongsToEmployee: policy.leadBelongsToEmployee, refreshLeadDetailAccess() {}, setWorkedLeadHolds() {}, setDraftLead() {}, synchronizeLeadWorkspace() {},
    });
    event({ lead: { _id: "transferred", assignedAgent: { _id: "owner" }, assignmentRevision: 7 } });
    assert.equal(leadDetailReadGuard.canRead("transferred"), false);
    event({ lead: { _id: "transferred", assignedAgent: { _id: "another-owner" }, assignmentRevision: 8 } });
    assert.equal(leadDetailReadGuard.canRead("transferred"), false);
    event({ lead: { _id: "transferred", assignedAgent: { _id: "owner" }, assignmentRevision: 9 } });
    assert.equal(leadDetailReadGuard.canRead("transferred"), true);
});

test("cancellable detail reads preserve their captured business and employee session", async () => {
    let request;
    const adapters = module("../src/api/leads.ts", { "../lib/api": { api: { get: async (url, options) => { request = { url, options }; return { data: {} }; } } } });
    const signal = new AbortController().signal;
    await adapters.getLead("transferred", { businessId: "business-a", employeeSession: "signed-test", signal });
    assert.equal(request.url, "/leads/transferred"); assert.equal(request.options.signal, signal);
    assert.equal(request.options.headers["X-Business-Id"], "business-a");
    assert.equal(request.options.headers["X-CRM-Attendance-Session"], "signed-test");
    assert.equal(request.options.headers["X-CRM-Admin-Session"], "");
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
        leads: [{ _id: "lead", assignmentRevision: 3 }], selectedBulkLeadRevisions: {lead: 3}, selectedLead: { _id: "lead" },
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
            authUser: {},
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

test("outcome tags do not implicitly save a typed note and cannot continue after the signed session changes", async () => {
    for (const changed of [false, true]) {
        let actions = 0, noteSaves = 0, finish;
        let session = "signed-original";
        const pending = new Promise(resolve => { finish = resolve; });
        const ref = { current: null };
        const run = callback(employeePage, "runLeadActionAfterComment")({
            leadActionPendingRef: ref, pendingCommentSaveRef: { current: { leadId: "lead", body: "earlier note", promise: pending } },
            selectedLead: { _id: "lead" }, commentDraft: "Uncommitted typed draft",
            callingScope: { businessId: "business-a" }, callingWorkOwner: { current: Symbol() }, employeeCode: "employee",
            setCallingWork() {}, setActiveLeadAction() {}, startCommentSave() { noteSaves++; }, trackCallingSave() {},
            getActiveBusinessId: () => "business-a", authUser: { attendanceHubSession: "signed-original" },
            getAuthUser: () => ({ user: { employeeCode: "employee" }, attendanceHubSession: session }),
        });
        const save = run("lead", "outcome", async () => { actions++; }, false);
        assert.equal(actions, 0, "an already submitted note must finish first");
        if (changed) session = "signed-replacement";
        finish(); await save;
        assert.equal(noteSaves, 0, "the unsaved draft is not a saved note");
        assert.equal(actions, changed ? 0 : 1);
        assert.equal(ref.current, null);
    }
});

test("all three outcome adapters use bounded writes with their captured business and signed session", async () => {
    const requests = [];
    const adapters = module("../src/api/leads.ts", { "../lib/api": { api: { patch: async (...args) => { requests.push(args); return { data: {} }; } } } });
    for (const name of ["logConnectedLeadCall", "logLeadNotConnected", "logLeadVoicemail"]) {
        await adapters[name]("lead", "employee", { businessId: "business-a", employeeSession: "signed-original" });
    }
    assert.equal(new Set(requests.map(([url]) => url)).size, 3);
    for (const [, input, options] of requests) {
        assert.equal(input.employeeId, "employee"); assert.equal(options.timeout, 15000);
        assert.equal(options.headers["X-Business-Id"], "business-a");
        assert.equal(options.headers["X-CRM-Attendance-Session"], "signed-original");
    }
});
