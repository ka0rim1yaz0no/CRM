import { api } from "../lib/api";
import { getAuthUser } from "./authStorage";
import { getActiveBusinessId } from "./businessStorage";
import type { AttendanceRecord } from "./attendance";
import { attendanceSessionCacheKey, retainAttendanceSnapshot } from "../lib/attendanceSessionCache";

export const attendanceIntegrityEnabled = import.meta.env.VITE_CRM_ATTENDANCE_INTEGRITY === "true" ||
    (import.meta.env.DEV && import.meta.env.VITE_CRM_ATTENDANCE_INTEGRITY !== "false");
export const attendanceDurationModelEnabled = import.meta.env.VITE_CRM_ATTENDANCE_DURATION_MODEL === "true";
export type SessionEvent = { id: string; source: "Login" | "Logout" | "Time In" | "Time Out" | "Break Out" | "Break In" |
    "Lunch Break Out" | "Lunch Break In" | "Off the Phone Out" | "Non-Billable Off the Phone Out" | "Off the Phone In"; at: string; commandId: string; sequence: number; sessionId?: string;
    attendanceStatus?: "On time" | "Late" | "Undertime" | ""; autoTimeOut?: boolean; shiftDayKey?: string };
export type AttendanceSessionSnapshot = {
    offPhonePolicy?: import("../../shared/attendanceOffPhone").OffPhoneLimitPolicy;
    offPhoneBilling?: import("../../shared/attendanceOffPhone").OffPhoneBillingSnapshot | null;
    dashboardDays?: DashboardAttendanceDay[];
    currentShiftDay?: string;
    sessionId: string | null; revision: number; fingerprint: string; state: "ONLINE" | "OFFLINE" | "BREAK" | "LUNCH" | "OFF THE PHONE";
    stateSince: string | null; lifecycle: string; serverTime: string; receivedAt: number; resetDeadline: string | null; recoveryEnabled?: boolean;
    assignedShift: { dayKey: string; start: string; end: string; resetDeadline: string } | null;
    reviewState: string; review: string[]; records: SessionEvent[]; syncPending: boolean;
    historyReviewRequired?: boolean;
    allowedActions?: SessionEvent["source"][];
    autoTimeOutEnabled?: boolean;
    policySyncPending?: boolean;
    timeOutOverrideEnabled?: boolean;
    sessions: Array<{ id: string; startedAt: string; endedAt: string | null; mode: string; modeSince: string; lifecycle: string;
        events: SessionEvent[]; shift: AttendanceSessionSnapshot["assignedShift"]; time?: { scheduled: { online: number } } }>;
    audit: Array<{ commandId: string; actor: { code: string; role: string }; reason: string; operation: string; at: string; targetIds: string[] }>;
    policy?: AttendancePolicy;
    allowances?: { breakMinutes: number; lunchMinutes: number };
    systemClosure: { effectiveAt: string; processedAt: string } | null;
    time?: { actual: Record<string, number>; scheduled: Record<string, number> } | null;
};
export type DashboardAttendanceDay = {
    dayKey: string; shiftStart: string; shiftEnd: string; eventIds: string[]; timeIn: string | null; timeOut: string | null;
    milliseconds: Record<string, number>; breakMinutes: number; lunchMinutes: number;
    overBreakRows: Array<{ id: string; label: string; startedAt: string; endedAt: string | null; durationMs: number;
        allowedMs: number; overMs: number; isOpen: boolean }>;
};
export type AttendancePolicy = { revision: number; graceMinutes: number; breakMinutes: number; lunchMinutes: number;
    shiftStart: string; shiftEnd: string; recoveryEnabled: boolean; recoveryTime: string; autoTimeOutTime?: string;
    autoTimeOutEnabled?: boolean; policySyncPending?: boolean };
export type AttendanceCommand = { commandId: string; expectedRevision: number; fingerprint?: string;
    operation: "action" | "correct" | "undo" | "add-time-out"; source?: SessionEvent["source"]; reason?: string;
    sessionId?: string; timeOutAt?: string; closeRest?: boolean;
    targetCommandId?: string; changes?: Array<{ targetId?: string; source?: SessionEvent["source"]; at?: string; remove?: boolean }> };
