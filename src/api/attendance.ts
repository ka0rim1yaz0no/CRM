import { api } from "../lib/api";
import { getAuthUser } from "./authStorage";
import { attendanceIntegrityEnabled, attendanceSessionHeaders, getAttendanceSession, performAttendanceAction, sessionEventRecord, type AttendanceSessionSnapshot } from "./attendanceSession";

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
    sequence?: number;
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
    sessionSnapshot?: AttendanceSessionSnapshot;
    createdAt: string;
};

export type AttendanceInput = Pick<AttendanceRecord, "source"> & {
    timeIn: string;
};

export type AttendanceQuery = {
    businessId?: string;
    archived?: boolean;
    all?: boolean;
    limit?: number;
    from?: string;
    to?: string;
};

export async function getEmployeeAttendance(employeeId: string, params: AttendanceQuery = {}) {
    if (attendanceIntegrityEnabled) {
        const snapshot = await getAttendanceSession(employeeId, params.businessId);
        const records = snapshot.records.map((event) => sessionEventRecord(event, employeeId)).reverse()
            .filter((record) => (!params.from || record.timeIn >= params.from) && (!params.to || record.timeIn <= params.to));
        return params.all ? records : records.slice(0, params.limit || 300);
    }
    const response = await api.get<AttendanceRecord[]>(`/employees/${employeeId}/attendance`, {
        headers: { ...attendanceSessionHeaders(), ...(params.businessId ? { "X-Business-Id": params.businessId } : {}) },
        params: params.all ? params : { limit: params.limit ?? 300, ...params },
    });
    return response.data;
}

export async function getEmployeesAttendance(employeeIds: string[], params: Pick<AttendanceQuery, "all" | "from" | "to"> = {}) {
    const response = await api.get<AttendanceRecord[]>("/attendance", {
        headers: attendanceSessionHeaders(),
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
    if (attendanceIntegrityEnabled) return runSessionAction(employeeId, "Time In");
    const response = await api.post<AttendanceRecord>(`/employees/${employeeId}/attendance/time-in`, attendanceEventPayload(), { headers: attendanceSessionHeaders() });
    return response.data;
}

export async function timeOutEmployee(employeeId: string) {
    if (attendanceIntegrityEnabled) return runSessionAction(employeeId, "Time Out");
    const response = await api.post<AttendanceRecord>(`/employees/${employeeId}/attendance/time-out`, {
        intent: "manual-attendance-time-out",
        ...attendanceEventPayload(),
    }, { headers: attendanceSessionHeaders() });
    return response.data;
}

export async function breakOutEmployee(employeeId: string) {
    if (attendanceIntegrityEnabled) return runSessionAction(employeeId, "Break Out");
    const response = await api.post<AttendanceRecord>(`/employees/${employeeId}/attendance/break-out`, attendanceEventPayload(), { headers: attendanceSessionHeaders() });
    return response.data;
}

export async function breakInEmployee(employeeId: string) {
    if (attendanceIntegrityEnabled) return runSessionAction(employeeId, "Break In");
    const response = await api.post<AttendanceRecord>(`/employees/${employeeId}/attendance/break-in`, attendanceEventPayload(), { headers: attendanceSessionHeaders() });
    return response.data;
}

export async function lunchBreakOutEmployee(employeeId: string) {
    if (attendanceIntegrityEnabled) return runSessionAction(employeeId, "Lunch Break Out");
    const response = await api.post<AttendanceRecord>(`/employees/${employeeId}/attendance/lunch-break-out`, attendanceEventPayload(), { headers: attendanceSessionHeaders() });
    return response.data;
}

export async function lunchBreakInEmployee(employeeId: string) {
    if (attendanceIntegrityEnabled) return runSessionAction(employeeId, "Lunch Break In");
    const response = await api.post<AttendanceRecord>(`/employees/${employeeId}/attendance/lunch-break-in`, attendanceEventPayload(), { headers: attendanceSessionHeaders() });
    return response.data;
}

export async function reportEmployeeActivity(employeeId: string, state: "active" | "idle", options: { idleStartedAt?: string; reason?: string } = {}) {
    if (attendanceIntegrityEnabled) {
        const record = await runSessionAction(employeeId, state === "idle" ? "Off the Phone Out" : "Off the Phone In");
        return { availabilityStatus: record.sessionSnapshot!.state, attendanceRecords: [record] };
    }
    const response = await api.post<{ availabilityStatus: string; attendanceRecords?: AttendanceRecord[] }>(`/employees/${employeeId}/activity`, { state, ...options }, { headers: attendanceSessionHeaders() });
    return response.data;
}

async function runSessionAction(employeeId: string, source: AttendanceRecord["source"]): Promise<AttendanceRecord> {
    const snapshot = await performAttendanceAction(employeeId, source);
    const event = [...snapshot.records].reverse().find((item) => item.source === source);
    if (!event) throw new Error("The saved attendance result could not be confirmed. Refresh attendance.");
    return { ...sessionEventRecord(event, employeeId), sessionSnapshot: snapshot, syncPending: snapshot.syncPending };
}
