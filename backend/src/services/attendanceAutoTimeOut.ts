import type { AttendanceSession } from "./attendanceSessionState";
import { zonedDateTimeToUtc, zonedParts } from "./attendanceShift";

export function attendanceAutoTimeOutCutoff(session: AttendanceSession | null, time = "08:05"): Date | null {
  const shift = session?.shift;
  if (!session || session.lifecycle !== "open" || !shift || shift.ambiguous || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) return null;
  const start = new Date(shift.start); const end = new Date(shift.end);
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || end <= start) return null;
  const first = zonedParts(start); const last = zonedParts(end);
  const nextDay = new Date(Date.UTC(first.year, first.month - 1, first.day + 1));
  if (last.year !== nextDay.getUTCFullYear() || last.month !== nextDay.getUTCMonth() + 1 || last.day !== nextDay.getUTCDate() ||
      last.hour * 60 + last.minute > first.hour * 60 + first.minute) return null;
  const [hour, minute] = time.split(":").map(Number);
  const cutoff = zonedDateTimeToUtc(last.year, last.month, last.day, hour, minute);
  // Never backdate a checkout before the shift end or before an existing event.
  if (cutoff < end || !Number.isFinite(Date.parse(session.startedAt)) || Date.parse(session.startedAt) > cutoff.getTime() ||
      session.events.some((event) => !Number.isFinite(Date.parse(event.at)) || Date.parse(event.at) > cutoff.getTime())) return null;
  return cutoff;
}
