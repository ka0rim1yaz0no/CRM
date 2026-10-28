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
const presentation = {};
const earnings = {};
runInNewContext(ts.transpileModule(readFileSync(new URL("../shared/payrollEarnings.ts", import.meta.url), "utf8"),
    { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText, { exports: earnings });
runInNewContext(ts.transpileModule(readFileSync(new URL("../shared/payrollPresentation.ts", import.meta.url), "utf8"),
    { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText, { exports: presentation });
runInNewContext(ts.transpileModule('import { jsx, jsxs } from "react/jsx-runtime";\n' + declarations.map(node => node.getText(ast)).join("\n") +
    "\nexports.document = PayslipDocument; exports.words = payslipAmountInWords; exports.rows = payrollDeductionRows; exports.displayRows = payslipDeductionRows; exports.ready = payslipOutputReady; exports.csv = payrollCsv; exports.search = payrollMatchesSearch;",
    { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText, { require, exports, payrollDeductionRows: presentation.payrollDeductionRows, payrollDeductionDisplayRows: presentation.payrollDeductionDisplayRows, isEarnedPayrollVersion: earnings.isEarnedPayrollVersion });

const record = { employeeName: "Synthetic Payroll", employeeId: "90000002", department: "Studio", payType: "Semi-monthly",
    payPeriod: "Oct 6, 2026 - Oct 20, 2026", paidOn: "Oct 25, 2026", grossPay: 15000, basicPay: 15000,
    netPay: 14951.09, deductions: 48.91, lateMinutes: 12, excessBreakMinutes: 6, deductibleMinutes: 18, minuteRate: 2.72, hourlyRate: 163.04 };
const money = value => `PHP ${value.toFixed(2)}`;
test("payslip amount in words retains centavos and handles carry rounding", () => {
    assert.equal(exports.words(14951.09), "Fourteen Thousand Nine Hundred Fifty One and 09/100");
    assert.equal(exports.words(0.01), "Zero and 01/100");
    assert.equal(exports.words(19.999), "Twenty and 00/100");
});

test("non-billable Off the Phone is included in the saved payslip breakdown exactly once", () => {
    const value = { ...record, lateMinutes: 1, nonBillableOffPhoneMinutes: 11 };
    const rows = exports.rows(value);
    assert.equal(rows.filter(row => row.label === "Non-billable Off the Phone").length, 1);
    assert.equal(rows.find(row => row.label === "Non-billable Off the Phone").minutes, 11);
    assert.equal(rows.reduce((sum, row) => sum + Math.round(row.amount * 100), 0), Math.round(value.deductions * 100));
});

test("deductions and payslips retain the non-billable line at zero without changing saved amounts", () => {
    for (const minutes of [undefined, 0, 11]) {
        const value = { ...record, nonBillableOffPhoneMinutes: minutes };
        const before = JSON.stringify(value), rows = exports.rows(value);
        const item = rows.find(row => row.label === "Non-billable Off the Phone");
        assert.ok(item); assert.equal(item.minutes, minutes ?? 0);
        assert.equal(rows.filter(row => row.label === item.label).length, 1);
        if (!minutes) assert.equal(item.amount, 0);
        assert.equal(rows.reduce((sum, row) => sum + Math.round(row.amount * 100), 0), Math.round(value.deductions * 100));
        const html = renderToStaticMarkup(React.createElement(exports.document, { record: value, money }));
        assert.ok(html.includes(`Non-billable Off the Phone (${minutes ?? 0} min)`));
        assert.ok(html.includes("PHP 14951.09")); assert.ok(html.includes("PHP 48.91"));
        assert.equal(JSON.stringify(value), before);
    }
});

test("non-billable deductions remain separate from adjusted shortfall and reconcile for capped pay", () => {
    for (const total of [0, 0.01, 29.89, 15000]) {
        const rows = exports.rows({ ...record, deductions: total, scheduledHours: 8, workedMinutesOverride: 470,
            excessBreakMinutes: 0, nonBillableOffPhoneMinutes: 11 });
        assert.equal(rows.find(row => row.label === "Adjusted time shortfall").minutes, 0);
        assert.equal(rows.find(row => row.label === "Non-billable Off the Phone").minutes, 11);
        assert.equal(rows.filter(row => row.label === "Non-billable Off the Phone").length, 1);
        assert.equal(rows.reduce((sum, row) => sum + Math.round(row.amount * 100), 0), Math.round(total * 100));
    }
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

test("earned payslips show current earnings rather than the full cutoff basic pay and retain one non-billable charge", () => {
    const value = { ...record, status: "Pending", calculationVersion: "earned-hours-v1", earnedToDate: true,
        earningsAsOf: "2026-10-27T17:00:00Z", grossPay: 1000, deductions: 10, netPay: 990,
        excessBreakMinutes: 0, excessLunchMinutes: 0, nonBillableOffPhoneMinutes: 6, lateMinutes: 600, absenceMinutes: 480, deductibleMinutes: 6, overtimeHours: 0 };
    const before = JSON.stringify(value);
    const html = renderToStaticMarkup(React.createElement(exports.document, { record: value, money }));
    assert.ok(html.includes("Provisional Payslip")); assert.ok(html.includes("Earned Regular Pay"));
    assert.ok(html.includes("PHP 1000.00")); assert.ok(html.includes("PHP 990.00")); assert.ok(!html.includes("PHP 15000.00"));
    const rows = exports.rows(value); assert.equal(rows.reduce((sum, row) => sum + row.minutes, 0), 6);
    assert.equal(rows.find(row => row.label === "Non-billable Off the Phone").amount, 10);
    for (const label of ["Late", "Undertime", "Absence"]) assert.ok(html.includes(`${label} (`));
    assert.equal((html.match(/Already excluded from earned pay/g) || []).length, 3);
    assert.equal(JSON.stringify(value), before);
});

test("earned deduction display restores attendance shortfalls without charging them again or changing paid records", () => {
    for (const status of ["Pending", "Paid", "Completed"]) for (const workedMinutesOverride of [null, 420]) {
        const value = { ...record, status, calculationVersion: "earned-hours-v1", deductions: 10,
            lateMinutes: 12, earlyTimeOutMinutes: 30, absenceMinutes: 480, nonBillableOffPhoneMinutes: 6,
            excessBreakMinutes: 0, excessLunchMinutes: 0, workedMinutesOverride };
        const before = JSON.stringify(value), rows = exports.displayRows(value);
        for (const [label, minutes] of [["Late", 12], ["Undertime", 30], ["Absence", 480]]) {
            const row = rows.find(item => item.label === label);
            assert.equal(row.minutes, minutes); assert.equal(row.amount, null);
            assert.equal(row.note, workedMinutesOverride === null ? "Already excluded from earned pay" : "Paid hours manually adjusted");
        }
        assert.equal(rows.reduce((total, row) => total + Math.round((row.amount ?? 0) * 100), 0), 1000);
        assert.equal(rows.find(row => row.label === "Non-billable Off the Phone").amount, 10);
        assert.equal(JSON.stringify(value), before);
    }
    assert.deepEqual(exports.displayRows(record), exports.rows(record));
});

test("approved earned all-deductions payslip subtracts all six categories and preserves its exact net", () => {
    const value = { ...record, status: "Pending", calculationVersion: "earned-hours-all-deductions-v1", earnedToDate: true,
        grossPay: 1000, deductions: 100, netPay: 900, lateMinutes: 10, earlyTimeOutMinutes: 10, absenceMinutes: 50,
        excessBreakMinutes: 10, excessLunchMinutes: 10, nonBillableOffPhoneMinutes: 10, deductibleMinutes: 100, overtimeHours: 0 };
    const before = JSON.stringify(value), rows = exports.displayRows(value);
    assert.equal(rows.length, 6); assert.equal(rows.reduce((sum, row) => sum + row.amount, 0), 100);
    for (const label of ["Late", "Undertime", "Absence", "Excess break", "Excess lunch", "Non-billable Off the Phone"]) {
        assert.ok(rows.find(row => row.label === label).amount > 0, label);
    }
    const html = renderToStaticMarkup(React.createElement(exports.document, { record: value, money }));
    assert.ok(html.includes("Earned Regular Pay")); assert.ok(html.includes("PHP 1000.00")); assert.ok(html.includes("PHP 900.00"));
    assert.ok(!html.includes("Already excluded from earned pay")); assert.ok(!html.includes("PHP 15000.00"));
    assert.equal(JSON.stringify(value), before);
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
        { dtr: { ...dtr, storedCutoff: false } }, { record: { ...record, netPay: 1 } },
        { record: { ...record, earningsUnavailable: true } }, { dtr: { ...dtr, summary: { earningsUnavailable: true } } }]) assert.equal(exports.ready({ ...input, ...patch }), false);
    assert.equal(exports.ready({ ...input, accuracyEnabled: false, dtr: { ...dtr, storedCutoff: false } }), true);
    assert.match(source, /disabled=\{!isPayslipOutputReady \|\| sendPayslipMutation\.isPending \|\| payslipPdfMutation\.isPending\}/);
    assert.match(source, /if \(!isPayslipOutputReady \|\| payslipPdfMutation\.isPending\) return;/);
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
        const action = pageAction("exportCsv", { activeTab, isExportUnavailable: false, employees: [employee], rosterGaps: [], filteredBankEmployees: [bank], filteredPayrollItems: [item], filteredArchivedItems: [item],
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
test("print/save actions prepare only a verified payslip and never print the live CRM page", () => {
    assert.doesNotMatch(source, /window\.print\(/);
    for (const ready of [false, true]) for (const pending of [false, true]) for (const mode of ["open", "save"]) {
        let requested = 0, opened = 0;
        const target = { opener: {}, document: { title: "", body: { textContent: "" } } };
        pageAction("printPayslip", { isPayslipOutputReady: ready, payslipPdfMutation: { isPending: pending, mutate(value) { requested++; assert.equal(value.mode, mode); } },
            window: { open() { opened++; return target; } } })(mode);
        assert.equal(requested, Number(ready && !pending)); assert.equal(opened, Number(ready && !pending && mode === "open"));
        if (opened) assert.equal(target.opener, null);
    }
});
test("PDF failure closes its preparing tab and popup blocking falls back to a download", () => {
    let closed = 0, downloaded = 0, opened = 0, status = "";
    const config = pageAction("payslipPdfMutation", { useMutation: config => config, setPayslipDeliveryStatus: value => { status = value; },
        openPayslipPdf() { opened++; }, downloadPayslipPdf() { downloaded++; } });
    config.onError(new Error("Synthetic timeout"), { target: { close() { closed++; } } });
    assert.equal(closed, 1); assert.equal(status, "Synthetic timeout");
    config.onSuccess({ blob: {}, fileName: "fake.pdf" }, { mode: "open", target: null });
    assert.equal(downloaded, 1); assert.equal(opened, 0);
    config.onSuccess({ blob: {}, fileName: "fake.pdf" }, { mode: "open", target: { closed: false } });
    assert.equal(opened, 1);
});
test("print sheet reuses the payslip document outside the clipping modal with bounded paper layout", () => {
    const css = readFileSync(new URL("../src/pages/admin/payroll/payslip-print.css", import.meta.url), "utf8");
    assert.match(source, /createPortal\([\s\S]*?className="payroll-print-root"[\s\S]*?<PayslipDocument record=\{payslipPreviewRecord\}[\s\S]*?document\.body/);
    for (const rule of ["width: 190mm", "size: A4 portrait", "margin: 10mm", "min-height: 0 !important", "overflow: visible !important", "position: static !important", "break-inside: avoid-page", "print-color-adjust: exact"])
        assert.ok(css.includes(rule), rule);
    assert.match(css, /body:has\(> \.payroll-print-root\) > :not\(\.payroll-print-root\)\s*\{\s*display: none !important/);
    assert.doesNotMatch(css, /position: fixed|max-height:\s*\d|overflow:\s*hidden/);
});
