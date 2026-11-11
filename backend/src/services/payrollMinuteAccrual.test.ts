import assert from "node:assert/strict";
import { test } from "node:test";
import { minuteAccrualAmounts } from "../../../shared/payrollMinuteAccrual";
import { fixedHalfSalaryBase } from "../../../shared/payrollFixedHalf";
import { earnedMinuteCappedVersion } from "../../../shared/payrollEarnings";
import { payrollDeductionRows, payrollDeductionDisplayRows, payrollDeductionDisplayTotal } from "../../../shared/payrollPresentation";
import { minuteAccrualEnabled, earnedPayrollVersion, fixedHalfSalaryEnabled } from "../config/payrollEarnings";

test("minute accrual starts at zero and grows with earned time instead of crediting the full cap", () => {
    const rate = 1000 / 23 / 8 / 60;
    assert.equal(minuteAccrualAmounts(500, rate, 0, 0).netPay, 0);
    const first = minuteAccrualAmounts(500, rate, 60 / 60, 0), next = minuteAccrualAmounts(500, rate, 61 / 60, 0);
    assert.equal(first.grossPay, Math.round(60 * rate * 100) / 100);
    assert.ok(next.netPay > first.netPay && next.netPay < 500);
});
test("gross is capped by the correctly split half-month budget, including odd salary cents", () => {
    const first = minuteAccrualAmounts(fixedHalfSalaryBase(1000.01, true), 2, 100, 0);
    const second = minuteAccrualAmounts(fixedHalfSalaryBase(1000.01, false), 2, 100, 0);
    assert.equal(first.grossPay, 500); assert.equal(second.grossPay, 500.01);
    assert.equal(Math.round((first.netPay + second.netPay) * 100), 100001);
});
test("verified excess rest and non-billable minutes are deducted once and cannot create negative pay", () => {
    assert.deepEqual(minuteAccrualAmounts(500, 1, 1, 7), { grossPay: 60, deductions: 7, netPay: 53 });
    assert.deepEqual(minuteAccrualAmounts(500, 1, 1, 80), { grossPay: 60, deductions: 60, netPay: 0 });
    assert.deepEqual(minuteAccrualAmounts(500, 1, 100, 7), { grossPay: 500, deductions: 7, netPay: 493 });
});
test("minute accrual rejects invalid inputs and overtime instead of silently changing the pay policy", () => {
    for (const value of [-1, NaN, Infinity]) assert.throws(() => minuteAccrualAmounts(value, 1, 1, 0));
    for (const value of [-1, NaN, Infinity]) assert.throws(() => minuteAccrualAmounts(500, value, 1, 0));
    for (const value of [-1, NaN, Infinity]) assert.throws(() => minuteAccrualAmounts(500, 1, value, 0));
    for (const value of [-1, 0.5, NaN, Infinity]) assert.throws(() => minuteAccrualAmounts(500, 1, 1, value));
    assert.throws(() => minuteAccrualAmounts(500, 1, 1, 0, 1), /Overtime/);
    assert.throws(() => minuteAccrualAmounts(500, Number.MAX_VALUE, 0, Number.MAX_SAFE_INTEGER), /range/);
});
test("unearned late, undertime and absence remain visible without being added to the cash deductions again", () => {
    const source = { calculationVersion: earnedMinuteCappedVersion, minuteRate: 1, deductions: 7, lateMinutes: 10, earlyTimeOutMinutes: 20, absenceMinutes: 480, excessBreakMinutes: 1, excessLunchMinutes: 1, nonBillableOffPhoneMinutes: 5 };
    const charged = payrollDeductionRows(source); assert.equal(charged.reduce((sum, row) => sum + row.amount, 0), 7);
    assert.ok(!charged.some(row => ["Late", "Undertime", "Absence"].includes(row.label)));
    const shown = payrollDeductionDisplayRows(source);
    for (const label of ["Late", "Undertime", "Absence"]) { const row = shown.find(item => item.label === label)!; assert.equal(row.amount, null); assert.match(row.note!, /Already excluded/); assert.ok(row.informationalAmount! > 0); }
    assert.equal(payrollDeductionDisplayTotal(source), 7);
});
test("minute-accrual activation cannot be backdated into restored cutoffs", context => {
    const keys = ["CRM_MINUTE_ACCRUAL_FROM", "CRM_EARNED_PAYROLL_FROM", "CRM_FIXED_HALF_SALARY_FROM"], before = keys.map(key => process.env[key]);
    context.after(() => keys.forEach((key, index) => { if (before[index] === undefined) delete process.env[key]; else process.env[key] = before[index]; }));
    process.env.CRM_EARNED_PAYROLL_FROM = "2026-10-06"; process.env.CRM_FIXED_HALF_SALARY_FROM = "2026-10-21";
    for (const from of ["2026-10-21", "2026-11-31", "invalid"]) { process.env.CRM_MINUTE_ACCRUAL_FROM = from; assert.throws(() => minuteAccrualEnabled("Nov 6, 2026 - Nov 20, 2026")); }
    process.env.CRM_MINUTE_ACCRUAL_FROM = "2026-11-06";
    assert.equal(minuteAccrualEnabled("Oct 21, 2026 - Nov 5, 2026"), false);
    assert.equal(fixedHalfSalaryEnabled("Oct 21, 2026 - Nov 5, 2026"), true);
    assert.equal(earnedPayrollVersion("Nov 6, 2026 - Nov 20, 2026"), earnedMinuteCappedVersion);
    assert.equal(fixedHalfSalaryEnabled("Nov 6, 2026 - Nov 20, 2026"), false);
    assert.equal(minuteAccrualEnabled("Nov 21, 2026 - Dec 5, 2026"), true);
});
