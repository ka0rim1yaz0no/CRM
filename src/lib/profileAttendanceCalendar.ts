import type { AttendanceSessionSnapshot } from "../api/attendanceSession";
import type { EmployeeAttendanceCalendarStatus } from "../api/employeeProfileAttendance";

export function profileAttendanceAbsent(snapshot: AttendanceSessionSnapshot, dayKey: string, calendar?: EmployeeAttendanceCalendarStatus) {
    if (!calendar || !dayKey.startsWith(`${calendar.month}-`)) return false;
    const day = snapshot.dashboardDays?.find(item => item.dayKey === dayKey);
    if (day?.timeIn || day?.eventIds.length || snapshot.records.some(event => event.shiftDayKey === dayKey)) return false;
    const status = calendar.days.find(item => item.dayKey === dayKey);
    return Boolean(status?.absent && !status.excused && status.attendanceRevision === snapshot.revision &&
        Date.parse(status.shiftEnd) <= Date.parse(calendar.serverTime));
}

export function attendanceCalendarCells(month: string): Array<string | null> {
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month) || Number(month.slice(0, 4)) < 1900) throw new Error("Invalid calendar month.");
    const first = new Date(`${month}-01T00:00:00Z`), length = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
    return Array.from({ length: 42 }, (_, index) => {
        const day = index - first.getUTCDay() + 1;
        return day < 1 || day > length ? null : `${month}-${String(day).padStart(2, "0")}`;
    });
}

export function moveAttendanceCalendarMonth(month: string, delta: number) {
    attendanceCalendarCells(month);
    const date = new Date(`${month}-01T00:00:00Z`);
    date.setUTCMonth(date.getUTCMonth() + delta);
    const next = date.toISOString().slice(0, 7);
    return date.getUTCFullYear() < 1900 || date.getUTCFullYear() > 9999 ? month : next;
}

export function profileAttendanceDay(snapshot: AttendanceSessionSnapshot, dayKey: string) {
    const day = snapshot.dashboardDays?.find(item => item.dayKey === dayKey);
    if (!day) return null;
    const ids = new Set(day.eventIds);
    const events = snapshot.records.filter(event => ids.has(event.id)).sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || a.sequence - b.sequence);
    const sessions = snapshot.sessions.filter(session => session.shift?.dayKey === dayKey).sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt) || a.id.localeCompare(b.id));
    const open = sessions.at(-1)?.lifecycle === "open";
    const review = !day.timeIn || sessions.some(session => session.lifecycle === "system-closed" || session.lifecycle === "open" &&
        (session.id !== snapshot.sessionId || dayKey !== snapshot.currentShiftDay));
    const status = review ? "Needs review" : open ? "In progress" : (day.milliseconds.underTime || 0) > 0 ? "Undertime"
        : (day.milliseconds.late || 0) > 0 ? "Late" : day.timeOut ? "Completed" : "Recorded";
    return { ...day, events, status, timeOut: open ? null : day.timeOut };
}
