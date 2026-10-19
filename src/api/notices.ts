import { api } from "../lib/api";
import { getAuthUser } from "./authStorage";

export type NoticeSeverity = "Info" | "Warning" | "Critical";

export type Notice = {
    _id: string;
    employee: string | { _id: string; name: string; employeeCode: string; team: string; role: string };
    title: string;
    message: string;
    severity: NoticeSeverity;
    issuedBy: string;
    isRead: boolean;
    href?: string;
    source?: string;
    sourceId?: string;
    acknowledgedAt?: string;
    replies?: {
        _id?: string;
        message: string;
        createdAt: string;
    }[];
    createdAt: string;
};

export type NoticeInput = {
    title: string;
    message: string;
    severity: NoticeSeverity;
    issuedBy: string;
    href?: string;
    source?: string;
    sourceId?: string;
};

export async function getEmployeeNotices(employeeId: string) {
    const response = await api.get<Notice[]>(`/employees/${employeeId}/notices`);
    return response.data;
}

export async function getRecentNotices() {
    const response = await api.get<Notice[]>("/notices");
    return response.data;
}

export async function createEmployeeNotice(employeeId: string, notice: NoticeInput) {
    const response = await api.post<Notice>(`/employees/${employeeId}/notices`, notice);
    return response.data;
}

export async function updateEmployeeNotice(employeeId: string, noticeId: string, notice: NoticeInput) {
    const response = await api.patch<Notice>(`/employees/${employeeId}/notices/${noticeId}`, notice);
    return response.data;
}

export async function deleteEmployeeNotice(employeeId: string, noticeId: string) {
    const response = await api.delete<{ deletedCount: number }>(`/employees/${employeeId}/notices/${noticeId}`);
    return response.data;
}

export async function markEmployeeNoticeRead(employeeId: string, noticeId: string) {
    const response = await api.patch<Notice>(`/employees/${employeeId}/notices/${noticeId}/read`);
    return response.data;
}

export async function acknowledgeEmployeeNotice(employeeId: string, noticeId: string) {
    const response = await api.patch<Notice>(`/employees/${employeeId}/notices/${noticeId}/acknowledge`);
    return response.data;
}

export async function replyToEmployeeNotice(employeeId: string, noticeId: string, message: string) {
    const response = await api.post<Notice>(`/employees/${employeeId}/notices/${noticeId}/replies`, { message });
    return response.data;
}

export async function markEmployeeNoticesRead(employeeId: string) {
    const auth = getAuthUser();
    const headers = auth?.userType === "admin"
        ? { "X-CRM-Admin-Session": auth.sessionToken || "" }
        : { "X-CRM-Attendance-Session": auth?.attendanceHubSession || "" };
    const response = await api.patch<Notice[]>(`/employees/${employeeId}/notices/read`, undefined, { headers });
    return response.data;
}
