import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { createRequire } from "node:module";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
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
test("Payments follows Notices and Attendance follows Payments with URL refresh and five-tab keyboard navigation", () => {
    const profile = readFileSync(new URL("../src/pages/profile/index.tsx", import.meta.url), "utf8");
    assert.match(profile, /\["notices",[\s\S]*?\["payments", "Payments"\]/);
    assert.match(profile, /requestedProfileTab === "payments"/);
    assert.match(profile, /\["payments", "Payments"\],[\s\S]*?\["attendance", "Attendance"\]/);
    assert.match(profile, /requestedProfileTab === "attendance"/);
    assert.match(profile, /const tabs = \["overview", "leave", "notices", "payments", "attendance"\]/);
    assert.match(profile, /tabs\.length - 1/);
    const component = readFileSync(new URL("../src/components/EmployeePayments.tsx", import.meta.url), "utf8");
    assert.match(component, /queryKey: \["employee-payments", businessId, employeeId, view, page\]/);
    assert.match(component, /gcTime: 0/); assert.doesNotMatch(component, /keepPreviousData|placeholderData/);
    assert.match(component, /payrollDeductionDisplayRows\(item\)/); assert.match(component, /refetchInterval: 30000/);
});

test("Profile Payments retains deduction totals and net pay without a separate applied-to-net-pay row", () => {
    const component = readFileSync(new URL("../src/components/EmployeePayments.tsx", import.meta.url), "utf8");
    const ast = ts.createSourceFile("payments.tsx", component, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const names = new Set(["PaymentDetails", "calendarDate", "quantity"]);
    const declarations = ast.statements.filter(node => node.name && names.has(node.name.text) || ts.isVariableStatement(node) && node.declarationList.declarations.some(item => names.has(item.name.getText(ast))));
    const modules = {};
    for (const name of ["payrollPresentation", "payrollEarnings", "payrollSavedRates"]) {
        const exported = {};
        runInNewContext(ts.transpileModule(readFileSync(new URL(`../shared/${name}.ts`, import.meta.url), "utf8"),
            { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText, { exports: exported });
        Object.assign(modules, exported);
    }
    const exported = {};
    runInNewContext(ts.transpileModule(declarations.map(node => node.getText(ast)).join("\n") + "\nexports.details = PaymentDetails;",
        { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText,
    { exports: exported, require: createRequire(import.meta.url), ...modules });
    const value = { calculationVersion: "earned-hours-late-rest-v1", earnedToDate: true, payType: "Semi-monthly", department: "Synthetic",
        status: "Pending", paidOn: null, scheduledPayDate: null, basicPay: 15000, monthlyBasicPay: 30000, paidHoursPerDay: 8,
        minuteRate: 2.5, hourlyRate: 150, grossPay: 2400, deductions: 10, netPay: 2390, lateMinutes: 2, earlyTimeOutMinutes: 60,
        absenceMinutes: 480, excessBreakMinutes: 2, excessLunchMinutes: 0, nonBillableOffPhoneMinutes: 0, workingDays: 25,
        attendanceDays: 2, absentDays: 1, workedHours: 16, scheduledHours: 24, deductibleMinutes: 4, incompleteShiftDays: 0, overtimeHours: 0 };
    const before = JSON.stringify(value), money = number => `PHP ${number.toFixed(2)}`;
    const html = renderToStaticMarkup(React.createElement(exported.details, { item: value, money }));
    for (const text of ["Undertime", "60m", "PHP 150.00", "Absence", "480m", "PHP 1200.00", "Total deductions", "PHP 1360.00", "PHP 2390.00"]) assert.ok(html.includes(text), text);
    assert.ok(!html.includes("Applied to net pay"));
    assert.ok(!html.includes("Not deducted"));
    assert.ok(!html.includes("Already excluded from earned pay")); assert.ok(!html.includes("no additional deduction"));
    assert.equal(JSON.stringify(value), before);
});
