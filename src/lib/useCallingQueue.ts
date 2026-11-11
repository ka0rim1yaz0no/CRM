import { useEffect, useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getMyLeads, type MyLeadsPage } from "../api/leads";
import { getAuthUser } from "../api/authStorage";
import { callingQueueKey, type CallingScope } from "./callingWorkflow";
import { socket } from "./socket";
import { getActiveBusinessId } from "../api/businessStorage";
import { callingQueueAffected, registerCallingQueueRefresh, type QueueLeadChange } from "./callingQueueRefresh";
import { knownCallingQueueDependencies, restoreCallingQueueDependencies } from "./callingQueueResponse";
export async function fetchCallingQueue(scope: CallingScope, employeeSession?: string, previous?: MyLeadsPage) {
    const page = await getMyLeads({ employeeId: scope.employeeId, callingQueue: true, page: 1, limit: 50,
        knownRefreshDependencies: knownCallingQueueDependencies(scope, previous) },
        { businessId: scope.businessId, employeeSession, timeoutMs: 10000 });
    if (!page.callingQueue || page.callingQueue.scope.businessId !== scope.businessId || page.callingQueue.scope.employeeId !== scope.employeeId) {
        throw new Error("The calling queue does not match this employee and business. Refresh the CRM.");
    }
    return { ...restoreCallingQueueDependencies(scope, previous, page), receivedAt: performance.now() };
}
export function useCallingQueue(input: CallingScope, enabled = true) {
    const scope = useMemo(() => ({ employeeId: input.employeeId, businessId: input.businessId }), [input.employeeId, input.businessId]);
    const client = useQueryClient();
    const session = getAuthUser()?.attendanceHubSession || undefined;
    const query = useQuery({ queryKey: callingQueueKey(scope), queryFn: () => fetchCallingQueue(scope, getAuthUser()?.attendanceHubSession || undefined, client.getQueryData<MyLeadsPage>(callingQueueKey(scope))),
        enabled: enabled && Boolean(scope.employeeId && scope.businessId), retry: false, networkMode: "always",
        refetchInterval: 5000, refetchOnWindowFocus: true, refetchOnReconnect: true });
    useEffect(() => {
        if (!enabled || !scope.employeeId || !scope.businessId) return;
        const refreshes = registerCallingQueueRefresh(client, scope, session, () => getActiveBusinessId() === scope.businessId &&
            (getAuthUser()?.attendanceHubSession || undefined) === session);
        const refresh = refreshes.request;
        const changed = (payload: QueueLeadChange = {}) => {
            const auth = getAuthUser(), names = auth?.userType === "employee" ? [auth.user.name, auth.user.employeeCode, ...(auth.user.aliases || [])] : [];
            if (callingQueueAffected(scope, client.getQueryData<MyLeadsPage>(callingQueueKey(scope)), payload, names)) refresh();
        };
        const visible = () => { if (document.visibilityState === "visible") refresh(); };
        socket.on("lead:changed", changed); socket.on("connect", refresh);
        window.addEventListener("focus", refresh); document.addEventListener("visibilitychange", visible);
        return () => { socket.off("lead:changed", changed); socket.off("connect", refresh);
            window.removeEventListener("focus", refresh); document.removeEventListener("visibilitychange", visible); refreshes.dispose(); };
    }, [client, enabled, scope, session]);
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
