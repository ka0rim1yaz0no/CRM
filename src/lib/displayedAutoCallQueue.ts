import type { Lead } from "../api/leads";
import { isLeadEligibleForAutoCall } from "./employeeAutoCall";
import { normalizePhoneForCall } from "./phoneNumber";

export type DisplayedQueueScope = { employeeId: string; businessId: string };
type DisplayedQueue = { owner: symbol; scope: DisplayedQueueScope; leads: readonly Lead[]; ready: boolean };
let displayed: DisplayedQueue | null = null;
export const displayedQueueChanged = "crm:displayed-auto-call-queue-changed";

export function publishDisplayedAutoCallQueue(owner: symbol, scope: DisplayedQueueScope, leads: readonly Lead[], ready: boolean) {
    displayed = { owner, scope, leads, ready };
    window.dispatchEvent(new Event(displayedQueueChanged));
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
