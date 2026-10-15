import type { AttendanceSource } from "../models/Attendance";

export type TimeBucket = "online" | "break" | "lunch" | "offPhone" | "offline";
export type TimeEvent = { at: Date; bucket: TimeBucket };
export const breakAllowanceMs = 15 * 60_000;
export const lunchAllowanceMs = 60 * 60_000;

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
    milliseconds[bucket] += Math.max(0, time - cursor);
    if (event.bucket !== bucket) stateSince = time;
    bucket = event.bucket;
    cursor = time;
  }
  milliseconds[bucket] += Math.max(0, end - cursor);
  const elapsedInStateMs = Math.max(0, end - stateSince);
  return {
    milliseconds,
    state: bucket,
    stateSince: new Date(stateSince),
    elapsedInStateMs,
    remainingBreakMs: bucket === "break" ? Math.max(0, breakAllowanceMs - elapsedInStateMs) : null,
    remainingLunchMs: bucket === "lunch" ? Math.max(0, lunchAllowanceMs - elapsedInStateMs) : null,
    overdue: (bucket === "break" && elapsedInStateMs > breakAllowanceMs) ||
      (bucket === "lunch" && elapsedInStateMs > lunchAllowanceMs),
  };
}
