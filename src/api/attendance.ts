import { api } from "../lib/api";
import { getAuthUser } from "./authStorage";

const attendanceV2 = import.meta.env.VITE_CRM_ATTENDANCE_V2 === "true" ||
    (import.meta.env.DEV && import.meta.env.VITE_CRM_ATTENDANCE_V2 !== "false");
function attendanceEventPayload() {
    return attendanceV2 ? { eventId: crypto.randomUUID() } : {};
}
function adminAttendanceHeaders() {
    const auth = getAuthUser();
    return auth?.userType === "admin" && auth.sessionToken
        ? { "X-CRM-Admin-Session": auth.sessionToken } : {};
}

export type AttendanceRecord = {
    _id: string;
    employee: string;
    timeIn: string;
    source:
        | "Login"
        | "Logout"
        | "Time In"
        | "Time Out"
        | "Break Out"
        | "Break In"
        | "Lunch Break Out"
        | "Lunch Break In"
        | "Off the Phone Out"
        | "Off the Phone In";
    attendanceStatus?: "On time" | "Late" | "Undertime" | "";
    isArchived?: boolean;
    syncPending?: boolean;
    createdAt: string;
};

export type AttendanceInput = Pick<AttendanceRecord, "source"> & {
    timeIn: string;
};

export type AttendanceQuery = {
    archived?: boolean;
    all?: boolean;
    limit?: number;
    from?: string;
    to?: string;
};

export async function getEmployeeAttendance(employeeId: string, params: AttendanceQuery = {}) {
    const response = await api.get<AttendanceRecord[]>(`/employees/${employeeId}/attendance`, {
        params: params.all ? params : { limit: params.limit ?? 300, ...params },
    });
    return response.data;
}

export async function getEmployeesAttendance(employeeIds: string[], params: Pick<AttendanceQuery, "all" | "from" | "to"> = {}) {
    const response = await api.get<AttendanceRecord[]>("/attendance", {
        params: { employeeIds: employeeIds.join(","), ...params },
    });
    return response.data;
}

export async function createEmployeeAttendance(employeeId: string, attendance: AttendanceInput) {
    const response = await api.post<AttendanceRecord>(`/employees/${employeeId}/attendance`,
        { ...attendance, ...attendanceEventPayload() }, { headers: adminAttendanceHeaders() });
    return response.data;
}

export async function updateEmployeeAttendance(employeeId: string, attendanceId: string, attendance: AttendanceInput) {
    const response = await api.put<AttendanceRecord>(`/employees/${employeeId}/attendance/${attendanceId}`,
        attendance, { headers: adminAttendanceHeaders() });
    return response.data;
}

export async function updateEmployeeWorkedMinutes(employeeId: string, timeInRecordId: string, workedMinutes: number) {
    const response = await api.patch<{ workedMinutes: number; timeOut: string; affectedBusinesses: number }>(
        `/employees/${employeeId}/attendance/worked-minutes`,
        { timeInRecordId, workedMinutes }, { headers: adminAttendanceHeaders() }
    );
    return response.data;
}

export async function archiveEmployeeAttendance(employeeId: string, attendanceId: string) {
    const response = await api.patch<AttendanceRecord>(`/employees/${employeeId}/attendance/${attendanceId}/archive`,
        undefined, { headers: adminAttendanceHeaders() });
    return response.data;
}

export async function timeInEmployee(employeeId: string) {
    const response = await api.post<AttendanceRecord>(`/employees/${employeeId}/attendance/time-in`, attendanceEventPayload());
    return response.data;
}

export async function timeOutEmployee(employeeId: string) {
    const response = await api.post<AttendanceRecord>(`/employees/${employeeId}/attendance/time-out`, {
        intent: "manual-attendance-time-out",
        ...attendanceEventPayload(),
    });
    return response.data;
}

export async function breakOutEmployee(employeeId: string) {
    const response = await api.post<AttendanceRecord>(`/employees/${employeeId}/attendance/break-out`, attendanceEventPayload());
    return response.data;
}

export async function breakInEmployee(employeeId: string) {
    const response = await api.post<AttendanceRecord>(`/employees/${employeeId}/attendance/break-in`, attendanceEventPayload());
    return response.data;
}

export async function lunchBreakOutEmployee(employeeId: string) {
    const response = await api.post<AttendanceRecord>(`/employees/${employeeId}/attendance/lunch-break-out`, attendanceEventPayload());
    return response.data;
}

export async function lunchBreakInEmployee(employeeId: string) {
    const response = await api.post<AttendanceRecord>(`/employees/${employeeId}/attendance/lunch-break-in`, attendanceEventPayload());
    return response.data;
}

export async function reportEmployeeActivity(employeeId: string, state: "active" | "idle", options: { idleStartedAt?: string; reason?: string } = {}) {
    const response = await api.post<{ availabilityStatus: string; attendanceRecords?: AttendanceRecord[] }>(`/employees/${employeeId}/activity`, { state, ...options });
    return response.data;
}