export function attendanceSessionHeaders() {
    const auth = getAuthUser();
    return auth?.userType === "admin" ? { "X-CRM-Admin-Session": auth.sessionToken || "" } :
        { "X-CRM-Attendance-Session": auth?.attendanceHubSession || "" };
}
const snapshots = new Map<string, AttendanceSessionSnapshot>();
const pendingActions = new Map<string, AttendanceCommand>();
function cacheKey(employeeId: string, businessId: string) {
    const auth = getAuthUser();
    return attendanceSessionCacheKey(`${auth?.userType}:${auth?.user.employeeCode}:${auth?.userType === "employee" ? auth.attendanceHubSession : auth?.sessionToken}`, businessId, employeeId);
}
export async function getAttendanceSession(employeeId: string, businessId?: string) {
    const business = businessId ?? getActiveBusinessId();
    const key = cacheKey(employeeId, business);
    const response = await api.get<AttendanceSessionSnapshot>(`/employees/${employeeId}/attendance/session`, { headers: { ...attendanceSessionHeaders(), "X-Business-Id": business } });
    return retainAttendanceSnapshot(snapshots, key, response.data);
}
export async function submitAttendanceCommand(employeeId: string, command: AttendanceCommand, businessId?: string) {
    const business = businessId ?? getActiveBusinessId();
    const key = cacheKey(employeeId, business);
    const response = await api.post<AttendanceSessionSnapshot>(`/employees/${employeeId}/attendance/commands`, command, { headers: { ...attendanceSessionHeaders(), "X-Business-Id": business } });
    return retainAttendanceSnapshot(snapshots, key, response.data);
}
export async function previewAttendanceCommand(employeeId: string, command: AttendanceCommand, businessId?: string) {
    const response = await api.post<{ revision: number; before: AttendanceSessionSnapshot; after: AttendanceSessionSnapshot;
        payrollImpact: string; businessIds: string[]; targets: string[] }>(`/employees/${employeeId}/attendance/preview`, command, { headers: { ...attendanceSessionHeaders(), ...(businessId ? { "X-Business-Id": businessId } : {}) } });
    return response.data;
}
export async function performAttendanceAction(employeeId: string, source: SessionEvent["source"]) {
    const business = getActiveBusinessId();
    const sessionKey = cacheKey(employeeId, business);
    const key = `${sessionKey}:${source}`;
    let command = pendingActions.get(key);
    if (!command) {
        const snapshot = snapshots.get(sessionKey) || await getAttendanceSession(employeeId, business);
        command = { commandId: crypto.randomUUID(), expectedRevision: snapshot.revision, fingerprint: snapshot.fingerprint, operation: "action", source };
        pendingActions.set(key, command);
    }
    try { const result = await submitAttendanceCommand(employeeId, command, business); pendingActions.delete(key); return result; }
    catch (error) {
        const status = (error as { response?: { status?: number } }).response?.status;
        const code = (error as { response?: { data?: { code?: string } } }).response?.data?.code;
        if (status && code !== "ATTENDANCE_BUSY") pendingActions.delete(key);
        throw error;
    }
}
export function sessionEventRecord(event: SessionEvent, employeeId: string): AttendanceRecord {
    return { _id: event.id, eventId: event.id, employee: employeeId, timeIn: event.at, source: event.source, createdAt: event.at,
        sequence: event.sequence, attendanceStatus: event.attendanceStatus, shiftDayKey: event.shiftDayKey, autoTimeOut: event.autoTimeOut };
}
export async function getAttendancePolicy() {
    return (await api.get<AttendancePolicy>("/attendance-policy", { headers: attendanceSessionHeaders() })).data;
}
export async function saveAttendancePolicy(policy: AttendancePolicy) {
    return (await api.put<AttendancePolicy>("/attendance-policy", { ...policy, expectedRevision: policy.revision }, { headers: attendanceSessionHeaders() })).data;
}
