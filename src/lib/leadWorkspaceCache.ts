import type { QueryClient } from "@tanstack/react-query";
import type { AdminLeadsPage, Lead, MyLeadsPage } from "../api/leads";
import type { CallingScope } from "./callingWorkflow";

export type LeadWorkspaceChange = { lead?: Lead; leadIds?: string[] };
export function latestLead(current: Lead | null | undefined, incoming: Lead) {
    if (!current || current._id !== incoming._id) return incoming;
    if ((current.assignmentRevision || 0) > (incoming.assignmentRevision || 0)) return current;
    const before = Date.parse(current.updatedAt || ""), after = Date.parse(incoming.updatedAt || "");
    return Number.isFinite(before) && Number.isFinite(after) && before > after ? current : incoming;
}

function matchesTab(lead: Lead, tab: string) {
    if (tab === "my" || tab === "leads" || tab === "unassigned") return lead.status === "NEW" || lead.status === "Follow up";
    const status = { qualified: "Qualified", negotiation: "Ongoing Negotiation", completed: "Completed", dead: "Dead", archived: "Archived" }[tab];
    return !status || lead.status === status;
}

export function applyLeadPageChange<T extends MyLeadsPage | AdminLeadsPage>(page: T | undefined, change: LeadWorkspaceChange, belongsHere = true): T | undefined {
    if (!page) return page;
    const removed = new Set(change.leadIds || []), incoming = change.lead;
    const current = incoming && page.leads.find(lead => lead._id === incoming._id);
    const lead = incoming ? latestLead(current, incoming) : undefined;
    if (lead && (!belongsHere || !matchesTab(lead, page.tab))) removed.add(lead._id);
    const rows = page.leads.filter(item => !removed.has(item._id)).map(item => lead?._id === item._id ? lead : item);
    const queue = "callingQueue" in page ? page.callingQueue : undefined;
    const queueChanged = queue && (removed.has(queue.nextLeadId || "") || (lead && queue.nextLeadId === lead._id) || queue.entries.some(entry => removed.has(entry.leadId) || entry.leadId === lead?._id));
    return { ...page, leads: rows, total: Math.max(0, page.total - page.leads.filter(item => removed.has(item._id)).length),
        ...(queueChanged ? { callingQueue: { ...queue, version: "", nextLead: null, nextLeadId: null, nextReason: null, nextDecision: null,
            waitReason: "REFRESHING_QUEUE", entries: queue.entries.filter(entry => !removed.has(entry.leadId) && entry.leadId !== lead?._id) } } : {}) };
}

export function isLeadWorkspaceQuery(key: readonly unknown[], businessId: string, employeeId?: string) {
    if (key[0] === "calling-queue") return key[1] === businessId && (!employeeId || key[2] === employeeId);
    if (key[0] === "leads") return key.at(-1) === businessId && (!employeeId || key[1] === employeeId);
    return !employeeId && key[0] === "admin-leads" && key[1] === businessId;
}

// Cancel older reads before applying a confirmed response, then ask the server
// to rebuild ordering/counts. The browser never chooses a replacement caller.
export async function synchronizeLeadWorkspace(client: QueryClient, businessId: string, change: LeadWorkspaceChange, employee?: CallingScope & { belongsHere: boolean }) {
    const predicate = (query: { queryKey: readonly unknown[] }) => isLeadWorkspaceQuery(query.queryKey, businessId, employee?.employeeId);
    await client.cancelQueries({ predicate });
    client.setQueriesData<MyLeadsPage | AdminLeadsPage>({ predicate }, page => applyLeadPageChange(page, change, employee?.belongsHere));
    if (change.lead) {
        const lead = change.lead;
        for (const kind of ["lead", "admin-route-lead"]) client.setQueryData<Lead>([kind, businessId, lead._id], current => latestLead(current, lead));
    }
    for (const id of change.leadIds || []) {
        for (const kind of ["lead", "admin-route-lead"]) client.removeQueries({ queryKey: [kind, businessId, id], exact: true });
    }
    await client.invalidateQueries({ predicate }, { cancelRefetch: false });
}
