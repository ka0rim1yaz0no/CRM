import { api } from "../lib/api";
import type { CallingDecision } from "../../shared/leadCallingPolicy";
import type { Employee } from "./employees";
import type { Team } from "./teams";

export type LeadStatus =
    | "NEW"
    | "Follow up"
    | "Ongoing comms"
    | "Qualified"
    | "Ongoing Negotiation"
    | "Completed"
    | "Dead"
    | "Archived";

export type Lead = {
    _id: string;
    leadName: string;
    position: string;
    businessName: string;
    businessAddress: string;
    email: string;
    phone: string;
    website: string;
    source: string;
    category: string;
    status: LeadStatus;
    createdByName: string;
    createdByType: "admin" | "employee" | "system";
    assignedAgent: Employee | null;
    assignedAgentName: string;
    assignmentRevision?: number;
    autoAssignedAt: string | null;
    assignedTeam: Team | null;
    favoriteByEmployees?: string[];
    googlePlaceId: string;
    placeProvider?: "" | "google" | "tomtom";
    providerPlaceId?: string;
    notes: string;
    callsByEmployee?: Array<{
        employee?: string;
        employeeName?: string;
        count?: number;
        lastCallAt?: string | null;
    }>;
    comments?: Array<{
        _id?: string;
        authorName: string;
        authorType: "admin" | "employee";
        body: string;
        createdAt: string;
    }>;
    activity?: Array<{
        _id?: string;
        label: string;
        detail: string;
        status: string;
        actorName: string;
        actorType: "admin" | "employee" | "system";
        createdAt: string;
    }>;
    followUpAt: string | null;
    followUpNote: string;
    followUpPriority: number;
    aiScore: number;
    aiScoreReason: string;
    aiScoreSource: string;
    aiScoredAt: string | null;
    createdAt?: string;
    updatedAt?: string;
};

export type LeadInput = {
    leadName: string;
    position: string;
    businessName: string;
    businessAddress: string;
    email: string;
    phone: string;
    website: string;
    source: string;
    category: string;
    status: LeadStatus;
    assignedAgent: string | null;
    assignedAgentName?: string;
    assignedTeam: string | null;
    googlePlaceId: string;
    notes: string;
    followUpAt?: string | null;
    followUpNote?: string;
    followUpPriority?: number;
    aiScore?: number;
    aiScoreReason?: string;
    aiScoreSource?: string;
    aiScoredAt?: string | null;
    activityActorName?: string;
    activityActorType?: "admin" | "employee" | "system";
};

export type BusinessPlaceLead = {
    googlePlaceId: string;
    provider?: "google" | "tomtom";
    providerPlaceId?: string;
    providerCategory?: string;
    matchedQuery?: string;
    relevanceScore?: number;
    relevanceReason?: string;
    businessName: string;
    businessAddress: string;
    phone: string;
    website: string;
    latitude?: number;
    longitude?: number;
};

export type PlacesImportResult = {
    places: BusinessPlaceLead[];
    leads: Lead[];
    skippedNoPhoneCount?: number;
    duplicateCount?: number;
    rejectedIrrelevantCount?: number;
    searchedLocations?: string[];
    searchedQueries?: string[];
    searchedPages?: number;
};

export type TomTomUsage = {
    provider: "tomtom";
    dayKey: string;
    periodKey: string;
    resetAt: string;
    usagePeriod: "month";
    used: number;
    limit: number;
    remaining: number;
    configured: boolean;
    evaluationMode: boolean;
    products: {
        discover: {
            product: "places-discover";
            periodKey: string;
            used: number;
            limit: number;
            remaining: number;
        };
        search: {
            product: "search";
            periodKey: string;
            used: number;
            limit: number;
            remaining: number;
        };
        suggest: {
            product: "places-suggest";
            periodKey: string;
            used: number;
            limit: number;
            remaining: number;
        };
        details: {
            product: "places-details";
            periodKey: string;
            used: number;
            limit: number;
            remaining: number;
        };
        geocoding: {
            product: "geocoding";
            periodKey: string;
            used: number;
            limit: number;
            remaining: number;
        };
    };
    manualEstimatedRequests: number;
    autoEstimatedRequests: number;
    geocodingEstimatedRequests: number;
    maxResultsPerRequest: number;
    resetTimeZone: string;
};

