import { api } from "../lib/api";
import { getAuthUser } from "./authStorage";
import type { AttendanceSessionSnapshot } from "./attendanceSession";

export type CallDashboardRow = {
    employeeId: string;
    employeeCode: string;
    name: string;
    businessId: string;
    businessName: string;
    role: string;
    team: string;
    status: "ON CALL" | "ONLINE" | "READY" | "OFFLINE" | "CALL WAITING" | "OFF THE PHONE" | "BREAK" | "LUNCH" | "UNVERIFIED";
    statusStartedAt: string | null;
    waitingStartedAt?: string | null;
    callStateAvailable?: boolean;
    transitionUntil: string | null;
    detail: string;
    offPhoneCompletedMs: number;
    offPhoneActiveStartedAt: string | null;
    offPhoneTotalMs: number;
    offPhoneNonBillable?: boolean;
    coachingActive?: boolean;
    offPhoneNonBillableFrom?: string | null;
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

export async function getCallDashboard(businessId?: string) {
    const auth = getAuthUser();
    const response = await api.get<CallDashboardSnapshot>("/call-dashboard", {
        timeout: 10000,
        headers: { ...(auth?.userType === "admin" && auth.sessionToken ? { "X-CRM-Admin-Session": auth.sessionToken } : {}),
            ...(businessId ? { "X-Business-Id": businessId } : {}) },
    });
    if (businessId && response.data.business.id !== businessId) throw new Error("Call Dashboard business changed. Refreshing the selected business.");
    return response.data;
}

export type OfflineClockEvidence = { state: "recorded"; startedAt: string } | { state: "not-recorded" | "unavailable" };

// Historical checkouts can predate the dashboard's shift lookback. Read their
// canonical projection separately, without touching the employee calling cache.
export async function getOfflineClockEvidence(employeeId: string, businessId: string, signal?: AbortSignal): Promise<OfflineClockEvidence> {
    const auth = getAuthUser();
    if (!employeeId || !businessId || auth?.userType !== "admin" || !auth.sessionToken) throw new Error("Administrator attendance verification is required.");
    const response = await api.get<AttendanceSessionSnapshot>(`/employees/${encodeURIComponent(employeeId)}/attendance/session`, {
        params: { view: "status" }, timeout: 10000, signal,
        headers: { "X-CRM-Admin-Session": auth.sessionToken, "X-Business-Id": businessId },
    });
    const current = getAuthUser();
    if (current?.userType !== "admin" || current.sessionToken !== auth.sessionToken) throw new Error("Administrator session changed.");
    const snapshot = response.data;
    if (snapshot.statusOnly !== true || snapshot.state !== "OFFLINE" || snapshot.sessionId !== null || snapshot.reviewState !== "verified" || !Array.isArray(snapshot.sessions)) return { state: "unavailable" };
    const last = snapshot.sessions.at(-1);
    if (!last && snapshot.stateSince === null) return { state: "not-recorded" };
    const startedAt = last?.endedAt ? Date.parse(last.endedAt) : NaN;
    const serverTime = Date.parse(snapshot.serverTime);
    if (!last || last.mode !== "OFFLINE" || !["manually-closed", "system-closed"].includes(last.lifecycle) ||
        !Number.isFinite(startedAt) || startedAt <= 0 || !Number.isFinite(serverTime) || startedAt > serverTime ||
        !Number.isFinite(Date.parse(last.startedAt)) || Date.parse(last.startedAt) > startedAt ||
        Date.parse(last.modeSince) !== startedAt || Date.parse(snapshot.stateSince || "") !== startedAt) return { state: "unavailable" };
    return { state: "recorded", startedAt: last.endedAt! };
}
