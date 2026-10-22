import { useEffect, useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getMyLeads } from "../api/leads";
import { getAuthUser } from "../api/authStorage";
import { callingQueueKey, type CallingScope } from "./callingWorkflow";
import { socket } from "./socket";
export async function fetchCallingQueue(scope: CallingScope, employeeSession?: string) {
    const page = await getMyLeads({ employeeId: scope.employeeId, callingQueue: true, page: 1, limit: 50 },
        { businessId: scope.businessId, employeeSession, timeoutMs: 10000 });
    if (!page.callingQueue || page.callingQueue.scope.businessId !== scope.businessId || page.callingQueue.scope.employeeId !== scope.employeeId) {
        throw new Error("The calling queue does not match this employee and business. Refresh the CRM.");
    }
    return { ...page, receivedAt: performance.now() };
}
export function useCallingQueue(input: CallingScope, enabled = true) {
    const scope = useMemo(() => ({ employeeId: input.employeeId, businessId: input.businessId }), [input.employeeId, input.businessId]);
    const client = useQueryClient();
    const query = useQuery({ queryKey: callingQueueKey(scope), queryFn: () => fetchCallingQueue(scope, getAuthUser()?.attendanceHubSession || undefined),
        enabled: enabled && Boolean(scope.employeeId && scope.businessId), refetchInterval: 5000, refetchOnWindowFocus: true, refetchOnReconnect: true });
    useEffect(() => {
        if (!enabled || !scope.employeeId || !scope.businessId) return;
        const refresh = () => { void client.invalidateQueries({ queryKey: callingQueueKey(scope) }, { cancelRefetch: false }); };
        const visible = () => { if (document.visibilityState === "visible") refresh(); };
        socket.on("lead:changed", refresh); socket.on("connect", refresh);
        window.addEventListener("focus", refresh); document.addEventListener("visibilitychange", visible);
        return () => { socket.off("lead:changed", refresh); socket.off("connect", refresh);
            window.removeEventListener("focus", refresh); document.removeEventListener("visibilitychange", visible); };
    }, [client, enabled, scope]);
    const nextAt = query.data?.callingQueue?.nextEligibilityChangeAt;
    const serverTime = query.data?.callingQueue?.serverTime;
    const receivedAt = query.data?.receivedAt;
    useEffect(() => {
        if (!nextAt || !serverTime || receivedAt === undefined) return;
        const remaining = +new Date(nextAt) - +new Date(serverTime) - Math.max(0, performance.now() - receivedAt);
        const timer = window.setTimeout(() => { void client.invalidateQueries({ queryKey: callingQueueKey(scope) }, { cancelRefetch: false }); }, Math.min(2147483647, Math.max(0, remaining)));
        return () => window.clearTimeout(timer);
    }, [client, nextAt, serverTime, receivedAt, scope]);
    return query;
}
