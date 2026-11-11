import type { ClientSession, Types } from "mongoose";
import { attendancePayrollDtr, payrollRatesForCutoff, type PayrollReadContext } from "../controllers/payrollController";
import { PayrollValidationError } from "./payrollAccuracy";
import { serverReadTime } from "./readSnapshot";
import { savedPayrollPeriod } from "../../../shared/payrollPeriod";
import { minuteAccrualAmounts } from "../../../shared/payrollMinuteAccrual";
import { earnedMinuteCappedVersion } from "../../../shared/payrollEarnings";

export const datedHistoricalCutoff = { start: "2026-10-21", end: "2026-11-05" } as const;
type SavedHistoricalRecord = { employeeId: string; payPeriod: string; calculationSnapshot?: Record<string, unknown> };
function savedObject(value: unknown, message: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new PayrollValidationError(message);
  return value as Record<string, unknown>;
}
function savedClock(value: unknown) {
  if (typeof value !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) throw new PayrollValidationError("The saved cutoff shift is required for its dated attendance breakdown.");
  return value;
}
function savedMinutes(value: unknown) {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 1440) throw new PayrollValidationError("The saved cutoff allowances are required for its dated attendance breakdown.");
  return value;
}

// This comparison is a read-only reference. Payment and recompute writers never call it.
export async function historicalPayrollComparison(employee: { _id: Types.ObjectId; employeeCode: string }, record: SavedHistoricalRecord, session?: ClientSession) {
  const period = savedPayrollPeriod(record.payPeriod);
  if (!period || period.start !== datedHistoricalCutoff.start || period.end !== datedHistoricalCutoff.end || record.employeeId !== employee.employeeCode) {
    throw new PayrollValidationError("The dated historical breakdown is limited to its saved cutoff and employee.");
  }
  const snapshot = savedObject(record.calculationSnapshot, "The saved cutoff inputs are required for its dated attendance breakdown.");
  const salary = snapshot.monthlySalary;
  if (typeof salary !== "number" || !Number.isFinite(salary) || salary < 0 || !Number.isSafeInteger(Math.round(salary * 100))) throw new PayrollValidationError("The saved monthly salary is required for an attendance-based comparison.");
  const shift = savedObject(snapshot.settings, "The saved cutoff shift is required for its dated attendance breakdown.");
  const savedPolicy = savedObject(snapshot.policy, "The saved cutoff allowances are required for its dated attendance breakdown.");
  const policy = { breakMinutes: savedMinutes(savedPolicy.breakMinutes), lunchMinutes: savedMinutes(savedPolicy.lunchMinutes), graceMinutes: savedMinutes(savedPolicy.graceMinutes) };
  const settings = { officialShiftStartTime: savedClock(shift.officialShiftStartTime), officialShiftEndTime: savedClock(shift.officialShiftEndTime),
    lateGraceMinutes: policy.graceMinutes, attendanceTimeZone: "Asia/Manila", breakMinutes: policy.breakMinutes, lunchMinutes: policy.lunchMinutes };
  const context: PayrollReadContext = { settings, policy, requireAssignedShiftMatch: true };
  const dtr = await attendancePayrollDtr(employee._id, record.payPeriod, session, context);
  if (dtr.rows.some(row => ["Needs Review", "In Progress", "Scheduled"].includes(row.status))) {
    throw new PayrollValidationError("Dated attendance needs review before a historical payment comparison can be calculated.");
  }
  const rows = dtr.rows.map(row => {
    if (row.dateKey < period.start || row.dateKey > period.end) throw new PayrollValidationError("Attendance outside the saved cutoff cannot enter its historical breakdown.");
    const gross = row.isWeekend ? 0 : row.earnedGrossHours;
    if (typeof gross !== "number" || !Number.isFinite(gross) || gross < 0) throw new PayrollValidationError("Verified earned minutes are required for the historical breakdown.");
    const rest = row.isWeekend ? 0 : row.excessBreakMinutes + row.excessLunchMinutes + (row.nonBillableOffPhoneMinutes || 0);
    return { ...row, earnedGrossHours: gross, earnedDeductibleMinutes: rest, regularHours: Math.max(0, gross - rest / 60),
      deductibleMinutes: rest, missingHours: rest / 60, overtimeHours: 0 };
  });
  const sum = (field: "earnedGrossHours" | "regularHours" | "deductibleMinutes") => rows.reduce((total, row) => total + row[field], 0);
  const rates = payrollRatesForCutoff(salary, record.payPeriod, settings, policy);
  const amounts = minuteAccrualAmounts(rates.cutoffBasePay, rates.minuteRate, sum("earnedGrossHours"), sum("deductibleMinutes"), 0);
  const summary = { ...dtr.summary, ...amounts, basicPay: rates.cutoffBasePay, paidHoursPerDay: rates.paidHoursPerDay, hourlyRate: rates.hourlyRate,
    minuteRate: rates.minuteRate, workingDays: dtr.summary.workingDays, monthlyWorkingDays: rates.monthlyWorkingDays,
    workedHours: sum("regularHours"), earnedGrossHours: sum("earnedGrossHours"), deductibleMinutes: sum("deductibleMinutes"),
    missingHours: sum("deductibleMinutes") / 60, overtimeHours: 0, overtimeApproved: false, calculationVersion: earnedMinuteCappedVersion,
    recordedInShiftHours: rows.filter(row => !row.isWeekend).reduce((total, row) => total + row.grossHours, 0),
    unpaidLunchHours: rows.filter(row => !row.isWeekend).reduce((total, row) => total + Math.min(row.lunchHours, policy.lunchMinutes / 60), 0),
    calculationSnapshot: { settings: { officialShiftStartTime: settings.officialShiftStartTime, officialShiftEndTime: settings.officialShiftEndTime },
      policy, ...rates, rounding: "Read-only dated earned-minute comparison. Unworked time is excluded once; only excess rest and non-billable Off the Phone are additional deductions. Coaching stays paid. Early-in and overtime add no pay. Saved payroll is unchanged." } };
  return { asOf: serverReadTime().toISOString(), referenceOnly: true as const, basis: "dated-earned-minutes" as const,
    fromDate: period.start, toDate: period.end, summary, rows };
}
