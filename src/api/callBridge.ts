import { getActiveBusinessId } from "./businessStorage";
import { api } from "../lib/api";
import { backendOrigin } from "../lib/backendUrl";
import { CALLING_QUEUE_POLICY_VERSION } from "../../shared/leadCallingPolicy";
import type { Lead } from "./leads";
import { getAuthUser } from "./authStorage";
import { beginAutoCallPause, observeAutoCallControl, settleAutoCallPause } from "../lib/autoCallControl";

export type CallBridgeState = "offline" | "unknown" | "idle" | "calling" | "active";

export type CallBridgeStatus = {
    employeeCode: string;
    autoCallDisabled?: boolean;
    autoCallPaused?: boolean;
    autoCallUserPaused?: boolean;
    manualCallHold?: boolean;
    autoCallControlVersion?: number;
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
    idleConfirmationPending?: boolean;
    postCallWaitMs?: number;
    observedAttemptId?: string | null;
    observedLeadId?: string | null;
    deadlineDispatchEnabled?: boolean;
    deadlinePreparationMs?: number;
    nativeDialProtocol?: number;
    nativeDialReady?: boolean;
};

export async function requestNativeCall(employeeCode: string, options: { businessId: string; employeeSession: string;
    attemptId: string; leadId: string; normalizedPhone: string; manual?: boolean; manualHoldVersion?: number; timeoutMs?: number; signal?: AbortSignal }) {
    const binding = readBrowserSession();
    const response = await api.post<{ queued: boolean; claimed: boolean; attemptId: string; leadId: string; serverTime: string; dialIntentUntil: string }>(
        "/call-bridge/native-dial", { employeeCode, attemptId: options.attemptId, leadId: options.leadId, normalizedPhone: options.normalizedPhone,
            manual: options.manual === true, manualHoldVersion: options.manualHoldVersion, browserDeviceKey: getStoredBrowserDeviceKey(),
            browserSessionId: binding?.employeeCode === employeeCode && binding.businessId === options.businessId ? binding.sessionId : "" },
        { timeout: options.timeoutMs, signal: options.signal, headers: { ...autoCallClientHeaders, "X-Business-Id": options.businessId, "X-CRM-Attendance-Session": options.employeeSession } });
    return response.data;
}

export async function cancelNativeCall(employeeCode: string, options: { businessId: string; employeeSession: string; attemptId: string; leadId: string }) {
    await fetch(new URL("/api/call-bridge/native-dial/cancel", backendOrigin), { method: "POST", keepalive: true,
        headers: { "Content-Type": "application/json", "X-Business-Id": options.businessId, "X-CRM-Attendance-Session": options.employeeSession,
            "X-CRM-User-Code": employeeCode, "X-CRM-User-Type": "employee" },
        body: JSON.stringify({ employeeCode, attemptId: options.attemptId, leadId: options.leadId }) });
}

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

