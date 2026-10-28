import { attendanceSlotKey } from "./attendanceShift";
import type { AttendanceSource } from "../models/Attendance";
import { accountTime, breakAllowanceMs, bucketForAttendanceSource, lunchAllowanceMs, excessClickedSessionMilliseconds, clickedSessionIntervals, calculateSlotAttendance, recordsWithClosingBoundaries } from "./timeAccounting";
import { attendanceDurationModelEnabled, attendanceAccuracyFixesEnabled } from "../config/rolloutFlags";
import { projectAttendance } from "./attendanceSessionState";
import { isOffPhoneStart, nonBillableOffPhoneIntervals } from "../../../shared/attendanceOffPhone";
import { offPhoneLimitPolicy } from "../config/payrollEarnings";

export type HubEvent = { id: string; source: AttendanceSource; at: Date; eventId?: string; createdAt?: Date; sequence?: number; autoTimeOut?: boolean };
export type HubSettings = { officialShiftStartTime: string; officialShiftEndTime: string; lateGraceMinutes: number; attendanceTimeZone: string; breakMinutes?: number; lunchMinutes?: number };
export const hubTimeZone = "Asia/Manila";

export function hubShiftBounds(dayKey: string, settings: HubSettings) {
  const [year, month, day] = dayKey.split("-").map(Number);
  const [startHour, startMinute] = settings.officialShiftStartTime.split(":").map(Number);
  const [endHour, endMinute] = settings.officialShiftEndTime.split(":").map(Number);
  const start = new Date(Date.UTC(year, month - 1, day, startHour - 8, startMinute));
  const overnight = endHour * 60 + endMinute <= startHour * 60 + startMinute;
  const end = new Date(Date.UTC(year, month - 1, day + Number(overnight), endHour - 8, endMinute));
  return { start, end };
}

export function hubDayKey(value: Date, settings: HubSettings) {
  return attendanceSlotKey(value, hubTimeZone, settings.officialShiftStartTime, settings.officialShiftEndTime);
}

