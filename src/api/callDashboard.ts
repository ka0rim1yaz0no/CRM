import { api } from "../lib/api";

export type CallDashboardRow = {
    employeeId: string;
    employeeCode: string;
    name: string;
    role: string;
    team: string;
    status: "ON CALL" | "OFFLINE" | "CALL WAITING" | "OFF THE PHONE";
    statusStartedAt: string | null;
    transitionUntil: string | null;
    detail: string;
    offPhoneCompletedMs: number;
    offPhoneActiveStartedAt: string | null;
    offPhoneTotalMs: number;
};

export type CallDashboardSnapshot = {
    generatedAt: string;
    shift: { start: string; end: string };
    employees: CallDashboardRow[];
};

export async function getCallDashboard() {
    const response = await api.get<CallDashboardSnapshot>("/call-dashboard");
    return response.data;
}