export async function verifyCallBridgeDeadlineLaunch(employeeCode: string, options: {businessId: string; employeeSession: string;
    leadId: string; reservationToken: string; timeoutMs: number}) {
    const browserSession = readBrowserSession();
    const response = await api.post<{leadId: string; normalizedPhone: string; serverTime: string; dialIntentUntil: string}>("/call-bridge/verify-deadline-launch",
        {employeeCode, leadId: options.leadId, reservationToken: options.reservationToken, browserDeviceKey: getStoredBrowserDeviceKey(),
            browserSessionId: browserSession?.employeeCode === employeeCode && browserSession.businessId === options.businessId ? browserSession.sessionId : ""},
        {timeout: options.timeoutMs, headers: {...autoCallClientHeaders, "X-Business-Id": options.businessId, "X-CRM-Attendance-Session": options.employeeSession}});
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

export async function holdAutoCallForManual(employeeCode: string, options: {
    businessId: string; employeeSession: string; attemptId: string; leadId: string; normalizedPhone: string; timeoutMs?: number;
}) {
    const auth = getAuthUser();
    if (auth?.userType !== "employee" || auth.user.employeeCode !== employeeCode || auth.attendanceHubSession !== options.employeeSession ||
        getActiveBusinessId() !== options.businessId) throw new Error("Calling session changed");
    const scope = { employeeId: auth.user._id, businessId: options.businessId };
    beginAutoCallPause(scope);
    try {
        const binding = readBrowserSession();
        const response = await api.post<{ autoCallPaused: boolean; autoCallUserPaused: boolean; manualCallHold: boolean; autoCallControlVersion: number }>("/call-bridge/manual-call-hold",
            { employeeCode, attemptId: options.attemptId, leadId: options.leadId, normalizedPhone: options.normalizedPhone,
                browserDeviceKey: getStoredBrowserDeviceKey(), browserSessionId: binding?.employeeCode === employeeCode &&
                    binding.businessId === options.businessId ? binding.sessionId : "" },
            { timeout: options.timeoutMs || 10000, headers: { ...autoCallClientHeaders, "X-Business-Id": options.businessId,
                "X-CRM-Attendance-Session": options.employeeSession } });
        const current = getAuthUser();
        if (current?.userType === "employee" && current.user._id === scope.employeeId && current.attendanceHubSession === options.employeeSession) {
            observeAutoCallControl(scope, response.data, true);
        }
        return response.data;
    } catch (error) {
        const data = (error as { response?: { data?: CallBridgeStatus } }).response?.data;
        if (data) observeAutoCallControl(scope, data, true);
        settleAutoCallPause(scope);
        throw error;
    }
}

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
const activationRequestTimeoutMs = 10_000;

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
        const configuredTimeout = Number(options.timeoutMs);
        const timeoutMs = Number.isFinite(configuredTimeout) && configuredTimeout > 0
            ? Math.min(configuredTimeout, activationRequestTimeoutMs) : activationRequestTimeoutMs;
        const controller = new AbortController();
        let timer: number | undefined;
        try {
            // Every caller shares this promise, so it must settle even if the
            // transport stops delivering its own timeout or abort events.
            const deadline = new Promise<never>((_resolve, reject) => {
                timer = window.setTimeout(() => {
                    reject(Object.assign(new Error("Call Bridge activation timed out. Retrying."), { code: "CALL_BRIDGE_ACTIVATION_TIMEOUT" }));
                    controller.abort();
                }, timeoutMs);
            });
            const response = await Promise.race([api.post<CallBridgeActivation>(
                "/call-bridge/activate",
                { employeeCode, browserDeviceKey, browserSessionId: browserSession.sessionId, browserSessionStartedAt: browserSession.startedAt },
                { timeout: timeoutMs, signal: controller.signal, headers: { "X-Business-Id": businessId,
                    ...(options.employeeSession ? { "X-CRM-Attendance-Session": options.employeeSession } : {}) } }
            ), deadline]);
            attempt.result = response.data;
            // Renew well inside the server's 30-second browser-session freshness
            // window; every dial still rechecks the live binding on the server.
            if (response.data.activated) attempt.retryAfter = Date.now() + 10_000;
            return response.data;
        } catch (error) {
            const response = (error as { response?: { status?: number; data?: { code?: string; message?: string } } }).response;
            const code = response?.data?.code;
            if (response?.status === 409 && (code === "NEWER_BROWSER_SESSION_ACTIVE" || code === "CALL_BRIDGE_BUSY")) {
                attempt.retryAfter = Date.now() + (code === "CALL_BRIDGE_BUSY" ? 5000 : activationConflictRetryMs);
                attempt.result = { activated: false, switchable: true, employeeCode, code,
                    reason: response.data?.message || "Call Bridge is waiting for the current browser session or call to finish." };
                return attempt.result;
            }
            attempt.result = { activated: false, switchable: true, employeeCode,
                reason: "Call Bridge activation could not be verified. Retrying." };
            throw error;
        } finally {
            window.clearTimeout(timer);
            attempt.pending = undefined;
        }
    })();
    return attempt.pending;
}

type StatusRead = {
    cancel: () => void;
    promise: Promise<CallBridgeStatus>;
    consumers: number;
    settled: boolean;
};
const pendingStatusReads = new Map<string, StatusRead>();
const statusReadTimeoutMs = 10_000;

