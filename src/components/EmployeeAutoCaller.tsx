import { useEffect, useLayoutEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { useLocation, useNavigate } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import { getAuthUser } from "../api/authStorage";
import { getActiveBusinessId } from "../api/businessStorage";
import { activateCallBridgeForEmployee, callTimingV2Enabled, canUseCallBridgeBrowserSession, getCallBridgeStatus, markCallBridgeDialStarted, prepareCallBridgeDeadline, releaseCallBridgeCall, reserveCallBridgeCall } from "../api/callBridge";
import { getEmployeeSummary, normalizeEmployeeAvailabilityStatus } from "../api/employees";
import { attendanceIntegrityEnabled, getAttendanceSession } from "../api/attendanceSession";
import { callingAttendanceBlock, callingAttendancePending, callingAttendanceChanged } from "../lib/callingAttendance";
import { getLead, recordLeadCall, type Lead } from "../api/leads";
import { leadBelongsToEmployee } from "../../shared/leadAssignmentPolicy";
import { AUTO_CALL_API_TIMEOUT_MS, AUTO_CALL_CHECK_INTERVAL_MS, getEmployeeCommentMarker, isSalesRole, startAutoCallPendingComment } from "../lib/employeeAutoCall";
import { callingQueueKey, callingWorkMessage, callingWorkflowChanged, setCallingProgress } from "../lib/callingWorkflow";
import { fetchCallingQueue } from "../lib/useCallingQueue";
import { socket } from "../lib/socket";

function currentScope() {
    const auth = getAuthUser();
    return auth?.userType === "employee" ? JSON.stringify([auth.user._id, auth.user.employeeCode, getActiveBusinessId(), auth.attendanceHubSession || ""]) : "";
}
function subscribeIdentity(listener: () => void) {
    for (const name of ["crm:auth-changed", "crm:business-changed", "storage"]) window.addEventListener(name, listener);
    return () => { for (const name of ["crm:auth-changed", "crm:business-changed", "storage"]) window.removeEventListener(name, listener); };
}
type Attempt = { id: string; lead: Lead; phone: string; queueVersion: string; token: string; phase: "reserve" | "dispatch"; expiresAt: number };

export default function EmployeeAutoCaller() {
    const navigate = useNavigate(), location = useLocation();
    const router = useRef({ navigate, location });
    useLayoutEffect(() => { router.current = { navigate, location }; }, [navigate, location]);
    const identity = useSyncExternalStore(subscribeIdentity, currentScope);
    const [employeeId = "", employeeCode = "", businessId = "", employeeSession = ""]: string[] = identity ? JSON.parse(identity) : [];
    const scope = useMemo(() => ({ employeeId, businessId }), [employeeId, businessId]);
    const queryClient = useQueryClient();
    const auth = getAuthUser();
    const salesEmployee = isSalesRole(auth?.user.role, auth?.userType === "employee" ? auth.user.team : undefined);
    const employeeRoute = location.pathname !== "/login" && !location.pathname.startsWith("/admin/");
    const operation = useRef<symbol | null>(null);
    useEffect(() => {
        if (!identity || !employeeId || !businessId || !salesEmployee || !employeeRoute) return;
        if (!callTimingV2Enabled) { setCallingProgress(scope, "Automatic calling requires the approved timing configuration. Refresh or contact an administrator."); return; }
        let disposed = false, retryRequested = false, timer: number | undefined, prepareTimer: number | undefined;
        let pending: Attempt | null = null;
        let deadlinePending: {id: string; notBefore: string; expiresAt: number; serverTime: number; receivedAt: number} | null = null;
        let deadlineRequest: AbortController | undefined;
        let retryAfter = 0, consecutiveFailures = 0;
        const current = () => !disposed && currentScope() === identity;
        const canContinue = () => current() && !callingWorkMessage(scope) && !callingAttendanceBlock(employeeCode);
        const options = { businessId, employeeSession, timeoutMs: AUTO_CALL_API_TIMEOUT_MS };
        const showCallLead = (lead: Lead) => {
            if (!current()) return;
            queryClient.setQueryData(["lead", businessId, lead._id], lead);
            const route = router.current;
            if (route.location.pathname === "/leads" && new URLSearchParams(route.location.search).get("lead") === lead._id) return;
            const params = new URLSearchParams(route.location.pathname === "/leads" ? route.location.search : "");
            params.set("lead", lead._id);
            route.navigate({ pathname: "/leads", search: `?${params}` }, { replace: true,
                state: { autoCallLead: lead, autoCallPreserveFilters: true, autoCallBusinessId: businessId, autoCallEmployeeId: employeeId } });
        };
        let restoredAttempt = "";
        const progress = (message: string) => { if (current()) setCallingProgress(scope, message); };
        const invalidate = () => { void queryClient.invalidateQueries({ queryKey: callingQueueKey(scope) }, { cancelRefetch: false }); };
        const arm = (remaining: number, prepare = true) => {
            window.clearTimeout(timer); window.clearTimeout(prepareTimer);
            const delay = Math.min(2147483647, Math.max(0, remaining));
            timer = window.setTimeout(() => { void tick(true); }, delay);
            if (prepare && delay > 12000) prepareTimer = window.setTimeout(() => { void tick(true); }, delay - 12000);
        };
        const release = async (attempt: Attempt) => {
            try { await releaseCallBridgeCall(employeeCode, { ...options, leadId: attempt.lead._id, reservationToken: attempt.token || attempt.id }); }
            catch { /* The server lease expires even when cleanup cannot reach it. */ }
        };
        const tick = async (retryIfBusy = false) => {
            if (!current() || performance.now() < retryAfter) return;
            if (operation.current) { if (retryIfBusy) retryRequested = true; return; }
            const owner = Symbol("auto-call-operation"); operation.current = owner;
            let launched = false, consumed = false, failed = false;
            try {
                const work = callingWorkMessage(scope);
                if (work) { progress(work); return; }
                if (callingAttendancePending(employeeCode)) { progress("Saving attendance"); return; }
                progress("Checking attendance");
                const own = getAuthUser();
                if (own?.userType !== "employee") return;
                const employee = attendanceIntegrityEnabled ? own.user : await getEmployeeSummary(employeeId, options);
                const attendance = attendanceIntegrityEnabled ? await getAttendanceSession(employeeId, businessId) : null;
                if (!current()) return;
                if (!isSalesRole(employee.role, employee.team) || (attendance ? attendance.state !== "ONLINE" : normalizeEmployeeAvailabilityStatus(employee.availabilityStatus) !== "ONLINE") || callingAttendanceBlock(employeeCode)) {
                    progress("Employee not ONLINE"); return;
                }
                if (pending && performance.now() >= pending.expiresAt) { await release(pending); pending = null; }
                if (deadlinePending && performance.now() >= deadlinePending.expiresAt) deadlinePending = null;
                let prepared: Awaited<ReturnType<typeof prepareCallBridgeDeadline>> | null = null;
                if (!pending && !deadlinePending) {
                    progress("Connecting to Call Bridge");
                    await activateCallBridgeForEmployee(employeeCode, options);
                    if (!canContinue()) return;
                    if (!canUseCallBridgeBrowserSession(employeeCode)) { progress("Call Bridge is waiting for this browser session"); return; }
                    progress("Checking Call Bridge readiness");
                    const bridge = await getCallBridgeStatus(employeeCode, options);
                    if (!canContinue()) return;
                    const snapshotAge = bridge.clientReceivedAtMonotonic === undefined ? 0 : Math.max(0, performance.now() - bridge.clientReceivedAtMonotonic);
                    const remaining = bridge.nextCallAllowedAt && bridge.serverTime ? +new Date(bridge.nextCallAllowedAt) - +new Date(bridge.serverTime) - snapshotAge : 0;
                    const confirmedDeadline = bridge.lastCallEndedAt && bridge.nextCallAllowedAt &&
                        Date.parse(bridge.nextCallAllowedAt) === Date.parse(bridge.lastCallEndedAt) + 30000;
                    if (bridge.deadlineDispatchEnabled && bridge.state === "idle" && confirmedDeadline && bridge.serverTime && remaining <= 12000 && remaining > -45000) {
                        deadlinePending = {id: crypto.randomUUID(), notBefore: bridge.nextCallAllowedAt!, expiresAt: performance.now() + Math.max(0, remaining) + 25000,
                            serverTime: Date.parse(bridge.serverTime), receivedAt: bridge.clientReceivedAtMonotonic ?? performance.now()};
                    } else if (!bridge.ready) {
                        if (bridge.state === "active") {
                            progress("Waiting for current call to end");
                            const observed = `${bridge.observedAttemptId || ""}:${bridge.observedLeadId || ""}`;
                            if (bridge.observedLeadId && bridge.observedAttemptId && observed !== restoredAttempt) {
                                try {
                                    const lead = await getLead(bridge.observedLeadId, options);
                                    if (current() && leadBelongsToEmployee(lead, employeeId, [employee.name, employee.employeeCode, ...(employee.aliases || [])])) {
                                        showCallLead(lead); restoredAttempt = observed;
                                    }
                                } catch { /* A stale or foreign-business observed lead must not replace this employee's detail. */ }
                            }
                        }
                        else if (bridge.state === "calling") progress("Dial requested; waiting for call confirmation");
                        else if (bridge.state === "unknown" || bridge.state === "offline") progress(bridge.reason || "Call Bridge unavailable");
                        else if (remaining > 0) { progress(bridge.waitCode === "DIAL_RETRY_WAIT" ? "Waiting for the unconfirmed dial retry deadline" : "Waiting for call cooldown"); arm(remaining); }
                        else progress(bridge.reason || "Call Bridge unavailable");
                        return;
                    }
                    if (!deadlinePending) {
                        progress("Checking calling queue");
                        const page = await queryClient.fetchQuery({ queryKey: callingQueueKey(scope), queryFn: () => fetchCallingQueue(scope, employeeSession), staleTime: 0, retry: false, networkMode: "always" });
                        if (!canContinue()) return;
                        const queue = page.callingQueue!;
                        if (!queue.callingWindow.permitted) {
                            progress("Outside calling hours");
                            if (queue.callingWindow.nextStartAt) arm(+new Date(queue.callingWindow.nextStartAt) - +new Date(queue.serverTime));
                            return;
                        }
                        if (!queue.nextLead || !queue.nextDecision?.normalizedPhone) {
                            progress(queue.nextEligibilityChangeAt ? "Waiting for the next scheduled lead or comment cooldown" : "No eligible assigned leads"); return;
                        }
                        pending = { id: crypto.randomUUID(), lead: queue.nextLead, phone: queue.nextDecision.normalizedPhone, queueVersion: queue.version,
                            token: "", phase: "reserve", expiresAt: performance.now() + 45000 };
                    }
                }
                if (deadlinePending) {
                    progress("Preparing next call for the cooldown deadline");
                    deadlineRequest = new AbortController();
                    try { prepared = await prepareCallBridgeDeadline(employeeCode, {...options, attemptId: deadlinePending.id,
                        notBefore: deadlinePending.notBefore, signal: deadlineRequest.signal, timeoutMs: 25000}); }
                    finally { deadlineRequest = undefined; }
                    const plan = deadlinePending, id = plan.id; deadlinePending = null;
                    consumed = true;
                    if (!prepared.lead) { progress("Dial launch already processed; waiting for confirmation"); return; }
                    pending = {id, lead: prepared.lead, phone: prepared.normalizedPhone, queueVersion: "", token: prepared.reservationToken,
                        phase: "dispatch", expiresAt: performance.now() + 45000};
                    const responseAge = plan.serverTime + performance.now() - plan.receivedAt - Date.parse(prepared.serverTime);
                    if (!Number.isFinite(responseAge) || Math.abs(responseAge) > 2000) {
                        if (!prepared.alreadyStarted) await release(pending); pending = null;
                        progress("Call authorization arrived late. Checking current server state"); return;
                    }
                }
                if (!pending) return;
                const attempt = pending;
                if (!canContinue()) { if (prepared) { await release(attempt); pending = null; } return; }
                if (attempt.phase === "reserve") {
                    progress("Reserving next call");
                    const reservation = await reserveCallBridgeCall(employeeCode, { ...options, attemptId: attempt.id, leadId: attempt.lead._id,
                        queueVersion: attempt.queueVersion, normalizedPhone: attempt.phone });
                    if (!reservation.allowed) { pending = null; progress(reservation.reason || "Call Bridge unavailable"); invalidate(); return; }
                    attempt.token = reservation.reservationToken; attempt.phase = "dispatch";
                    if (reservation.leadId !== attempt.lead._id || reservation.normalizedPhone !== attempt.phone) {
                        await release(attempt); pending = null; progress("The reserved call target changed. Refreshing queue"); invalidate(); return;
                    }
                }
                if (!canContinue()) { await release(attempt); pending = null; return; }
                progress("Confirming dial permission");
                const dispatch = prepared || await markCallBridgeDialStarted(employeeCode, { ...options, leadId: attempt.lead._id, reservationToken: attempt.token });
                consumed = true; pending = null;
                if (!canContinue() || !canUseCallBridgeBrowserSession(employeeCode) || dispatch.leadId !== attempt.lead._id || dispatch.normalizedPhone !== attempt.phone) {
                    if (!dispatch.alreadyStarted) await release(attempt);
                    return;
                }
                showCallLead(attempt.lead);
                restoredAttempt = `${attempt.id}:${attempt.lead._id}`;
                if (dispatch.alreadyStarted) progress("Dial launch already processed; waiting for confirmation");
                else {
                    startAutoCallPendingComment(`${businessId}:${employeeCode}`, attempt.lead._id, getEmployeeCommentMarker(attempt.lead.comments));
                    const link = document.createElement("a"); link.href = `tel:${dispatch.normalizedPhone}`;
                    link.setAttribute("aria-hidden", "true"); document.body.appendChild(link);
                    try { link.click(); launched = true; } finally { link.remove(); }
                    progress("Dial requested; waiting for call confirmation");
                }
                const confirmationRemaining = +new Date(dispatch.dialIntentUntil) - +new Date(dispatch.serverTime);
                if (!Number.isFinite(confirmationRemaining)) throw new Error("Dial confirmation deadline is missing. Waiting for server state.");
                const confirmationDeadline = performance.now() + Math.max(0, confirmationRemaining);
                let confirmed = false;
                while (current() && performance.now() < confirmationDeadline) {
                    await new Promise(resolve => window.setTimeout(resolve, Math.min(2000, Math.max(0, confirmationDeadline - performance.now()))));
                    if (!current()) break;
                    const state = await getCallBridgeStatus(employeeCode, options);
                    if (!current()) break;
                    if (state.observedAttemptId === attempt.id && state.observedLeadId === attempt.lead._id) { confirmed = true; break; }
                }
                if (current()) {
                    progress(confirmed ? "Waiting for current call to end" : "Dial launch not confirmed");
                    await recordLeadCall(attempt.lead._id, { activityActorName: employee.name, activityActorType: "employee", employeeId,
                        callOutcome: confirmed ? "confirmed" : "failed" }, options).catch(() => undefined);
                    if (!confirmed) await release(attempt);
                    invalidate();
                }
            } catch (error) {
                failed = true;
                if ((error as {code?: string; name?: string}).code === "ERR_CANCELED" || (error as {name?: string}).name === "AbortError") {
                    failed = false; deadlinePending = null; progress(callingAttendanceBlock(employeeCode) || callingWorkMessage(scope) || "Checking current calling state"); return;
                }
                const response = (error as { response?: { data?: { code?: string; message?: string; reason?: string; serverTime?: string; nextCallAllowedAt?: string }; status?: number } }).response;
                if (response && (response.status || 0) < 500) {
                    if (pending) { await release(pending); pending = null; }
                    progress(response.data?.message || response.data?.reason || "Calling request failed. Retrying"); invalidate();
                } else progress(consumed || launched ? "Dial launch not confirmed" : "Queue or call service unavailable. Retrying");
                if (response?.status === 409) {
                    failed = false;
                    deadlinePending = null;
                    const remaining = response.data?.nextCallAllowedAt && response.data.serverTime
                        ? Date.parse(response.data.nextCallAllowedAt) - Date.parse(response.data.serverTime) : 0;
                    if (current()) arm(Math.max(250, Number.isFinite(remaining) && remaining > 0 ? remaining : AUTO_CALL_CHECK_INTERVAL_MS), false);
                    return;
                }
                // A lost response retains its logical attempt/token for an idempotent retry.
                const delay = Math.min(30000, AUTO_CALL_CHECK_INTERVAL_MS * 2 ** Math.min(consecutiveFailures++, 3));
                retryAfter = performance.now() + delay;
                if (current()) arm(delay, false);
            } finally {
                if (!failed) consecutiveFailures = 0;
                if (disposed && pending) { await release(pending); pending = null; }
                if (operation.current === owner) operation.current = null;
                if (current() && retryRequested) { retryRequested = false; void tick(); }
            }
        };
        const refresh = () => { if (current()) { invalidate(); void tick(true); } };
        const visible = () => { if (document.visibilityState === "visible") refresh(); };
        const workChanged = () => {
            if (!canContinue()) deadlineRequest?.abort();
            if (!callingWorkMessage(scope)) void tick(true);
        };
        void tick();
        const interval = window.setInterval(() => { void tick(); }, AUTO_CALL_CHECK_INTERVAL_MS);
        window.addEventListener("focus", refresh); window.addEventListener("online", refresh); window.addEventListener("pageshow", refresh);
        document.addEventListener("visibilitychange", visible);
        window.addEventListener(callingWorkflowChanged, workChanged);
        window.addEventListener(callingAttendanceChanged, workChanged);
        window.addEventListener("storage", workChanged);
        socket.on("connect", refresh); socket.on("lead:changed", refresh); socket.on("call-dashboard:updated", refresh);
        return () => {
            disposed = true; window.clearInterval(interval); window.clearTimeout(timer); window.clearTimeout(prepareTimer);
            deadlineRequest?.abort();
            window.removeEventListener("focus", refresh); window.removeEventListener("online", refresh); window.removeEventListener("pageshow", refresh);
            document.removeEventListener("visibilitychange", visible);
            window.removeEventListener(callingWorkflowChanged, workChanged); socket.off("connect", refresh); socket.off("lead:changed", refresh); socket.off("call-dashboard:updated", refresh);
            window.removeEventListener(callingAttendanceChanged, workChanged); window.removeEventListener("storage", workChanged);
            if (pending) void release(pending);
        };
    }, [identity, employeeId, employeeCode, businessId, employeeSession, queryClient, scope, salesEmployee, employeeRoute]);
    return null;
}
