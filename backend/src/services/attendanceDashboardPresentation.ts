import type { AssignedShift, SessionEvent } from "./attendanceSessionState";
import { calculateHubDay, hubDayKey, type HubSettings } from "./attendanceHubMath";
import { clickedSessionIntervals, excessClickedSessionMilliseconds, calculateSlotAttendance, recordsWithClosingBoundaries } from "./timeAccounting";
import { attendanceDurationModelEnabled, attendanceAccuracyFixesEnabled } from "../config/rolloutFlags";

type Policy = { shiftStart: string; shiftEnd: string; graceMinutes: number; breakMinutes: number; lunchMinutes: number };

type AttendanceReadSnapshot = { records: SessionEvent[];
  sessions: Array<{ shift: AssignedShift | null; events: SessionEvent[]; lifecycle?: string; endedAt?: string | null }> };

export function groupAttendanceByShiftDay(snapshot: AttendanceReadSnapshot, settings: HubSettings) {
  const assigned = new Map(snapshot.sessions.flatMap((session) => session.events.map((event) => [event.id, session.shift?.dayKey] as const)));
  const grouped = new Map<string, SessionEvent[]>();
  for (const event of snapshot.records) {
    const day = assigned.get(event.id) || hubDayKey(new Date(event.at), settings);
    const events = grouped.get(day) || [];
    events.push(event);
    grouped.set(day, events);
  }
  return grouped;
}

export function attendanceDashboardPresentation(snapshot: AttendanceReadSnapshot, policy: Policy, now: Date) {
  const settings: HubSettings = { officialShiftStartTime: policy.shiftStart, officialShiftEndTime: policy.shiftEnd,
    lateGraceMinutes: policy.graceMinutes, breakMinutes: policy.breakMinutes, lunchMinutes: policy.lunchMinutes, attendanceTimeZone: "Asia/Manila" };
  const grouped = groupAttendanceByShiftDay(snapshot, settings);
  const dashboardDays = [...grouped].map(([dayKey, events]) => {
    const closingBoundaries = snapshot.sessions.filter(session => session.shift?.dayKey === dayKey && session.lifecycle === "system-closed" && session.endedAt).map(session => new Date(session.endedAt!));
    const day = calculateHubDay(dayKey, events.map((event) => ({ ...event, at: new Date(event.at) })), settings, now, false, closingBoundaries);
    const records = [...events].sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || a.sequence - b.sequence);
    const clicked = recordsWithClosingBoundaries(records.map((event) => ({ source: event.source, timeIn: new Date(event.at) })), closingBoundaries);
    const asOf = new Date(Math.min(now.getTime(), Date.parse(day.shiftEnd)));
    const calculated = calculateSlotAttendance(clicked, { ...policy, shiftStart: new Date(day.shiftStart), shiftEnd: new Date(day.shiftEnd) }, now);
    const overBreakRows = ([
      ["Break Out", "Break In", "Break", policy.breakMinutes],
      ["Lunch Break Out", "Lunch Break In", "Lunch Break", policy.lunchMinutes],
    ] as const).flatMap(([out, back, label, minutes]) => clickedSessionIntervals(clicked, out, back, asOf).flatMap((interval) => {
      const pair = [{ source: out, timeIn: interval.start }, { source: back, timeIn: interval.end }];
      const session = (out === "Break Out" ? calculated.breakSessions : calculated.lunchSessions).find((item) => item.start.getTime() === interval.start.getTime());
      const overMs = attendanceDurationModelEnabled() || attendanceAccuracyFixesEnabled() ? (session?.excessMinutes || 0) * 60_000 : excessClickedSessionMilliseconds(pair, out, back, minutes * 60_000, asOf);
      if (!overMs) return [];
      return [{ id: records.find((event) => event.source === out && event.at === interval.start.toISOString())?.id || `${dayKey}:${out}:${interval.start.toISOString()}`,
        label, startedAt: interval.start.toISOString(), endedAt: interval.open ? null : interval.end.toISOString(),
        durationMs: interval.milliseconds, allowedMs: minutes * 60_000, overMs, isOpen: interval.open }];
    }));
    return { dayKey, shiftStart: day.shiftStart, shiftEnd: day.shiftEnd, eventIds: records.map((event) => event.id),
      timeIn: day.timeIn, timeOut: day.timeOut, milliseconds: day.milliseconds, overBreakRows,
      ...(day.coachingMs === undefined ? {} : { coachingMs: day.coachingMs }),
      breakMinutes: day.breakMinutes, lunchMinutes: day.lunchMinutes };
  }).sort((a, b) => a.dayKey.localeCompare(b.dayKey));
  return { dashboardDays, currentShiftDay: hubDayKey(now, settings) };
}
