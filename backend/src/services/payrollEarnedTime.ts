import { accountTime, bucketForAttendanceSource, calculateSlotAttendance, recordsWithClosingBoundaries, type SlotAttendancePolicy } from "./timeAccounting";
import type { AttendanceSource } from "../models/Attendance";

export function earnedPayrollTime(records: Array<{ source: string; timeIn: Date }>, policy: SlotAttendancePolicy, now: Date, paidHours: number, allDeductions = false, excludeUndertimeAbsence = false) {
    const activity = accountTime(recordsWithClosingBoundaries(records, policy.closingBoundaries).flatMap(record => {
        const bucket = bucketForAttendanceSource(record.source as AttendanceSource);
        return bucket ? [{ at: record.timeIn, bucket }] : [];
    }), policy.shiftStart, policy.shiftEnd, now);
    const attendance = calculateSlotAttendance(records, policy, now);
    const presentMs = activity.milliseconds.online + activity.milliseconds.break + activity.milliseconds.lunch + activity.milliseconds.offPhone;
    const unpaidLunchMs = Math.min(activity.milliseconds.lunch, policy.lunchMinutes * 60_000);
    const grossHours = Math.min(paidHours, Math.max(0, presentMs - unpaidLunchMs) / 3_600_000);
    const excess = (rows: typeof attendance.breakSessions, allowance: number) => rows.reduce((sum, row) => sum +
        (row.open ? Math.ceil(Math.max(0, row.milliseconds - allowance * 60_000) / 60_000) : row.excessMinutes), 0);
    const excessBreakMinutes = excess(attendance.breakSessions, policy.breakMinutes);
    const excessLunchMinutes = excess(attendance.lunchSessions, policy.lunchMinutes);
    const nonBillableOffPhoneMinutes = attendance.nonBillableOffPhoneMinutes;
    const restMinutes = excessBreakMinutes + excessLunchMinutes + nonBillableOffPhoneMinutes;
    const lateMinutes = allDeductions ? attendance.lateMinutes : 0;
    const earlyTimeOutMinutes = allDeductions ? attendance.earlyTimeOutMinutes : 0;
    const absenceMinutes = allDeductions && !records.length && now >= policy.shiftEnd ? Math.round(paidHours * 60) : 0;
    const deductibleMinutes = restMinutes + lateMinutes + (excludeUndertimeAbsence ? 0 : earlyTimeOutMinutes + absenceMinutes);
    return { grossHours, workedHours: Math.max(0, grossHours - restMinutes / 60),
        excessBreakMinutes, excessLunchMinutes, nonBillableOffPhoneMinutes, lateMinutes, earlyTimeOutMinutes, absenceMinutes, deductibleMinutes };
}