export type TomTomPlacesImportResult = PlacesImportResult & {
    provider: "tomtom";
    requestCount: number;
    limitReached: boolean;
    usage: Omit<TomTomUsage, "manualEstimatedRequests" | "autoEstimatedRequests" | "maxResultsPerRequest" | "resetTimeZone">;
};

export type TomTomPlacesAutoSearchResult = TomTomPlacesImportResult & {
    product: string;
    location: string;
    radiusMiles?: number;
    searchedQueries: string[];
    searchedLocations?: string[];
    searchedPages: number;
};

export type LeadScoreResult = {
    usedAi: boolean;
    leads: Lead[];
};

export type LeadReassignmentResult = {
    reassignedCount: number;
    leads: Lead[];
};

export type LeadBulkArchiveResult = {
    archivedCount: number;
};

export type LeadBulkRestoreResult = {
    restoredCount: number;
};

export type LeadBulkAssignResult = {
    assignedCount: number;
};

export type LeadPermanentDeleteResult = {
    deletedCount: number;
};

export type LeadCountResult = Partial<Record<LeadStatus | "Unassigned" | "ALL" | "ContactedToday", number>>;

export type LeadImportInput = Partial<LeadInput> & {
    createdAt?: string | null;
    assignedToName?: string;
};

export type LeadImportResult = {
    importedCount: number;
    skippedCount: number;
    duplicateCount?: number;
    leads: Lead[];
};

export type MyLeadsPage = {
    receivedAt?: number;
    leads: Lead[];
    tab: EmployeeLeadTab;
    page: number;
    limit: number;
    total: number;
    stateOptions: LeadStateOption[];
    hasMore: boolean;
    nextPage: number | null;
    callingQueue?: CallingQueueSnapshot;
};

export type CallingQueueSnapshot = {
    policyVersion: string;
    scope: { employeeId: string; employeeCode: string; businessId: string };
    version: string;
    serverTime: string;
    nextEligibilityChangeAt: string | null;
    nextLeadId: string | null;
    nextLead: Lead | null;
    nextReason: CallingDecision["reason"] | null;
    nextDecision: (CallingDecision & { leadId: string; normalizedPhone: string | null }) | null;
    entries: Array<CallingDecision & { leadId: string; normalizedPhone: string | null }>;
    callingWindow: { permitted: boolean; nextStartAt: string | null };
    waitReason: string | null;
};

export type EmployeeLeadTab = "my" | "qualified" | "negotiation" | "completed" | "dead" | "archived" | "all";
export type AdminLeadApiTab = "leads" | "qualified" | "negotiation" | "completed" | "dead" | "archived" | "unassigned" | "all";

export type LeadStateOption = {
    code: string;
    name: string;
    count: number;
};

export type AdminLeadsPage = {
    leads: Lead[];
    tab: AdminLeadApiTab;
    page: number;
    limit: number;
    total: number;
    stateOptions: LeadStateOption[];
    hasMore: boolean;
    nextPage: number | null;
};

export type AgentLeadDashboardSummary = {
    totalActiveAgents: number;
    onlineAgents: number;
    totalOpenLeads: number;
    unassignedLeads: number;
    dueFollowUps: number;
    touchedLeadsToday: number;
    commentsToday: number;
    callsToday: number;
    activityToday: number;
    qualifiedLeads: number;
    negotiationLeads: number;
};

export type AgentLeadProgress = {
    employeeId: string;
    employeeName: string;
    employeeCode: string;
    businessId: string;
    businessName: string;
    role: string;
    team: string;
    status: string;
    availabilityStatus: string;
    assignedLeads: number;
    newLeads: number;
    followUps: number;
    ongoing: number;
    qualified: number;
    negotiation: number;
    dead: number;
    dueFollowUps: number;
    scheduledToday: number;
    commentsToday: number;
    callsToday: number;
    activityToday: number;
    touchedLeadsToday: number;
    progressPercent: number;
    productivityScore: number;
    lastActivityAt: string | null;
};

export type AgentLeadActivity = {
    id: string;
    employeeId?: string;
    employeeName: string;
    action: string;
    detail: string;
    leadId: string;
    leadName: string;
    businessName: string;
    status: LeadStatus;
    createdAt: string | null;
};

