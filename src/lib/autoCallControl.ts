import type { CallingScope } from "./callingWorkflow";

export const autoCallControlChanged = "crm:auto-call-control-changed";
export type AutoCallControl = Readonly<{ paused: boolean; userPaused: boolean; manualHold: boolean; version: number; pending: boolean }>;
const empty: AutoCallControl = Object.freeze({ paused: false, userPaused: false, manualHold: false, version: 0, pending: false });
const states = new Map<string, { raw: string; value: AutoCallControl }>();
const storageKey = (scope: CallingScope) => `crm:auto-call-control:v1:${scope.employeeId}`;

export function getAutoCallControl(scope: CallingScope): AutoCallControl {
    const key = storageKey(scope), cached = states.get(key);
    let raw = cached?.raw || "";
    try { raw = window.localStorage.getItem(key) || ""; } catch { /* Keep the in-memory hold when storage is unavailable. */ }
    if (cached?.raw === raw) return cached.value;
    let value = empty;
    try {
        const parsed = JSON.parse(raw);
        if (typeof parsed.paused === "boolean" && Number.isSafeInteger(parsed.version) && parsed.version >= 0) {
            value = Object.freeze({ paused: parsed.paused, userPaused: typeof parsed.userPaused === "boolean" ? parsed.userPaused : (parsed.paused && !parsed.manualHold),
                manualHold: parsed.manualHold === true, version: parsed.version, pending: parsed.pending === true });
        }
    } catch { /* An absent or malformed cache never authorizes a server-side call. */ }
    states.set(key, { raw, value });
    return value;
}

function store(scope: CallingScope, value: AutoCallControl) {
    const key = storageKey(scope), previous = getAutoCallControl(scope), raw = JSON.stringify({ ...value, pending: false });
    if (previous.paused === value.paused && previous.version === value.version && previous.pending === value.pending &&
        previous.userPaused === value.userPaused && previous.manualHold === value.manualHold) return;
    states.set(key, { raw, value: Object.freeze(value) });
    try { window.localStorage.setItem(key, raw); } catch { /* The server-side hold remains authoritative. */ }
    window.dispatchEvent(new Event(autoCallControlChanged));
}

export function beginAutoCallPause(scope: CallingScope) {
    const current = getAutoCallControl(scope);
    store(scope, { ...current, paused: true, manualHold: true, pending: true });
}

export function settleAutoCallPause(scope: CallingScope) {
    store(scope, { ...getAutoCallControl(scope), pending: false });
}

export function observeAutoCallControl(scope: CallingScope, data: { autoCallPaused?: boolean; autoCallUserPaused?: boolean;
    manualCallHold?: boolean; autoCallControlVersion?: number }, mutation = false) {
    if (typeof data.autoCallPaused !== "boolean" || !Number.isSafeInteger(data.autoCallControlVersion) || data.autoCallControlVersion! < 0) return;
    const current = getAutoCallControl(scope), version = data.autoCallControlVersion!;
    if (version < current.version || !mutation && current.pending && version === current.version) return;
    store(scope, { paused: data.autoCallPaused, userPaused: data.autoCallUserPaused ?? (data.autoCallPaused && !data.manualCallHold),
        manualHold: data.manualCallHold === true, version, pending: false });
}

export function subscribeAutoCallControl(listener: () => void) {
    window.addEventListener(autoCallControlChanged, listener);
    window.addEventListener("storage", listener);
    return () => { window.removeEventListener(autoCallControlChanged, listener); window.removeEventListener("storage", listener); };
}
