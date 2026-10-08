import assert from "node:assert/strict";
import test from "node:test";
import {
  monthlyWorkingDaysForPayPeriod,
  periodRange,
  payrollRatesForCutoff,
  resolveCutoffForDate,
  scheduledPayDateForPeriod,
} from "./payrollController";

function localDateKey(value: Date | null) {
  if (!value) return "";
  return [value.getFullYear(), String(value.getMonth() + 1).padStart(2, "0"), String(value.getDate()).padStart(2, "0")].join("-");
}

test("uses half of monthly salary for each cutoff while retaining the full 6th-5th rate denominator", () => {
  const firstCutoff = payrollRatesForCutoff(30_000, "Oct 6, 2026 - Oct 20, 2026");
  const secondCutoff = payrollRatesForCutoff(30_000, "Oct 21, 2026 - Nov 5, 2026");

  assert.equal(firstCutoff.cutoffBasePay, 15_000);
  assert.equal(secondCutoff.cutoffBasePay, 15_000);
  assert.equal(firstCutoff.monthlyWorkingDays, monthlyWorkingDaysForPayPeriod("Oct 6, 2026 - Nov 5, 2026"));
  assert.equal(secondCutoff.monthlyWorkingDays, firstCutoff.monthlyWorkingDays);
  assert.equal(firstCutoff.minuteRate, secondCutoff.minuteRate);
});

test("assigns the 6th-20th cutoff to the 25th pay date", () => {
  assert.equal(
    localDateKey(scheduledPayDateForPeriod("Oct 6, 2026 - Oct 20, 2026")),
    "2026-10-25"
  );
});

test("assigns the 21st-5th cutoff to the following 10th pay date", () => {
  assert.equal(
    localDateKey(scheduledPayDateForPeriod("Oct 21, 2026 - Nov 5, 2026")),
    "2026-11-10"
  );
});

test("includes the exact cutoff end date in both semi-monthly attendance windows", () => {
  const firstCutoff = periodRange("Oct 6, 2026 - Oct 20, 2026");
  const secondCutoff = periodRange("Oct 21, 2026 - Nov 5, 2026");

  assert.equal(localDateKey(firstCutoff.start), "2026-10-06");
  assert.equal(localDateKey(firstCutoff.end), "2026-10-21");
  assert.equal(localDateKey(secondCutoff.start), "2026-10-21");
  assert.equal(localDateKey(secondCutoff.end), "2026-11-06");
});

test("keeps both cutoff rates anchored to the same complete 6th-5th cycle", () => {
  assert.equal(monthlyWorkingDaysForPayPeriod("Oct 6, 2026 - Oct 20, 2026"), 23);
  assert.equal(monthlyWorkingDaysForPayPeriod("Oct 21, 2026 - Nov 5, 2026"), 23);
});

test("keeps the 21st-5th cutoff selected through its 10th payday", () => {
  const onPayday = resolveCutoffForDate(new Date(2026, 9, 10), "Semi-monthly");
  const afterPayday = resolveCutoffForDate(new Date(2026, 9, 11), "Semi-monthly");

  assert.equal(localDateKey(onPayday!.start), "2026-09-21");
  assert.equal(localDateKey(onPayday!.end), "2026-10-05");
  assert.equal(localDateKey(afterPayday!.start), "2026-10-06");
  assert.equal(localDateKey(afterPayday!.end), "2026-10-20");
});

test("keeps the 6th-20th cutoff selected through its 25th payday", () => {
  const onPayday = resolveCutoffForDate(new Date(2026, 9, 25), "Semi-monthly");
  const afterPayday = resolveCutoffForDate(new Date(2026, 9, 26), "Semi-monthly");

  assert.equal(localDateKey(onPayday!.start), "2026-10-06");
  assert.equal(localDateKey(onPayday!.end), "2026-10-20");
  assert.equal(localDateKey(afterPayday!.start), "2026-10-21");
  assert.equal(localDateKey(afterPayday!.end), "2026-11-05");
});

test("carries the second cutoff and payday correctly across a year boundary", () => {
  const cutoff = resolveCutoffForDate(new Date(2027, 0, 10), "Semi-monthly");

  assert.equal(localDateKey(cutoff!.start), "2026-12-21");
  assert.equal(localDateKey(cutoff!.end), "2027-01-05");
  assert.equal(localDateKey(cutoff!.payDate), "2027-01-10");
});

test("deduction rate is monthly salary divided by full-cycle weekdays, eight hours, and sixty minutes", () => {
  const rates = payrollRatesForCutoff(30_000, "Oct 6, 2026 - Oct 20, 2026");
  const expected = 30_000 / rates.monthlyWorkingDays / 8 / 60;
  assert.ok(Math.abs(rates.minuteRate - expected) < 1e-10);
});