export type AgentLeadMonthlyRow = {
    employeeId: string;
    employeeName: string;
    businessId: string;
    businessName: string;
    role: string;
    team: string;
    leadsAdded: number;
    followUps: number;
    qualified: number;
    archiveDead: number;
    comments: number;
    calls: number;
    actions: number;
    qualifiedLeads: Array<{
        leadId: string;
        leadName: string;
        businessName: string;
        source: string;
        category: string;
        status: LeadStatus;
        assignedAgentName: string;
        statusAt: string | null;
        createdAt: string | null;
    }>;
    touchedLeads: number;
    productivityScore: number;
    lastActivityAt: string | null;
};

export type AgentLeadDashboard = {
    generatedAt: string;
    business: { id: string; name: string };
    summary: AgentLeadDashboardSummary;
    agents: AgentLeadProgress[];
    selectedMonth: string;
    selectedCallDate: string;
    selectedDateFrom: string;
    selectedDateTo: string;
    monthOptions: string[];
    monthlyAgents: AgentLeadMonthlyRow[];
    recentActivity: AgentLeadActivity[];
};

export type EmployeeLeadLog = {
    id: string;
    employeeName: string;
    action: string;
    detail: string;
    note?: string;
    leadId: string;
    leadName: string;
    businessName: string;
    source: string;
    category: string;
    status: LeadStatus;
    followUpAt: string | null;
    createdAt: string;
};

export async function getLeads(
    params: {
        assignedAgent?: string;
        assignedAgentNames?: string[];
        page?: number;
        limit?: number;
        includeArchived?: boolean;
        all?: boolean;
        search?: string;
        status?: LeadStatus;
        statuses?: LeadStatus[];
        unassigned?: boolean;
    } = {}
) {
    const response = await api.get<Lead[]>("/leads", {
        params: {
            ...params,
            assignedAgentNames: params.assignedAgentNames?.join(","),
            statuses: params.statuses?.join(","),
        },
    });
    return response.data;
}

export async function getLeadCounts(params: { assignedAgent?: string; assignedAgentNames?: string[]; search?: string } = {}) {
    const response = await api.get<LeadCountResult>("/leads/counts", {
        params: {
            ...params,
            assignedAgentNames: params.assignedAgentNames?.join(","),
        },
    });
    return response.data;
}

export async function getAdminLeads(params: {
    assignedAgent?: string;
    assignedAgentNames?: string[];
    page?: number;
    limit?: number;
    search?: string;
    tab?: AdminLeadApiTab;
    queue?: "ALL" | "NEW" | "Follow up";
    statusFilter?: LeadStatus | "ALL";
    dateFrom?: string;
    dateTo?: string;
    state?: string;
    unassigned?: boolean;
    exportFile?: boolean;
}, context: LeadAssignmentContext = {}) {
    const endpoint = params.tab && params.tab !== "leads" ? `/admin-leads/${params.tab}` : "/admin-leads";
    const response = await api.get<AdminLeadsPage>(endpoint, {
        headers: assignmentHeaders(context),
        params: {
            ...params,
            tab: undefined,
            export: params.exportFile ? "true" : undefined,
            exportFile: undefined,
            assignedAgentNames: params.assignedAgentNames?.join(","),
        },
    });
    return response.data;
}

// export async function getAdminLeadCounts(params: { assignedAgent?: string; assignedAgentNames?: string[]; search?: string } = {}) {
//     const response = await api.get<LeadCountResult>("/admin-leads/counts", {
//         params: {
//             ...params,
//             assignedAgentNames: params.assignedAgentNames?.join(","),
//         },
//     });
//     return response.data;
// }

export async function getAdminLeadCounts(params: {
    assignedAgent?: string;
    assignedAgentNames?: string[];
    search?: string;
    state?: string;
    unassigned?: boolean;
} = {}, context: LeadAssignmentContext = {}) {
    const response = await api.get<LeadCountResult>("/admin-leads/counts", {
        headers: assignmentHeaders(context),
        params: {
            ...params,
            assignedAgentNames: params.assignedAgentNames?.join(","),
        },
    });

    return response.data;
}

export async function getAgentLeadDashboard(params: { month?: string; dateFrom?: string; dateTo?: string; callDate?: string } = {}) {
    const response = await api.get<AgentLeadDashboard>("/leads/agent-dashboard", { params });
    return response.data;
}

export async function getLead(id: string, options: LeadAssignmentContext & { timeoutMs?: number } = {}) {
    const response = await api.get<Lead>(`/leads/${id}`, { timeout: options.timeoutMs, headers: assignmentHeaders(options) });
    return response.data;
}

