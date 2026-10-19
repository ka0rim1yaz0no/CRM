import { api } from "../lib/api";
import { getAuthUser } from "./authStorage";

export type HubStatus = "ONLINE" | "BREAK" | "LUNCH" | "OFF THE PHONE" | "OFFLINE";
export type HubEvent = { id: string; source: string; at: string; eventId: string | null };
export type HubDay = {
    dayKey: string; shiftStart: string; shiftEnd: string; timeIn: string | null; timeOut: string | null;
    employeeCode: string; employeeId: string; employeeName: string; role: string; team: string; scopeKey: string;
    businessId: string; businessName: string; status: string; inProgress: boolean; excused: boolean; absent: boolean;
    mismatch: boolean; issues: string[]; review: string[]; note: string; leave: string | null;
    graceMinutes: number; breakMinutes: number; lunchMinutes: number;
    noteRevisions: Array<{ reason: string; excused: boolean; by: string; at: string }>;
    audit: Array<{ _id: string; occurredAt: string; description: string; metadata?: Record<string, string> }>;
    milliseconds: Record<"online" | "break" | "lunch" | "offPhone" | "offline" | "late" | "underTime" | "overBreak" | "overLunch" | "overtime", number>;
    events: HubEvent[];
    timeline: Array<{ bucket: string; start: string; end: string }>;
    businesses: Array<{ businessId: string; businessName: string; status: string; issues: string[]; milliseconds: HubDay["milliseconds"]; events: HubEvent[]; mismatch: boolean }>;
};
export type HubFilters = {
    preset: string; from?: string; to?: string; business?: string; employee?: string; team?: string; role?: string;
    issue?: string; sort?: string; direction?: string; page?: number; pageSize?: number;
    shiftView?: "today" | "date" | "all"; shiftDate?: string; historyPage?: number;
};
export type HubResponse = {
    rows: HubDay[]; total: number; page: number; pageSize: number;
    employees?: Array<Pick<HubDay, "scopeKey" | "employeeCode" | "employeeName" | "employeeId" | "team" | "role" | "businessId">>;
    history?: { page: number; hasOlder: boolean; hasNewer: boolean; today: string };
    range: { from: string; to: string }; serverTime: string;
    summary: { daysWorked: number; employeesPresent: number; online: number; break: number; lunch: number;
        offPhone: number; lateCount: number; late: number; overBreakCount: number; overBreak: number;
        overLunchCount: number; overLunch: number; underTimeCount: number; underTime: number;
        overtime: number; absent: number; needsReview: number; onTimeRate: number };
    thresholds: { breakMinutes: number; lunchMinutes: number; timezone: string };
    businesses: Array<{ id: string; name: string }>;
    trend: Array<{ dayKey: string; online: number; late: number; break: number; lunch: number; people: number }>;
    facets: { teams: string[]; roles: string[] };
    reviewQueue: Array<{ dayKey: string; employeeCode: string; employeeName: string; reason: string }>;
};

function sessionHeaders() {
    const auth = getAuthUser();
    return auth?.userType === "admin" ? { "X-CRM-Admin-Session": auth.sessionToken || "" } :
        { "X-CRM-Attendance-Session": auth?.attendanceHubSession || "" };
}
export async function getAttendanceHubDays(filters: HubFilters) {
    const response = await api.get<HubResponse>("/attendance-hub/days", { params: filters, headers: sessionHeaders() });
    return response.data;
}
export async function getAttendanceHubLive(business?: string) {
    const response = await api.get<{ status: HubStatus; since: string | null; serverTime: string; day: HubDay | null;
        shiftStart: string; shiftEnd: string; thresholds: HubResponse["thresholds"] & { graceMinutes: number } }>("/attendance-hub/live", { params: { business }, headers: sessionHeaders() });
    return response.data;
}
export async function getAttendanceHubDay(dayKey: string, employeeCode: string, business?: string) {
    const response = await api.get<{ day: HubDay; serverTime: string }>(`/attendance-hub/day/${encodeURIComponent(dayKey)}`,
        { params: { preset: "custom", from: dayKey, to: dayKey, employeeCode, business }, headers: sessionHeaders() });
    return response.data.day;
}
export async function saveAttendanceHubNote(day: HubDay, reason: string, excused: boolean) {
    const response = await api.post(`/attendance-hub/day/${encodeURIComponent(day.dayKey)}/note`,
        { employeeCode: day.employeeCode, businessId: day.businessId, reason, excused }, { headers: sessionHeaders() });
    return response.data;
}
export async function downloadAttendanceHubCsv(filters: HubFilters) {
    const response = await api.get<Blob>("/attendance-hub/export", { params: filters, headers: sessionHeaders(), responseType: "blob" });
    const url = URL.createObjectURL(response.data);
    const link = document.createElement("a");
    link.href = url;
    link.download = "attendance.csv";
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
