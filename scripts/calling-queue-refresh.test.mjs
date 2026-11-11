import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";
const require = createRequire(import.meta.url);
const normalize = value => { const parsed = require("libphonenumber-js").parsePhoneNumberFromString(value || "", "US"); return parsed?.isValid() ? parsed.number : null; };

function setup() {
    let now = 0, id = 0; const timers = new Map(), exported = {};
    const source = readFileSync(new URL("../src/lib/callingQueueRefresh.ts", import.meta.url), "utf8");
    runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
        { exports: exported, window: { setTimeout: (run, delay) => { timers.set(++id, { run, at: now + delay }); return id; }, clearTimeout: value => timers.delete(value) },
            require: name => name === "./callingWorkflow" ? { callingQueueKey: scope => ["calling-queue", scope.businessId, scope.employeeId] } :
                name === "./phoneNumber" ? { normalizePhoneForCall: normalize } : assert.fail("Unexpected runtime dependency") });
    const advance = async delay => {
        const end = now + delay;
        for (;;) {
            const next = [...timers].sort((a,b) => a[1].at - b[1].at).find(([, timer]) => timer.at <= end);
            if (!next) break; now = next[1].at; timers.delete(next[0]); next[1].run();
            for (let turn = 0; turn < 5; turn++) await Promise.resolve();
        }
        now = end;
    };
    return { ...exported, advance, timers };
}
const scope = { businessId: "synthetic-business", employeeId: "synthetic-owner" };
const page = (owner = scope.employeeId) => ({ callingQueue: { scope: { ...scope, employeeId: owner },
    refreshDependencies: { version: 1, leadIds: ["own-lead", "hidden-duplicate"], phones: ["+12025550121"] } } });
const change = extra => ({ businessId: scope.businessId, action: "comment-added", lead: { _id: "other-lead", assignedAgent: { _id: "other-owner" }, phone: "+12025550999" }, ...extra });

test("six business scopes filter unrelated complete events but retain own, newly assigned and duplicate-phone changes", () => {
    const { callingQueueAffected: affected } = setup();
    for (let index = 0; index < 6; index++) {
        const currentScope = { ...scope, businessId: "synthetic-" + index }, currentPage = page(); currentPage.callingQueue.scope = currentScope;
        const unrelated = change({ businessId: currentScope.businessId });
        assert.equal(affected(currentScope, currentPage, unrelated), false);
        for (const lead of [
            { _id: "own-lead", assignedAgent: { _id: "new-owner" }, phone: "+12025550999" },
            { _id: "newly-assigned", assignedAgent: { _id: currentScope.employeeId }, phone: "+12025550999" },
            { _id: "other-lead", assignedAgent: { _id: "other-owner" }, phone: "(202) 555-0121" },
            { _id: "hidden-duplicate", assignedAgent: null, phone: "+12025550999" },
        ]) assert.equal(affected(currentScope, currentPage, { ...unrelated, lead }), true);
        assert.equal(affected(currentScope, currentPage, change({ businessId: "not-this-business" })), false);
    }
});

test("legacy replies, missing metadata, phone edits, bulk updates and ambiguous events retain conservative refresh", () => {
    const { callingQueueAffected: affected } = setup();
    for (const state of [undefined, {}, { callingQueue: { scope } }, { callingQueue: { scope, refreshDependencies: { version: 1 } } }, page("another-owner")])
        assert.equal(affected(scope, state, change()), true);
    for (const payload of [{}, { action: "bulk-assigned", leadIds: ["unknown-lead"] }, change({ action: "updated" }), change({ action: "unknown-action" })])
        assert.equal(affected(scope, page(), payload), true);
    assert.equal(affected(scope, page(), change({ assignedAgentId: scope.employeeId })), true);
    assert.equal(affected(scope, page(), change({ lead: { _id: "legacy-lead", assignedAgent: null, assignedAgentName: " Synthetic Owner " } }), ["Synthetic Owner"]), true);
});

