import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";
import * as eligibility from "../src/lib/employeeAutoCall.ts";
import { normalizePhoneForCall } from "../src/lib/phoneNumber.ts";

function load(file, sandbox) {
    const text = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
    const ast = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const source = ts.createPrinter().printFile(ts.factory.updateSourceFile(ast, ast.statements.filter(node => !ts.isImportDeclaration(node))));
    const exports = {};
    runInNewContext(ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText, { exports, Event, ...sandbox });
    return exports;
}
const scope = { employeeId: "fake-employee", businessId: "fake-a" };
const lead = (id, extra = {}) => ({ _id: id, status: "NEW", assignedAgent: scope.employeeId, phone: "+12025550101", comments: [], ...extra });

function fixture(options = {}) {
    let now = Date.parse("2026-10-20T23:00:00Z"), nextTimer = 0, business = scope.businessId;
    let pending = { leadId: "old-pending", baselineCommentMarker: "old" };
    const listeners = new Map(), timers = new Map(), effects = [], cleanups = [];
    const calls = { reserve: [], dialStart: [], dial: [], release: [], navigate: [], invalidated: 0 };
    const window = { dispatchEvent: event => listeners.get(event.type)?.(), addEventListener: (name, callback) => listeners.set(name, callback),
        removeEventListener: name => listeners.delete(name), clearTimeout: id => timers.delete(id), clearInterval() {},
        setInterval: () => ++nextTimer, setTimeout: (callback, ms) => { const id = ++nextTimer; timers.set(id, { callback, ms }); return id; },
        localStorage: { getItem: () => "0", setItem() {} } };
    class Clock extends Date { constructor(value) { super(value === undefined ? now : value); } static now() { return now; } }
    const queue = load("src/lib/displayedAutoCallQueue.ts", { ...eligibility, normalizePhoneForCall, window, Date: Clock });
    const owner = Symbol("test-view");
    let rows = options.rows || [lead("first"), lead("old-pending")];
    const publish = (leads, ready = true) => { rows = leads; queue.publishDisplayedAutoCallQueue(owner, scope, rows, ready); };
    publish(rows, options.ready !== false);
    const employee = { _id: scope.employeeId, employeeCode: "fake-code", role: "Sales", availabilityStatus: "ONLINE", name: "Synthetic" };
    const auth = { userType: "employee", user: employee };
    const caller = load("src/components/EmployeeAutoCaller.tsx", { ...eligibility, ...queue, window, Date: Clock,
        normalizePhoneForCall, crypto: { randomUUID: () => `attempt-${++nextTimer}` },
        useRef: current => ({ current }), useEffect: callback => effects.push(callback), useNavigate: () => (...args) => calls.navigate.push(args),
        useLocation: () => ({ pathname: options.path || "/leads" }),
        useQueryClient: () => ({ invalidateQueries: async () => { calls.invalidated++; } }),
        getAuthUser: () => auth, getActiveBusinessId: () => business,
        activateCallBridgeForEmployee: async () => ({}), getEmployeeSummary: async () => employee, normalizeEmployeeAvailabilityStatus: value => value,
        getCallBridgeStatus: async () => ({ ready: now >= (options.cooldown || 0), connected: true, nextivaProcessDetected: true,
            state: calls.dial.length ? "active" : "idle", nextCallAllowedAt: options.cooldown ? new Date(options.cooldown).toISOString() : null,
            serverTime: new Date(now).toISOString(), clientReceivedAt: now, lastCallEndedAt: null }),
        getNextAutoCallLead: async () => ({ lead: lead("background"), normalizedPhone: "+12025550101" }),
        getLead: async id => { options.onRead?.({ publish, switchBusiness: () => { business = "fake-b"; } }); return options.fresh || rows.find(row => row._id === id) || lead(id); },
        getAutoCallPendingComment: () => pending, clearAutoCallPendingComment: () => { pending = null; },
        startAutoCallPendingComment: (_code, id) => { pending = { leadId: id }; },
        reserveCallBridgeCall: async (_code, input) => { calls.reserve.push({ ...input, at: now }); options.onReserve?.({ publish }); return { allowed: true, reservationToken: "fake-token" }; },
        markCallBridgeDialStarted: async (_code, input) => { calls.dialStart.push(input); options.onDialStart?.({ publish }); return { alreadyStarted: options.alreadyStarted || false }; },
        releaseCallBridgeCall: async (_code, input) => { calls.release.push(input); }, recordLeadCall: async () => ({}), callTimingV2Enabled: true,
        document: { body: { appendChild() {} }, createElement: () => ({ setAttribute() {}, remove() {}, click() { calls.dial.push(now); } }) } });
    caller.default();
    for (const callback of effects) { const cleanup = callback(); if (cleanup) cleanups.push(cleanup); }
    const settle = async (runTimers = true) => {
        for (let step = 0; step < 15; step++) {
            await new Promise(resolve => setImmediate(resolve));
            if (runTimers && timers.size) {
                const [id, timer] = timers.entries().next().value;
                timers.delete(id); now += timer.ms; timer.callback();
            }
        }
    };
    return { queue, publish, calls, settle, timers, stop: () => cleanups.forEach(cleanup => cleanup()) };
}

