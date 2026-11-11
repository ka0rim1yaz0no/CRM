import { getAuthUser } from "../api/authStorage";
import { getActiveBusinessId } from "../api/businessStorage";
import { attendanceIntegrityEnabled, getAttendanceStatus } from "../api/attendanceSession";
import { activateCallBridgeForEmployee, canUseCallBridgeBrowserSession, getCallBridgeStatus, requestNativeCall, releaseCallBridgeCall, cancelNativeCall, holdAutoCallForManual } from "../api/callBridge";
import { callingAttendanceBlock, callingAttendancePending, callingAttendanceChanged } from "./callingAttendance";
import { callingWorkMessage, setCallingWork, callingWorkflowChanged, type CallingScope } from "./callingWorkflow";
import { observeCallingBridge } from "./callingDisplay";
import { beginAutoCallPause, settleAutoCallPause } from "./autoCallControl";

export async function callLeadThroughBridge(scope: CallingScope, leadId: string, normalizedPhone: string) {
    const auth = getAuthUser();
    if (auth?.userType !== "employee" || auth.user._id !== scope.employeeId || !auth.attendanceHubSession) throw new Error("Sign in again before calling");
    const code = auth.user.employeeCode, session = auth.attendanceHubSession;
    let leaving = false, cancelled = false;
    const current = () => {
        const user = getAuthUser();
        return !leaving && !cancelled && user?.userType === "employee" && user.user._id === scope.employeeId && user.user.employeeCode === code &&
            user.attendanceHubSession === session && getActiveBusinessId() === scope.businessId;
    };
    const attendanceBlock = () => callingAttendanceBlock(code, "manual");
    let attendanceChecked = !attendanceIntegrityEnabled;
    if (!current()) throw new Error("Calling session changed");
    const initialBlock = (attendanceChecked ? attendanceBlock() : "") || callingWorkMessage(scope);
    if (callingAttendancePending(code) || initialBlock) throw new Error(initialBlock || "Saving attendance. Try again once it is confirmed.");
    const owner = Symbol("manual-native-call"), attemptId = crypto.randomUUID();
    const options = { businessId: scope.businessId, employeeSession: session, timeoutMs: 10000 };
    const statusOptions = { ...options, mode: "manual" as const };
    let confirmed = false, requested = false;
    const controller = new AbortController();
    const cancel = () => { if (!confirmed) void cancelNativeCall(code, { ...options, attemptId, leadId }).catch(() => undefined); };
    const pagehide = () => { leaving = true; controller.abort(); cancel(); };
    const changed = () => {
        if (!current() || callingAttendancePending(code) || (attendanceChecked && attendanceBlock()) || callingWorkMessage(scope, owner)) {
            cancelled = true; controller.abort(); cancel();
        }
    };
    const events = [callingAttendanceChanged, callingWorkflowChanged, "crm:auth-changed", "crm:business-changed", "storage"];
    for (const event of events) window.addEventListener(event, changed);
    window.addEventListener("pagehide", pagehide);
    setCallingWork(scope, owner, "Waiting for manual call confirmation");
    beginAutoCallPause(scope);
    try {
        if (attendanceIntegrityEnabled) {
            await getAttendanceStatus(scope.employeeId, scope.businessId);
            attendanceChecked = true;
            if (!current() || callingAttendancePending(code)) throw new Error("Calling session or attendance changed");
            const blocked = attendanceBlock();
            if (blocked) throw new Error(blocked);
        }
        await activateCallBridgeForEmployee(code, options);
        if (!current() || !canUseCallBridgeBrowserSession(code) || attendanceBlock()) throw new Error("Calling session changed");
        const hold = await holdAutoCallForManual(code, { ...options, attemptId, leadId, normalizedPhone });
        if (!Number.isSafeInteger(hold.autoCallControlVersion) || hold.autoCallControlVersion < 0 || !hold.manualCallHold) throw new Error("Manual calling hold was not confirmed");
        if (!current()) throw new Error("Calling session changed");
        const preflightEnd = performance.now() + 45_000;
        while (true) {
            if (performance.now() >= preflightEnd) throw new Error("The previous call end could not be confirmed. Check Nextiva before trying again");
            if (!current() || !canUseCallBridgeBrowserSession(code) || callingAttendancePending(code) || attendanceBlock() || callingWorkMessage(scope, owner)) throw new Error("Calling session, attendance or lead work changed");
            const bridge = await getCallBridgeStatus(code, { ...statusOptions, timeoutMs: Math.min(options.timeoutMs, Math.max(1, preflightEnd - performance.now())) });
            if (current()) observeCallingBridge(scope, bridge);
            if (performance.now() >= preflightEnd) throw new Error("The previous call end could not be confirmed. Check Nextiva before trying again");
            if (!current() || !bridge.nativeDialReady || callingAttendancePending(code) || attendanceBlock() || callingWorkMessage(scope, owner)) throw new Error(bridge.reason || "Call Bridge is not ready");
            if (bridge.ready || (bridge.connected && bridge.state === "idle" && bridge.waitCode === "POST_CALL_COOLDOWN")) break;
            const confirming = bridge.waitCode === "CALL_END_UNCONFIRMED" && bridge.idleConfirmationPending === true;
            if (!bridge.connected || !confirming) throw new Error(bridge.reason || "Call Bridge is not ready");
            setCallingWork(scope, owner, "Waiting for previous call confirmation");
            await new Promise(resolve => window.setTimeout(resolve, Math.min(1000, preflightEnd - performance.now())));
        }
        requested = true;
        const command = await requestNativeCall(code, { ...options, attemptId, leadId, normalizedPhone, manual: true,
            manualHoldVersion: hold.autoCallControlVersion, signal: controller.signal });
        if (!current() || callingAttendancePending(code) || attendanceBlock() || callingWorkMessage(scope, owner)) throw new Error("Calling state changed before confirmation");
        if (!command.queued || command.attemptId !== attemptId || command.leadId !== leadId) throw new Error("Native call target changed");
        const remaining = Date.parse(command.dialIntentUntil) - Date.parse(command.serverTime);
        if (!Number.isFinite(remaining) || remaining <= 0 || remaining > 30000) throw new Error("Call authorization expired");
        const end = performance.now() + remaining;
        while (current() && performance.now() < end) {
            await new Promise(resolve => window.setTimeout(resolve, Math.min(1000, end - performance.now())));
            if (!current()) break;
            const state = await getCallBridgeStatus(code, statusOptions);
            if (current()) observeCallingBridge(scope, state);
            if (state.observedAttemptId === attemptId && state.observedLeadId === leadId) { confirmed = true; break; }
            if (attendanceBlock()) break;
        }
        if (!current() || !confirmed) throw new Error("Call launch was not confirmed. Check Nextiva before trying again");
        return { employeeCode: code };
    } finally {
        window.removeEventListener("pagehide", pagehide);
        for (const event of events) window.removeEventListener(event, changed);
        if (!confirmed) settleAutoCallPause(scope);
        cancel();
        if (requested && !confirmed) await releaseCallBridgeCall(code, { ...options, leadId, reservationToken: attemptId }).catch(() => undefined);
        setCallingWork(scope, owner, "");
    }
}
