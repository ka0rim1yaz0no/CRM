import assert from "node:assert/strict";
import test from "node:test";
import {
  excessClickedSessionMinutes,
  monthlyWorkingDaysForPayPeriod,
  periodRange,
  payrollRatesForCutoff,
  payrollAttendanceWithWorkedMinutes,
  resolveCutoffForDate,
  scheduledPayDateForPeriod,
  visiblePayrollDtrRows,
  workedMinutesInsideShift,
} from "./payrollController";

function attendance(source: string, minute: number) {
  return { source, timeIn: new Date(Date.UTC(2026, 9, 9, 0, minute)) };
}

test("deducts lunch and break only after their clicked duration exceeds the allowance", () => {
  assert.equal(excessClickedSessionMinutes([
    attendance("Lunch Break Out", 0),
    attendance("Lunch Break In", 60),
  ], "Lunch Break Out", "Lunch Break In", 60), 0);

  assert.equal(excessClickedSessionMinutes([
    attendance("Break Out", 0),
    attendance("Break In", 17),
  ], "Break Out", "Break In", 15), 2);
});

test("does not deduct an unfinished lunch or break without an employee click in", () => {
  assert.equal(excessClickedSessionMinutes([
    attendance("Break Out", 0),
  ], "Break Out", "Break In", 15), 0);
});

test("calculates each clicked break independently instead of using fixed clock times", () => {
  assert.equal(excessClickedSessionMinutes([
    attendance("Break Out", 0),
    attendance("Break In", 20),
    attendance("Break Out", 30),
    attendance("Break In", 50),
  ], "Break Out", "Break In", 15), 10);
});

test("keeps future scheduled dates out of attendance detail rows", () => {
  const rows = visiblePayrollDtrRows([
    { status: "Present", date: "Oct 12" },
    { status: "In Progress", date: "Oct 13" },
    { status: "Scheduled", date: "Oct 14" },
  ]);

  assert.deepEqual(rows, [
    { status: "Present", date: "Oct 12" },
    { status: "In Progress", date: "Oct 13" },
  ]);
});

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

test("counts work only inside the official shift window", () => {
  const shiftStart = 10_000;
  const shiftEnd = shiftStart + 540;
  assert.equal(workedMinutesInsideShift(shiftStart - 45, shiftEnd, shiftStart, shiftEnd), 540);
  assert.equal(workedMinutesInsideShift(shiftStart - 45, shiftEnd - 30, shiftStart, shiftEnd), 510);
  assert.equal(workedMinutesInsideShift(shiftStart + 15, shiftEnd + 60, shiftStart, shiftEnd), 525);
});

test("a cutoff worked-minute override recalculates total shortage without changing scheduled time", () => {
  const adjusted = payrollAttendanceWithWorkedMinutes({
    attendanceDays: 10,
    absentDays: 0,
    absentHours: 0,
    lateDays: 0,
    lateHours: 0,
    workingDays: 10,
    workedHours: 80,
    overtimeHours: 0,
    missingHours: 0,
    scheduledHours: 80,
    lateMinutes: 0,
    excessLunchMinutes: 10,
    excessBreakMinutes: 5,
    absenceMinutes: 0,
    earlyTimeOutMinutes: 0,
    deductibleMinutes: 15,
    incompleteShiftDays: 0,
  }, 4_500);

  assert.equal(adjusted.effectiveWorkedMinutes, 4_500);
  assert.equal(adjusted.workedHours, 75);
  assert.equal(adjusted.earlyTimeOutMinutes, 300);
  assert.equal(adjusted.deductibleMinutes, 315);
  assert.equal(adjusted.scheduledHours, 80);
});
