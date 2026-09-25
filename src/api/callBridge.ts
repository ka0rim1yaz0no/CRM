import { getActiveBusinessId } from "./businessStorage";
import { api } from "../lib/api";
import { backendOrigin } from "../lib/backendUrl";

export type CallBridgeState = "offline" | "unknown" | "idle" | "calling" | "active";

export type CallBridgeStatus = {
    employeeCode: string;
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
};

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
};

export type CallBridgeReservation =
    | {
        allowed: true;
        employeeCode: string;
        state: "calling";
        callLeaseUntil: string;
    }
    | ({ allowed: false } & CallBridgeStatus);

const browserDeviceKeyStorageKey = "crm:call-bridge:browser-device-key:v1";
const browserSessionStorageKey = "crm:call-bridge:browser-session:v1";

type BrowserSession = {
    employeeCode: string;
    businessId: string;
    sessionId: string;
    startedAt: number;
};

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
    options: { timeoutMs?: number } = {}
) {
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
    const response = await api.post<CallBridgeActivation>(
        "/call-bridge/activate",
        {
            employeeCode,
            browserDeviceKey,
            browserSessionId: browserSession.sessionId,
            browserSessionStartedAt: browserSession.startedAt,
        },
        { timeout: options.timeoutMs }
    );

    return response.data;
}

export async function getCallBridgeStatus(employeeCode: string, options: { timeoutMs?: number } = {}) {
    const response = await api.get<CallBridgeStatus>("/call-bridge/status", {
        params: { employeeCode },
        timeout: options.timeoutMs,
    });
    return response.data;
}

export async function reserveCallBridgeCall(employeeCode: string, options: { timeoutMs?: number; leadId?: string } = {}) {
    const response = await api.post<CallBridgeReservation>(
        "/call-bridge/reserve",
        { employeeCode, leadId: options.leadId },
        { timeout: options.timeoutMs }
    );
    return response.data;
}

export async function markCallBridgeDialStarted(employeeCode: string, options: { timeoutMs?: number; leadId?: string } = {}) {
    const response = await api.post<{ startedAt: string; dialIntentUntil: string }>(
        "/call-bridge/dial-start",
        { employeeCode, leadId: options.leadId },
        { timeout: options.timeoutMs }
    );
    return response.data;
}

export async function releaseCallBridgeCall(employeeCode: string, options: { timeoutMs?: number } = {}) {
    const response = await api.post<CallBridgeStatus>("/call-bridge/release", { employeeCode }, { timeout: options.timeoutMs });
    return response.data;
}

export async function revokeCallBridgeDevices(employeeCode: string) {
    const response = await api.delete<{ message: string; devicesRemoved: number }>("/call-bridge/devices", {
        data: { employeeCode },
    });
    return response.data;
}

export const callBridgePackageUrl = `${backendOrigin}/api/call-bridge/package`;
export const callBridgeBackendUrl = backendOrigin;
export const callBridgeBusinessId = () => getActiveBusinessId() || "default";
