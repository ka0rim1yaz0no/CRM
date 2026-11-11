import assert from "node:assert/strict";
import { test } from "node:test";
import { fixedHalfSalaryAmounts, fixedHalfSalaryBase } from "../../../shared/payrollFixedHalf";
import { adjustedPayrollHours } from "../../../shared/payrollWorkedHours";
import { fixedHalfSalaryVersion } from "../../../shared/payrollEarnings";
import { payrollDeductionRows, payrollDeductionDisplayTotal } from "../../../shared/payrollPresentation";

test("unequal cutoff working days never change the half-month base or the full monthly total", () => {
    for (const days of [[11, 12], [10, 11], [11, 10], [12, 10]]) {
        const monthly = 1000, rate = monthly / (days[0] + days[1]) / 8 / 60;
        const first = fixedHalfSalaryAmounts(fixedHalfSalaryBase(monthly, true), rate, 0);
        const second = fixedHalfSalaryAmounts(fixedHalfSalaryBase(monthly, false), rate, 0);
        assert.equal(first.grossPay, 500); assert.equal(second.grossPay, 500); assert.equal(first.netPay + second.netPay, monthly);
    }
});
test("odd monthly cents are distributed once, never paid twice", () => {
    assert.equal(fixedHalfSalaryBase(1000.01, true), 500); assert.equal(fixedHalfSalaryBase(1000.01, false), 500.01);
    assert.equal(Math.round((fixedHalfSalaryBase(1000.01, true) + fixedHalfSalaryBase(1000.01, false)) * 100), 100001);
});
test("deductions use the unchanged monthly minute rate once and gross never increases with paid hours", () => {
    const rate = 1000 / 23 / 8 / 60, result = fixedHalfSalaryAmounts(500, rate, 5);
    assert.equal(result.grossPay, 500); assert.equal(result.deductions, Math.round(5 * rate * 100) / 100);
    assert.equal(result.netPay, Math.round((result.grossPay - result.deductions) * 100) / 100);
});
test("money stays bounded and invalid or overtime inputs are refused", () => {
    assert.deepEqual(fixedHalfSalaryAmounts(500, 2, 1000), { grossPay: 500, deductions: 500, netPay: 0 });
    assert.throws(() => fixedHalfSalaryAmounts(500, 2, 1, 1), /Overtime/);
    for (const minutes of [-1, 0.5, NaN, Infinity]) assert.throws(() => fixedHalfSalaryAmounts(500, 2, minutes));
    assert.throws(() => fixedHalfSalaryAmounts(-1, 2, 0)); assert.throws(() => fixedHalfSalaryBase(Infinity, true));
});
test("reviewed paid hours contain rest shortfalls once, including the unchanged-value case", () => {
    const source = { scheduledHours: 88, excessBreakMinutes: 2, excessLunchMinutes: 3, nonBillableOffPhoneMinutes: 4, calculationVersion: fixedHalfSalaryVersion };
    const adjusted = adjustedPayrollHours(source, 88 * 60 - 14);
    assert.equal(adjusted.deductibleMinutes, 14);
    const deductions = fixedHalfSalaryAmounts(500, 0.25, adjusted.deductibleMinutes).deductions;
    const record = { ...source, ...adjusted, deductions, lateMinutes: 5 };
    const rows = payrollDeductionRows(record);
    assert.equal(rows.reduce((sum, row) => sum + row.minutes, 0), 14);
    assert.equal(Math.round(rows.reduce((sum, row) => sum + row.amount, 0) * 100), Math.round(deductions * 100));
    assert.equal(payrollDeductionDisplayTotal(record), deductions);
    assert.throws(() => adjustedPayrollHours(source, 88 * 60), /rest deductions/);
});