function sharedStatusRead(key: string, params: { employeeCode: string; mode?: "manual" }, headers: Record<string, string>, timeoutMs: number) {
    let entry = pendingStatusReads.get(key);
    if (!entry) {
        const controller = new AbortController();
        const transport = Promise.resolve().then(() => api.get<CallBridgeStatus>("/call-bridge/status", {
            params, timeout: statusReadTimeoutMs, signal: controller.signal, headers,
        }));
        let timer: number | undefined;
        let cancel = () => {};
        const deadline = new Promise<never>((_resolve, reject) => {
            cancel = () => {
                reject(Object.assign(new Error("Call Bridge status timed out. Retrying."), { code: "CALL_BRIDGE_STATUS_TIMEOUT" }));
                controller.abort();
            };
            timer = window.setTimeout(cancel, statusReadTimeoutMs);
        });
        const settled = () => {
            created.settled = true;
            window.clearTimeout(timer);
            if (pendingStatusReads.get(key) === created) pendingStatusReads.delete(key);
        };
        const created: StatusRead = { cancel, consumers: 0, settled: false, promise: Promise.race([transport, deadline]).then(response => {
            settled();
            return { ...response.data, clientReceivedAt: Date.now(),
                clientReceivedAtMonotonic: typeof performance === "undefined" ? undefined : performance.now() };
        }, error => { settled(); throw error; }) };
        pendingStatusReads.set(key, created);
        entry = created;
    }
    const current = entry;
    current.consumers++;
    return new Promise<CallBridgeStatus>((resolve, reject) => {
        let done = false;
        const finish = () => {
            if (done) return false;
            done = true;
            window.clearTimeout(timer);
            current.consumers--;
            if (!current.consumers && !current.settled) {
                if (pendingStatusReads.get(key) === current) pendingStatusReads.delete(key);
                current.cancel();
            }
            return true;
        };
        const timer = window.setTimeout(() => {
            if (finish()) reject(Object.assign(new Error("Call Bridge status timed out. Retrying."), { code: "CALL_BRIDGE_STATUS_TIMEOUT" }));
        }, timeoutMs);
        current.promise.then(value => { if (finish()) resolve(value); }, error => { if (finish()) reject(error); });
    });
}

export async function getCallBridgeStatus(employeeCode: string, options: { timeoutMs?: number; businessId?: string; employeeSession?: string; mode?: "manual" } = {}) {
    // A live device alone does not authorize a browser whose activation was rejected.
    await currentActivationAttempt(employeeCode)?.pending?.catch(() => undefined);
    const auth = getAuthUser(), binding = readBrowserSession(), businessId = options.businessId || getActiveBusinessId();
    const session = options.employeeSession || auth?.attendanceHubSession || "", browserKey = getStoredBrowserDeviceKey();
    const adminSession = auth?.userType === "admin" ? auth.sessionToken || "" : "";
    const browserSession = binding?.employeeCode === employeeCode && binding.businessId === businessId ? binding.sessionId : "";
    const key = JSON.stringify([businessId, employeeCode, session, auth?.userType, auth?.user.employeeCode, adminSession, browserKey, browserSession, options.mode]);
    const requestedTimeout = Number(options.timeoutMs);
    const timeoutMs = Number.isFinite(requestedTimeout) && requestedTimeout > 0 ? Math.min(requestedTimeout, statusReadTimeoutMs) : statusReadTimeoutMs;
    // Share only the in-flight read, never a completed readiness result or a dial authorization.
    const response = await sharedStatusRead(key, { employeeCode, ...(options.mode ? { mode: options.mode } : {}) }, { "X-CRM-Native-Dial": "1", "X-CRM-Bridge-Browser-Key": browserKey,
        "X-CRM-Bridge-Browser-Session": browserSession, ...(businessId ? { "X-Business-Id": businessId } : {}),
        ...(session ? { "X-CRM-Attendance-Session": session } : {}),
        ...(adminSession ? { "X-CRM-Admin-Session": adminSession } : {}) }, timeoutMs);
    const activation = currentActivationAttempt(employeeCode)?.result;
    const current = getAuthUser();
    if (auth?.userType === "employee" && auth.user._id && current?.userType === "employee" && auth.user._id === current.user._id &&
        current.user.employeeCode === employeeCode && current.attendanceHubSession === session) {
        observeAutoCallControl({ employeeId: current.user._id, businessId: businessId || "default" }, response);
    }
    return { ...response,
        ...(activation?.switchable && !activation.activated ? { ready: false, reason: activation.reason || response.reason } : {}) };
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
