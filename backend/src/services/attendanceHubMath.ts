import { attendanceSlotKey } from "./attendanceShift";
import type { AttendanceSource } from "../models/Attendance";
import { accountTime, breakAllowanceMs, bucketForAttendanceSource, lunchAllowanceMs, excessClickedSessionMilliseconds } from "./timeAccounting";
import { projectAttendance } from "./attendanceSessionState";

export type HubEvent = { id: string; source: AttendanceSource; at: Date; eventId?: string; createdAt?: Date; sequence?: number };
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

export function calculateHubDay(dayKey: string, sourceEvents: HubEvent[], settings: HubSettings, now: Date, excused = false) {
  const breakLimit = settings.breakMinutes === undefined ? breakAllowanceMs : settings.breakMinutes * 60_000;
  const lunchLimit = settings.lunchMinutes === undefined ? lunchAllowanceMs : settings.lunchMinutes * 60_000;
  const { start, end } = hubShiftBounds(dayKey, settings);
  const events = [...sourceEvents].filter((event) => Number.isFinite(event.at.getTime()))
    // One manual command may emit several events at the same millisecond.
    .sort((a, b) => a.at.getTime() - b.at.getTime()
      || (a.sequence !== undefined && b.sequence !== undefined ? a.sequence - b.sequence : 0)
      || a.id.localeCompare(b.id));
  const buckets = accountTime(events.flatMap((event) => {
    const bucket = bucketForAttendanceSource(event.source);
    return bucket ? [{ at: event.at, bucket }] : [];
  }), start, end, now);
  const timeIn = events.find((event) => event.source === "Time In" || event.source === "Login");
  const timeOut = [...events].reverse().find((event) => event.source === "Time Out" || event.source === "Logout");
  const projection = projectAttendance(events.map((event, index) => ({ id: event.id, source: event.source, at: event.at.toISOString(), sequence: event.sequence ?? index, commandId: event.eventId || event.id, recordedAt: event.at.toISOString() })));
  const hasOpenSession = Boolean(projection.active);
  const isInProgress = hasOpenSession && now < end;
  const rawLateMs = timeIn ? Math.max(0, timeIn.at.getTime() - start.getTime() - Math.max(0, settings.lateGraceMinutes) * 60_000) : 0;
  const lateMs = rawLateMs >= 60_000 ? rawLateMs : 0;
  const underTimeMs = timeOut && timeIn && !hasOpenSession && now >= end
    ? Math.max(0, end.getTime() - timeOut.at.getTime()) : 0;
  const overtime = timeOut && timeIn && timeOut.at > end && !hasOpenSession
    ? accountTime(events.flatMap((event) => {
      const bucket = bucketForAttendanceSource(event.source);
      return bucket ? [{ at: event.at, bucket }] : [];
    }), end, timeOut.at, timeOut.at).milliseconds.online : 0;

  const clickedRecords = events.map((event) => ({ source: event.source, timeIn: event.at }));
  const asOf = new Date(Math.min(now.getTime(), end.getTime()));
  const breakOverMs = excessClickedSessionMilliseconds(clickedRecords, "Break Out", "Break In", breakLimit, asOf);
  const lunchOverMs = excessClickedSessionMilliseconds(clickedRecords, "Lunch Break Out", "Lunch Break In", lunchLimit, asOf);
  const review: string[] = projection.issues.map((issue) => issue.message);
  const active: { break?: Date; lunch?: Date; offPhone?: Date } = {};
  let lunchAttempts = 0;
  let lastSource = "";
  for (const event of events) {
    if (event.source === "Time In" || event.source === "Login") { lunchAttempts = 0; }
    if (event.source === lastSource) review.push(`Duplicate ${event.source}`);
    lastSource = event.source;
    if (event.at < start || event.at > end) review.push("Event outside shift");
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
    } else if (event.source === "Off the Phone Out") {
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
  if (lateMs >= 60_000) issues.push("LATE");
  if (breakOverMs > 0) issues.push("OVER BREAK");
  if (lunchOverMs > 0) issues.push("OVER LUNCH");
  if (underTimeMs > 0) issues.push("UNDER TIME");
  if (hasOpenSession) issues.push("OPEN SESSION");
  if (excused) issues.push("EXCUSED");
  return {
    dayKey, shiftStart: start.toISOString(), shiftEnd: end.toISOString(),
    breakMinutes: breakLimit / 60_000, lunchMinutes: lunchLimit / 60_000,
    timeline: buckets.intervals.map((interval) => ({ bucket: interval.bucket, start: interval.start.toISOString(), end: interval.end.toISOString() })),
    timeIn: timeIn?.at.toISOString() || null, timeOut: hasOpenSession ? null : timeOut?.at.toISOString() || null,
    inProgress: isInProgress, excused, issues: excused ? issues.filter((issue) => issue === "EXCUSED" || issue === "OPEN SESSION") : issues,
    review: Array.from(new Set(review)),
    milliseconds: { ...buckets.milliseconds, late: excused ? 0 : lateMs, underTime: excused ? 0 : underTimeMs,
      overBreak: excused ? 0 : breakOverMs, overLunch: excused ? 0 : lunchOverMs, overtime },
    status: events.length ? (isInProgress ? "In progress" : hasOpenSession || !timeIn ? "Needs review" : "Present") : "No record",
    events: events.map((event) => ({ id: event.id, source: event.source, at: event.at.toISOString(), eventId: event.eventId || null })),
  };
}
