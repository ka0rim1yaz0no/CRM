import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
const require = createRequire(import.meta.url);
const source = readFileSync(new URL("../src/components/admin/PayrollRecomputeDialog.tsx", import.meta.url), "utf8");
function render({ preview = null, confirm = false, reason = "", error = "" } = {}) {
    let index = 0; const values = ["2026-10-15", "2026-10-15", preview, {}, reason, confirm, false, error];
    const exports = {};
    runInNewContext(ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText,
        { exports, require: name => name === "react" ? { ...React, useState: () => [values[index++], () => {}], useEffect: () => {}, useRef: () => ({ current: null }) } :
            name === "../../api/payroll" ? {} : name === "../../lib/currency" ? { formatCurrency: value => `PHP ${value.toFixed(2)}` } : require(name) });
    return renderToStaticMarkup(React.createElement(exports.default, { onClose() {}, onSaved() {} }));
}
const preview = { canApply: true, totalDifference: 10, rows: [{ employeeCode: "synthetic", employeeName: "Synthetic Payroll", ownerBusinessId: "fake-a", businessIds: ["fake-a", "fake-b"],
    before: { grossPay: 100, deductions: 20, netPay: 80 }, after: { grossPay: 100, deductions: 10, netPay: 90 }, difference: 10, reviewDays: 0, potentialOvertimeHours: 2, approvedOvertimeHours: 0 }] };
test("payroll confirmation requires preview, resolved rows, explicit checkbox and audit reason", () => {
    for (const options of [{}, { preview }, { preview, confirm: true }, { preview: { ...preview, canApply: false }, confirm: true, reason: "Synthetic test" }]) {
        assert.match(render(options), /<button[^>]*disabled=""[^>]*>Confirm cutoff/);
    }
    assert.doesNotMatch(render({ preview, confirm: true, reason: "Synthetic test" }), /<button[^>]*disabled=""[^>]*>Confirm cutoff/);
    const html = render({ preview });
    for (const value of ["Gross old", "Deductions old", "Net old", "fake-a", "PHP 80.00", "PHP 90.00", "Approved weekend OT"]) assert.ok(html.includes(value));
    assert.match(render({ error: "Shift settings are required for payroll" }), /role="alert"/);
});
test("payroll uses saved backend rates and a preview, never a frontend eight-hour assumption", () => {
    const page = readFileSync(new URL("../src/pages/admin/payroll/index.tsx", import.meta.url), "utf8");
    assert.match(page, /getPayrollAccuracyConfig/); assert.match(page, /PayrollRecomputeDialog/);
    assert.doesNotMatch(page, /Paid day not snapshotted/);
    assert.match(page, /paidHoursPerDay/); assert.match(page, /accuracyEnabled && !dtr\.storedCutoff/);
    assert.match(page, /employeeDtr\.currentAttendanceWarning && <p role="alert"/);
    assert.match(page, /Saved pay has not changed/);
    assert.match(page, /employeeDtr\.potentialOvertimeHours \?\? employeeDtr\.summary\.overtimeHours/);
    for (const field of ["grossHours", "lunchHours", "regularHours", "overtimeHours"]) assert.ok(page.includes(`formatHoursMinutes(row.${field})`));
    assert.doesNotMatch(page, /\/\s*8\b/);
    const hub = readFileSync(new URL("../src/components/AttendanceHub.tsx", import.meta.url), "utf8");
    assert.doesNotMatch(hub, /<h3>Breaks<\/h3>/); assert.match(hub, /firstBreak: "1st Break", secondBreak: "2nd Break"/);
});

test("payroll approval displays explicit non-billable minutes, included deduction and the backend rate without inventing legacy data", () => {
    const details = { before: { minutes: 0, amount: 0 }, after: { minutes: 11, amount: 29.92 }, minuteRate: 2.72 };
    const html = render({ preview: { ...preview, rows: [{ ...preview.rows[0], nonBillableOffPhone: details }] } });
    for (const label of ["Non-billable Off the Phone", "Minutes old / new", "Included deduction old / new", "Deduction rate / min", "0 / 11 min", "PHP 29.92", "PHP 2.72"]) assert.ok(html.includes(label), label);
    assert.doesNotMatch(html, /<th[^>]*>Non-billable Off the Phone<\/th>/);
    assert.match(html, /PHP 20\.00 \/ PHP 10\.00<\/span><dl[^>]*><dt[^>]*>Non-billable Off the Phone/);
    assert.ok(render({ preview }).includes("Not available"), "old preview responses must not pretend the missing breakdown is zero");
});

test("the payroll roster has no separate non-billable column and leaves the deduction calculation intact", () => {
    const page = readFileSync(new URL("../src/pages/admin/payroll/index.tsx", import.meta.url), "utf8");
    const roster = page.slice(page.indexOf('aria-label="Employee payroll records"'), page.indexOf('</table>', page.indexOf('aria-label="Employee payroll records"')));
    assert.doesNotMatch(roster, /Non-billable|nonBillable/);
    assert.match(roster, /colSpan=\{9\}/);
    assert.match(page, /function payslipDeductionRows\(record: PayrollRecord\) \{ return payrollDeductionRows\(record\); \}/);
});
