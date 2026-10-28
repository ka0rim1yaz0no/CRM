import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";

const source = readFileSync(new URL("../src/api/employeePayments.ts", import.meta.url), "utf8");
const periods = {};
runInNewContext(ts.transpileModule(readFileSync(new URL("../shared/payrollPeriod.ts", import.meta.url), "utf8"),
    { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText, { exports: periods });
function adapter() {
    let business = "synthetic-a", auth = { userType: "employee", user: { _id: "synthetic-own" }, attendanceHubSession: "synthetic-session" };
    const calls = [], exports = {};
    let finish;
    const modules = { "../lib/api": { api: { get(url, config) { calls.push({ url, config }); return new Promise(resolve => { finish = resolve; }); } } },
        "./authStorage": { getAuthUser: () => auth }, "./businessStorage": { getActiveBusinessId: () => business }, "../../shared/payrollPeriod": periods };
    runInNewContext(ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText,
        { exports, require: name => { assert.ok(modules[name]); return modules[name]; } });
    return { request: exports.getEmployeePayments, calls, finish: data => finish({ data: { view: "current", ...data } }), setBusiness: value => { business = value; },
        setAuth: value => { auth = value; }, auth: () => auth };
}
test("payment requests pin their signed employee session and tenant rather than inheriting a later login", async () => {
    const fixture = adapter(), controller = new AbortController();
    const promise = fixture.request("synthetic-own", "synthetic-a", 2, controller.signal);
    assert.equal(fixture.calls.length, 1);
    const { url, config } = fixture.calls[0]; assert.equal(url, "/employees/synthetic-own/payments");
    assert.equal(config.headers["X-CRM-Admin-Session"], ""); assert.equal(config.headers["X-CRM-Attendance-Session"], "synthetic-session");
    assert.equal(config.headers["X-Business-Id"], "synthetic-a"); assert.equal(config.headers["Cache-Control"], "no-store");
    assert.equal(config.params.page, 2); assert.equal(config.signal, controller.signal); assert.equal(config.timeout, 15000);
    fixture.finish({ business: { id: "synthetic-a" }, items: [] }); assert.equal((await promise).items.length, 0);
});
test("late payment responses are discarded after tenant, account or signed-session changes", async () => {
    for (const change of [fixture => fixture.setBusiness("synthetic-b"), fixture => fixture.setAuth(null),
        fixture => fixture.setAuth({ ...fixture.auth(), user: { _id: "synthetic-other" } }),
        fixture => fixture.setAuth({ ...fixture.auth(), attendanceHubSession: "synthetic-next-session" })]) {
        const fixture = adapter(), promise = fixture.request("synthetic-own", "synthetic-a"); change(fixture);
        fixture.finish({ business: { id: "synthetic-a" } }); await assert.rejects(promise, /Payment session changed/);
    }
    const fixture = adapter(), promise = fixture.request("synthetic-own", "synthetic-a");
    fixture.finish({ business: { id: "synthetic-wrong" } }); await assert.rejects(promise, /Payment session changed/);
});
test("financial requests never use an admin identity, a foreign employee or an unsigned login", async () => {
    for (const change of [fixture => fixture.setAuth({ userType: "admin", sessionToken: "synthetic-admin", user: { _id: "synthetic-own" } }),
        fixture => fixture.setAuth({ ...fixture.auth(), attendanceHubSession: null }), fixture => fixture.setBusiness("synthetic-other")]) {
        const fixture = adapter(); change(fixture); await assert.rejects(fixture.request("synthetic-own", "synthetic-a"), /Sign in again/);
        assert.equal(fixture.calls.length, 0);
    }
    const fixture = adapter(); await assert.rejects(fixture.request("synthetic-foreign", "synthetic-a"), /Sign in again/);
    assert.equal(fixture.calls.length, 0);
});
test("Payments follows Notices and includes URL refresh and four-tab keyboard navigation", () => {
    const profile = readFileSync(new URL("../src/pages/profile/index.tsx", import.meta.url), "utf8");
    assert.match(profile, /\["notices",[\s\S]*?\["payments", "Payments"\]/);
    assert.match(profile, /requestedProfileTab === "payments"/);
    assert.match(profile, /const tabs = \["overview", "leave", "notices", "payments"\]/);
    assert.match(profile, /tabs\.length - 1/);
    const component = readFileSync(new URL("../src/components/EmployeePayments.tsx", import.meta.url), "utf8");
    assert.match(component, /queryKey: \["employee-payments", businessId, employeeId, view, page\]/);
    assert.match(component, /gcTime: 0/); assert.doesNotMatch(component, /keepPreviousData|placeholderData/);
    assert.match(component, /payrollDeductionDisplayRows\(item\)/); assert.match(component, /refetchInterval: 30000/);
});
