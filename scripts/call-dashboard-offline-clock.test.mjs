import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";

const now = "2026-10-31T03:00:00.237Z", checkout = "2026-10-27T00:05:00.237Z";
function fixture(extra = {}, session = {}) {
    return { statusOnly: true, state: "OFFLINE", sessionId: null, reviewState: "verified", historyReviewRequired: true,
        serverTime: now, stateSince: checkout, sessions: [{ startedAt: "2026-10-26T15:00:00.237Z", endedAt: checkout,
            modeSince: checkout, mode: "OFFLINE", lifecycle: "manually-closed", ...session }], ...extra };
}
function load(snapshot = fixture(), setup = {}) {
    const calls = [], exported = {};
    let auth = setup.auth ?? { userType: "admin", sessionToken: "synthetic-admin-session" };
    const source = readFileSync(new URL("../src/api/callDashboard.ts", import.meta.url), "utf8");
    runInNewContext(ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText,
        { exports: exported, require: name => {
            if (name === "./authStorage") return { getAuthUser: () => auth };
            if (name === "../lib/api") return { api: { get: async (url, options) => {
                calls.push({ url, options });
                if (setup.fail) throw new Error("Synthetic read failure");
                if (setup.replaceAuth) auth = setup.replaceAuth;
                return { data: structuredClone(snapshot) };
            } } };
            assert.fail(`Unexpected runtime dependency: ${name}`);
        } });
    return { read: exported.getOfflineClockEvidence, dashboard: exported.getCallDashboard, calls };
}

test("six business-scoped signed GETs recover genuine historical checkouts without calling-cache or record writes", async () => {
    for (let business = 0; business < 6; business++) {
        const { read, calls } = load();
        const signal = new AbortController().signal;
        const result = await read("synthetic/employee", `synthetic-${business}`, signal);
        assert.equal(result.state, "recorded"); assert.equal(result.startedAt, checkout);
        assert.equal(calls.length, 1);
        assert.equal(calls[0].url, "/employees/synthetic%2Femployee/attendance/session");
        assert.equal(calls[0].options.headers["X-Business-Id"], `synthetic-${business}`);
        assert.equal(calls[0].options.headers["X-CRM-Admin-Session"], "synthetic-admin-session");
        assert.equal(calls[0].options.params.view, "status"); assert.equal(calls[0].options.signal, signal);
        assert.equal((await read("synthetic/employee", `synthetic-${business}`)).startedAt, checkout);
    }
});

test("automatic canonical closures are accepted, while absent history is not fabricated as midnight or zero", async () => {
    assert.equal((await load(fixture({}, { lifecycle: "system-closed" })).read("test", "test")).state, "recorded");
    assert.equal((await load(fixture({ sessions: [], stateSince: null })).read("test", "test")).state, "not-recorded");
    assert.equal((await load(fixture({ sessions: [] })).read("test", "test")).state, "unavailable");
});

test("active, conflicting, unverified and malformed canonical states cannot supply an Offline clock", async () => {
    const cases = [fixture({ state: "ONLINE" }), fixture({ sessionId: "open" }), fixture({ reviewState: "needs-correction" }),
        fixture({ reviewState: "migration-review" }), fixture({ statusOnly: false }), fixture({ sessions: null }), fixture({ serverTime: "invalid" }),
        fixture({ stateSince: "2026-10-27T00:05:00.238Z" }), fixture({}, { mode: "ONLINE" }), fixture({}, { lifecycle: "open" }),
        fixture({}, { endedAt: null }), fixture({}, { endedAt: "invalid" }), fixture({}, { modeSince: now }),
        fixture({}, { startedAt: now }), fixture({ stateSince: "2026-11-01T00:00:00Z" }, { endedAt: "2026-11-01T00:00:00Z", modeSince: "2026-11-01T00:00:00Z" })];
    for (const snapshot of cases) assert.equal((await load(snapshot).read("test", "test")).state, "unavailable");
});

test("missing business/admin scope, changed login and failed reads never expose checkout evidence", async () => {
    for (const auth of [{ userType: "employee", sessionToken: "not-admin" }, { userType: "admin" }]) {
        const { read, calls } = load(fixture(), { auth });
        await assert.rejects(read("test", "test")); assert.equal(calls.length, 0);
    }
    const missing = load();
    await assert.rejects(missing.read("", "test")); await assert.rejects(missing.read("test", "")); assert.equal(missing.calls.length, 0);
    await assert.rejects(load(fixture(), { replaceAuth: { userType: "admin", sessionToken: "new-session" } }).read("test", "test"));
    await assert.rejects(load(fixture(), { fail: true }).read("test", "test"));
});

test("the existing Call Dashboard read and generated timestamps are unchanged", async () => {
    const snapshot = { business: { id: "synthetic" }, generatedAt: now, serverTime: now, employees: [] };
    const { dashboard, calls } = load(snapshot);
    const result = await dashboard("synthetic");
    assert.equal(JSON.stringify(result), JSON.stringify(snapshot)); assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "/call-dashboard");
    await assert.rejects(dashboard("another-business"));
});
