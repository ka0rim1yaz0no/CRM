import { api } from "../lib/api";

export type EmployeeTransaction = {
    _id: string;
    employee: string;
    category: "Attendance" | "Notice" | "Lead" | "Message" | "System";
    title: string;
    description: string;
    occurredAt: string;
    createdAt: string;
};

export async function getEmployeeTransactions(employeeId: string, date?: string) {
    const response = await api.get<EmployeeTransaction[]>(`/employees/${employeeId}/transactions`, {
        params: date ? { date } : undefined,
    });
    return response.data;
}

export type EmployeeActivityPage = {
    items: EmployeeTransaction[];
    hasMore: boolean;
    nextOffset: number | null;
    metrics: {
        activeLeads: number;
        closedDeals: number;
        callAttempts: number;
    } | null;
};

export async function getEmployeeRecentActivity(employeeId: string, offset = 0, limit = 10) {
    const response = await api.get<EmployeeActivityPage>(`/employees/${employeeId}/recent-activity`, {
        params: { offset, limit },
    });
    return response.data;
}