export async function getMyLeads(params: {
    employeeId?: string;
    employeeNames?: string[];
    page?: number;
    limit?: number;
    tab?: EmployeeLeadTab;
    queue?: "ALL" | "NEW" | "Follow up";
    search?: string;
    searchAll?: boolean;
    includeArchived?: boolean;
    state?: string;
    autoCallEligible?: boolean;
    callingQueue?: boolean;
}, options: { timeoutMs?: number; businessId?: string; employeeSession?: string } = {}) {
    const endpoint = params.tab && params.tab !== "my" ? `/my-leads/${params.tab}` : "/my-leads";
    const response = await api.get<MyLeadsPage>(endpoint, {
        params: {
            ...params,
            tab: undefined,
            employeeNames: params.employeeNames?.join(","),
        },
        timeout: options.timeoutMs,
        headers: { ...(options.businessId ? { "X-Business-Id": options.businessId } : {}),
            ...(options.employeeSession ? { "X-CRM-Attendance-Session": options.employeeSession } : {}) },
    });
    return response.data;
}

export async function getNextAutoCallLead(params: {
    employeeId: string;
    employeeNames: string[];
    excludedLeadIds?: string[];
}, options: { timeoutMs?: number; businessId?: string; employeeSession?: string } = {}) {
    const page = await getMyLeads({ employeeId: params.employeeId, callingQueue: true, limit: 1 }, options);
    const queue = page.callingQueue;
    return queue?.nextLead && queue.nextDecision?.normalizedPhone
        ? { lead: queue.nextLead, reason: queue.nextReason, normalizedPhone: queue.nextDecision.normalizedPhone, queue: queue.nextLead.status === "Follow up" ? "Follow up" as const : "NEW" as const }
        : null;
}

export async function getMyLeadCounts(params: { employeeId?: string; employeeNames?: string[]; state?: string } = {}) {
    const response = await api.get<LeadCountResult>("/my-leads/counts", {
        params: {
            ...params,
            employeeNames: params.employeeNames?.join(","),
        },
    });
    return response.data;
}

export async function getEmployeeLeadLogs(params: { employee?: string; action?: string; search?: string; start?: string; end?: string; limit?: number } = {}) {
    const response = await api.get<EmployeeLeadLog[]>("/leads/employee-logs", { params });
    return response.data;
}

export async function createLead(lead: LeadInput) {
    const response = await api.post<Lead>("/leads", lead);
    return response.data;
}

export async function importLeads(leads: LeadImportInput[]) {
    const response = await api.post<LeadImportResult>("/leads/import", { leads });
    return response.data;
}

export async function updateLead(id: string, lead: LeadInput, context: LeadAssignmentContext = {}) {
    const response = await api.put<Lead>(`/leads/${id}`, lead, { headers: assignmentHeaders(context) });
    return response.data;
}

export async function assignLead(
    id: string,
    assignment: { assignedAgent: string; assignedAgentName?: string; expectedAssignmentRevision?: number } & LeadActivityActorInput,
    context: LeadAssignmentContext = {}
) {
    const response = await api.patch<Lead>(`/leads/${id}/assign`, assignment, { headers: assignmentHeaders(context) });
    return response.data;
}

export async function archiveLead(id: string, actor: LeadActivityActorInput = {}, context: LeadAssignmentContext = {}) {
    const response = await api.patch<Lead>(`/leads/${id}/archive`, actor, { headers: assignmentHeaders(context) });
    return response.data;
}

export async function restoreLead(id: string) {
    const response = await api.patch<Lead>(`/leads/${id}/restore`);
    return response.data;
}

export async function permanentlyDeleteLead(id: string) {
    const response = await api.delete<LeadPermanentDeleteResult>(`/leads/${id}/permanent`);
    return response.data;
}

export async function bulkArchiveLeads(leadIds: string[]) {
    const response = await api.patch<LeadBulkArchiveResult>("/leads/bulk/archive", {
        leadIds,
        activityActorName: "Admin",
        activityActorType: "admin",
    });
    return response.data;
}

export type EmployeeBulkArchiveResult = { archivedCount: number; archivedIds: string[]; conflictIds: string[];
    busyIds: string[]; alreadyArchivedCount: number; selectedCount: number; preservedOtherOwnerCount: number };

