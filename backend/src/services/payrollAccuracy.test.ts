import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { paidHoursPerDay, accuratePayrollRates, accuratePayrollDay, roundMoney } from "./payrollAccuracy";
import { payrollAccuracyEnabled } from "../config/rolloutFlags";
import { calculateSlotAttendance } from "./timeAccounting";

const settings = { officialShiftStartTime: "23:00", officialShiftEndTime: "08:00" };
const start = new Date("2026-10-15T15:00:00Z"), end = new Date("2026-10-16T00:00:00Z");
const policy = { shiftStart: start, shiftEnd: end, graceMinutes: 0, breakMinutes: 15, lunchMinutes: 60 };
const punch = (source: string, minutes: number, seconds = 0) => ({ source, timeIn: new Date(+start + minutes * 60_000 + seconds * 1000) });
test("accuracy flag defaults local on, production off, with explicit rollback", () => {
  const env = process.env.NODE_ENV, flag = process.env.CRM_PAYROLL_ACCURACY;
  try { delete process.env.CRM_PAYROLL_ACCURACY;
    for (const value of ["development", "test", "production"]) { process.env.NODE_ENV = value; assert.equal(payrollAccuracyEnabled(), value !== "production"); }
    process.env.CRM_PAYROLL_ACCURACY = "false"; assert.equal(payrollAccuracyEnabled(), false);
  } finally { if (env === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = env; if (flag === undefined) delete process.env.CRM_PAYROLL_ACCURACY; else process.env.CRM_PAYROLL_ACCURACY = flag; }
});
test("paid day is derived from shift and lunch, including overnight and different lengths", () => {
  for (const [officialShiftStartTime, officialShiftEndTime] of [["22:00", "07:00"], ["23:00", "08:00"]]) {
    for (const lunchMinutes of [30, 60]) {
      assert.equal(paidHoursPerDay({ officialShiftStartTime, officialShiftEndTime }, { lunchMinutes }), 9 - lunchMinutes / 60);
    }
  }
  assert.equal(paidHoursPerDay(settings, { lunchMinutes: 60 }), 8);
  assert.equal(paidHoursPerDay({ officialShiftStartTime: "22:00", officialShiftEndTime: "07:00" }, { lunchMinutes: 30 }), 8.5);
  assert.equal(paidHoursPerDay({ officialShiftStartTime: "07:00", officialShiftEndTime: "13:00" }, { lunchMinutes: 60 }), 5);
  for (const bad of [{}, { officialShiftStartTime: "25:00", officialShiftEndTime: "07:00" }, { officialShiftStartTime: "23:00", officialShiftEndTime: "23:00" }]) {
    assert.throws(() => paidHoursPerDay(bad, { lunchMinutes: 60 }), error => (error as { statusCode: number }).statusCode === 422);
  }
  assert.throws(() => paidHoursPerDay(settings, { lunchMinutes: 540 }), /Shift settings are required for payroll/);
  const rate = accuratePayrollRates(30000, 23, settings, policy);
  assert.equal(rate.minuteRate, 30000 / 23 / paidHoursPerDay(settings, policy) / 60);
  assert.equal(roundMoney(24 * rate.minuteRate), 65.22);
});
test("payroll uses one disjoint late/early total, independent rests, absence and review exclusion", () => {
  process.env.CRM_PAYROLL_ACCURACY = "true";
  try {
    const records = [punch("Time In", 5), punch("Break Out", 75), punch("Break In", 90, 1), punch("Break Out", 120), punch("Break In", 135),
      punch("Lunch Break Out", 200), punch("Lunch Break In", 261), punch("Time Out", 530)];
    const day = accuratePayrollDay(records, policy, end, paidHoursPerDay(settings, policy), false);
    assert.deepEqual(day.components, { lateMinutes: 5, earlyTimeOutMinutes: 10, excessBreakMinutes: 1, excessLunchMinutes: 1, absenceMinutes: 0, nonBillableOffPhoneMinutes: 0, deductibleMinutes: 17 });
    assert.equal(day.missingHours * 60, day.components.deductibleMinutes);
    for (const [first, last, late, early] of [[5, 540, 5, 0], [0, 530, 0, 10], [-60, -30, 0, 540], [600, 610, 540, 0]]) {
      const item = calculateSlotAttendance([punch("Time In", first), punch("Time Out", last)], policy, new Date(+end + 3_600_000));
      assert.deepEqual([item.lateMinutes, item.earlyTimeOutMinutes], [late, early]);
      assert.ok(item.lateMinutes + item.earlyTimeOutMinutes <= 540);
    }
    for (const seconds of [0, 1]) assert.equal(calculateSlotAttendance([punch("Time In", 0), punch("Break Out", 60), punch("Break In", 75, seconds), punch("Time Out", 540)], policy, end).excessBreakMinutes, seconds);
    const absent = accuratePayrollDay([], policy, end, 8, false);
    assert.equal(absent.components.absenceMinutes, 480); assert.equal(absent.missingHours, 8);
    const open = accuratePayrollDay([punch("Time In", 5), punch("Break Out", 60)], policy, end, 8, false);
    assert.equal(open.status, "Needs Review"); assert.equal(open.components.deductibleMinutes, 0);
    const third = accuratePayrollDay([...records.slice(0, -1), punch("Break Out", 300), punch("Break In", 315), punch("Time Out", 540)], policy, end, 8, false);
    assert.equal(third.status, "Needs Review"); assert.equal(third.components.deductibleMinutes, 0);
    const weekend = accuratePayrollDay([punch("Time In", 0), punch("Time Out", 120)], policy, end, 8, true);
    assert.equal(weekend.overtimeHours, 2); assert.equal(weekend.components.deductibleMinutes, 0);
  } finally { delete process.env.CRM_PAYROLL_ACCURACY; }
});
test("active payroll sources do not contain fixed eight-hour or nine-hour fallback expressions", () => {
  for (const path of ["../controllers/payrollController.ts", "./payrollAccuracy.ts", "./payrollRecomputeService.ts", "../../../src/pages/admin/payroll/index.tsx", "../../../src/pages/admin/payrollCompute/index.tsx"]) {
    const source = readFileSync(new URL(path, import.meta.url), "utf8");
    assert.doesNotMatch(source, /\/\s*8\b|\|\|\s*9\b/);
  }
});
