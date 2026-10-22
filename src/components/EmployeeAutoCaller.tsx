import { useEffect, useLayoutEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { useLocation, useNavigate } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import { getAuthUser } from "../api/authStorage";
import { getActiveBusinessId } from "../api/businessStorage";
import { activateCallBridgeForEmployee, callTimingV2Enabled, canUseCallBridgeBrowserSession, getCallBridgeStatus, markCallBridgeDialStarted, releaseCallBridgeCall, reserveCallBridgeCall } from "../api/callBridge";
import { getEmployeeSummary, normalizeEmployeeAvailabilityStatus } from "../api/employees";
import { getLead, recordLeadCall, type Lead } from "../api/leads";
import { leadBelongsToEmployee } from "../../shared/leadAssignmentPolicy";
import { AUTO_CALL_API_TIMEOUT_MS, AUTO_CALL_CHECK_INTERVAL_MS, getEmployeeCommentMarker, isSalesRole, startAutoCallPendingComment } from "../lib/employeeAutoCall";
import { callingQueueKey, callingWorkMessage, callingWorkflowChanged, setCallingProgress } from "../lib/callingWorkflow";
import { fetchCallingQueue, useCallingQueue } from "../lib/useCallingQueue";
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
    useCallingQueue(scope, Boolean(identity) && employeeRoute && salesEmployee && callTimingV2Enabled);
    const operation = useRef<symbol | null>(null);
    useEffect(() => {
        if (!identity || !employeeId || !businessId || !salesEmployee || !employeeRoute) return;
        if (!callTimingV2Enabled) { setCallingProgress(scope, "Automatic calling requires the approved timing configuration. Refresh or contact an administrator."); return; }
        let disposed = false, retryRequested = false, timer: number | undefined, prepareTimer: number | undefined;
        let pending: Attempt | null = null;
        let retryAfter = 0, consecutiveFailures = 0;
        const current = () => !disposed && currentScope() === identity;
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
            if (prepare && delay > 10000) prepareTimer = window.setTimeout(() => { void queryClient.fetchQuery({ queryKey: callingQueueKey(scope), queryFn: () => fetchCallingQueue(scope, employeeSession) }).catch(() => undefined); }, delay - 10000);
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
                const employee = await getEmployeeSummary(employeeId, options);
                if (!current()) return;
                if (!isSalesRole(employee.role, employee.team) || normalizeEmployeeAvailabilityStatus(employee.availabilityStatus) !== "ONLINE") {
                    progress("Employee not ONLINE"); return;
                }
                if (pending && performance.now() >= pending.expiresAt) { await release(pending); pending = null; }
                if (!pending) {
                    progress("Checking calling queue");
                    const page = await queryClient.fetchQuery({ queryKey: callingQueueKey(scope), queryFn: () => fetchCallingQueue(scope, employeeSession), staleTime: 0 });
                    if (!current()) return;
                    const queue = page.callingQueue!;
                    if (!queue.callingWindow.permitted) {
                        progress("Outside calling hours");
                        if (queue.callingWindow.nextStartAt) arm(+new Date(queue.callingWindow.nextStartAt) - +new Date(queue.serverTime));
                        return;
                    }
                    await activateCallBridgeForEmployee(employeeCode, options);
                    if (!current()) return;
                    if (!canUseCallBridgeBrowserSession(employeeCode)) { progress("Call Bridge is waiting for this browser session"); return; }
                    const bridge = await getCallBridgeStatus(employeeCode, options);
                    if (!current()) return;
                    if (!bridge.ready) {
                        const snapshotAge = bridge.clientReceivedAtMonotonic === undefined ? 0 : Math.max(0, performance.now() - bridge.clientReceivedAtMonotonic);
                        const remaining = bridge.nextCallAllowedAt && bridge.serverTime ? +new Date(bridge.nextCallAllowedAt) - +new Date(bridge.serverTime) - snapshotAge : 0;
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
                    if (!queue.nextLead || !queue.nextDecision?.normalizedPhone) {
                        progress(queue.nextEligibilityChangeAt ? "Waiting for the next scheduled lead or comment cooldown" : "No eligible assigned leads"); return;
                    }
                    pending = { id: crypto.randomUUID(), lead: queue.nextLead, phone: queue.nextDecision.normalizedPhone, queueVersion: queue.version,
                        token: "", phase: "reserve", expiresAt: performance.now() + 45000 };
                }
                const attempt = pending;
                if (!current() || callingWorkMessage(scope)) return;
                if (attempt.phase === "reserve") {
                    const reservation = await reserveCallBridgeCall(employeeCode, { ...options, attemptId: attempt.id, leadId: attempt.lead._id,
                        queueVersion: attempt.queueVersion, normalizedPhone: attempt.phone });
                    if (!reservation.allowed) { pending = null; progress(reservation.reason || "Call Bridge unavailable"); invalidate(); return; }
                    attempt.token = reservation.reservationToken; attempt.phase = "dispatch";
                    if (reservation.leadId !== attempt.lead._id || reservation.normalizedPhone !== attempt.phone) {
                        await release(attempt); pending = null; progress("The reserved call target changed. Refreshing queue"); invalidate(); return;
                    }
                }
                if (!current() || callingWorkMessage(scope)) { await release(attempt); pending = null; return; }
                const dispatch = await markCallBridgeDialStarted(employeeCode, { ...options, leadId: attempt.lead._id, reservationToken: attempt.token });
                consumed = true; pending = null;
                if (!current() || callingWorkMessage(scope) || !canUseCallBridgeBrowserSession(employeeCode) || dispatch.leadId !== attempt.lead._id || dispatch.normalizedPhone !== attempt.phone) return;
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
                const response = (error as { response?: { data?: { code?: string; message?: string }; status?: number } }).response;
                if (response && (response.status || 0) < 500) {
                    if (pending) { await release(pending); pending = null; }
                    progress(response.data?.message || "Calling request failed. Retrying"); invalidate();
                } else progress(consumed || launched ? "Dial launch not confirmed" : "Queue or call service unavailable. Retrying");
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
        const workChanged = () => { if (!callingWorkMessage(scope)) void tick(true); };
        void tick();
        const interval = window.setInterval(() => { void tick(); }, AUTO_CALL_CHECK_INTERVAL_MS);
        window.addEventListener("focus", refresh); window.addEventListener("online", refresh); window.addEventListener("pageshow", refresh);
        document.addEventListener("visibilitychange", visible);
        window.addEventListener(callingWorkflowChanged, workChanged);
        socket.on("connect", refresh); socket.on("lead:changed", refresh); socket.on("call-dashboard:updated", refresh);
        return () => {
            disposed = true; window.clearInterval(interval); window.clearTimeout(timer); window.clearTimeout(prepareTimer);
            window.removeEventListener("focus", refresh); window.removeEventListener("online", refresh); window.removeEventListener("pageshow", refresh);
            document.removeEventListener("visibilitychange", visible);
            window.removeEventListener(callingWorkflowChanged, workChanged); socket.off("connect", refresh); socket.off("lead:changed", refresh); socket.off("call-dashboard:updated", refresh);
            if (pending) void release(pending);
        };
    }, [identity, employeeId, employeeCode, businessId, employeeSession, queryClient, scope, salesEmployee, employeeRoute]);
    return null;
}
