import type { CallBridgeStatus } from "../api/callBridge";
import type { CallingScope } from "./callingWorkflow";

export type CallingDisplay = {
    status: "CALL WAITING" | "ON CALL";
    lastCallEndedAt: number;
    serverTime: number;
    receivedAt: number;
    bridgeIssue: string;
    requestIssue: string;
};
const empty: CallingDisplay = Object.freeze({ status: "CALL WAITING", lastCallEndedAt: 0, serverTime: 0, receivedAt: 0, bridgeIssue: "", requestIssue: "" });
const snapshots = new Map<string, CallingDisplay>();
const key = (scope: CallingScope) => JSON.stringify([scope.employeeId, scope.businessId]);
const changed = "crm:calling-display-changed";
const notify = () => window.dispatchEvent(new Event(changed));
export const callingDisplay = (scope: CallingScope) => snapshots.get(key(scope)) || empty;
export function resetCallingDisplay(scope: CallingScope) { snapshots.delete(key(scope)); notify(); }
export function observeCallingBridge(scope: CallingScope, bridge: CallBridgeStatus) {
    const previous = callingDisplay(scope), serverTime = Date.parse(bridge.serverTime || "");
    if (!Number.isFinite(serverTime) || serverTime < previous.serverTime) return;
    const endedAt = Date.parse(bridge.lastCallEndedAt || "");
    const bridgeIssue = !bridge.connected || bridge.state === "unknown" || bridge.state === "offline"
        ? bridge.reason || "Call Bridge is unavailable. New calls are blocked."
        : bridge.nativeDialReady !== true ? "Native dialing is unavailable. Update Call Bridge between calls." : "";
    snapshots.set(key(scope), { ...previous, status: bridge.state === "active" && bridge.connected ? "ON CALL" : "CALL WAITING",
        lastCallEndedAt: Number.isFinite(endedAt) && endedAt <= serverTime ? endedAt : 0,
        serverTime, receivedAt: bridge.clientReceivedAtMonotonic ?? performance.now(), bridgeIssue });
    notify();
}
export function setCallingDisplayIssue(scope: CallingScope, message: string) {
    const previous = callingDisplay(scope);
    if (previous.requestIssue === message) return;
    snapshots.set(key(scope), { ...previous, requestIssue: message }); notify();
}
export function postCallRemainingMs(snapshot: CallingDisplay, now: number) {
    if (snapshot.status === "ON CALL" || !snapshot.lastCallEndedAt || !snapshot.serverTime) return null;
    const serverNow = snapshot.serverTime + Math.max(0, now - snapshot.receivedAt);
    // A retry lease is not another post-call cooldown. Only a confirmed call end anchors these 30 seconds.
    return Math.max(0, Math.min(30000, snapshot.lastCallEndedAt + 30000 - serverNow));
}
export function subscribeCallingDisplay(listener: () => void) {
    window.addEventListener(changed, listener);
    return () => window.removeEventListener(changed, listener);
}
