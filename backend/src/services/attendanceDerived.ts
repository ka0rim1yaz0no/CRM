import type { AttendanceStatus } from "../models/Attendance";
import { assignAttendanceShift } from "./attendanceShift";
import { projectAttendance, type AttendanceSession, type SessionCorrection, type SessionEvent, type SystemClosure } from "./attendanceSessionState";
import { calculateSlotAttendance, deductionComponents } from "./timeAccounting";
import { attendanceAccuracyFixesEnabled } from "../config/rolloutFlags";

export type AttendanceDerivedPolicy = {
  breakMinutes: number; lunchMinutes: number; graceMinutes: number;
  shiftStart: string; shiftEnd: string; recoveryTime?: string; revision?: number;
};
export type AttendanceDerivedLedger = {
  events: SessionEvent[]; corrections?: SessionCorrection[]; closures?: SystemClosure[]; revision?: number;
};
export type AttendanceDerivedDay = ReturnType<typeof calculateSlotAttendance> & {
  dayKey: string; shiftStart: string; shiftEnd: string; sessionIds: string[]; eventIds: string[];
  status: AttendanceStatus; computedAt: string; revision?: number; policyRevision?: number;
  accuracyVersion?: 1;
};

export function attendanceDerivedDaysDueForRefresh(ledger: AttendanceDerivedLedger & { derived?: AttendanceDerivedDay[]; migrationRequired?: boolean }, now: Date) {
  if (ledger.migrationRequired || !ledger.derived?.length) return [];
  const projection = projectAttendance(ledger.events, ledger.corrections, ledger.closures);
  if (projection.blockingIssues.length) return [];
  return ledger.derived.filter((day) => {
    if (attendanceAccuracyFixesEnabled() && day.accuracyVersion !== 1) return false;
    const end = Date.parse(day.shiftEnd); const computed = Date.parse(day.computedAt);
    if (day.hasOpenSession || !Number.isFinite(end) || !Number.isFinite(computed) || computed >= end || end > now.getTime()) return false;
    const sessions = projection.sessions.filter((session) => day.sessionIds.includes(session.id));
    return sessions.length > 0 && sessions.every((session) => session.lifecycle !== "open") &&
      !projection.sessions.some((session) => session.lifecycle === "open" && session.shift?.dayKey === day.dayKey);
  });
}

// One canonical day per assigned shift, never a sum of the copies in each business.
export function deriveAttendanceDays(ledger: AttendanceDerivedLedger, policy: AttendanceDerivedPolicy, now: Date): AttendanceDerivedDay[] {
  const projection = projectAttendance(ledger.events, ledger.corrections, ledger.closures, { allowUnreturnedCheckout: attendanceAccuracyFixesEnabled() });
  const groups = new Map<string, { shift: NonNullable<AttendanceSession["shift"]>; sessions: AttendanceSession[] }>();
  for (const session of projection.sessions) {
    const shift = session.shift || assignAttendanceShift(new Date(session.startedAt), policy.shiftStart, policy.shiftEnd, policy.recoveryTime);
    const group = groups.get(shift.dayKey) || { shift, sessions: [] };
    group.sessions.push(session);
    groups.set(shift.dayKey, group);
  }
  return [...groups].sort(([a], [b]) => a.localeCompare(b)).map(([dayKey, { shift, sessions }]) => {
    const slotPolicy = { ...policy, shiftStart: new Date(shift.start), shiftEnd: new Date(shift.end) };
    const events = sessions.flatMap((session) => session.events);
    const sessionRecords = (session: AttendanceSession) => session.events.map(event => ({ source: event.source as string, timeIn: new Date(event.at) }));
    const closingBoundaries = sessions.filter(session => session.lifecycle === "system-closed" && session.endedAt).map(session => new Date(session.endedAt!));
    const records = sessions.flatMap(sessionRecords);
    const summary = calculateSlotAttendance(records, { ...slotPolicy, closingBoundaries }, now);
    // Never pair a missing return in an earlier session with a later session's return.
    const perSession = sessions.map((session) => calculateSlotAttendance(
      sessionRecords(session), { ...slotPolicy, closingBoundaries: session.lifecycle === "system-closed" && session.endedAt ? [new Date(session.endedAt)] : [] },
      new Date(Math.min(now.getTime(), session.endedAt ? Date.parse(session.endedAt) : now.getTime())),
    ));
    const breakSessions = perSession.flatMap((item) => item.breakSessions);
    const lunchSessions = perSession.flatMap((item) => item.lunchSessions);
    const nonBillableOffPhoneSessions = perSession.flatMap(item => item.nonBillableOffPhoneSessions);
    const nonBillableOffPhoneMinutes = nonBillableOffPhoneSessions.reduce((total, item) => total + item.minutes, 0);
    const excessBreakMinutes = breakSessions.reduce((total, item) => total + item.excessMinutes, 0);
    const excessLunchMinutes = lunchSessions.reduce((total, item) => total + item.excessMinutes, 0);
    const hasOpenSession = sessions.some((session) => session.lifecycle === "open");
    const issues: string[] = [];
    if (summary.lateMinutes) issues.push("LATE");
    if (excessBreakMinutes) issues.push("OVER BREAK");
    if (excessLunchMinutes) issues.push("OVER LUNCH");
    if (summary.earlyTimeOutMinutes) issues.push("UNDER TIME");
    if (nonBillableOffPhoneMinutes) issues.push("NON-BILLABLE OFF PHONE");
    if (hasOpenSession) issues.push("OPEN SESSION");
    if (attendanceAccuracyFixesEnabled()) {
      if (breakSessions.some(item => item.notReturned)) issues.push("BREAK NOT RETURNED");
      if (lunchSessions.some(item => item.notReturned)) issues.push("LUNCH NOT RETURNED");
    }
    if (sessions.some((session) => session.lifecycle === "system-closed")) issues.push("SYSTEM CLOSED");
    if (projection.issues.some((issue) => events.some((event) => event.id === issue.eventId))) issues.push("TIMELINE REVIEW");
    return { ...summary, breakSessions, lunchSessions, nonBillableOffPhoneSessions, nonBillableOffPhoneMinutes, excessBreakMinutes, excessLunchMinutes, hasOpenSession, issues,
      deductibleMinutes: deductionComponents({ ...summary, excessBreakMinutes, excessLunchMinutes, nonBillableOffPhoneMinutes }).deductibleMinutes,
      dayKey, shiftStart: shift.start, shiftEnd: shift.end, sessionIds: sessions.map((session) => session.id),
      eventIds: [...new Set(events.map((event) => event.id))],
      status: summary.lateMinutes ? "Late" : summary.earlyTimeOutMinutes ? "Undertime" : "On time",
      computedAt: now.toISOString(), ...(ledger.revision === undefined ? {} : { revision: ledger.revision }),
      ...(attendanceAccuracyFixesEnabled() ? { accuracyVersion: 1 as const } : {}),
      ...(policy.revision === undefined ? {} : { policyRevision: policy.revision }),
    };
  });
}
