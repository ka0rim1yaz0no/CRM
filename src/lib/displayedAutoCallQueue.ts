import type { Lead } from "../api/leads";
import { isLeadEligibleForAutoCall } from "./employeeAutoCall";
import { normalizePhoneForCall } from "./phoneNumber";

export type DisplayedQueueScope = { employeeId: string; businessId: string };
type DisplayedQueue = { owner: symbol; scope: DisplayedQueueScope; leads: readonly Lead[]; ready: boolean; loadMore?: () => Promise<boolean> };
let displayed: DisplayedQueue | null = null;
let pendingLoad: Pick<DisplayedQueue, "owner" | "scope"> | null = null;
let loadBackoff: (Pick<DisplayedQueue, "owner" | "scope"> & { until: number }) | null = null;
export const displayedQueueChanged = "crm:displayed-auto-call-queue-changed";

export function publishDisplayedAutoCallQueue(owner: symbol, scope: DisplayedQueueScope, leads: readonly Lead[], ready: boolean, loadMore?: () => Promise<boolean>) {
    displayed = { owner, scope, leads, ready, loadMore };
    window.dispatchEvent(new Event(displayedQueueChanged));
}

export async function requestMoreDisplayedAutoCallLeads(scope: DisplayedQueueScope) {
    const queue = displayed;
    const matches = (value: Pick<DisplayedQueue, "owner" | "scope"> | null) => value?.owner === queue?.owner &&
        value?.scope.employeeId === scope.employeeId && value?.scope.businessId === scope.businessId;
    if (!queue?.ready || !matches(queue) || !queue.loadMore || matches(pendingLoad) ||
        (matches(loadBackoff) && loadBackoff!.until > Date.now())) return false;
    const pending = { owner: queue.owner, scope: queue.scope };
    pendingLoad = pending;
    try {
        const loaded = await queue.loadMore();
        if (!loaded) loadBackoff = { ...pending, until: Date.now() + 5_000 };
        return loaded && matches(displayed);
    } catch {
        loadBackoff = { ...pending, until: Date.now() + 5_000 };
        return false;
    } finally {
        if (pendingLoad === pending) pendingLoad = null;
    }
}

export function clearDisplayedAutoCallQueue(owner: symbol) {
    if (displayed?.owner === owner) displayed = null;
}

export function isAutoCallLeadAssigned(lead: Lead, employeeId: string, employeeNames: string[]) {
    const agent = typeof lead.assignedAgent === "object" && lead.assignedAgent ? lead.assignedAgent._id : lead.assignedAgent;
    const names = new Set(employeeNames.map(name => name.trim().toLowerCase()).filter(Boolean));
    return String(agent || "") === employeeId || names.has(String(lead.assignedAgentName || "").trim().toLowerCase());
}

export function firstDisplayedAutoCallLead(scope: DisplayedQueueScope, employeeNames: string[], excluded: ReadonlySet<string>, now = new Date()) {
    if (!displayed?.ready || displayed.scope.businessId !== scope.businessId || displayed.scope.employeeId !== scope.employeeId) return null;
    for (const lead of displayed.leads) {
        if (excluded.has(lead._id) || !isAutoCallLeadAssigned(lead, scope.employeeId, employeeNames) || !isLeadEligibleForAutoCall(lead, now, employeeNames)) continue;
        const normalizedPhone = normalizePhoneForCall(lead.phone);
        if (normalizedPhone) return { lead, normalizedPhone };
    }
    return null;
}
