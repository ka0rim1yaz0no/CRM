import { api } from "../lib/api";
import { getAuthUser } from "./authStorage";
import { getActiveBusinessId } from "./businessStorage";
import type { AttendanceSessionSnapshot } from "./attendanceSession";

export type EmployeeAttendanceCalendarStatus = {
    month: string; serverTime: string;
    days: Array<{ dayKey: string; shiftEnd: string; absent: boolean; excused: boolean; attendanceRevision: number }>;
};

async function ownAttendanceRead<T>(employeeId: string, businessId: string, route: string, signal?: AbortSignal) {
    const auth = getAuthUser();
    if (auth?.userType !== "employee" || auth.user._id !== employeeId || !auth.attendanceHubSession ||
        !businessId || getActiveBusinessId() !== businessId) throw new Error("Sign in again to view attendance.");
    const session = auth.attendanceHubSession;
    const { data } = await api.get<T>(`/employees/${encodeURIComponent(employeeId)}/attendance/${route}`, {
        signal, timeout: 15000,
        headers: { "X-Business-Id": businessId, "X-CRM-Admin-Session": "", "X-CRM-Attendance-Session": session, "Cache-Control": "no-store" },
    });
    const current = getAuthUser();
    if (current?.userType !== "employee" || current.user._id !== employeeId || current.attendanceHubSession !== session ||
        getActiveBusinessId() !== businessId) throw new Error("Attendance session changed. Refresh attendance.");
    return data;
}

export async function getEmployeeProfileAttendance(employeeId: string, businessId: string, signal?: AbortSignal) {
    const data = await ownAttendanceRead<AttendanceSessionSnapshot>(employeeId, businessId, "session", signal);
    if (!data || !Array.isArray(data.dashboardDays) || !Array.isArray(data.sessions) || !Array.isArray(data.records) ||
        !Number.isFinite(Date.parse(data.serverTime))) throw new Error("Attendance history is unavailable. Refresh attendance.");
    return data;
}

export async function getEmployeeProfileAttendanceCalendar(employeeId: string, businessId: string, month: string, signal?: AbortSignal) {
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month) || Number(month.slice(0, 4)) < 1900) throw new Error("Choose a valid attendance month.");
    const data = await ownAttendanceRead<EmployeeAttendanceCalendarStatus>(employeeId, businessId, `calendar?month=${encodeURIComponent(month)}`, signal);
    if (!data || data.month !== month || !Number.isFinite(Date.parse(data.serverTime)) || !Array.isArray(data.days) || data.days.some(day => !day || typeof day !== "object") ||
        new Set(data.days.map(day => day.dayKey)).size !== data.days.length || data.days.some(day =>
            !/^\d{4}-\d{2}-\d{2}$/.test(day.dayKey) || !day.dayKey.startsWith(`${month}-`) ||
            !Number.isFinite(Date.parse(day.dayKey)) || new Date(day.dayKey).toISOString().slice(0, 10) !== day.dayKey ||
            !Number.isFinite(Date.parse(day.shiftEnd)) || typeof day.absent !== "boolean" || typeof day.excused !== "boolean" ||
            day.absent && day.excused || !Number.isInteger(day.attendanceRevision) || day.attendanceRevision < 0)) {
        throw new Error("Absence status is unavailable. Refresh attendance.");
    }
    return data;
}
