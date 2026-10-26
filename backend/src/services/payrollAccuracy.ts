import { calculateSlotAttendance, accountTime, bucketForAttendanceSource, deductionComponents, recordsWithClosingBoundaries } from "./timeAccounting";
import { projectAttendance, type SessionEvent } from "./attendanceSessionState";
import type { AttendanceSource } from "../models/Attendance";
import { attendanceAccuracyFixesEnabled } from "../config/rolloutFlags";
import { nonBillableOffPhoneIntervals } from "../../../shared/attendanceOffPhone";

export type PayrollShiftSettings = { officialShiftStartTime?: string | null; officialShiftEndTime?: string | null };
export class PayrollValidationError extends Error {
  statusCode = 422;
}
const clockMinutes = (value: unknown) => {
  if (typeof value !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) return NaN;
  const [hours, minutes] = value.split(":").map(Number);
  return hours * 60 + minutes;
};
export function paidHoursPerDay(settings: PayrollShiftSettings, policy: { lunchMinutes: number }) {
  const start = clockMinutes(settings.officialShiftStartTime), end = clockMinutes(settings.officialShiftEndTime);
  const grossMinutes = (end - start + 1440) % 1440;
  const paidMinutes = grossMinutes - policy.lunchMinutes;
  if (!Number.isFinite(paidMinutes) || !Number.isFinite(policy.lunchMinutes) || policy.lunchMinutes < 0 || paidMinutes <= 0) {
    throw new PayrollValidationError("Shift settings are required for payroll");
  }
  return paidMinutes / 60;
}
export const roundMoney = (value: number) => Math.round((value + Number.EPSILON) * 100) / 100;
export function accuratePayrollRates(salary: number, monthlyWorkingDays: number, settings: PayrollShiftSettings, policy: { lunchMinutes: number }) {
  const paidHours = paidHoursPerDay(settings, policy);
  if (!Number.isInteger(monthlyWorkingDays) || monthlyWorkingDays <= 0 || !Number.isFinite(salary) || salary < 0) {
    throw new PayrollValidationError("Payroll salary and monthly working days must be valid");
  }
  const hourlyRate = salary / monthlyWorkingDays / paidHours;
  return { monthlySalary: salary, monthlyWorkingDays, cutoffBasePay: roundMoney(salary / 2),
    paidHoursPerDay: paidHours, hourlyRate, minuteRate: hourlyRate / 60 };
}
export function accuratePayrollDay(records: Array<{ source: string; timeIn: Date }>, policy: {
  breakMinutes: number; lunchMinutes: number; graceMinutes: number; shiftStart: Date; shiftEnd: Date; closingBoundaries?: Date[];
}, now: Date, paidHours: number, weekend: boolean, mismatch = false) {
  const calculated = calculateSlotAttendance(records, policy, now);
  const events = records.map((item, sequence) => ({ id: String(sequence), commandId: String(sequence), sequence,
    source: item.source as AttendanceSource, at: item.timeIn.toISOString(), recordedAt: item.timeIn.toISOString() } as SessionEvent));
  const projection = projectAttendance(events, [], [], { allowUnreturnedCheckout: attendanceAccuracyFixesEnabled() });
  const first = records.find(item => ["Time In", "Login"].includes(item.source));
  const final = [...records].reverse().find(item => ["Time Out", "Logout"].includes(item.source));
  const unfinished = calculated.hasOpenSession || calculated.breakSessions.some(item => item.open) || calculated.lunchSessions.some(item => item.open);
  const review = mismatch || (attendanceAccuracyFixesEnabled() && Boolean(policy.closingBoundaries?.length)) || projection.issues.length > 0 || unfinished || Boolean(records.length && !first) ||
    records.some(item => item.timeIn > now) || calculated.breakSessions.length > 2 || calculated.lunchSessions.length > 1 || Boolean(first && now < policy.shiftEnd);
  const completed = now >= policy.shiftEnd;
  const status = review ? "Needs Review" : first ? weekend ? "Overtime" : calculated.lateMinutes ? "Late" : "Present"
    : weekend ? "Weekend" : completed ? "Absent" : "Scheduled";
  const components = deductionComponents({ ...calculated, absenceMinutes: status === "Absent" ? Math.round(paidHours * 60) : 0 },
    review || weekend || status === "Scheduled");
  const activity = accountTime(recordsWithClosingBoundaries(records, policy.closingBoundaries).flatMap(item => {
    const bucket = bucketForAttendanceSource(item.source as AttendanceSource);
    return bucket ? [{ at: item.timeIn, bucket }] : [];
  }), weekend && first ? first.timeIn : policy.shiftStart, weekend && final && !unfinished ? final.timeIn : policy.shiftEnd, now);
  const grossHours = (activity.milliseconds.online + activity.milliseconds.break + activity.milliseconds.lunch + activity.milliseconds.offPhone) / 3_600_000;
  const overtimeNonBillableMinutes = weekend && first ? nonBillableOffPhoneIntervals(records, first.timeIn, final?.timeIn || now, now)
    .reduce((sum, interval) => sum + interval.minutes, 0) : 0;
  return { status, review, calculated, components, grossHours, lunchHours: activity.milliseconds.lunch / 3_600_000,
    regularHours: weekend || status === "Scheduled" || review ? 0 : Math.max(0, paidHours - components.deductibleMinutes / 60),
    overtimeHours: weekend && !review ? Math.max(0, grossHours - activity.milliseconds.lunch / 3_600_000 - overtimeNonBillableMinutes / 60) : 0,
    missingHours: components.deductibleMinutes / 60 };
}