export async function getLeadWorkspaceCapabilities(context: LeadAssignmentContext) {
    const response = await api.get<{ phoneDeduplication: boolean; employeeBulkArchive: boolean }>("/leads/workspace-capabilities", { headers: assignmentHeaders(context) });
    return response.data;
}

export async function archiveEmployeeLeads(leads: Array<{ _id: string; assignmentRevision?: number }>, context: LeadAssignmentContext) {
    const response = await api.patch<EmployeeBulkArchiveResult>("/leads/employee/bulk/archive", {
        leadIds: leads.map(lead => lead._id), expectedAssignmentRevisions: Object.fromEntries(leads.map(lead => [lead._id, lead.assignmentRevision || 0])),
    }, { headers: assignmentHeaders(context) });
    return response.data;
}

export async function archiveAllActiveLeads() {
    const response = await api.patch<LeadBulkArchiveResult>("/leads/bulk/archive-all", {
        confirmation: "ARCHIVE_ALL_ACTIVE_LEADS",
        activityActorName: "Admin",
        activityActorType: "admin",
    });
    return response.data;
}

export async function bulkRestoreLeads(leadIds: string[]) {
    const response = await api.patch<LeadBulkRestoreResult>("/leads/bulk/restore", {
        leadIds,
        activityActorName: "Admin",
        activityActorType: "admin",
    });
    return response.data;
}

export type LeadAssignmentContext = { businessId?: string; employeeSession?: string; adminSession?: string };

function assignmentHeaders(context: LeadAssignmentContext) {
    if (context.employeeSession !== undefined || context.adminSession !== undefined) return {
        ...(context.businessId ? { "X-Business-Id": context.businessId } : {}),
        "X-CRM-Attendance-Session": context.employeeSession || "", "X-CRM-Admin-Session": context.adminSession || "",
    };
    return { ...(context.businessId ? { "X-Business-Id": context.businessId } : {}),
        ...(context.employeeSession ? { "X-CRM-Attendance-Session": context.employeeSession } : {}),
        ...(context.adminSession ? { "X-CRM-Admin-Session": context.adminSession } : {}) };
}

export async function bulkAssignLeads(input: { leadIds: string[]; assignedAgent: string; assignedAgentName: string; expectedAssignmentRevisions?: Record<string, number> }, context: LeadAssignmentContext = {}) {
    const response = await api.patch<LeadBulkAssignResult>("/leads/bulk/assign", {
        ...input,
        activityActorName: "Admin",
        activityActorType: "admin",
    }, { headers: assignmentHeaders(context) });
    return response.data;
}

export async function bulkPermanentlyDeleteArchivedLeads(leadIds: string[]) {
    const response = await api.delete<LeadPermanentDeleteResult>("/leads/bulk/permanent", { data: { leadIds } });
    return response.data;
}

export async function bulkPermanentlyDeleteActiveLeads(leadIds: string[]) {
    const response = await api.delete<LeadPermanentDeleteResult>("/leads/bulk/active/permanent", { data: { leadIds } });
    return response.data;
}

export async function restoreAllArchivedLeads() {
    const response = await api.patch<LeadBulkRestoreResult>("/leads/archived/restore", {
        confirmation: "RESTORE_ALL_ARCHIVED_LEADS",
        activityActorName: "Admin",
        activityActorType: "admin",
    });
    return response.data;
}

export async function permanentlyDeleteAllArchivedLeads() {
    const response = await api.delete<LeadPermanentDeleteResult>("/leads/archived/permanent", {
        data: { confirmation: "DELETE_ALL_ARCHIVED_LEADS" },
    });
    return response.data;
}

export async function autoAssignLead(id: string, context: LeadAssignmentContext = {}) {
    const response = await api.patch<Lead>(`/leads/${id}/auto-assign`, {}, { headers: assignmentHeaders(context) });
    return response.data;
}

export async function reassignNewLeads(context: LeadAssignmentContext = {}) {
    const response = await api.patch<LeadReassignmentResult>("/leads/reassign-new", {}, { headers: assignmentHeaders(context) });
    return response.data;
}