export function calculateHubDay(dayKey: string, sourceEvents: HubEvent[], settings: HubSettings, now: Date, excused = false, closingBoundaries: Date[] = []) {
  const breakLimit = settings.breakMinutes === undefined ? breakAllowanceMs : settings.breakMinutes * 60_000;
  const lunchLimit = settings.lunchMinutes === undefined ? lunchAllowanceMs : settings.lunchMinutes * 60_000;
  const { start, end } = hubShiftBounds(dayKey, settings);
  const events = [...sourceEvents].filter((event) => Number.isFinite(event.at.getTime()))
    // One manual command may emit several events at the same millisecond.
    .sort((a, b) => a.at.getTime() - b.at.getTime()
      || (a.sequence !== undefined && b.sequence !== undefined ? a.sequence - b.sequence : 0)
      || a.id.localeCompare(b.id));
  const clickedRecords = recordsWithClosingBoundaries(events.map(event => ({ source: event.source, timeIn: event.at })), closingBoundaries);
  const calculated = attendanceDurationModelEnabled() || attendanceAccuracyFixesEnabled()
    ? calculateSlotAttendance(clickedRecords, { breakMinutes: breakLimit / 60_000, lunchMinutes: lunchLimit / 60_000,
      graceMinutes: settings.lateGraceMinutes, shiftStart: start, shiftEnd: end }, now) : null;
  const buckets = accountTime(clickedRecords.flatMap((event) => {
    const bucket = bucketForAttendanceSource(event.source as AttendanceSource);
    return bucket ? [{ at: event.timeIn, bucket }] : [];
  }), start, end, now);
  const timeIn = events.find((event) => event.source === "Time In" || event.source === "Login");
  const timeOut = [...events].reverse().find((event) => event.source === "Time Out" || event.source === "Logout");
  const projection = projectAttendance(events.map((event, index) => ({ id: event.id, source: event.source, at: event.at.toISOString(), sequence: event.sequence ?? index, commandId: event.eventId || event.id, recordedAt: event.at.toISOString() })), [], [], { allowUnreturnedCheckout: attendanceAccuracyFixesEnabled() });
  const hasOpenSession = attendanceAccuracyFixesEnabled() && calculated ? calculated.hasOpenSession : Boolean(projection.active);
  const isInProgress = hasOpenSession && now < end;
  const rawLateMs = timeIn ? Math.max(0, timeIn.at.getTime() - start.getTime() - Math.max(0, settings.lateGraceMinutes) * 60_000) : 0;
  let lateMs = rawLateMs >= 60_000 ? rawLateMs : 0;
  let underTimeMs = timeOut && timeIn && !hasOpenSession && now >= end
    ? Math.max(0, end.getTime() - timeOut.at.getTime()) : 0;
  const overtime = timeOut && timeIn && timeOut.at > end && !hasOpenSession
    ? accountTime(events.flatMap((event) => {
      const bucket = bucketForAttendanceSource(event.source);
      return bucket ? [{ at: event.at, bucket }] : [];
    }), end, timeOut.at, timeOut.at).milliseconds.online : 0;

  const asOf = new Date(Math.min(now.getTime(), end.getTime()));
  const breakSessions = clickedSessionIntervals(clickedRecords, "Break Out", "Break In", asOf).map((interval) => ({
    startedAt: interval.start.toISOString(), endedAt: interval.open ? null : interval.end.toISOString(),
    durationMs: interval.milliseconds, isOpen: interval.open,
  }));
  let breakOverMs = excessClickedSessionMilliseconds(clickedRecords, "Break Out", "Break In", breakLimit, asOf);
  let lunchOverMs = excessClickedSessionMilliseconds(clickedRecords, "Lunch Break Out", "Lunch Break In", lunchLimit, asOf);
  const accuracy = attendanceAccuracyFixesEnabled();
  if (calculated) {
    lateMs = calculated.lateMinutes * 60_000;
    underTimeMs = calculated.earlyTimeOutMinutes * 60_000;
    breakOverMs = calculated.excessBreakMinutes * 60_000;
    lunchOverMs = calculated.excessLunchMinutes * 60_000;
  }
  const review: string[] = projection.issues.map((issue) => issue.message);
  const active: { break?: Date; lunch?: Date; offPhone?: Date } = {};
  let lunchAttempts = 0;
  let lastSource = "";
  for (const event of events) {
    if (event.source === "Time Out" || event.source === "Logout") delete active.offPhone;
    if (event.source === "Time In" || event.source === "Login") { lunchAttempts = 0; }
    if (event.source === lastSource) review.push(`Duplicate ${event.source}`);
    lastSource = event.source;
    if (event.at < start || (event.at > end && !event.autoTimeOut)) review.push("Event outside shift");
    if (event.source === "Break Out") {
      if (active.break) review.push("Break Out without Break In");
      active.break = event.at;
    } else if (event.source === "Break In") {
      if (!active.break) review.push("Break In without Break Out");
      delete active.break;
    } else if (event.source === "Lunch Break Out") {
      lunchAttempts += 1;
      if (lunchAttempts > 1) review.push("Second lunch attempt");
      if (active.lunch) review.push("Lunch Out without Lunch In");
      active.lunch = event.at;
    } else if (event.source === "Lunch Break In") {
      if (!active.lunch) review.push("Lunch In without Lunch Out");
      delete active.lunch;
    } else if (isOffPhoneStart(event.source)) {
      if (active.offPhone) review.push("Off the Phone Out without In");
      active.offPhone = event.at;
    } else if (event.source === "Off the Phone In") {
      if (!active.offPhone) review.push("Off the Phone In without Out");
      delete active.offPhone;
    }
  }
  if (active.break) {
    if (now >= end) review.push("Unclosed break");
  }
  if (active.lunch) {
    if (now >= end) review.push("Unclosed lunch");
  }
  if (active.offPhone && now >= end) review.push("Unclosed Off the Phone");
  if (events.length && !timeIn) review.push("Missing Time In");
  if (hasOpenSession && now >= end) review.push("Open session");
  const issues = [] as string[];
  if (accuracy && calculated) {
    for (const [label, sessions] of [["BREAK", calculated.breakSessions], ["LUNCH", calculated.lunchSessions]] as const) {
      const unreturned = sessions.filter(item => item.notReturned);
      if (unreturned.length) issues.push(`${label} NOT RETURNED (${excused ? 0 : unreturned.reduce((sum, item) => sum + item.excessMinutes, 0)} MIN)`);
    }
  }
  if (lateMs >= 60_000) issues.push("LATE");
  if (breakOverMs > 0) issues.push("OVER BREAK");
  if (lunchOverMs > 0) issues.push("OVER LUNCH");
  if (underTimeMs > 0) issues.push("UNDER TIME");
  if (hasOpenSession) issues.push("OPEN SESSION");
  const nonBillable = nonBillableOffPhoneIntervals(clickedRecords, start, end, now, offPhoneLimitPolicy());
  const nonBillableOffPhoneMinutes = nonBillable.reduce((total, interval) => total + interval.minutes, 0);
  if (nonBillableOffPhoneMinutes && !excused) issues.push("NON-BILLABLE OFF PHONE");
  if (excused) issues.push("EXCUSED");
  return {
    dayKey, shiftStart: start.toISOString(), shiftEnd: end.toISOString(), autoTimeOut: events.some((event) => event.autoTimeOut),
    breakMinutes: breakLimit / 60_000, lunchMinutes: lunchLimit / 60_000,
    nonBillableOffPhoneMinutes: excused ? 0 : nonBillableOffPhoneMinutes,
    breakSessions: accuracy && calculated ? calculated.breakSessions.map(item => ({ startedAt: item.start.toISOString(),
      endedAt: item.open ? null : item.end.toISOString(), durationMs: item.milliseconds, isOpen: item.open,
      ...(item.notReturned ? { notReturned: true, chargedMinutes: excused ? 0 : item.excessMinutes } : {}) })) : breakSessions,
    timeline: buckets.intervals.map((interval) => ({ bucket: interval.bucket, start: interval.start.toISOString(), end: interval.end.toISOString() })),
    timeIn: timeIn?.at.toISOString() || null, timeOut: hasOpenSession ? null : timeOut?.at.toISOString() || null,
    inProgress: isInProgress, excused, issues: excused ? issues.filter((issue) => issue === "EXCUSED" || issue === "OPEN SESSION") : issues,
    review: Array.from(new Set(review)),
    milliseconds: { ...buckets.milliseconds, late: excused ? 0 : lateMs, underTime: excused ? 0 : underTimeMs,
      nonBillableOffPhone: nonBillable.reduce((total, interval) => total + interval.milliseconds, 0),
      overBreak: excused ? 0 : breakOverMs, overLunch: excused ? 0 : lunchOverMs, overtime },
    status: events.length ? (isInProgress ? "In progress" : hasOpenSession || !timeIn ? "Needs review" : "Present") : "No record",
    events: events.map((event) => ({ id: event.id, source: event.source, at: event.at.toISOString(), eventId: event.eventId || null, autoTimeOut: event.autoTimeOut || undefined })),
  };
}
