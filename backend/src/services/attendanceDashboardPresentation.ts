import type { AssignedShift, SessionEvent } from "./attendanceSessionState";
import { calculateHubDay, hubDayKey, type HubSettings } from "./attendanceHubMath";
import { clickedSessionIntervals, excessClickedSessionMilliseconds } from "./timeAccounting";

type Policy = { shiftStart: string; shiftEnd: string; graceMinutes: number; breakMinutes: number; lunchMinutes: number };

export function attendanceDashboardPresentation(snapshot: { records: SessionEvent[];
  sessions: Array<{ shift: AssignedShift | null; events: SessionEvent[] }> }, policy: Policy, now: Date) {
  const settings: HubSettings = { officialShiftStartTime: policy.shiftStart, officialShiftEndTime: policy.shiftEnd,
    lateGraceMinutes: policy.graceMinutes, breakMinutes: policy.breakMinutes, lunchMinutes: policy.lunchMinutes, attendanceTimeZone: "Asia/Manila" };
  const assigned = new Map(snapshot.sessions.flatMap((session) => session.events.map((event) => [event.id, session.shift?.dayKey] as const)));
  const grouped = new Map<string, SessionEvent[]>();
  for (const event of snapshot.records) {
    const day = assigned.get(event.id) || hubDayKey(new Date(event.at), settings);
    const events = grouped.get(day) || [];
    events.push(event);
    grouped.set(day, events);
  }
  const dashboardDays = [...grouped].map(([dayKey, events]) => {
    const day = calculateHubDay(dayKey, events.map((event) => ({ ...event, at: new Date(event.at) })), settings, now);
    const records = [...events].sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || a.sequence - b.sequence);
    const clicked = records.map((event) => ({ source: event.source, timeIn: new Date(event.at) }));
    const asOf = new Date(Math.min(now.getTime(), Date.parse(day.shiftEnd)));
    const overBreakRows = ([
      ["Break Out", "Break In", "Break", policy.breakMinutes],
      ["Lunch Break Out", "Lunch Break In", "Lunch Break", policy.lunchMinutes],
    ] as const).flatMap(([out, back, label, minutes]) => clickedSessionIntervals(clicked, out, back, asOf).flatMap((interval) => {
      const pair = [{ source: out, timeIn: interval.start }, { source: back, timeIn: interval.end }];
      const overMs = excessClickedSessionMilliseconds(pair, out, back, minutes * 60_000, asOf);
      if (!overMs) return [];
      return [{ id: records.find((event) => event.source === out && event.at === interval.start.toISOString())?.id || `${dayKey}:${out}:${interval.start.toISOString()}`,
        label, startedAt: interval.start.toISOString(), endedAt: interval.open ? null : interval.end.toISOString(),
        durationMs: interval.milliseconds, allowedMs: minutes * 60_000, overMs, isOpen: interval.open }];
    }));
    return { dayKey, shiftStart: day.shiftStart, shiftEnd: day.shiftEnd, eventIds: records.map((event) => event.id),
      timeIn: day.timeIn, timeOut: day.timeOut, milliseconds: day.milliseconds, overBreakRows,
      breakMinutes: day.breakMinutes, lunchMinutes: day.lunchMinutes };
  }).sort((a, b) => a.dayKey.localeCompare(b.dayKey));
  return { dashboardDays, currentShiftDay: hubDayKey(now, settings) };
}
