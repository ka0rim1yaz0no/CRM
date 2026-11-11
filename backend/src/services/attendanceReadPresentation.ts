import { groupAttendanceByShiftDay, attendanceDashboardPresentation } from "./attendanceDashboardPresentation";
import { hubDayKey, hubShiftBounds, type HubSettings } from "./attendanceHubMath";
import type { projectAttendance } from "./attendanceSessionState";

type Policy = { shiftStart: string; shiftEnd: string; graceMinutes: number; breakMinutes: number; lunchMinutes: number };

export function attendanceChangedDays(projection: ReturnType<typeof projectAttendance>, policy: Policy, since: Date, now: Date) {
  const settings: HubSettings = { officialShiftStartTime: policy.shiftStart, officialShiftEndTime: policy.shiftEnd,
    lateGraceMinutes: policy.graceMinutes, breakMinutes: policy.breakMinutes, lunchMinutes: policy.lunchMinutes, attendanceTimeZone: "Asia/Manila" };
  const grouped = groupAttendanceByShiftDay({ records: projection.effectiveEvents, sessions: projection.sessions }, settings);
  const changedDayKeys = [...grouped.keys()].filter(key => hubShiftBounds(key, settings).end.getTime() >= since.getTime());
  const ids = new Set(changedDayKeys.flatMap(key => grouped.get(key)!.map(event => event.id)));
  const presentation = attendanceDashboardPresentation({ records: projection.effectiveEvents.filter(event => ids.has(event.id)),
    sessions: projection.sessions }, policy, now);
  return { ...presentation, changedDayKeys, currentShiftDay: hubDayKey(now, settings) };
}