test("first displayed eligible lead wins over an old pending lead", async () => {
    const state = fixture(); await state.settle();
    assert.equal(state.calls.reserve[0].leadId, "first"); assert.equal(state.calls.dial.length, 1);
    assert.equal(state.calls.reserve[0].businessId, "fake-a");
    assert.equal(state.calls.navigate[0][1].state.autoCallPreserveFilters, true); state.stop();
});

test("filtered order is authoritative, including an empty or loading view", async () => {
    for (const options of [{ rows: [lead("filtered-first"), lead("first")] }, { rows: [] }, { ready: false }]) {
        const state = fixture(options); await state.settle();
        assert.equal(state.calls.reserve[0]?.leadId, options.rows?.[0]?._id);
        assert.equal(state.calls.dial.length, options.rows?.length ? 1 : 0); state.stop();
    }
});

test("invalid phone, recently commented, future follow-up and unassigned rows are skipped", async () => {
    const rows = [lead("invalid", { phone: "invalid" }), lead("commented", { comments: [{ authorType: "employee", createdAt: "2026-10-20T22:59:00Z" }] }),
        lead("future", { followUpAt: "2026-10-22T00:00:00Z" }), lead("other", { assignedAgent: "other-employee" }), lead("eligible")];
    const state = fixture({ rows }); await state.settle(); assert.equal(state.calls.reserve[0].leadId, "eligible"); state.stop();
});

for (const phase of ["onRead", "onReserve", "onDialStart"]) test(`filter changes during ${phase} cancel the stale candidate`, async () => {
    const state = fixture({ [phase]: ({ publish }) => publish([lead("new-first")]) }); await state.settle();
    assert.equal(state.calls.dial.length, 0);
    if (phase !== "onRead") { assert.equal(state.calls.release.length, 1); assert.equal(state.calls.release[0].businessId, "fake-a"); }
    state.stop();
});

test("business switch, changed phone and an already-consumed dial claim never launch a call", async () => {
    for (const options of [{ onRead: ({ switchBusiness }) => switchBusiness() }, { fresh: lead("first", { phone: "+12025550102" }) }, { alreadyStarted: true }]) {
        const state = fixture(options); await state.settle(); assert.equal(state.calls.dial.length, 0); state.stop();
    }
});

test("the 30-second server deadline remains required before reservation", async () => {
    const deadline = Date.parse("2026-10-20T23:00:30Z");
    const state = fixture({ cooldown: deadline }); await state.settle(false);
    assert.equal(state.calls.reserve.length, 0);
    await state.settle(); assert.equal(state.calls.reserve.length, 1); assert.ok(state.calls.reserve[0].at >= deadline);
    assert.equal(state.calls.dial.length, 1); state.stop();
});

test("background selection opens Leads first and does not dial an invisible queue", async () => {
    const state = fixture({ path: "/dashboard" }); await state.settle();
    assert.equal(state.calls.navigate[0][0], "/leads"); assert.equal(state.calls.reserve.length, 0); assert.equal(state.calls.dial.length, 0); state.stop();
});

test("views are employee/business scoped and an old unmount cannot clear a newer view", () => {
    const state = fixture({ ready: false }); const owner = Symbol(), newer = Symbol();
    state.queue.publishDisplayedAutoCallQueue(owner, scope, [lead("first")], true);
    assert.equal(state.queue.firstDisplayedAutoCallLead({ ...scope, businessId: "other" }, [], new Set()), null);
    assert.equal(state.queue.firstDisplayedAutoCallLead({ ...scope, employeeId: "other" }, [], new Set()), null);
    state.queue.publishDisplayedAutoCallQueue(newer, scope, [lead("newer")], true);
    state.queue.clearDisplayedAutoCallQueue(owner);
    assert.equal(state.queue.firstDisplayedAutoCallLead(scope, [], new Set()).lead._id, "newer");
    state.queue.clearDisplayedAutoCallQueue(newer); assert.equal(state.queue.firstDisplayedAutoCallLead(scope, [], new Set()), null); state.stop();
});

test("UI publishes exactly its rendered filtered rows and auto navigation preserves filters", () => {
    const page = readFileSync(new URL("../src/pages/leads/index.tsx", import.meta.url), "utf8");
    const caller = readFileSync(new URL("../src/components/EmployeeAutoCaller.tsx", import.meta.url), "utf8");
    assert.match(page, /publishDisplayedAutoCallQueue[\s\S]*?filteredLeads/);
    assert.match(page, /filteredLeads\.map\(\(lead\)/);
    assert.match(page, /leadSearch\.trim\(\) === debouncedLeadSearch/);
    assert.match(page, /autoCallPreserveFilters/); assert.match(caller, /autoCallPreserveFilters: true/);
    assert.ok(!caller.includes("queueAutoCallLead = {"), "pending leads must not bypass the displayed queue");
});
