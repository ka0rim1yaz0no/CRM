import { api } from "../lib/api";

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
    createdAt: string;
};

export type AttendanceInput = Pick<AttendanceRecord, "source"> & {
    timeIn: string;
};

export async function getEmployeeAttendance(employeeId: string, params?: { archived?: boolean }) {
    const response = await api.get<AttendanceRecord[]>(`/employees/${employeeId}/attendance`, { params });
    return response.data;
}

export async function getEmployeesAttendance(employeeIds: string[]) {
    const response = await api.get<AttendanceRecord[]>("/attendance", {
        params: { employeeIds: employeeIds.join(",") },
    });
    return response.data;
}

export async function createEmployeeAttendance(employeeId: string, attendance: AttendanceInput) {
    const response = await api.post<AttendanceRecord>(`/employees/${employeeId}/attendance`, attendance);
    return response.data;
}

export async function updateEmployeeAttendance(employeeId: string, attendanceId: string, attendance: AttendanceInput) {
    const response = await api.put<AttendanceRecord>(`/employees/${employeeId}/attendance/${attendanceId}`, attendance);
    return response.data;
}

export async function archiveEmployeeAttendance(employeeId: string, attendanceId: string) {
    const response = await api.patch<AttendanceRecord>(`/employees/${employeeId}/attendance/${attendanceId}/archive`);
    return response.data;
}

export async function timeInEmployee(employeeId: string) {
    const response = await api.post<AttendanceRecord>(`/employees/${employeeId}/attendance/time-in`);
    return response.data;
}

export async function timeOutEmployee(employeeId: string) {
    const response = await api.post<AttendanceRecord>(`/employees/${employeeId}/attendance/time-out`, {
        intent: "manual-attendance-time-out",
    });
    return response.data;
}

export async function breakOutEmployee(employeeId: string) {
    const response = await api.post<AttendanceRecord>(`/employees/${employeeId}/attendance/break-out`);
    return response.data;
}

export async function breakInEmployee(employeeId: string) {
    const response = await api.post<AttendanceRecord>(`/employees/${employeeId}/attendance/break-in`);
    return response.data;
}

export async function lunchBreakOutEmployee(employeeId: string) {
    const response = await api.post<AttendanceRecord>(`/employees/${employeeId}/attendance/lunch-break-out`);
    return response.data;
}

export async function lunchBreakInEmployee(employeeId: string) {
    const response = await api.post<AttendanceRecord>(`/employees/${employeeId}/attendance/lunch-break-in`);
    return response.data;
}

export async function reportEmployeeActivity(employeeId: string, state: "active" | "idle", options: { idleStartedAt?: string; reason?: string } = {}) {
    const response = await api.post<{ availabilityStatus: string; attendanceRecords?: AttendanceRecord[] }>(`/employees/${employeeId}/activity`, { state, ...options });
    return response.data;
}