export async function scheduleLeadFollowUp(
    id: string,
    followUp: { followUpAt: string; followUpNote?: string; followUpPriority?: number } & LeadActivityActorInput,
    options: { businessId?: string; employeeSession?: string } = {}
) {
    const response = await api.patch<Lead>(`/leads/${id}/follow-up`, followUp, { headers: { ...(options.businessId ? { "X-Business-Id": options.businessId } : {}), ...(options.employeeSession ? { "X-CRM-Attendance-Session": options.employeeSession } : {}) } });
    return response.data;
}

export async function addLeadComment(
    id: string,
    comment: { body: string; authorName?: string; authorType?: "admin" | "employee" },
    options: LeadAssignmentContext = {}
) {
    const response = await api.post<Lead>(`/leads/${id}/comments`, comment, { headers: assignmentHeaders(options) });
    return response.data;
}

type LeadActivityActorInput = {
    activityActorName?: string;
    activityActorType?: "admin" | "employee" | "system";
    employeeId?: string;
};

export async function recordLeadCall(
    id: string,
    actor: LeadActivityActorInput & { callOutcome?: "confirmed" | "failed" } = {},
    options: { timeoutMs?: number; businessId?: string; employeeSession?: string } = {}
) {
    const response = await api.post<Lead>(`/leads/${id}/calls`, actor, { timeout: options.timeoutMs,
        headers: { ...(options.businessId ? { "X-Business-Id": options.businessId } : {}), ...(options.employeeSession ? { "X-CRM-Attendance-Session": options.employeeSession } : {}) } });
    return response.data;
}

export async function updateLeadComment(id: string, commentId: string, comment: { body: string } & LeadActivityActorInput) {
    const response = await api.patch<Lead>(`/leads/${id}/comments/${commentId}`, comment);
    return response.data;
}

export async function updateLeadStatus(id: string, status: LeadStatus, actor: LeadActivityActorInput = {}, options: { businessId?: string; employeeSession?: string } = {}) {
    const response = await api.patch<Lead>(`/leads/${id}/status`, { status, ...actor }, { headers: { ...(options.businessId ? { "X-Business-Id": options.businessId } : {}), ...(options.employeeSession ? { "X-CRM-Attendance-Session": options.employeeSession } : {}) } });
    return response.data;
}

export async function toggleLeadFavorite(id: string, input: { employeeId: string; favorite: boolean }, context: LeadAssignmentContext = {}) {
    const response = await api.patch<Lead>(`/leads/${id}/favorite`, input, { headers: assignmentHeaders(context) });
    return response.data;
}

export async function scoreLeadsByHighestPotential(leadIds: string[] = []) {
    const response = await api.post<LeadScoreResult>("/leads/ai-score", { leadIds });
    return response.data;
}

export async function getTomTomUsage({ product = "", location = "", targetLeads = 1000 }: { product?: string; location?: string; targetLeads?: number } = {}) {
    const response = await api.get<TomTomUsage>("/leads/tomtom/usage", { params: { product, location, targetLeads } });
    return response.data;
}

export async function searchAndImportTomTomPlaces({
    textQuery,
    category = "",
    location = "",
    radiusMiles = 0,
    maxResults = 1000,
    maxRequests,
}: {
    textQuery: string;
    category?: string;
    location?: string;
    radiusMiles?: number;
    maxResults?: number;
    maxRequests?: number;
}) {
    const response = await api.post<TomTomPlacesImportResult>("/leads/tomtom/search-import", {
        textQuery,
        category,
        location,
        radiusMiles,
        maxResults,
        maxRequests,
    });
    return response.data;
}

export async function autoSearchTomTomPlacesLeads({
    product,
    location = "",
    radiusMiles = 0,
    maxResults = 1000,
    maxRequests,
}: {
    product: string;
    location?: string;
    radiusMiles?: number;
    maxResults?: number;
    maxRequests?: number;
}) {
    const response = await api.post<TomTomPlacesAutoSearchResult>("/leads/tomtom/auto-search", {
        product,
        location,
        radiusMiles,
        maxResults,
        maxRequests,
    });
    return response.data;
}


// call logger

// export type LeadCallLogItem = {
//     _id?: string;
//     employee:
//     | string
//     | {
//         _id: string;
//         name?: string;
//     };
//     employeeName: string;
//     employeeRole?: string;
//     employeeTeam?: string;
//     calledAt?: string;
// };

// export type LeadCallStat = {
//     _id?: string;
//     lead:
//     | string
//     | {
//         _id: string;
//     };
//     leadName: string;
//     businessName: string;
//     callCount: number;
//     lastCallAt?: string | null;
//     callLogs: LeadCallLogItem[];
//     createdAt?: string;
//     updatedAt?: string;
// };

