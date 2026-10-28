import type { AttendanceSessionSnapshot } from "../api/attendanceSession";
import { attendanceServerNow } from "./attendanceHubState";
import { ATTENDANCE_TIME_ZONE, formatAttendanceSlotKey, type AttendanceSlotSettings } from "./attendanceSlots";
import { phShiftTimeLabel } from "./dashboardCallInsights";

export function attendanceShiftReminder(snapshot: AttendanceSessionSnapshot | undefined, employeeCode: string,
    settings: AttendanceSlotSettings | undefined, localNow: number) {
    if (!snapshot || !employeeCode || !settings || snapshot.state !== "OFFLINE" || snapshot.sessionId ||
        !Number.isFinite(snapshot.receivedAt) || localNow - snapshot.receivedAt > 90_000) return null;
    const start = settings.officialShiftStartTime, end = settings.officialShiftEndTime;
    const validTime = (value: unknown): value is string => typeof value === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
    if (!validTime(start) || !validTime(end)) return null;
    const now = attendanceServerNow(snapshot.serverTime, snapshot.receivedAt, localNow);
    if (!Number.isFinite(now)) return null;
    const parts = new Intl.DateTimeFormat("en-US", { timeZone: ATTENDANCE_TIME_ZONE, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(now);
    const minutes = Number(parts.find(part => part.type === "hour")?.value) * 60 + Number(parts.find(part => part.type === "minute")?.value);
    const timeMinutes = (value: string) => Number(value.slice(0, 2)) * 60 + Number(value.slice(3));
    const first = timeMinutes(start), last = timeMinutes(end);
    if (first < last ? minutes < first || minutes >= last : first !== last && minutes < first && minutes >= last) return null;
    const dayKey = formatAttendanceSlotKey(new Date(now), { ...settings, attendanceTimeZone: ATTENDANCE_TIME_ZONE });
    const recorded = (at: string | null | undefined) => Boolean(at && Number.isFinite(Date.parse(at)) && Date.parse(at) <= now);
    // A completed shift is still clocked in; OFFLINE alone must never trigger a missing-punch alert.
    if (snapshot.sessions.some(session => session.shift?.dayKey === dayKey && recorded(session.startedAt)) ||
        snapshot.dashboardDays?.some(day => day.dayKey === dayKey && recorded(day.timeIn)) ||
        snapshot.records.some(event => event.shiftDayKey === dayKey && ["Time In", "Login"].includes(event.source) && recorded(event.at))) return null;
    return { id: `time-in:${employeeCode}:${dayKey}`, dayKey, shiftStartLabel: phShiftTimeLabel(start) };
}
