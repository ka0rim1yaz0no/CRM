import { api } from "../lib/api";

export type CallDashboardRow = {
    employeeId: string;
    employeeCode: string;
    name: string;
    businessId: string;
    businessName: string;
    role: string;
    team: string;
    status: "ON CALL" | "ONLINE" | "OFFLINE" | "CALL WAITING" | "OFF THE PHONE" | "BREAK" | "LUNCH";
    statusStartedAt: string | null;
    transitionUntil: string | null;
    detail: string;
    offPhoneCompletedMs: number;
    offPhoneActiveStartedAt: string | null;
    offPhoneTotalMs: number;
};

export type CallDashboardSnapshot = {
    generatedAt: string;
    business: { id: string; name: string };
    shift: { start: string; end: string };
    employees: CallDashboardRow[];
};

export async function getCallDashboard() {
    const response = await api.get<CallDashboardSnapshot>("/call-dashboard");
    return response.data;
}
