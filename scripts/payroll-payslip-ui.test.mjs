import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";

const require = createRequire(import.meta.url);
const source = readFileSync(new URL("../src/pages/admin/payroll/index.tsx", import.meta.url), "utf8");
const ast = ts.createSourceFile("payroll.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const names = new Set(["numberWordsUnderTwenty", "numberWordsTens", "monthNames", "numberToWords", "formatHoursMinutes", "formatDays",
    "countWeekdays", "clampCalendarDay", "workingDaysForPayPeriod", "PayslipDocument", "payslipAmountInWords", "payslipDeductionRows", "payslipOutputReady", "payrollCsv", "payrollMatchesSearch"]);
const declarations = ast.statements.filter(node => node.name && names.has(node.name.text) || ts.isVariableStatement(node) && node.declarationList.declarations.some(item => names.has(item.name.getText(ast))));
const exports = {};
runInNewContext(ts.transpileModule('import { jsx, jsxs } from "react/jsx-runtime";\n' + declarations.map(node => node.getText(ast)).join("\n") +
    "\nexports.document = PayslipDocument; exports.words = payslipAmountInWords; exports.rows = payslipDeductionRows; exports.ready = payslipOutputReady; exports.csv = payrollCsv; exports.search = payrollMatchesSearch;",
    { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText, { require, exports });

const record = { employeeName: "Synthetic Payroll", employeeId: "90000002", department: "Studio", payType: "Semi-monthly",
    payPeriod: "Oct 6, 2026 - Oct 20, 2026", paidOn: "Oct 25, 2026", grossPay: 15000, basicPay: 15000,
    netPay: 14951.09, deductions: 48.91, lateMinutes: 12, excessBreakMinutes: 6, deductibleMinutes: 18, minuteRate: 2.72, hourlyRate: 163.04 };
const money = value => `PHP ${value.toFixed(2)}`;
test("payslip amount in words retains centavos and handles carry rounding", () => {
    assert.equal(exports.words(14951.09), "Fourteen Thousand Nine Hundred Fifty One and 09/100");
    assert.equal(exports.words(0.01), "Zero and 01/100");
    assert.equal(exports.words(19.999), "Twenty and 00/100");
});
test("section searches and CSV exports preserve values without spreadsheet formula execution", () => {
    assert.equal(exports.search(["Synthetic Employee", "90000002", undefined], "  employee  "), true);
    assert.equal(exports.search(["Synthetic Employee"], "missing"), false);
    assert.equal(exports.search([undefined], ""), true);
    assert.equal(exports.csv([["=1+1", " +SUM(A1)", '@cmd', 'a,"b"', 48.91, "00123"]]),
        '"\'=1+1","\' +SUM(A1)","\'@cmd","a,""b""","48.91","00123"');
    assert.ok(source.includes("rows = filteredBankEmployees.map"));
    assert.ok(source.includes("rows = filteredPayrollItems.map"));
    assert.ok(source.includes("...filteredArchivedItems.map"));
    const messages = readFileSync(new URL("../src/pages/messages/index.tsx", import.meta.url), "utf8");
    assert.ok(messages.includes('text-[#ffffff]">{attachment.name}'));
});
test("payslip renders saved monetary amounts and the exact saved hourly rate", () => {
    const html = renderToStaticMarkup(React.createElement(exports.document, { record, money }));
    for (const value of ["PHP 14951.09", "PHP 48.91", "PHP 163.04", "and 09/100 only"]) assert.ok(html.includes(value), value);
    const zeroBase = renderToStaticMarkup(React.createElement(exports.document, { record: { ...record, basicPay: 0, grossPay: 10, netPay: 10, deductions: 0, overtimeHours: 1 }, money }));
    assert.match(zeroBase, /Basic Pay<\/td><td[^>]*>PHP 0\.00<\/td>/);
});
test("payslip deduction rows reconcile in cents without negative rounding or invented zero totals", () => {
    assert.equal(typeof exports.rows, "function");
    for (const amount of [0, 0.01, 0.03, 48.91, 15000]) {
        const rows = exports.rows({ ...record, deductions: amount, lateMinutes: 1, excessBreakMinutes: 1, excessLunchMinutes: 1, earlyTimeOutMinutes: 1, absenceMinutes: 1 });
        assert.equal(rows.reduce((sum, row) => sum + Math.round(row.amount * 100), 0), Math.round(amount * 100));
        assert.ok(rows.every(row => row.amount >= 0));
    }
    const unknown = exports.rows({ ...record, lateMinutes: 0, excessBreakMinutes: 0 });
    assert.equal(unknown.at(-1).label, "Other saved deductions"); assert.equal(unknown.at(-1).amount, 48.91);
});
test("payslip output rejects loading, failed, mismatched, unsaved or inconsistent cutoffs", () => {
    assert.equal(typeof exports.ready, "function");
    const dtr = { employee: { employeeCode: record.employeeId }, payPeriod: record.payPeriod, storedCutoff: true };
    const input = { record, dtr, fetching: false, error: false, accuracyEnabled: true };
    assert.equal(exports.ready(input), true);
    for (const patch of [{ fetching: true }, { error: true }, { accuracyEnabled: undefined }, { dtr: undefined }, { record: null },
        { dtr: { ...dtr, payPeriod: "Other cutoff" } }, { dtr: { ...dtr, employee: { employeeCode: "other" } } },
        { dtr: { ...dtr, storedCutoff: false } }, { record: { ...record, netPay: 1 } }]) assert.equal(exports.ready({ ...input, ...patch }), false);
    assert.equal(exports.ready({ ...input, accuracyEnabled: false, dtr: { ...dtr, storedCutoff: false } }), true);
    assert.match(source, /disabled=\{!isPayslipOutputReady \|\| sendPayslipMutation\.isPending\}/);
    assert.match(source, /if \(!isPayslipOutputReady\) return;/);
});

function pageAction(name, inputs) {
    const page = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "PayrollPage");
    const declaration = page.body.statements.find(node => ts.isVariableStatement(node) && node.declarationList.declarations.some(item => item.name.getText(ast) === name));
    const context = { ...inputs, result: undefined };
    runInNewContext(ts.transpileModule(declarations.filter(node => !ts.isFunctionDeclaration(node) || node.name.text !== "PayslipDocument").map(node => node.getText(ast)).join("\n") +
        `\n${declaration.getText(ast)}\nresult = ${name};`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText, context);
    return context.result;
}
test("export action downloads the currently filtered section, not stale payroll rows", async () => {
    const item = { name: "Synthetic Item", second: "10", third: "Description", fourth: "Each cutoff", status: "Applied", category: "Deductions" };
    const employee = { ...record, employeeName: "Synthetic Export" };
    const bank = { name: "Synthetic Bank Employee", employeeCode: "90000003", bankName: "Fake Bank", bankAccountName: "Test", bankAccountNumber: "00123" };
    for (const activeTab of ["Employee Payroll", "Bank Accounts", "Deductions", "Archived"]) {
        let blob, clicked = false; const link = { click() { clicked = true; } };
        const action = pageAction("exportCsv", { activeTab, isExportUnavailable: false, employees: [employee], filteredBankEmployees: [bank], filteredPayrollItems: [item], filteredArchivedItems: [item],
            itemCategory: activeTab === "Deductions" ? "Deductions" : undefined, itemLabels: { name: "Deduction", second: "Amount", third: "Description", fourth: "Frequency" },
            Blob, URL: { createObjectURL(value) { blob = value; return "blob:synthetic"; }, revokeObjectURL() {} }, document: { createElement: () => link } });
        action(); assert.equal(clicked, true); const csv = await blob.text();
        assert.equal(link.download, `payroll-${activeTab.toLowerCase().replaceAll(" ", "-")}.csv`);
        assert.equal(csv.includes("Synthetic Bank Employee"), activeTab === "Bank Accounts");
        assert.equal(csv.includes("Synthetic Item"), ["Deductions", "Archived"].includes(activeTab));
        assert.equal(csv.includes("Synthetic Export"), ["Employee Payroll", "Archived"].includes(activeTab));
        if (activeTab === "Employee Payroll") { assert.ok(csv.includes('"48.91"')); assert.ok(csv.includes('"14951.09"')); }
    }
    assert.doesNotThrow(() => pageAction("exportCsv", { isExportUnavailable: true })());
});
test("print action invokes printing only for a verified loaded payslip", () => {
    for (const ready of [false, true]) {
        let printed = 0;
        pageAction("printPayslip", { isPayslipOutputReady: ready, window: { print() { printed++; } } })();
        assert.equal(printed, Number(ready));
    }
});
