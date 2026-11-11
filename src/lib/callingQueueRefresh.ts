import type { QueryClient } from "@tanstack/react-query";
import type { Lead, MyLeadsPage } from "../api/leads";
import { callingQueueKey, type CallingScope } from "./callingWorkflow";
import { normalizePhoneForCall } from "./phoneNumber";

export type QueueLeadChange = { businessId?: string; action?: string; lead?: Lead; leadIds?: string[]; assignedAgentId?: string | null };
const scopedActions = new Set(["created", "assigned", "auto-assigned", "status-updated", "follow-up-scheduled", "comment-added", "comment-updated", "call-logged", "favorite-updated", "archived", "restored"]);

export function callingQueueAffected(scope: CallingScope, page: MyLeadsPage | undefined, change: QueueLeadChange,
    employeeNames: string[] = []) {
    if (!change || typeof change !== "object" || change.leadIds !== undefined && !Array.isArray(change.leadIds)) return true;
    if (change.businessId && change.businessId !== scope.businessId) return false;
    const queue = page?.callingQueue, dependencies = queue?.refreshDependencies;
    if (!queue || queue.scope.employeeId !== scope.employeeId || queue.scope.businessId !== scope.businessId || dependencies?.version !== 1 ||
        !Array.isArray(dependencies.leadIds) || !Array.isArray(dependencies.phones)) return true;
    const ids = new Set(dependencies.leadIds);
    if ([...(change.leadIds || []), ...(change.lead ? [change.lead._id] : [])].some(id => ids.has(id))) return true;
    if (change.assignedAgentId === scope.employeeId) return true;
    const lead = change.lead;
    // Bulk/unknown updates and edits which can change a phone retain the safe
    // full refresh. Only complete, dependency-aware single updates are filtered.
    if (!lead || !scopedActions.has(change.action || "")) return true;
    const owner = typeof lead.assignedAgent === "string" ? lead.assignedAgent : lead.assignedAgent?._id;
    if (owner === scope.employeeId || !owner && employeeNames.some(name => name.trim().toLowerCase() === lead.assignedAgentName?.trim().toLowerCase())) return true;
    const phone = normalizePhoneForCall(lead.phone);
    return Boolean(phone && dependencies.phones.includes(phone));
}

type RefreshEntry = { users: number; checks: Set<() => boolean>; timer?: number; running: boolean; again: boolean; request: () => void };
const clients = new WeakMap<QueryClient, Map<string, RefreshEntry>>();

export function registerCallingQueueRefresh(client: QueryClient, scope: CallingScope, session: string | undefined, isCurrent: () => boolean) {
    let entries = clients.get(client);
    if (!entries) { entries = new Map(); clients.set(client, entries); }
    const key = JSON.stringify([scope.businessId, scope.employeeId, session]);
    let entry = entries.get(key);
    if (!entry) {
        const queryKey = callingQueueKey(scope);
        const created: RefreshEntry = { users: 0, checks: new Set(), running: false, again: false, request: () => {} };
        const active = () => created.users > 0 && [...created.checks].some(check => check());
        const schedule = () => { if (created.users && created.timer === undefined) created.timer = window.setTimeout(() => { void run(); }, 200); };
        const run = async () => {
            created.timer = undefined;
            if (!active()) return;
            if (client.isFetching({ queryKey, exact: true })) { schedule(); return; }
            created.running = true; created.again = false;
            try { await client.invalidateQueries({ queryKey, exact: true }, { cancelRefetch: false }); }
            catch { /* The query owns its error state and the normal poll retries. */ }
            finally { created.running = false; if (created.again) schedule(); }
        };
        created.request = () => {
            if (!active()) return;
            if (created.running) { created.again = true; return; }
            schedule();
        };
        entry = created; entries.set(key, entry);
    }
    entry.users++;
    const current = entry;
    let disposed = false;
    const check = () => !disposed && isCurrent();
    current.checks.add(check);
    return { request: () => { if (check()) current.request(); }, dispose: () => {
        if (disposed) return;
        disposed = true;
        current.checks.delete(check);
        current.users--;
        if (current.users === 0) {
            window.clearTimeout(current.timer); current.timer = undefined; current.again = false;
            if (entries.get(key) === current) entries.delete(key);
        }
    } };
}
