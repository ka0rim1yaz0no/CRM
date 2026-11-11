import { useEffect, useState, useSyncExternalStore } from "react";
import { FiClock, FiPhoneCall } from "react-icons/fi";
import { useQuery } from "@tanstack/react-query";
import { getAuthUser } from "../api/authStorage";
import { getActiveBusinessId } from "../api/businessStorage";
import { getCallBridgeStatus } from "../api/callBridge";
import { callingDisplay, observeCallingBridge, subscribeCallingDisplay } from "../lib/callingDisplay";
import type { CallingScope } from "../lib/callingWorkflow";

export default function CallingStatus({ scope, hold = "", queueError = false }: { scope: CallingScope; hold?: string; queueError?: boolean }) {
    const snapshot = useSyncExternalStore(subscribeCallingDisplay, () => callingDisplay(scope), () => callingDisplay(scope));
    const auth = getAuthUser(), employeeCode = auth?.userType === "employee" && auth.user._id === scope.employeeId ? auth.user.employeeCode : "";
    const employeeSession = auth?.attendanceHubSession || "";
    const statusRead = useQuery({
        queryKey: ["calling-display-bridge", scope.businessId, scope.employeeId, employeeSession],
        enabled: Boolean(employeeCode && employeeSession && getActiveBusinessId() === scope.businessId),
        queryFn: async () => {
            const bridge = await getCallBridgeStatus(employeeCode, { businessId: scope.businessId, employeeSession, timeoutMs: 5000 });
            const current = getAuthUser();
            if (current?.userType === "employee" && current.user._id === scope.employeeId && current.attendanceHubSession === employeeSession &&
                getActiveBusinessId() === scope.businessId) observeCallingBridge(scope, bridge);
            return bridge;
        },
        refetchInterval: 2000, refetchOnWindowFocus: true, retry: false,
    });
    const [clock, setClock] = useState(() => performance.now());
    useEffect(() => {
        if (!snapshot.serverTime) return;
        const timer = window.setTimeout(() => setClock(performance.now()), Math.max(0, 20_001 - (performance.now() - snapshot.receivedAt)));
        return () => window.clearTimeout(timer);
    }, [snapshot.receivedAt, snapshot.serverTime]);
    const stale = Boolean(snapshot.serverTime && clock - snapshot.receivedAt > 20000);
    const onCall = snapshot.status === "ON CALL" && !stale;
    const issue = hold || (stale || statusRead.isError ? "Live call status unavailable. New calls remain guarded." : snapshot.bridgeIssue) ||
        (queueError ? "Calling queue unavailable. Retrying automatically." : snapshot.requestIssue);
    const Icon = onCall ? FiPhoneCall : FiClock;
    return <div className="min-w-0">
        <div className="flex min-h-7 items-center gap-2 text-sm font-semibold" role="status" aria-live="polite">
            <Icon aria-hidden="true" className="size-4 shrink-0" />
            <span>{onCall ? "On Call" : "Call Waiting"}</span>
        </div>
        {issue && <p className="mt-1 text-xs text-amber-300" role="alert">{issue}</p>}
    </div>;
}
