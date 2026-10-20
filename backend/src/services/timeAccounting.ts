import type { AttendanceSource } from "../models/Attendance";

export type TimeBucket = "online" | "break" | "lunch" | "offPhone" | "offline";
export type TimeEvent = { at: Date; bucket: TimeBucket };
export const breakAllowanceMs = 15 * 60_000;
export const lunchAllowanceMs = 60 * 60_000;

export type SlotAttendancePolicy = { breakMinutes: number; lunchMinutes: number; graceMinutes: number; shiftStart: Date; shiftEnd: Date };
export function calculateSlotAttendance(records: Array<{ source: string; timeIn: Date }>, policy: SlotAttendancePolicy, now: Date) {
  const ordered = records.map((record, index) => ({ ...record, index }))
    .filter((record) => Number.isFinite(record.timeIn.getTime()))
    .sort((a, b) => a.timeIn.getTime() - b.timeIn.getTime() || a.index - b.index);
  const asOf = new Date(Math.min(now.getTime(), policy.shiftEnd.getTime()));
  const intervals = (out: string, back: string, allowance: number) => clickedSessionIntervals(ordered, out, back, asOf)
    .map((interval) => {
      const minutes = Math.round(interval.milliseconds / 60_000);
      return { ...interval, minutes, excessMinutes: interval.open ? 0 : Math.max(0, minutes - allowance),
        overdueMs: Math.max(0, interval.milliseconds - allowance * 60_000) };
    });
  const breakSessions = intervals("Break Out", "Break In", policy.breakMinutes);
  const lunchSessions = intervals("Lunch Break Out", "Lunch Break In", policy.lunchMinutes);
  const first = ordered.find((record) => record.source === "Time In" || record.source === "Login");
  const final = ordered.at(-1);
  const hasOpenSession = Boolean(first && final && final.source !== "Time Out" && final.source !== "Logout");
  const timeOut = !hasOpenSession ? [...ordered].reverse().find((record) => record.source === "Time Out" || record.source === "Logout") : undefined;
  // Lateness keeps the existing minute-boundary grace rule; rounding applies to clicked rest durations.
  const lateMinutes = first ? Math.max(0, Math.floor((first.timeIn.getTime() - policy.shiftStart.getTime()) / 60_000) - policy.graceMinutes) : 0;
  const earlyTimeOutMinutes = first && timeOut && now >= policy.shiftEnd
    ? Math.max(0, Math.ceil((policy.shiftEnd.getTime() - timeOut.timeIn.getTime()) / 60_000)) : 0;
  const excessBreakMinutes = breakSessions.reduce((total, interval) => total + interval.excessMinutes, 0);
  const excessLunchMinutes = lunchSessions.reduce((total, interval) => total + interval.excessMinutes, 0);
  const issues: string[] = [];
  if (lateMinutes) issues.push("LATE");
  if (excessBreakMinutes) issues.push("OVER BREAK");
  if (excessLunchMinutes) issues.push("OVER LUNCH");
  if (earlyTimeOutMinutes) issues.push("UNDER TIME");
  if (hasOpenSession) issues.push("OPEN SESSION");
  return { breakSessions, lunchSessions, lateMinutes, excessBreakMinutes, excessLunchMinutes, earlyTimeOutMinutes,
    deductibleMinutes: lateMinutes + excessBreakMinutes + excessLunchMinutes + earlyTimeOutMinutes, hasOpenSession, issues };
}

