import { getActiveBusinessId } from "./businessStorage";
import { api } from "../lib/api";
import { backendOrigin } from "../lib/backendUrl";
import { CALLING_QUEUE_POLICY_VERSION } from "../../shared/leadCallingPolicy";
import type { Lead } from "./leads";

export type CallBridgeState = "offline" | "unknown" | "idle" | "calling" | "active";

export type CallBridgeStatus = {
    employeeCode: string;
    provider: "nextiva";
    connected: boolean;
    ready: boolean;
    state: CallBridgeState;
    reason: string;
    nextivaProcessDetected: boolean;
    deviceName: string;
    bridgeVersion: string;
    lastSeenAt: string | null;
    callLeaseUntil: string | null;
    nextCallAllowedAt: string | null;
    lastCallEndedAt: string | null;
    serverTime?: string;
    clientReceivedAt?: number;
    clientReceivedAtMonotonic?: number;
    waitCode?: string;
    postCallWaitMs?: number;
    observedAttemptId?: string | null;
    observedLeadId?: string | null;
    deadlineDispatchEnabled?: boolean;
    deadlinePreparationMs?: number;
};

export async function prepareCallBridgeDeadline(employeeCode: string, options: {businessId: string; employeeSession: string;
    attemptId: string; notBefore: string; signal: AbortSignal; timeoutMs: number}) {
    const browserSession = readBrowserSession();
    const response = await api.post<{startedAt: string; serverTime: string; dialIntentUntil: string; alreadyStarted: boolean;
        reservationToken: string; leadId: string; normalizedPhone: string; lead: Lead | null}>("/call-bridge/dial-at-deadline",
        {employeeCode, attemptId: options.attemptId, notBefore: options.notBefore, browserDeviceKey: getStoredBrowserDeviceKey(),
            browserSessionId: browserSession?.employeeCode === employeeCode && browserSession.businessId === options.businessId ? browserSession.sessionId : ""},
        {signal: options.signal, timeout: options.timeoutMs,
            headers: {...autoCallClientHeaders, "X-Business-Id": options.businessId, "X-CRM-Attendance-Session": options.employeeSession}});
    return response.data;
}

export type CallBridgePairing = {
    pairingCode: string;
    employeeCode: string;
    employeeName: string;
    businessId: string;
    accountSwitchingEnabled: boolean;
    expiresAt: string;
};

export type CallBridgeActivation = {
    activated: boolean;
    switchable: boolean;
    employeeChanged?: boolean;
    employeeCode: string;
    deviceName?: string;
    reason?: string;
    code?: "NEWER_BROWSER_SESSION_ACTIVE" | "CALL_BRIDGE_BUSY";
};

export type CallBridgeReservation =
    | {
        allowed: true;
        employeeCode: string;
        state: "calling";
        callLeaseUntil: string;
        reservationToken: string;
        attemptId?: string;
        serverTime?: string;
        leadId: string;
        normalizedPhone: string;
    }
    | ({ allowed: false; code?: "LEAD_ALREADY_COMMENTED" | "LEAD_NOT_ASSIGNED" | "LEAD_NOT_FOUND" | "LEAD_NOT_CALLABLE" } & CallBridgeStatus);

export type CallBridgeAttempt = {
    id: string;
    phase: "reserved" | "dialing" | "ringing" | "answered" | "voicemail" | "ended" | "classifying" | "classified" | "failed";
    outcome: "pending" | "connected" | "not_connected" | "voicemail" | "unclassified";
    outcomeReason: string;
    classificationConfidence: "" | "high" | "probable" | "needs_review";
    classificationSource:
      | ""
      | "manual"
      | "ringcentral_events"
      | "ringcentral_call_log"
      | "ringcentral_recording";
    providerResult: string;
    statusCodes: string[];
    reservedAt: string;
    dialStartedAt: string | null;
    answeredAt: string | null;
    endedAt: string | null;
    classifiedAt: string | null;
    durationSeconds: number;
};

export type LatestCallBridgeAttempt = {
    shadowMode: boolean;
    monitor?: {
        configured: boolean;
        connected: boolean;
        mapped: boolean;
        extensionId: string;
        extensionNumber: string;
        deviceName: string;
        lastError: string;
    };
    attempt: CallBridgeAttempt | null;
};

export const callTimingV2Enabled = import.meta.env.VITE_CRM_CALL_TIMING_V2 === "true" ||
    (import.meta.env.DEV && import.meta.env.VITE_CRM_CALL_TIMING_V2 !== "false");
export const autoCallClientVersion = CALLING_QUEUE_POLICY_VERSION;

const autoCallClientHeaders = {
    "X-CRM-Auto-Call-Version": autoCallClientVersion,
};

const browserDeviceKeyStorageKey = "crm:call-bridge:browser-device-key:v1";
const browserSessionStorageKey = "crm:call-bridge:browser-session:v1";

