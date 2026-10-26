import { api } from "../lib/api";
import { getAuthUser } from "./authStorage";

export type CallDashboardRow = {
    employeeId: string;
    employeeCode: string;
    name: string;
    businessId: string;
    businessName: string;
    role: string;
    team: string;
    status: "ON CALL" | "ONLINE" | "READY" | "OFFLINE" | "CALL WAITING" | "OFF THE PHONE" | "BREAK" | "LUNCH";
    statusStartedAt: string | null;
    transitionUntil: string | null;
    detail: string;
    offPhoneCompletedMs: number;
    offPhoneActiveStartedAt: string | null;
    offPhoneTotalMs: number;
    offPhoneNonBillable?: boolean;
    timeBucketsMs?: { online: number; break: number; lunch: number; offPhone: number; offline: number };
    breakRemainingMs?: number | null;
    lunchRemainingMs?: number | null;
    allowanceOverdue?: boolean;
    businesses?: Array<{ id: string; name: string }>;
    businessBreakdown?: Array<{ id: string; name: string; timeBucketsMs: { online: number; break: number; lunch: number; offPhone: number; offline: number } }>;
    callsCount?: number;
    talkTimeMs?: number;
    heartbeatAgeMs?: number | null;
    bridgeHealth?: "fresh" | "stale" | "offline" | "nextiva-closed";
};

export type CallDashboardSnapshot = {
    generatedAt: string;
    serverTime?: string;
    business: { id: string; name: string };
    shift: { start: string; end: string };
    employees: CallDashboardRow[];
};

export async function getCallDashboard() {
    const auth = getAuthUser();
    const response = await api.get<CallDashboardSnapshot>("/call-dashboard", {
        headers: auth?.userType === "admin" && auth.sessionToken ? { "X-CRM-Admin-Session": auth.sessionToken } : {},
    });
    return response.data;
}
