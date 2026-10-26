import assert from "node:assert/strict";
import { test } from "node:test";
import { savedPayrollPeriod, isConfiguredSavedPayrollPeriod } from "../../../shared/payrollPeriod";
import { savedPayrollDisplayRates } from "../../../shared/payrollSavedRates";
import { payrollReadGroups } from "./payrollReadPolicy";
import { periodRange } from "../controllers/payrollController";

const period = "Oct 6, 2026 - Oct 20, 2026";
const record = { _id: "canonical", employeeId: "synthetic", payPeriod: period, grossPay: 15000, deductions: 51.63, netPay: 14948.37,
    basicPay: 15000, status: "Pending", paidOn: "-", lateMinutes: 19, excessBreakMinutes: 0 };
test("ISO, named and legacy month labels normalize without timezone changes or guessed dates", () => {
    assert.deepEqual(savedPayrollPeriod("2026-10-06 - 2026-10-20"), savedPayrollPeriod(period));
    assert.deepEqual(savedPayrollPeriod("October 06, 2026 - October 20, 2026"), savedPayrollPeriod(period));
    assert.equal(savedPayrollPeriod("May 2026 1-15")?.start, "2026-05-01");
    assert.equal(savedPayrollPeriod("May 2026 16-End")?.end, "2026-05-31");
    assert.equal(savedPayrollPeriod("May 2026")?.end, "2026-05-31");
    for (const input of ["Current Month", "2026-02-30 - 2026-03-05", "Oct 20, 2026 - Oct 6, 2026", "Fake 2026", "May 2026 31-5"]) assert.equal(savedPayrollPeriod(input), null, input);
    const actual = periodRange("2026-10-06 - 2026-10-20");
    assert.deepEqual([actual.start.getFullYear(), actual.start.getMonth(), actual.start.getDate(), actual.end.getDate()], [2026, 9, 6, 21]);
    assert.throws(() => periodRange("2026-02-30 - 2026-03-05"), /Invalid saved payroll/);
});
test("history accepts complete configured cutoffs, not the overlapping zero monthly draft", () => {
    assert.equal(isConfiguredSavedPayrollPeriod(savedPayrollPeriod(period)!, {}), true);
    assert.equal(isConfiguredSavedPayrollPeriod(savedPayrollPeriod("Oct 21, 2026 - Nov 5, 2026")!, {}), true);
    assert.equal(isConfiguredSavedPayrollPeriod(savedPayrollPeriod("Oct 6, 2026 - Nov 5, 2026")!, {}), false);
    assert.equal(isConfiguredSavedPayrollPeriod(savedPayrollPeriod("Feb 16, 2028 - Feb 29, 2028")!, { payrollSecondCutoffStartDay: 16, payrollSecondCutoffEndDay: 31 }), true);
});
test("equivalent aliases render once; conflicting aliases preserve Admin's record and raise review without promoting Paid", () => {
    const iso = { ...record, _id: "iso", payPeriod: "2026-10-06 - 2026-10-20" };
    const before = JSON.stringify([record, iso]);
    assert.equal(payrollReadGroups([iso, record]).groups[0].record?._id, "canonical");
    assert.equal(payrollReadGroups([iso, record]).groups[0].requiresReview, false);
    assert.equal(JSON.stringify([record, iso]), before);
    for (const conflict of [{ status: "Paid" }, { deductions: 0, netPay: 15000 }, { lateMinutes: 2 }]) {
        const group = payrollReadGroups([{ ...iso, ...conflict }, record]).groups[0];
        assert.equal(group.record?._id, "canonical"); assert.equal(group.record?.status, "Pending"); assert.equal(group.requiresReview, true);
    }
    assert.equal(payrollReadGroups([{ ...record, _id: "one" }, { ...record, _id: "two", status: "Paid" }]).groups[0].record, null);
    assert.equal(payrollReadGroups([{ ...record, netPay: 1 }]).groups[0].record, null);
    assert.equal(payrollReadGroups([{ ...record, employeeId: "another" }, iso]).groups.length, 2);
});
test("display rates derive only from saved cutoff pay; historical totals are never changed", () => {
    const value = { payType: "Semi-monthly", monthlySalary: null, basicPay: 15000, workingDays: 23, minuteRate: 30000 / 23 / 8 / 60, hourlyRate: null, paidHoursPerDay: null };
    const before = JSON.stringify(value), rates = savedPayrollDisplayRates(value);
    assert.equal(rates.monthlyBasicPay, 30000); assert.equal(rates.hourlyRate, value.minuteRate * 60); assert.equal(rates.paidHoursPerDay, 8);
    assert.equal(JSON.stringify(value), before);
    assert.equal(savedPayrollDisplayRates({ ...value, minuteRate: 2.72 }).paidHoursPerDay, 8);
    assert.equal(savedPayrollDisplayRates({ ...value, paidHoursPerDay: 7.5, hourlyRate: 173.91 }).paidHoursPerDay, 7.5);
    assert.equal(savedPayrollDisplayRates({ ...value, basicPay: null, workingDays: null, minuteRate: 0 }).paidHoursPerDay, null);
    assert.equal(savedPayrollDisplayRates({ ...value, monthlySalary: 31000 }).monthlyBasicPay, 31000);
});

test("a saved zero minute rate yields zero hourly pay without inventing a paid-day basis", () => {
    const saved = { payType: "Semi-monthly", grossPay: 0, basicPay: 0, workingDays: 23, minuteRate: 0, hourlyRate: null, paidHoursPerDay: null };
    const before = JSON.stringify(saved), rates = savedPayrollDisplayRates(saved);
    assert.equal(rates.monthlyBasicPay, 0);
    assert.equal(rates.hourlyRate, 0);
    assert.equal(rates.paidHoursPerDay, null);
    assert.equal(JSON.stringify(saved), before);
    assert.equal(savedPayrollDisplayRates({ ...saved, paidHoursPerDay: 8 }).paidHoursPerDay, 8);
    for (const minuteRate of [undefined, null, -1, NaN]) {
        assert.equal(savedPayrollDisplayRates({ ...saved, minuteRate }).hourlyRate, null);
    }
    assert.equal(savedPayrollDisplayRates({ ...saved, basicPay: null }).hourlyRate, null);
    assert.equal(savedPayrollDisplayRates({ ...saved, grossPay: 15000 }).hourlyRate, null);
    assert.equal(savedPayrollDisplayRates({ ...saved, basicPay: 15000 }).hourlyRate, null);
    assert.equal(savedPayrollDisplayRates({ ...saved, basicPay: 15000, paidHoursPerDay: 8 }).hourlyRate, 30000 / 23 / 8);
    const zero = { ...record, basicPay: 0, grossPay: 0, deductions: 0, netPay: 0, scheduledHours: 8, absenceMinutes: 0 };
    const alias = { ...zero, _id: "zero-alias", payPeriod: "2026-10-06 - 2026-10-20", scheduledHours: 16, absenceMinutes: 480 };
    const conflict = payrollReadGroups([zero, alias]).groups[0];
    assert.equal(conflict.record?._id, zero._id);
    assert.equal(conflict.requiresReview, true, "equal zero money must not hide conflicting attendance evidence");
});