type BrowserSession = {
    employeeCode: string;
    businessId: string;
    sessionId: string;
    startedAt: number;
};

type ActivationAttempt = {
    employeeCode: string;
    sessionId: string;
    pending?: Promise<CallBridgeActivation>;
    result?: CallBridgeActivation;
    retryAfter: number;
};
let activationAttempt: ActivationAttempt | null = null;
const activationConflictRetryMs = 30_000;

function currentActivationAttempt(employeeCode: string) {
    const session = readBrowserSession();
    return session?.employeeCode === employeeCode && session.businessId === (getActiveBusinessId() || "default") &&
        activationAttempt?.employeeCode === employeeCode && activationAttempt.sessionId === session.sessionId
        ? activationAttempt : null;
}

export function canUseCallBridgeBrowserSession(employeeCode: string) {
    const attempt = currentActivationAttempt(employeeCode);
    return !attempt || Boolean(attempt.result?.activated || attempt.result?.switchable === false);
}

function randomIdentifier() {
    if (typeof crypto.randomUUID === "function") {
        return crypto.randomUUID();
    }

    const randomBytes = crypto.getRandomValues(new Uint8Array(24));
    return Array.from(randomBytes, (value) => value.toString(16).padStart(2, "0")).join("");
}

function getStoredBrowserDeviceKey() {
    try {
        return window.localStorage.getItem(browserDeviceKeyStorageKey) || "";
    } catch {
        return "";
    }
}

function getOrCreateBrowserDeviceKey() {
    const storedKey = getStoredBrowserDeviceKey();

    if (storedKey) {
        return storedKey;
    }

    const deviceKey = randomIdentifier();

    try {
        window.localStorage.setItem(browserDeviceKeyStorageKey, deviceKey);
    } catch {
        return "";
    }

    return deviceKey;
}

function readBrowserSession() {
    try {
        const storedSession = JSON.parse(window.sessionStorage.getItem(browserSessionStorageKey) || "null") as BrowserSession | null;

        return storedSession?.employeeCode && storedSession.sessionId && Number.isFinite(storedSession.startedAt)
            ? storedSession
            : null;
    } catch {
        return null;
    }
}

function writeBrowserSession(employeeCode: string, forceNew = false) {
    const businessId = getActiveBusinessId() || "default";
    const existingSession = readBrowserSession();

    if (
        !forceNew &&
        existingSession?.employeeCode === employeeCode &&
        existingSession.businessId === businessId
    ) {
        return existingSession;
    }

    const session = {
        employeeCode,
        businessId,
        sessionId: randomIdentifier(),
        startedAt: Date.now(),
    };

    try {
        window.sessionStorage.setItem(browserSessionStorageKey, JSON.stringify(session));
    } catch {
        // The activation request can still use this in-memory session once.
    }

    return session;
}

export function beginCallBridgeBrowserSession(employeeCode: string) {
    return writeBrowserSession(employeeCode, true);
}

export async function createCallBridgePairing(employeeId: string) {
    const browserDeviceKey = getOrCreateBrowserDeviceKey();
    const response = await api.post<CallBridgePairing>("/call-bridge/pairings", { employeeId, browserDeviceKey });
    return response.data;
}

export async function activateCallBridgeForEmployee(
    employeeCode: string,
    options: { timeoutMs?: number; businessId?: string; employeeSession?: string } = {}
) {
    const businessId = options.businessId || getActiveBusinessId() || "default";
    if (businessId !== (getActiveBusinessId() || "default")) throw new Error("The active business changed before Call Bridge activation.");
    const browserDeviceKey = getStoredBrowserDeviceKey();

    if (!browserDeviceKey) {
        return {
            activated: false,
            switchable: false,
            employeeCode,
            reason: "This browser has not paired a switchable Call Bridge computer.",
        } satisfies CallBridgeActivation;
    }

    const browserSession = writeBrowserSession(employeeCode);
    const previous = currentActivationAttempt(employeeCode);
    if (previous?.pending) return previous.pending;
    if (previous?.result && Date.now() < previous.retryAfter) return previous.result;
    const attempt: ActivationAttempt = { employeeCode, sessionId: browserSession.sessionId, retryAfter: 0, result: previous?.result };
    activationAttempt = attempt;
    attempt.pending = (async () => {
        try {
            const response = await api.post<CallBridgeActivation>(
                "/call-bridge/activate",
                { employeeCode, browserDeviceKey, browserSessionId: browserSession.sessionId, browserSessionStartedAt: browserSession.startedAt },
                { timeout: options.timeoutMs, headers: { "X-Business-Id": businessId,
                    ...(options.employeeSession ? { "X-CRM-Attendance-Session": options.employeeSession } : {}) } }
            );
            attempt.result = response.data;
            return response.data;
        } catch (error) {
            const response = (error as { response?: { status?: number; data?: { code?: string; message?: string } } }).response;
            const code = response?.data?.code;
            if (response?.status === 409 && (code === "NEWER_BROWSER_SESSION_ACTIVE" || code === "CALL_BRIDGE_BUSY")) {
                attempt.retryAfter = Date.now() + activationConflictRetryMs;
                attempt.result = { activated: false, switchable: true, employeeCode, code,
                    reason: response.data?.message || "Call Bridge is waiting for the current browser session or call to finish." };
                return attempt.result;
            }
            attempt.result = { activated: false, switchable: true, employeeCode,
                reason: "Call Bridge activation could not be verified. Retrying." };
            throw error;
        } finally {
            attempt.pending = undefined;
        }
    })();
    return attempt.pending;
}