test("duplicate layout/page subscribers combine event and focus bursts into one scoped refresh", async () => {
    const state = setup(), requests = [], client = { isFetching: () => 0, invalidateQueries: async (...args) => { requests.push(args); } };
    const first = state.registerCallingQueueRefresh(client, scope, "synthetic-session", () => true);
    const second = state.registerCallingQueueRefresh(client, scope, "synthetic-session", () => true);
    for (let event = 0; event < 100; event++) { first.request(); second.request(); }
    assert.equal(requests.length, 0); await state.advance(200); assert.equal(requests.length, 1);
    assert.deepEqual(Array.from(requests[0][0].queryKey), ["calling-queue", scope.businessId, scope.employeeId]);
    assert.equal(requests[0][0].exact, true); assert.equal(requests[0][1].cancelRefetch, false);
    first.dispose(); second.request(); await state.advance(200); assert.equal(requests.length, 2); second.dispose();
});

test("changes during a running read cause only one follow-up and an existing poll is never cancelled", async () => {
    const state = setup(); let fetching = true, requests = 0, finish;
    const client = { isFetching: () => Number(fetching), invalidateQueries: async () => { requests++; if (requests === 1) await new Promise(resolve => { finish = resolve; }); } };
    const listener = state.registerCallingQueueRefresh(client, scope, "synthetic-session", () => true);
    listener.request(); await state.advance(600); assert.equal(requests, 0);
    fetching = false; await state.advance(200); assert.equal(requests, 1);
    for (let event = 0; event < 100; event++) listener.request();
    finish(); for (let turn = 0; turn < 5; turn++) await Promise.resolve();
    await state.advance(200); assert.equal(requests, 2); listener.dispose();
});

test("unmount, tenant changes and replacement logins prevent delayed cross-scope reads", async () => {
    const state = setup(); let requests = 0, current = true;
    const client = { isFetching: () => 0, invalidateQueries: async () => { requests++; } };
    const first = state.registerCallingQueueRefresh(client, scope, "old-session", () => current);
    first.request(); current = false; await state.advance(200); assert.equal(requests, 0); first.dispose();
    const second = state.registerCallingQueueRefresh(client, scope, "new-session", () => true);
    second.request(); second.dispose(); await state.advance(200); assert.equal(requests, 0); assert.equal(state.timers.size, 0);
});

test("unmounting the first subscriber cannot strand another current caller until refresh", async () => {
    const state = setup(); let firstCurrent = true, requests = 0;
    const client = { isFetching: () => 0, invalidateQueries: async () => { requests++; } };
    const first = state.registerCallingQueueRefresh(client, scope, "same-session", () => firstCurrent);
    const second = state.registerCallingQueueRefresh(client, scope, "same-session", () => true);
    first.request(); firstCurrent = false; first.dispose();
    await state.advance(200); assert.equal(requests, 1);
    second.request(); await state.advance(200); assert.equal(requests, 2);
    first.request(); await state.advance(200); assert.equal(requests, 2);
    first.dispose(); second.dispose(); assert.equal(state.timers.size, 0);
});

test("10/25/50 simulated users avoid irrelevant refresh fanout and coalesce relevant bursts without production calls", async () => {
    for (const users of [10, 25, 50]) {
        const state = setup(), leases = []; let requests = 0;
        for (let user = 0; user < users; user++) {
            const ownScope = { ...scope, employeeId: "synthetic-owner-" + user }, ownPage = page(ownScope.employeeId);
            const client = { isFetching: () => 0, invalidateQueries: async () => { requests++; } };
            leases.push({ ownScope, ownPage, first: state.registerCallingQueueRefresh(client, ownScope, "synthetic-session", () => true),
                second: state.registerCallingQueueRefresh(client, ownScope, "synthetic-session", () => true) });
        }
        for (let event = 0; event < 100; event++) for (const user of leases)
            if (state.callingQueueAffected(user.ownScope, user.ownPage, change())) { user.first.request(); user.second.request(); }
        await state.advance(200); assert.equal(requests, 0);
        for (let event = 0; event < 100; event++) for (const user of leases) {
            const relevant = change({ lead: { _id: "shared-phone", assignedAgent: { _id: "other-owner" }, phone: "+12025550121" } });
            if (state.callingQueueAffected(user.ownScope, user.ownPage, relevant)) { user.first.request(); user.second.request(); }
        }
        await state.advance(200); assert.equal(requests, users);
        for (const user of leases) { user.first.dispose(); user.second.dispose(); }
    }
});