// export async function logLeadCall(leadId: string, employeeId: string) {
//     const response = await api.patch<LeadCallStat>(`/leads/${leadId}/log-call`, {
//         employeeId,
//         clickedAt: new Date().toISOString(),
//     });

//     return response.data;
// }

// export async function getLeadCallStat(leadId: string) {
//     const response = await api.get<LeadCallStat>(`/leads/${leadId}/call-stat`);
//     return response.data;
// }

// export async function getLeadCallStats(limit = 100) {
//     const response = await api.get<LeadCallStat[]>(`/leads/call-stats`, {
//         params: {
//             limit,
//         },
//     });

//     return response.data;
// }


export type LeadCallOutcome = "connected" | "not_connected" | "voicemail";

export type LeadCallLogItem = {
    _id?: string;
    employee:
    | string
    | {
        _id: string;
        name?: string;
    };
    employeeName: string;
    employeeRole?: string;
    employeeTeam?: string;
    outcome?: LeadCallOutcome;
    calledAt?: string;
    provider?: string;
    providerSessionId?: string;
    providerResult?: string;
    verificationSource?: "manual" | "ringcentral";
    durationSeconds?: number;
};

export type LeadCallStat = {
    _id?: string;
    lead:
    | string
    | {
        _id: string;
    };
    leadName: string;
    businessName: string;
    callCount: number;
    callNotConnectedCount?: number;
    callVoicemailCount?: number;
    lastCallAt?: string | null;
    lastNotConnectedAt?: string | null;
    lastVoicemailAt?: string | null;
    callLogs: LeadCallLogItem[];
    createdAt?: string;
    updatedAt?: string;
};

export type LeadCallSummaryLead = {
    leadId: string;
    leadName: string;
    businessName: string;
    callCount: number;
    callNotConnectedCount: number;
    callVoicemailCount: number;
    totalAttempts: number;
    lastCallAt: string | null;
};

export type EmployeeLeadCallSummary = {
    employeeId: string;
    employeeName: string;
    crmBusinessId: string;
    crmBusinessName: string;
    employeeRole: string;
    employeeTeam: string;
    totalCalls: number;
    totalNotConnectedCalls: number;
    totalVoicemails: number;
    totalAttempts: number;
    lastCallAt: string | null;
    leads: LeadCallSummaryLead[];
};

export type LeadCallSummaryParams = {
    from?: string;
    to?: string;
    employeeId?: string;
};

export async function getLeadCallStat(leadId: string) {
    const response = await api.get<LeadCallStat>(`/log/${leadId}/call-stat`);

    return response.data;
}

export async function getLeadCallStats(limit = 10000) {
    const response = await api.get<LeadCallStat[]>("/log/call-stats", {
        params: {
            limit,
        },
    });

    return response.data;
}

export async function getMyLeadCallStats(limit = 10000, employeeId = "") {
    const response = await api.get<LeadCallStat[]>("/log/call-stats/me", {
        params: {
            limit,
            employeeId,
        },
    });

    return response.data;
}

export async function getLeadCallSummary(params: LeadCallSummaryParams = {}) {
    const response = await api.get<EmployeeLeadCallSummary[]>("/log/call-summary", { params });
    return response.data;
}

export async function getMyLeadCallSummary(params: LeadCallSummaryParams = {}) {
    const response = await api.get<EmployeeLeadCallSummary[]>("/log/call-summary/me", { params });
    return response.data;
}

export async function logConnectedLeadCall(leadId: string, employeeId: string) {
    const response = await api.patch<LeadCallStat>(`/log/${leadId}/log-call`, {
        employeeId,
        clickedAt: new Date().toISOString(),
    });

    return response.data;
}

export async function logLeadNotConnected(leadId: string, employeeId: string) {
    const response = await api.patch<LeadCallStat>(`/log/${leadId}/not-connected`, {
        employeeId,
        clickedAt: new Date().toISOString(),
    });

    return response.data;
}

export async function logLeadVoicemail(leadId: string, employeeId: string) {
    const response = await api.patch<LeadCallStat>(`/log/${leadId}/voicemail`, {
        employeeId,
        clickedAt: new Date().toISOString(),
    });

    return response.data;
}