export async function getCallBridgeStatus(employeeCode: string, options: { timeoutMs?: number; businessId?: string; employeeSession?: string } = {}) {
    // A live device alone does not authorize a browser whose activation was rejected.
    await currentActivationAttempt(employeeCode)?.pending?.catch(() => undefined);
    const response = await api.get<CallBridgeStatus>("/call-bridge/status", {
        params: { employeeCode },
        timeout: options.timeoutMs,
        headers: { ...(options.businessId ? { "X-Business-Id": options.businessId } : {}), ...(options.employeeSession ? { "X-CRM-Attendance-Session": options.employeeSession } : {}) },
    });
    const activation = currentActivationAttempt(employeeCode)?.result;
    return { ...response.data,
        ...(activation?.switchable && !activation.activated ? { ready: false, reason: activation.reason || response.data.reason } : {}),
        clientReceivedAt: Date.now(), clientReceivedAtMonotonic: typeof performance === "undefined" ? undefined : performance.now() };
}

export async function getLatestCallBridgeAttempt(employeeCode: string, leadId: string) {
    const response = await api.get<LatestCallBridgeAttempt>("/call-bridge/attempts/latest", {
        params: { employeeCode, leadId },
    });
    return response.data;
}

export async function reserveCallBridgeCall(employeeCode: string, options: { timeoutMs?: number; leadId?: string; attemptId?: string; businessId?: string; queueVersion?: string; normalizedPhone?: string; employeeSession?: string } = {}) {
    const response = await api.post<CallBridgeReservation>(
        "/call-bridge/reserve",
        { employeeCode, leadId: options.leadId, attemptId: options.attemptId, queueVersion: options.queueVersion, normalizedPhone: options.normalizedPhone },
        { timeout: options.timeoutMs, headers: { ...autoCallClientHeaders, ...(options.businessId ? { "X-Business-Id": options.businessId } : {}), ...(options.employeeSession ? { "X-CRM-Attendance-Session": options.employeeSession } : {}) } }
    );
    return response.data;
}

export async function markCallBridgeDialStarted(employeeCode: string, options: { timeoutMs?: number; leadId: string; reservationToken: string; businessId?: string; employeeSession?: string }) {
    const response = await api.post<{ startedAt: string; serverTime: string; dialIntentUntil: string; alreadyStarted?: boolean; leadId: string; normalizedPhone: string }>(
        "/call-bridge/dial-start",
        { employeeCode, leadId: options.leadId, reservationToken: options.reservationToken },
        { timeout: options.timeoutMs, headers: { ...autoCallClientHeaders, ...(options.businessId ? { "X-Business-Id": options.businessId } : {}), ...(options.employeeSession ? { "X-CRM-Attendance-Session": options.employeeSession } : {}) } }
    );
    return response.data;
}

export async function releaseCallBridgeCall(
    employeeCode: string,
    options: { timeoutMs?: number; leadId: string; reservationToken: string; businessId?: string; employeeSession?: string }
) {
    const response = await api.post<CallBridgeStatus>(
        "/call-bridge/release",
        { employeeCode, leadId: options.leadId, reservationToken: options.reservationToken },
        { timeout: options.timeoutMs, headers: { ...autoCallClientHeaders, ...(options.businessId ? { "X-Business-Id": options.businessId } : {}), ...(options.employeeSession ? { "X-CRM-Attendance-Session": options.employeeSession } : {}) } }
    );
    return response.data;
}

export async function revokeCallBridgeDevices(employeeCode: string) {
    const response = await api.delete<{ message: string; devicesRemoved: number }>("/call-bridge/devices", {
        data: { employeeCode },
    });
    return response.data;
}

export function getCallBridgePackageUrl(businessId = getActiveBusinessId()) {
    const url = new URL("/api/call-bridge/package", backendOrigin);
    if (businessId.trim()) url.searchParams.set("businessId", businessId.trim());
    return url.href;
}
export const callBridgeBackendUrl = backendOrigin;
export const callBridgeBusinessId = () => getActiveBusinessId() || "default";