export function clickedSessionIntervals<T extends { source: string; timeIn: Date }>(records: T[], outSource: string, inSource: string, asOf?: Date) {
  let open: Date | null = null;
  const intervals: Array<{ start: Date; end: Date; milliseconds: number; open: boolean }> = [];
  for (const record of records) {
    if (open && ["Time In", "Login", "Time Out", "Logout"].includes(record.source)) {
      if (asOf) {
        const end = new Date(Math.min(record.timeIn.getTime(), asOf.getTime()));
        intervals.push({ start: open, end, milliseconds: Math.max(0, end.getTime() - open.getTime()), open: true });
      }
      open = null;
    }
    if (record.source === outSource && !open) open = record.timeIn;
    if (record.source === inSource && open) {
      intervals.push({ start: open, end: record.timeIn, milliseconds: Math.max(0, record.timeIn.getTime() - open.getTime()), open: false });
      open = null;
    }
  }
  if (open && asOf) intervals.push({ start: open, end: asOf, milliseconds: Math.max(0, asOf.getTime() - open.getTime()), open: true });
  return intervals;
}
// Preserve the existing payroll rule: round each completed clicked interval to minutes first.
export function excessClickedSessionMinutes<T extends { source: string; timeIn: Date }>(records: T[], outSource: string, inSource: string, allowanceMinutes: number) {
  return clickedSessionIntervals(records, outSource, inSource).reduce((total, interval) => total + (interval.open ? 0 : Math.max(0, Math.round(interval.milliseconds / 60_000) - allowanceMinutes)), 0);
}
export function excessClickedSessionMilliseconds<T extends { source: string; timeIn: Date }>(records: T[], outSource: string, inSource: string, allowanceMs: number, asOf: Date) {
  return clickedSessionIntervals(records, outSource, inSource, asOf).reduce((total, interval) => total + Math.max(0, interval.milliseconds - allowanceMs), 0);
}

export function bucketForAttendanceSource(source: AttendanceSource): TimeBucket | null {
  if (source === "Login" || source === "Time In" || source === "Break In" ||
    source === "Lunch Break In" || source === "Off the Phone In") return "online";
  if (source === "Logout" || source === "Time Out") return "offline";
  if (source === "Break Out") return "break";
  if (source === "Lunch Break Out") return "lunch";
  if (source === "Off the Phone Out") return "offPhone";
  return null;
}

// Events are server-timestamped; intervals are clipped to [shiftStart, min(now, shiftEnd)].
// A missing return event leaves the current bucket open, never converts it to online.
export function accountTime(events: TimeEvent[], shiftStart: Date, shiftEnd: Date, now: Date) {
  const start = shiftStart.getTime();
  const end = Math.max(start, Math.min(now.getTime(), shiftEnd.getTime()));
  const milliseconds: Record<TimeBucket, number> = { online: 0, break: 0, lunch: 0, offPhone: 0, offline: 0 };
  const intervals: Array<{ bucket: TimeBucket; start: Date; end: Date }> = [];
  const addInterval = (bucket: TimeBucket, from: number, to: number) => {
    milliseconds[bucket] += Math.max(0, to - from);
    if (to > from) intervals.push({ bucket, start: new Date(from), end: new Date(to) });
  };
  const sorted = events.filter((event) => Number.isFinite(event.at.getTime()))
    .map((event, index) => ({ ...event, index }))
    .sort((a, b) => a.at.getTime() - b.at.getTime() || a.index - b.index);
  let bucket: TimeBucket = "offline";
  let stateSince = start;
  let cursor = start;
  for (const event of sorted) {
    const time = event.at.getTime();
    if (time > end) break;
    if (time < start) {
      bucket = event.bucket;
      stateSince = start;
      continue;
    }
    addInterval(bucket, cursor, time);
    if (event.bucket !== bucket) stateSince = time;
    bucket = event.bucket;
    cursor = time;
  }
  addInterval(bucket, cursor, end);
  const elapsedInStateMs = Math.max(0, end - stateSince);
  return {
    milliseconds,
    intervals,
    state: bucket,
    stateSince: new Date(stateSince),
    elapsedInStateMs,
    remainingBreakMs: bucket === "break" ? Math.max(0, breakAllowanceMs - elapsedInStateMs) : null,
    remainingLunchMs: bucket === "lunch" ? Math.max(0, lunchAllowanceMs - elapsedInStateMs) : null,
    overdue: (bucket === "break" && elapsedInStateMs > breakAllowanceMs) ||
      (bucket === "lunch" && elapsedInStateMs > lunchAllowanceMs),
  };
}
