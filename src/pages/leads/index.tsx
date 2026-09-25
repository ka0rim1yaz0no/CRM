import type { FormEvent, UIEvent } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FiArchive, FiCalendar, FiCheckCircle, FiClock, FiEdit2, FiMail, FiMessageCircle, FiPhone, FiPlus, FiSave, FiSearch, FiStar, FiUserPlus, FiVoicemail, FiX } from "react-icons/fi";
import { FaWhatsapp } from "react-icons/fa";
import { useLocation, useSearchParams } from "react-router";
import MainLayout from "../layout";
import { getAuthUser } from "../../api/authStorage";
import { getEmployees, type Employee } from "../../api/employees";
import { addLeadComment, archiveLead, assignLead, createLead, getLead, getLeadCallStat, getMyLeadCounts, getMyLeads, logConnectedLeadCall, logLeadNotConnected, logLeadVoicemail, recordLeadCall, scheduleLeadFollowUp, toggleLeadFavorite, updateLead, updateLeadStatus, type EmployeeLeadTab, type Lead, type LeadInput, type LeadStatus, type MyLeadsPage } from "../../api/leads";
import { getSystemSettings } from "../../api/systemSettings";
import { useToast } from "../../components/ToastProvider";
import { useFeatureFlags } from "../../hooks/useFeatureFlags";
import { formatCstDate, formatCstDateTime, formatCstDateTimeInput, getCurrentCstDateTimeInput, parseCstDateTimeInput, formatPhDateTime } from "../../lib/dateTime";
import { clearAutoCallPendingComment, getAutoCallPendingComment, getEmployeeCommentMarker, startAutoCallPendingComment } from "../../lib/employeeAutoCall";
import { socket } from "../../lib/socket";

const tabs: Array<LeadStatus | "ALL"> = [
    "NEW",
    "Qualified",
    "Ongoing Negotiation",
    "Completed",
    "Dead",
    "Archived",
    "ALL",
];

const LEAD_PAGE_SIZE = 50;

const employeeStatusOptions: LeadStatus[] = [
    "NEW",
    "Follow up",
    "Qualified",
    "Ongoing Negotiation",
    "Dead",
];

type CallLoggerConfirmAction = "connected" | "not_connected" | "voicemail";
type LeadActionName = "archive" | "assignment" | "details" | "schedule" | "status";

type LeadChangedPayload = {
    action: string;
    lead?: Lead;
    leadIds?: string[];
    assignedAgentId?: string | null;
};

const emptyLead: LeadInput = {
    leadName: "",
    position: "",
    businessName: "",
    businessAddress: "",
    email: "",
    phone: "",
    website: "",
    source: "Manual",
    category: "",
    status: "NEW",
    assignedAgent: null,
    assignedAgentName: "",
    assignedTeam: null,
    googlePlaceId: "",
    notes: "",
    followUpAt: null,
    followUpNote: "",
    followUpPriority: 0,
};

type LeadActivityItem = {
    label: string;
    detail: string;
    status: string;
    createdAt?: string;
};

type LeadDetailDraft = {
    leadName: string;
    position: string;
    businessName: string;
    businessAddress: string;
    email: string;
    phone: string;
    website: string;
    source: string;
    category: string;
};

const emptyLeadDetailDraft: LeadDetailDraft = {
    leadName: "",
    position: "",
    businessName: "",
    businessAddress: "",
    email: "",
    phone: "",
    website: "",
    source: "",
    category: "",
};

function createLeadDetailDraft(lead: Lead | null): LeadDetailDraft {
    if (!lead) {
        return emptyLeadDetailDraft;
    }

    return {
        leadName: lead.leadName || "",
        position: lead.position || "",
        businessName: lead.businessName || "",
        businessAddress: lead.businessAddress || "",
        email: lead.email || "",
        phone: lead.phone || "",
        website: lead.website || "",
        source: lead.source || "",
        category: lead.category || "",
    };
}

function getLeadActivity(lead: Lead): LeadActivityItem[] {
    const commentActivities = (lead.comments || []).map((comment) => ({
        label: comment.authorName === "CSV Import" ? "Uploaded comment" : "Comment",
        detail: `${comment.authorName || "Employee"}: ${comment.body}`,
        status: "Done",
        createdAt: comment.createdAt,
    }));

    if (lead.activity?.length) {
        return [
            ...lead.activity.map((item) => ({
                label: item.label,
                detail: item.detail,
                status: item.status,
                createdAt: item.createdAt,
            })),
            ...commentActivities,
        ];
    }

    const assignedName = lead.assignedAgent?.name || lead.assignedAgentName || "you";

    return [
        ...commentActivities,
        {
            label: "Assigned",
            detail: `This lead is assigned to ${assignedName}.`,
            status: "Done",
        },
        {
            label: lead.status,
            detail: lead.status === "Follow up" ? "Follow-up is due for this lead." : `Current status is ${lead.status}.`,
            status: "Current",
        },
    ];
}

function getCurrentLeadAgent(lead: Lead) {
    return lead.assignedAgent?.name || lead.assignedAgentName || "Unassigned";
}

function getPreviousLeadAgent(lead: Lead) {
    const currentAgent = getCurrentLeadAgent(lead).toLowerCase();
    const assignmentItems = (lead.activity || [])
        .filter((item) => String(item.label || "").toLowerCase() === "assigned")
        .sort((first, second) => new Date(second.createdAt || 0).getTime() - new Date(first.createdAt || 0).getTime());

    for (const item of assignmentItems) {
        const match = String(item.detail || "").match(/\b(?:to|assigned this lead to|passed this lead to)\s+(.+?)(?:\.|$)/i);
        const assignedName = match?.[1]?.trim();

        if (assignedName && assignedName.toLowerCase() !== currentAgent) {
            return assignedName;
        }

        if (item.actorType === "employee" && item.actorName && item.actorName.toLowerCase() !== currentAgent) {
            return item.actorName;
        }
    }

    return "None";
}

function formatFilterLabel(value: string) {
    return value
        .trim()
        .replace(/\s+/g, " ")
        .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function toLeadInput(lead: Lead, overrides: Partial<LeadInput> = {}): LeadInput {
    return {
        leadName: lead.leadName || "",
        position: lead.position || "",
        businessName: lead.businessName,
        businessAddress: lead.businessAddress || "",
        email: lead.email || "",
        phone: lead.phone || "",
        website: lead.website || "",
        source: lead.source || "Manual",
        category: lead.category || "",
        status: lead.status,
        assignedAgent: lead.assignedAgent?._id || null,
        assignedAgentName: lead.assignedAgentName || "",
        assignedTeam: lead.assignedTeam?._id || null,
        googlePlaceId: lead.googlePlaceId || "",
        notes: lead.notes || "",
        followUpAt: lead.followUpAt || null,
        followUpNote: lead.followUpNote || "",
        followUpPriority: lead.followUpPriority || 0,
        aiScore: lead.aiScore || 0,
        aiScoreReason: lead.aiScoreReason || "",
        aiScoreSource: lead.aiScoreSource || "",
        aiScoredAt: lead.aiScoredAt || null,
        ...overrides,
    };
}

function mergeLeadPages(current: Lead[], next: Lead[]) {
    const leadsById = new Map<string, Lead>();

    [...current, ...next].forEach((lead) => {
        if (!leadsById.has(lead._id)) {
            leadsById.set(lead._id, lead);
        }
    });

    return Array.from(leadsById.values());
}

function isLeadFavorite(lead: Lead, employeeId: string) {
    return Boolean(employeeId && (lead.favoriteByEmployees || []).some((favoriteEmployeeId) => String(favoriteEmployeeId) === employeeId));
}

function parseLeadTime(value?: string | null) {
    if (!value) return null;
    const time = new Date(value).getTime();
    return Number.isNaN(time) ? null : time;
}

function getManualCommentTime(lead: Lead) {
    const manualCommentTimes = (lead.comments || [])
        .filter((comment) => comment.authorName !== "CSV Import")
        .map((comment) => parseLeadTime(comment.createdAt))
        .filter((time): time is number => time !== null);

    return manualCommentTimes.length > 0 ? Math.max(...manualCommentTimes) : null;
}

function getCommentActivityTime(lead: Lead) {
    const commentActivityTimes = (lead.activity || [])
        .filter((item) => item.label.toLowerCase() === "comment added")
        .map((item) => parseLeadTime(item.createdAt))
        .filter((time): time is number => time !== null);

    return commentActivityTimes.length > 0 ? Math.max(...commentActivityTimes) : null;
}

function getAssignmentMoveTime(lead: Lead) {
    const assignmentTimes = (lead.activity || [])
        .filter((item) => {
            const label = item.label.toLowerCase();
            const detail = item.detail.toLowerCase();

            return label === "assigned" || detail.includes(" passed this lead") || detail.includes(" assigned this lead");
        })
        .map((item) => parseLeadTime(item.createdAt))
        .filter((time): time is number => time !== null);

    return assignmentTimes.length > 0 ? Math.max(...assignmentTimes) : null;
}

function getUpdateActivityTime(lead: Lead) {
    const updateTimes = (lead.activity || [])
        .filter((item) => {
            const label = item.label.toLowerCase();
            return label === "lead updated" || label === "status updated" || label === "status changed" || label === "follow up scheduled";
        })
        .map((item) => parseLeadTime(item.createdAt))
        .filter((time): time is number => time !== null);

    return updateTimes.length > 0 ? Math.max(...updateTimes) : null;
}

function getLeadDeprioritizedTime(lead: Lead) {
    const times = [getManualCommentTime(lead), getCommentActivityTime(lead), getAssignmentMoveTime(lead), getUpdateActivityTime(lead)].filter(
        (time): time is number => time !== null
    );
    return times.length > 0 ? Math.max(...times) : null;
}

function isScheduledForToday(lead: Lead) {
    return Boolean(lead.status !== "Qualified" && lead.followUpAt && formatCstDate(lead.followUpAt) === formatCstDate(new Date()));
}

function isScheduledDueNow(lead: Lead, now = Date.now()) {
    if (lead.status === "Qualified") {
        return false;
    }

    const followUpTime = parseLeadTime(lead.followUpAt);
    return followUpTime !== null && followUpTime <= now;
}

function hasManualCommentToday(lead: Lead) {
    const today = formatCstDate(new Date());
    return (lead.comments || []).some(
        (comment) => comment.authorName !== "CSV Import" && formatCstDate(comment.createdAt) === today
    ) || (lead.activity || []).some(
        (item) => item.label.toLowerCase() === "comment added" && formatCstDate(item.createdAt) === today
    );
}

function hasContactActivityToday(lead: Lead) {
    const today = formatCstDate(new Date());
    const contactActivityLabels = new Set(["comment added", "lead updated", "status updated", "status changed", "follow up scheduled"]);

    return hasManualCommentToday(lead) || (lead.activity || []).some(
        (item) => contactActivityLabels.has(item.label.toLowerCase()) && formatCstDate(item.createdAt) === today
    );
}

function getContactActivityTime(lead: Lead) {
    const contactActivityLabels = new Set(["comment added", "lead updated", "status updated", "status changed", "follow up scheduled"]);
    const times = [
        ...(lead.comments || [])
            .filter((comment) => comment.authorName !== "CSV Import")
            .map((comment) => parseLeadTime(comment.createdAt)),
        ...(lead.activity || [])
            .filter((item) => contactActivityLabels.has(item.label.toLowerCase()))
            .map((item) => parseLeadTime(item.createdAt)),
    ].filter((time): time is number => time !== null);

    return times.length > 0 ? Math.max(...times) : null;
}

function isHiddenFromEmployeeQueueToday(lead: Lead) {
    if (!hasContactActivityToday(lead)) {
        return false;
    }

    const followUpTime = parseLeadTime(lead.followUpAt);

    if (followUpTime === null || followUpTime > Date.now()) {
        return true;
    }

    const contactTime = getContactActivityTime(lead);
    return contactTime !== null && contactTime >= followUpTime;
}

function isCallPriorityLead(lead: Lead) {
    return !isScheduledForToday(lead) && isNewWorkQueueLead(lead) && !hasManualCommentToday(lead);
}

function getLeadQueueRank(lead: Lead, now = Date.now()) {
    const hasCommentToday = hasManualCommentToday(lead);
    const scheduledDueNow = isScheduledDueNow(lead, now);

    if (scheduledDueNow && !isHiddenFromEmployeeQueueToday(lead)) return 0;
    const scheduledToday = isScheduledForToday(lead);
    if (lead.status === "NEW" && !hasCommentToday && !scheduledToday) return 1;
    if (lead.status === "NEW" && !scheduledToday) return 2;
    if (lead.status === "Follow up" && !scheduledToday) return 3;
    if (scheduledToday) return 5;
    return 4;
}

function sortEmployeeLeadsForWorkQueue(leads: Lead[], now = Date.now()) {
    return [...leads].sort((first, second) => {
        const firstRank = getLeadQueueRank(first, now);
        const secondRank = getLeadQueueRank(second, now);

        if (firstRank !== secondRank) {
            return firstRank - secondRank;
        }

        if (firstRank === 0 || firstRank === 5) {
            return (parseLeadTime(first.followUpAt) || 0) - (parseLeadTime(second.followUpAt) || 0);
        }

        const firstWorkedAt = getLeadDeprioritizedTime(first);
        const secondWorkedAt = getLeadDeprioritizedTime(second);
        if (firstWorkedAt !== null || secondWorkedAt !== null) {
            if (firstWorkedAt === null) return -1;
            if (secondWorkedAt === null) return 1;
            const workedAtDelta = firstWorkedAt - secondWorkedAt;

            if (workedAtDelta !== 0) {
                return workedAtDelta;
            }
        }

        const createdAtDelta = (parseLeadTime(second.createdAt) || 0) - (parseLeadTime(first.createdAt) || 0);

        if (createdAtDelta !== 0) {
            return createdAtDelta;
        }

        return first._id.localeCompare(second._id);
    });
}

function isSalesAgent(employee: Employee) {
    const role = (employee.role || "").toLowerCase();
    const department = (employee.team || "").toLowerCase();
    return role.includes("agent") || role.includes("sales") || department.includes("sales");
}

function canViewAllLeadQueues(employee?: Employee | null) {
    const role = (employee?.role || "").toLowerCase();
    const team = (employee?.team || "").toLowerCase();

    return (role.includes("outside") && role.includes("sales")) || (team.includes("outside") && team.includes("sales"));
}

function canViewCompletedLeadQueue(employee?: Employee | null) {
    const role = (employee?.role || "").toLowerCase();
    const team = (employee?.team || "").toLowerCase();
    const isOutsideSales = (role.includes("outside") && role.includes("sales")) || (team.includes("outside") && team.includes("sales"));
    const isInsideSales = (role.includes("inside") && role.includes("sales")) || (team.includes("inside") && team.includes("sales"));

    return isOutsideSales || isInsideSales;
}

function isNewWorkQueueLead(lead: Lead) {
    return lead.status === "NEW" || lead.status === "Follow up";
}

function matchesEmployeeTab(lead: Lead, tab: LeadStatus | "ALL") {
    if (tab === "NEW") return isNewWorkQueueLead(lead);
    if (tab === "ALL") return true;
    return lead.status === tab;
}

function getEmployeeLeadTab(tab: LeadStatus | "ALL"): EmployeeLeadTab {
    if (tab === "NEW") return "my";
    if (tab === "Qualified") return "qualified";
    if (tab === "Ongoing Negotiation") return "negotiation";
    if (tab === "Completed") return "completed";
    if (tab === "Dead") return "dead";
    if (tab === "Archived") return "archived";
    return "all";
}

export default function Leads() {
    const queryClient = useQueryClient();
    const { showToast } = useToast();
    const { isEnabled } = useFeatureFlags();
    const location = useLocation();
    const [searchParams, setSearchParams] = useSearchParams();
    const authUser = getAuthUser();
    const employeeId = authUser?.userType === "employee" ? authUser.user._id : "";
    const employeeCode = authUser?.userType === "employee"
        ? String(authUser.user.employeeCode || authUser.user._id).trim()
        : "";
    const requestedLeadId = searchParams.get("lead") || "";
    const routedAutoCallLead = (location.state as { autoCallLead?: Lead } | null)?.autoCallLead;
    const employeeName = authUser?.userType === "employee" ? authUser.user.name : "Employee";
    const canViewAllLeads = authUser?.userType === "employee" && canViewAllLeadQueues(authUser.user);
    const canViewCompletedLeads = authUser?.userType === "employee" && canViewCompletedLeadQueue(authUser.user);
    const canSearchLeads = isEnabled("lead-search", "employee");
    const canAddLeads = isEnabled("lead-add", "employee");
    const canUseLeadCategories = isEnabled("lead-categories", "employee");
    const employeeLeadNames = useMemo(() => {
        if (authUser?.userType !== "employee") {
            return [];
        }

        return Array.from(new Set([authUser.user.name, authUser.user.employeeCode, ...(authUser.user.aliases || [])].filter(Boolean)));
    }, [authUser]);
    const [activeTab, setActiveTab] = useState<LeadStatus | "ALL">(() => canViewAllLeads ? "Qualified" : "NEW");
    const [activeCategoryTab, setActiveCategoryTab] = useState("ALL");
    const [showFavoritesOnly, setShowFavoritesOnly] = useState(false);
    const [leadSearch, setLeadSearch] = useState("");
    const [debouncedLeadSearch, setDebouncedLeadSearch] = useState("");
    const [leadStateFilter, setLeadStateFilter] = useState("ALL");
    const [isGlobalLeadSearch, setIsGlobalLeadSearch] = useState(false);
    const [selectedLeadId, setSelectedLeadId] = useState<string | null>(null);
    const [leadHistoryIds, setLeadHistoryIds] = useState<string[]>([]);
    const [isDetailEditing, setIsDetailEditing] = useState(false);
    const [detailDraft, setDetailDraft] = useState<LeadDetailDraft>(emptyLeadDetailDraft);
    const [commentDraft, setCommentDraft] = useState("");
    const pendingCommentSaveRef = useRef<{ leadId: string; body: string; promise: Promise<Lead> } | null>(null);
    const leadActionPendingRef = useRef<LeadActionName | null>(null);
    const [activeLeadAction, setActiveLeadAction] = useState<LeadActionName | null>(null);
    const [passAgentId, setPassAgentId] = useState("");
    const [passConfirm, setPassConfirm] = useState<{ lead: Lead; agent: Employee } | null>(null);
    const [followUpDateTime, setFollowUpDateTime] = useState("");
    const [statusDraft, setStatusDraft] = useState<LeadStatus>("NEW");
    const [isLeadModalOpen, setIsLeadModalOpen] = useState(false);
    const [leadForm, setLeadForm] = useState<LeadInput>(emptyLead);
    const [leadPage, setLeadPage] = useState(1);
    const [hasMoreLeads, setHasMoreLeads] = useState(true);
    const [isFetchingMoreLeads, setIsFetchingMoreLeads] = useState(false);
    const [queueClock, setQueueClock] = useState(() => Date.now());
    const [workedLeadHolds, setWorkedLeadHolds] = useState<Lead[]>([]);
    const visibleTabs = useMemo(
        () => tabs.filter((tab) => {
            if (canViewAllLeads && (tab === "NEW" || tab === "Archived" || tab === "ALL")) {
                return false;
            }

            return tab !== "Completed" || canViewCompletedLeads;
        }),
        [canViewAllLeads, canViewCompletedLeads]
    );
    const visibleEmployeeStatusOptions = useMemo(
        () => canViewCompletedLeads ? [...employeeStatusOptions, "Completed" as LeadStatus] : employeeStatusOptions,
        [canViewCompletedLeads]
    );
    const effectiveLeadSearch = canSearchLeads || isGlobalLeadSearch ? debouncedLeadSearch : "";
    const isGlobalLeadSearchActive = isGlobalLeadSearch && Boolean(effectiveLeadSearch);
    const employeeLeadTab = getEmployeeLeadTab(activeTab);
    const requestedEmployeeLeadTab = isGlobalLeadSearchActive ? "all" : employeeLeadTab;
    const leadQueryKey = useMemo(
        () => ["leads", employeeId, employeeLeadNames.join("|"), requestedEmployeeLeadTab, activeTab, effectiveLeadSearch, isGlobalLeadSearchActive, leadStateFilter] as const,
        [activeTab, effectiveLeadSearch, employeeId, employeeLeadNames, isGlobalLeadSearchActive, leadStateFilter, requestedEmployeeLeadTab]
    );
    const { data: leadPageData, isLoading, isError } = useQuery({
        queryKey: leadQueryKey,
        queryFn: () =>
            getMyLeads({
                employeeId,
                employeeNames: employeeLeadNames,
                tab: requestedEmployeeLeadTab,
                page: 1,
                limit: LEAD_PAGE_SIZE,
                search: effectiveLeadSearch || undefined,
                searchAll: isGlobalLeadSearchActive || undefined,
                includeArchived: isGlobalLeadSearchActive || undefined,
                state: leadStateFilter !== "ALL" ? leadStateFilter : undefined,
            }),
        enabled: Boolean(employeeId),
    });
    const leads = leadPageData?.leads || [];
    const leadStateOptions = leadPageData?.stateOptions || [];
    const { data: requestedLead } = useQuery({
        queryKey: ["lead", requestedLeadId],
        queryFn: () => getLead(requestedLeadId),
        enabled: Boolean(employeeId && requestedLeadId),
    });
    const { data: leadCounts = {} } = useQuery({
        queryKey: ["lead-counts", employeeId, employeeLeadNames.join("|"), leadStateFilter],
        queryFn: () => getMyLeadCounts({ employeeId, employeeNames: employeeLeadNames, state: leadStateFilter !== "ALL" ? leadStateFilter : undefined }),
        enabled: Boolean(employeeId),
    });
    const { data: employees = [] } = useQuery({
        queryKey: ["employees"],
        queryFn: getEmployees,
    });
    const { data: systemSettings } = useQuery({
        queryKey: ["system-settings"],
        queryFn: getSystemSettings,
        enabled: Boolean(employeeId),
    });
    const categoryTabs = useMemo(() => {
        const categoryNames = new Map<string, string>();
        const categorySourceLeads = activeTab === "NEW" ? leads.filter(isNewWorkQueueLead) : leads;

        categorySourceLeads.forEach((lead) => {
            const category = formatFilterLabel(lead.category || "");

            if (category) {
                categoryNames.set(category.toLowerCase(), category);
            }
        });

        return ["ALL", ...Array.from(categoryNames.values()).sort((first, second) => first.localeCompare(second))];
    }, [activeTab, leads]);

    const holdWorkedLead = (lead: Lead) => {
        setWorkedLeadHolds((currentLeads) => mergeLeadPages([lead], currentLeads));
        setSelectedLeadId(lead._id);
    };

    const filteredLeads = useMemo(() => {
        const statusFilteredLeads = isGlobalLeadSearchActive
            ? leads
            : activeTab === "NEW"
                ? leads.filter(isNewWorkQueueLead)
                : leads.filter((lead) => matchesEmployeeTab(lead, activeTab));
        const categoryFilteredLeads =
            isGlobalLeadSearchActive || !canUseLeadCategories || activeCategoryTab === "ALL"
                ? statusFilteredLeads
                : statusFilteredLeads.filter((lead) => formatFilterLabel(lead.category || "").toLowerCase() === activeCategoryTab.toLowerCase());
        const favoriteFilteredLeads = showFavoritesOnly
            && !isGlobalLeadSearchActive
            ? categoryFilteredLeads.filter((lead) => isLeadFavorite(lead, employeeId))
            : categoryFilteredLeads;
        const searchText = isGlobalLeadSearchActive ? "" : effectiveLeadSearch.toLowerCase();
        const searchFilteredLeads =
            !searchText
                ? favoriteFilteredLeads
                : favoriteFilteredLeads.filter((lead) =>
                    [
                        lead.leadName,
                        lead.businessName,
                        lead.businessAddress,
                        lead.email,
                        lead.phone,
                        lead.website,
                        lead.source,
                        lead.category,
                        lead.status,
                        lead.notes,
                        ...(lead.comments || []).flatMap((comment) => [comment.body, comment.authorName]),
                        ...(lead.activity || []).map((item) => item.detail),
                    ]
                        .join(" ")
                        .toLowerCase()
                        .includes(searchText)
                );
        return isGlobalLeadSearchActive ? searchFilteredLeads : sortEmployeeLeadsForWorkQueue(searchFilteredLeads, queueClock);
    }, [activeCategoryTab, activeTab, canUseLeadCategories, effectiveLeadSearch, employeeId, isGlobalLeadSearchActive, leads, queueClock, showFavoritesOnly, workedLeadHolds]);
    const contactedTodayCount = leadCounts.ContactedToday ?? leads.filter((lead) => isNewWorkQueueLead(lead) && isHiddenFromEmployeeQueueToday(lead)).length;

    const routeSelectedLead = requestedLeadId
        ? leads.find((lead) => lead._id === requestedLeadId) ||
          workedLeadHolds.find((lead) => lead._id === requestedLeadId) ||
          (requestedLead?._id === requestedLeadId ? requestedLead : null) ||
          (routedAutoCallLead?._id === requestedLeadId ? routedAutoCallLead : null)
        : null;
    const selectedLead =
        routeSelectedLead ||
        leads.find((lead) => lead._id === selectedLeadId) ||
        workedLeadHolds.find((lead) => lead._id === selectedLeadId) ||
        filteredLeads[0] ||
        null;
    const leadHistory = leadHistoryIds
        .map((leadId) => leads.find((lead) => lead._id === leadId) || workedLeadHolds.find((lead) => lead._id === leadId))
        .filter((lead): lead is Lead => Boolean(lead));
    const showLeadMiniTabs = systemSettings?.employeeLeadMiniTabsEnabled !== false;
    const isStatusDraftQualified = statusDraft === "Qualified";
    const shouldClearQualifiedFollowUp = Boolean(selectedLead && selectedLead.status === "Qualified" && selectedLead.followUpAt);
    const hasStatusUpdate = Boolean(selectedLead && (statusDraft !== selectedLead.status || (isStatusDraftQualified && selectedLead.followUpAt)));
    const whatsappPhone = (selectedLead?.phone || "").replace(/\D/g, "");
    const activity = selectedLead ? getLeadActivity(selectedLead) : [];
    const passableAgents = useMemo(
        () => employees.filter((employee) => employee.status !== "Archived" && employee._id !== employeeId && isSalesAgent(employee)),
        [employeeId, employees]
    );
    const getTabCount = (tab: LeadStatus | "ALL") => {
        if (tab === "NEW") {
            return (leadCounts.NEW || 0) + (leadCounts["Follow up"] || 0);
        }

        return leadCounts[tab] || 0;
    };
    const getTabLabel = (tab: LeadStatus | "ALL") => (tab === "NEW" ? (canViewAllLeads ? "Leads" : "My Leads") : tab);

    const clearNavbarLeadSearchParams = () => {
        if (searchParams.has("scope") || searchParams.has("leadSearch") || searchParams.has("lead")) {
            setSearchParams({}, { replace: true });
        }
    };

    const fetchMoreLeads = async () => {
        if (!employeeId || isFetchingMoreLeads || !hasMoreLeads) {
            return;
        }

        const nextPage = leadPage + 1;
        setIsFetchingMoreLeads(true);

        try {
            const nextLeadPage = await getMyLeads({
                employeeId,
                employeeNames: employeeLeadNames,
                tab: requestedEmployeeLeadTab,
                page: nextPage,
                limit: LEAD_PAGE_SIZE,
                search: effectiveLeadSearch || undefined,
                searchAll: isGlobalLeadSearchActive || undefined,
                includeArchived: isGlobalLeadSearchActive || undefined,
                state: leadStateFilter !== "ALL" ? leadStateFilter : undefined,
            });
            queryClient.setQueryData<typeof leadPageData>(leadQueryKey, (current) => ({
                ...(current || nextLeadPage),
                ...nextLeadPage,
                leads: mergeLeadPages(current?.leads || [], nextLeadPage.leads),
            }));
            setLeadPage(nextPage);
            setHasMoreLeads(nextLeadPage.hasMore);
        } finally {
            setIsFetchingMoreLeads(false);
        }
    };

    useEffect(() => {
        setLeadPage(1);
        setHasMoreLeads(true);
    }, [employeeId, employeeLeadNames.join("|"), effectiveLeadSearch, isGlobalLeadSearchActive, leadStateFilter, requestedEmployeeLeadTab]);

    useEffect(() => {
        if (leadStateFilter === "ALL" || leadStateOptions.length === 0) {
            return;
        }

        if (!leadStateOptions.some((option) => option.code === leadStateFilter)) {
            setLeadStateFilter("ALL");
        }
    }, [leadStateFilter, leadStateOptions]);

    useEffect(() => {
        if (visibleTabs.length > 0 && !visibleTabs.includes(activeTab)) {
            setActiveTab(visibleTabs[0]);
            setActiveCategoryTab("ALL");
        }
    }, [activeTab, visibleTabs]);

    const handleLeadListScroll = (event: UIEvent<HTMLDivElement>) => {
        const list = event.currentTarget;
        const scrollableDistance = list.scrollHeight - list.clientHeight;

        if (scrollableDistance <= 0 || list.scrollTop / scrollableDistance >= 0.5) {
            void fetchMoreLeads();
        }
    };

    const selectLead = (leadId: string) => {
        if (requestedLeadId && leadId !== requestedLeadId) {
            const nextSearchParams = new URLSearchParams(searchParams);
            nextSearchParams.delete("lead");
            setSearchParams(nextSearchParams, { replace: true });
        }

        setSelectedLeadId(leadId);

        if (!showLeadMiniTabs) {
            return;
        }

        setLeadHistoryIds((current) => (current.includes(leadId) ? current : [leadId, ...current].slice(0, 8)));
    };

    const closeLeadHistory = (leadId: string) => {
        setLeadHistoryIds((current) => current.filter((historyId) => historyId !== leadId));

        if (selectedLeadId !== leadId) {
            return;
        }

        const remainingHistory = leadHistoryIds.filter((historyId) => historyId !== leadId);
        setSelectedLeadId(remainingHistory[0] || filteredLeads.find((lead) => lead._id !== leadId)?._id || null);
    };

    useEffect(() => {
        if (!showLeadMiniTabs) {
            setLeadHistoryIds([]);
        }
    }, [showLeadMiniTabs]);

    const invalidateEmployeeLeads = () => {
        void queryClient.invalidateQueries({ queryKey: ["leads", employeeId] });
        void queryClient.invalidateQueries({ queryKey: ["lead-counts", employeeId] });
        void queryClient.refetchQueries({ queryKey: leadQueryKey });
        void queryClient.refetchQueries({ queryKey: ["lead-counts", employeeId, employeeLeadNames.join("|"), leadStateFilter] });
    };

    const updateCachedLeadPage = (updateLeads: (current: Lead[]) => Lead[]) => {
        queryClient.setQueryData<typeof leadPageData>(leadQueryKey, (current) =>
            current ? { ...current, leads: updateLeads(current.leads) } : current
        );
    };

    useEffect(() => {
        if (!employeeId) {
            return;
        }

        socket.connect();

        const handleLeadChanged = (payload: LeadChangedPayload) => {
            const changedLead = payload.lead;
            const changedLeadId = changedLead?._id;
            const changedLeadIds = new Set([...(payload.leadIds || []), ...(changedLeadId ? [changedLeadId] : [])]);

            if (changedLead) {
                queryClient.setQueriesData<MyLeadsPage>({ queryKey: ["leads", employeeId] }, (current) => {
                    if (!current) return current;

                    const hasLead = current.leads.some((lead) => lead._id === changedLead._id);
                    const isAssignedHere = changedLead.assignedAgent?._id === employeeId;
                    const shouldAddToCurrentPage = isAssignedHere && payload.action !== "call-logged";

                    if (!hasLead && !shouldAddToCurrentPage) {
                        return current;
                    }

                    return {
                        ...current,
                        leads: hasLead
                            ? current.leads.map((lead) => (lead._id === changedLead._id ? changedLead : lead))
                            : mergeLeadPages([changedLead], current.leads),
                    };
                });
            }

            if (changedLeadIds.size > 0) {
                queryClient.setQueriesData<MyLeadsPage>({ queryKey: ["leads", employeeId] }, (current) => {
                    if (!current) return current;

                    if (!current.leads.some((lead) => changedLeadIds.has(lead._id))) {
                        return current;
                    }

                    return {
                        ...current,
                        leads: current.leads.filter((lead) => !payload.leadIds?.includes(lead._id)),
                    };
                });
            }

            setQueueClock(Date.now());
            void queryClient.invalidateQueries({ queryKey: ["leads", employeeId] });
            void queryClient.invalidateQueries({ queryKey: ["lead-counts", employeeId] });
            void queryClient.refetchQueries({ queryKey: leadQueryKey });
            void queryClient.refetchQueries({ queryKey: ["lead-counts", employeeId, employeeLeadNames.join("|"), leadStateFilter] });
        };

        socket.on("lead:changed", handleLeadChanged);

        return () => {
            socket.off("lead:changed", handleLeadChanged);
        };
    }, [employeeId, employeeLeadNames, leadQueryKey, leadStateFilter, queryClient]);

    const createEmployeeOwnedLeadInput = (lead: LeadInput): LeadInput => ({
        ...lead,
        assignedAgent: employeeId || null,
        assignedAgentName: employeeName,
        activityActorName: employeeName,
        activityActorType: "employee",
    });

    const createLeadMutation = useMutation({
        mutationFn: createLead,
        onSuccess: (createdLead) => {
            queryClient.setQueryData<typeof leadPageData>(leadQueryKey, (current) =>
                current ? { ...current, leads: mergeLeadPages([createdLead], current.leads), total: current.total + 1 } : current
            );
            setLeadForm(createEmployeeOwnedLeadInput(emptyLead));
            setIsLeadModalOpen(false);
            invalidateEmployeeLeads();
            showToast({ tone: "success", message: "Lead added." });
        },
        onError: () => {
            showToast({ tone: "error", message: "Could not add lead." });
        },
    });

    const addCommentMutation = useMutation({
        mutationFn: ({ id, body }: { id: string; body: string }) =>
            addLeadComment(id, { body, authorName: employeeName, authorType: "employee" }),
        onMutate: (variables) => {
            const pendingAutoCall = getAutoCallPendingComment(employeeCode);
            clearAutoCallPendingComment(employeeCode, variables.id);
            const previousLeadPage = queryClient.getQueryData<typeof leadPageData>(leadQueryKey);
            const optimisticComment = {
                _id: `pending-${Date.now()}`,
                authorName: employeeName,
                authorType: "employee" as const,
                body: variables.body,
                createdAt: new Date().toISOString(),
            };

            updateCachedLeadPage((current) => current.map((lead) =>
                lead._id === variables.id
                    ? { ...lead, comments: [...(lead.comments || []), optimisticComment] }
                    : lead
            ));
            setCommentDraft((current) => (current.trim() === variables.body ? "" : current));

            return {
                previousLeadPage,
                pendingAutoCall: pendingAutoCall?.leadId === variables.id ? pendingAutoCall : null,
            };
        },
        onSuccess: (updatedLead, variables) => {
            updateCachedLeadPage((current) => current.map((lead) => (lead._id === updatedLead._id ? updatedLead : lead)));
            holdWorkedLead(updatedLead);
            clearAutoCallPendingComment(employeeCode, updatedLead._id);
            setCommentDraft((current) => (current.trim() === variables.body ? "" : current));
            void queryClient.invalidateQueries({ queryKey: ["lead-counts", employeeId] });
            showToast({ tone: "success", message: "Note added to the lead." });
        },
        onError: (error, variables, context) => {
            if (context?.previousLeadPage) {
                queryClient.setQueryData(leadQueryKey, context.previousLeadPage);
            }
            if (context?.pendingAutoCall && !getAutoCallPendingComment(employeeCode)) {
                startAutoCallPendingComment(
                    employeeCode,
                    context.pendingAutoCall.leadId,
                    context.pendingAutoCall.baselineCommentMarker
                );
            }
            setCommentDraft((current) => current || variables.body);
            const message =
                (error as { response?: { data?: { message?: string } } })?.response?.data?.message ||
                (error instanceof Error ? error.message : "") ||
                "Could not add the note. Please try again.";
            showToast({ tone: "error", message });
        },
    });

    const recordCallMutation = useMutation({
        mutationFn: (id: string) => recordLeadCall(id, { activityActorName: employeeName, activityActorType: "employee" }),
        onSuccess: (updatedLead) => {
            updateCachedLeadPage((current) => current.map((lead) => (lead._id === updatedLead._id ? updatedLead : lead)));
            invalidateEmployeeLeads();
        },
    });

    const updateDetailsMutation = useMutation({
        mutationFn: async ({ lead, draft }: { lead: Lead; draft: LeadDetailDraft }) => {
            const currentLead = await getLead(lead._id);
            return updateLead(
                currentLead._id,
                toLeadInput(currentLead, {
                    ...draft,
                    businessName: draft.businessName.trim(),
                    category: canUseLeadCategories ? draft.category : currentLead.category,
                    activityActorName: employeeName,
                    activityActorType: "employee",
                })
            );
        },
        onSuccess: (updatedLead) => {
            updateCachedLeadPage((current) => current.map((lead) => (lead._id === updatedLead._id ? updatedLead : lead)));
            setDetailDraft(createLeadDetailDraft(updatedLead));
            setIsDetailEditing(false);
            invalidateEmployeeLeads();
        },
        onError: () => {
            showToast({ tone: "error", message: "Could not save lead details." });
        },
    });

    const updateStatusMutation = useMutation({
        mutationFn: ({ id, status }: { id: string; status: LeadStatus }) =>
            updateLeadStatus(id, status, { activityActorName: employeeName, activityActorType: "employee" }),
        onSuccess: (updatedLead) => {
            updateCachedLeadPage((current) => current.map((lead) => (lead._id === updatedLead._id ? updatedLead : lead)));
            holdWorkedLead(updatedLead);
            if (updatedLead.status === "Qualified") {
                setFollowUpDateTime("");
            }
            invalidateEmployeeLeads();
        },
        onError: () => {
            showToast({ tone: "error", message: "Could not update lead status." });
        },
    });

    const toggleFavoriteMutation = useMutation({
        mutationFn: ({ lead, favorite }: { lead: Lead; favorite: boolean }) =>
            toggleLeadFavorite(lead._id, { employeeId, favorite }),
        onSuccess: (updatedLead) => {
            updateCachedLeadPage((current) => current.map((lead) => (lead._id === updatedLead._id ? updatedLead : lead)));
        },
        onError: () => {
            showToast({ tone: "error", message: "Could not update favorite." });
        },
    });

    const archiveLeadMutation = useMutation({
        mutationFn: (id: string) => archiveLead(id, { activityActorName: employeeName, activityActorType: "employee" }),
        onSuccess: (updatedLead) => {
            updateCachedLeadPage((current) => {
                if (activeTab === "Archived") {
                    return mergeLeadPages([updatedLead], current);
                }

                return current.filter((lead) => lead._id !== updatedLead._id);
            });
            setSelectedLeadId(updatedLead._id);
            setActiveTab("Archived");
            invalidateEmployeeLeads();
            showToast({ tone: "success", message: "Lead archived." });
        },
        onError: () => {
            showToast({ tone: "error", message: "Could not archive lead." });
        },
    });

    const scheduleFollowUpMutation = useMutation({
        mutationFn: ({ id, followUpAt, followUpNote }: { id: string; followUpAt: string; followUpNote: string }) =>
            scheduleLeadFollowUp(id, {
                followUpAt,
                followUpNote,
                followUpPriority: 100,
                activityActorName: employeeName,
                activityActorType: "employee",
            }),
        onSuccess: (updatedLead) => {
            updateCachedLeadPage((current) => current.map((lead) => (lead._id === updatedLead._id ? updatedLead : lead)));
            setFollowUpDateTime("");
            holdWorkedLead(updatedLead);
            invalidateEmployeeLeads();
            showToast({ tone: "success", message: "Follow-up scheduled." });
        },
        onError: () => {
            showToast({ tone: "error", message: "Could not schedule follow-up." });
        },
    });

    const passLeadMutation = useMutation({
        mutationFn: ({ lead, agent }: { lead: Lead; agent: Employee }) =>
            assignLead(
                lead._id,
                {
                    assignedAgent: agent._id,
                    assignedAgentName: agent.name,
                    activityActorName: employeeName,
                    activityActorType: "employee",
                }
            ),
        onSuccess: (updatedLead) => {
            updateCachedLeadPage((current) => mergeLeadPages([updatedLead], current));
            holdWorkedLead(updatedLead);
            setPassAgentId("");
            setPassConfirm(null);
            invalidateEmployeeLeads();
            showToast({ tone: "success", message: `Lead reassigned to ${updatedLead.assignedAgent?.name || updatedLead.assignedAgentName}.` });
        },
        onError: () => {
            showToast({ tone: "error", message: "Could not reassign the lead." });
        },
    });

    const startCommentSave = (leadId: string, body: string) => {
        const currentPendingSave = pendingCommentSaveRef.current;

        if (currentPendingSave?.leadId === leadId) {
            return currentPendingSave.promise;
        }

        const promise = addCommentMutation.mutateAsync({ id: leadId, body });
        pendingCommentSaveRef.current = { leadId, body, promise };
        void promise.then(
            () => {
                if (pendingCommentSaveRef.current?.promise === promise) pendingCommentSaveRef.current = null;
            },
            () => {
                if (pendingCommentSaveRef.current?.promise === promise) pendingCommentSaveRef.current = null;
            }
        );
        return promise;
    };

    const runLeadActionAfterComment = async (
        leadId: string,
        actionName: LeadActionName,
        action: () => Promise<unknown>
    ) => {
        if (leadActionPendingRef.current) {
            return;
        }

        leadActionPendingRef.current = actionName;
        setActiveLeadAction(actionName);

        try {
            const pendingCommentSave = pendingCommentSaveRef.current;
            let savedCommentBody = "";

            if (pendingCommentSave) {
                await pendingCommentSave.promise;
                if (pendingCommentSave.leadId === leadId) {
                    savedCommentBody = pendingCommentSave.body.trim();
                }
            }

            const unsavedComment = selectedLead?._id === leadId ? commentDraft.trim() : "";
            if (unsavedComment && unsavedComment !== savedCommentBody) {
                await startCommentSave(leadId, unsavedComment);
            }

            await action();
        } catch {
            // Each mutation reports its own error and a failed note prevents the queued action.
        } finally {
            leadActionPendingRef.current = null;
            setActiveLeadAction(null);
        }
    };

    useEffect(() => {
        setDetailDraft(createLeadDetailDraft(selectedLead));
        setIsDetailEditing(false);
        setCommentDraft("");
        setPassAgentId("");
        setPassConfirm(null);
    }, [selectedLead?._id]);

    useEffect(() => {
        setStatusDraft(selectedLead?.status || "NEW");
    }, [selectedLead?._id, selectedLead?.status]);

    useEffect(() => {
        setFollowUpDateTime(formatCstDateTimeInput(selectedLead?.followUpAt) || getCurrentCstDateTimeInput());
    }, [selectedLead?._id, selectedLead?.followUpAt]);

    useEffect(() => {
        const timeoutId = window.setTimeout(() => {
            setDebouncedLeadSearch(leadSearch.trim());
        }, 250);

        return () => window.clearTimeout(timeoutId);
    }, [leadSearch]);

    useEffect(() => {
        const routeSearch = searchParams.get("leadSearch") || "";
        const routeLeadId = searchParams.get("lead") || "";
        const shouldSearchAll = searchParams.get("scope") === "all" && Boolean(routeSearch);

        if (!shouldSearchAll && !routeLeadId) {
            return;
        }

        if (shouldSearchAll) {
            setLeadSearch(routeSearch);
            setDebouncedLeadSearch(routeSearch);
            setIsGlobalLeadSearch(true);
            setActiveTab("ALL");
            setShowFavoritesOnly(false);
            setActiveCategoryTab("ALL");
        }

        if (routeLeadId) {
            if (!shouldSearchAll && !canViewAllLeads) {
                setLeadSearch("");
                setDebouncedLeadSearch("");
                setIsGlobalLeadSearch(false);
                setActiveTab("NEW");
                setShowFavoritesOnly(false);
                setActiveCategoryTab("ALL");
            }

            setSelectedLeadId(routeLeadId);
        }
    }, [canViewAllLeads, searchParams]);

    useEffect(() => {
        const intervalId = window.setInterval(() => {
            setQueueClock(Date.now());
        }, 60 * 1000);

        return () => window.clearInterval(intervalId);
    }, []);

    useEffect(() => {
        if (!canSearchLeads && !isGlobalLeadSearch) {
            setLeadSearch("");
            setDebouncedLeadSearch("");
        }
    }, [canSearchLeads, isGlobalLeadSearch]);

    useEffect(() => {
        if (!canUseLeadCategories) {
            setActiveCategoryTab("ALL");
        }
    }, [canUseLeadCategories]);

    useEffect(() => {
        if (!canAddLeads) {
            setIsLeadModalOpen(false);
        }
    }, [canAddLeads]);

    useEffect(() => {
        setLeadPage(1);
        setHasMoreLeads(true);
        setSelectedLeadId(requestedLeadId || null);
        setActiveCategoryTab("ALL");
    }, [activeTab, effectiveLeadSearch, employeeId, showFavoritesOnly]);

    useEffect(() => {
        if (!isLoading && leadPage === 1) {
            const expectedTotal = isGlobalLeadSearchActive ? leadPageData?.total || leads.length : getTabCount(activeTab) || leadCounts.ALL || leads.length;
            setHasMoreLeads(leads.length === LEAD_PAGE_SIZE && leads.length < expectedTotal);
        }
    }, [activeTab, isGlobalLeadSearchActive, isLoading, leadCounts, leadPage, leadPageData?.total, leads.length]);

    const saveComment = () => {
        if (addCommentMutation.isPending || pendingCommentSaveRef.current) {
            return;
        }

        if (!selectedLead) {
            return;
        }

        const body = commentDraft.trim();

        if (!body) {
            return;
        }

        void startCommentSave(selectedLead._id, body).catch(() => undefined);
    };

    const handleArchiveLead = () => {
        if (!selectedLead || archiveLeadMutation.isPending) {
            return;
        }

        const leadId = selectedLead._id;
        void runLeadActionAfterComment(leadId, "archive", () => archiveLeadMutation.mutateAsync(leadId));
    };

    const requestPassLead = () => {
        if (!selectedLead || !passAgentId) {
            return;
        }

        const agent = passableAgents.find((employee) => employee._id === passAgentId);
        if (!agent) {
            showToast({ tone: "error", message: "Select an active agent first." });
            return;
        }

        setPassConfirm({ lead: selectedLead, agent });
    };

    const handleScheduleFollowUp = () => {
        if (scheduleFollowUpMutation.isPending) {
            return;
        }

        if (!selectedLead || !followUpDateTime) {
            showToast({ tone: "error", message: "Choose a follow-up date and time." });
            return;
        }

        if (selectedLead.status === "Qualified" || statusDraft === "Qualified") {
            showToast({ tone: "error", message: "Qualified leads do not use follow-up schedules." });
            return;
        }

        const scheduledDate = parseCstDateTimeInput(followUpDateTime);
        if (!scheduledDate) {
            showToast({ tone: "error", message: "Use a valid follow-up date and time." });
            return;
        }

        const leadId = selectedLead._id;
        void runLeadActionAfterComment(leadId, "schedule", () => scheduleFollowUpMutation.mutateAsync({
            id: leadId,
            followUpAt: scheduledDate.toISOString(),
            followUpNote: "",
        }));
    };

    const handleSaveStatus = () => {
        if (!selectedLead || updateStatusMutation.isPending || !hasStatusUpdate) {
            return;
        }

        const leadId = selectedLead._id;
        const nextStatus = statusDraft;
        void runLeadActionAfterComment(leadId, "status", () =>
            updateStatusMutation.mutateAsync({ id: leadId, status: nextStatus })
        );
    };

    const openLeadModal = () => {
        if (!canAddLeads) {
            showToast({ tone: "error", message: "Adding leads is disabled by admin." });
            return;
        }

        setLeadForm(createEmployeeOwnedLeadInput(emptyLead));
        setIsLeadModalOpen(true);
    };

    const closeLeadModal = () => {
        setLeadForm(createEmployeeOwnedLeadInput(emptyLead));
        setIsLeadModalOpen(false);
    };

    const updateLeadForm = (field: keyof LeadInput, value: string) => {
        setLeadForm((current) => ({ ...current, [field]: value }));
    };

    const handleSaveLead = (event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();

        if (createLeadMutation.isPending) {
            return;
        }

        if (!leadForm.businessName.trim()) {
            showToast({ tone: "error", message: "Business name is required." });
            return;
        }

        if (!employeeId) {
            showToast({ tone: "error", message: "Employee account is required to add a lead." });
            return;
        }

        if (!canAddLeads) {
            showToast({ tone: "error", message: "Adding leads is disabled by admin." });
            return;
        }

        createLeadMutation.mutate(createEmployeeOwnedLeadInput({
            ...leadForm,
            category: canUseLeadCategories ? leadForm.category : "",
        }));
    };

    const updateDetailDraft = (field: keyof LeadDetailDraft, value: string) => {
        setDetailDraft((current) => ({ ...current, [field]: value }));
    };

    const cancelDetailEdit = () => {
        setDetailDraft(createLeadDetailDraft(selectedLead));
        setIsDetailEditing(false);
    };

    const saveLeadDetails = () => {
        if (updateDetailsMutation.isPending) {
            return;
        }

        if (!selectedLead) {
            return;
        }

        if (!detailDraft.businessName.trim()) {
            showToast({ tone: "error", message: "Business name is required." });
            return;
        }

        const lead = selectedLead;
        const draft = { ...detailDraft };
        void runLeadActionAfterComment(lead._id, "details", () =>
            updateDetailsMutation.mutateAsync({ lead, draft })
        );
    };

    const confirmPassLead = () => {
        if (!passConfirm || passLeadMutation.isPending) {
            return;
        }

        const assignment = passConfirm;
        void runLeadActionAfterComment(assignment.lead._id, "assignment", () =>
            passLeadMutation.mutateAsync(assignment)
        );
    };

    const toggleFavorite = (lead: Lead) => {
        if (!employeeId || toggleFavoriteMutation.isPending) {
            return;
        }

        toggleFavoriteMutation.mutate({ lead, favorite: !isLeadFavorite(lead, employeeId) });
    };


    function getAuthEmployeeId() {
        const authUser = getAuthUser();

        if (!authUser || authUser.userType !== "employee") {
            return "";
        }

        const user = authUser.user;

        if (!user) {
            return "";
        }

        if ("_id" in user && user._id) {
            return String(user._id);
        }

        if ("id" in user && user.id) {
            return String(user.id);
        }

        return "";
    }

    const getCurrentEmployeeIdForCall = () => {
        return employeeId || getAuthEmployeeId();
    };

    const authEmployeeId = getCurrentEmployeeIdForCall();

    const activeSelectedLeadId = selectedLead?._id || "";

    const selectedLeadCallStatQuery = useQuery({
        queryKey: ["lead-call-stat", activeSelectedLeadId],
        queryFn: () => getLeadCallStat(activeSelectedLeadId),
        enabled: Boolean(activeSelectedLeadId),
    });

    const selectedLeadCallStat = selectedLeadCallStatQuery.data || null;

    const selectedLeadCallLogs = useMemo(() => {
        const logs = selectedLeadCallStat?.callLogs || [];

        if (!authEmployeeId) {
            return [];
        }

        return logs.filter((log) => {
            const logEmployeeId =
                typeof log.employee === "string"
                    ? log.employee
                    : log.employee?._id;

            return String(logEmployeeId) === String(authEmployeeId);
        });
    }, [selectedLeadCallStat?.callLogs, authEmployeeId]);

    const selectedLeadConnectedLogs = useMemo(() => {
        return selectedLeadCallLogs.filter((log) => {
            return (log.outcome || "connected") === "connected";
        });
    }, [selectedLeadCallLogs]);

    const selectedLeadNotConnectedLogs = useMemo(() => {
        return selectedLeadCallLogs.filter((log) => {
            return log.outcome === "not_connected";
        });
    }, [selectedLeadCallLogs]);

    const selectedLeadVoicemailLogs = useMemo(() => {
        return selectedLeadCallLogs.filter((log) => {
            return log.outcome === "voicemail";
        });
    }, [selectedLeadCallLogs]);

    const selectedLeadCallCount = selectedLeadConnectedLogs.length;
    const selectedLeadCallNotConnectedCount = selectedLeadNotConnectedLogs.length;
    const selectedLeadVoicemailCount = selectedLeadVoicemailLogs.length;
    const selectedLeadTotalCallAttempts =
        selectedLeadCallCount + selectedLeadCallNotConnectedCount + selectedLeadVoicemailCount;

    // const hasLoggedAnyCallActionToday = useMemo(() => {
    //     return selectedLeadCallLogs.some((log) => isSameLocalDay(log.calledAt));
    // }, [selectedLeadCallLogs]);

    const [callLoggerConfirmAction, setCallLoggerConfirmAction] =
        useState<CallLoggerConfirmAction | null>(null);

    const latestSelectedLeadCallLog = useMemo(() => {
        return [...selectedLeadCallLogs].sort((first, second) => {
            const firstTime = first.calledAt ? new Date(first.calledAt).getTime() : 0;
            const secondTime = second.calledAt ? new Date(second.calledAt).getTime() : 0;

            return secondTime - firstTime;
        })[0];
    }, [selectedLeadCallLogs]);

    const handleCallStatSuccess = async (
        callStat: Awaited<ReturnType<typeof logConnectedLeadCall>>,
        fallbackLeadId: string,
        successMessage: string
    ) => {
        showToast({
            tone: "success",
            message: successMessage,
        });

        const statLeadId =
            typeof callStat.lead === "string"
                ? callStat.lead
                : callStat.lead?._id;

        const leadIdToUpdate = statLeadId || fallbackLeadId;

        queryClient.setQueryData(["lead-call-stat", leadIdToUpdate], callStat);

        await Promise.all([
            queryClient.invalidateQueries({
                queryKey: ["lead-call-stat", leadIdToUpdate],
            }),

            queryClient.invalidateQueries({
                queryKey: ["lead-call-stats"],
                exact: false,
            }),

            queryClient.invalidateQueries({
                queryKey: ["lead-call-stats", "me"],
                exact: false,
            }),

            queryClient.invalidateQueries({
                queryKey: ["agent-lead-dashboard"],
                exact: false,
            }),
        ]);
    };

    const handleCallStatError = (error: any) => {
        const errorMessage =
            error?.response?.data?.message ||
            error?.message ||
            "Could not update call count. Please try again.";

        console.error("Lead call stat error:", error?.response?.data || error);

        showToast({
            tone: "error",
            message: errorMessage,
        });
    };

    const logConnectedCallMutation = useMutation({
        mutationFn: ({
            leadId,
            employeeId,
        }: {
            leadId: string;
            employeeId: string;
        }) => logConnectedLeadCall(leadId, employeeId),

        onSuccess: async (callStat, variables) => {
            await handleCallStatSuccess(
                callStat,
                variables.leadId,
                "Connected logged."
            );
        },

        onError: handleCallStatError,
    });

    const logNotConnectedMutation = useMutation({
        mutationFn: ({
            leadId,
            employeeId,
        }: {
            leadId: string;
            employeeId: string;
        }) => logLeadNotConnected(leadId, employeeId),

        onSuccess: async (callStat, variables) => {
            await handleCallStatSuccess(
                callStat,
                variables.leadId,
                "Not connected logged."
            );
        },

        onError: handleCallStatError,
    });

    const logVoicemailMutation = useMutation({
        mutationFn: ({
            leadId,
            employeeId,
        }: {
            leadId: string;
            employeeId: string;
        }) => logLeadVoicemail(leadId, employeeId),

        onSuccess: async (callStat, variables) => {
            await handleCallStatSuccess(
                callStat,
                variables.leadId,
                "Voicemail logged."
            );
        },

        onError: handleCallStatError,
    });

    const isLoggingConnectedCall = logConnectedCallMutation.isPending;
    const isLoggingNotConnected = logNotConnectedMutation.isPending;
    const isLoggingVoicemail = logVoicemailMutation.isPending;
    const isLoggingAnyCall =
        isLoggingConnectedCall || isLoggingNotConnected || isLoggingVoicemail;

    const selectedLeadDisplayName =
        selectedLead?.leadName || selectedLead?.businessName || "this lead";

    const requestedCallLoggerLabel =
        callLoggerConfirmAction === "not_connected"
            ? "Not connected"
            : callLoggerConfirmAction === "voicemail"
              ? "Voicemail"
              : "Connected";

    const openLogConnectedCallConfirm = () => {
        if (isLoggingAnyCall) {
            return;
        }

        if (!selectedLead) {
            showToast({
                tone: "error",
                message: "No lead selected.",
            });
            return;
        }

        setCallLoggerConfirmAction("connected");
    };

    const openLogNotConnectedConfirm = () => {
        if (isLoggingAnyCall) {
            return;
        }

        if (!selectedLead) {
            showToast({
                tone: "error",
                message: "No lead selected.",
            });
            return;
        }

        setCallLoggerConfirmAction("not_connected");
    };

    const openLogVoicemailConfirm = () => {
        if (isLoggingAnyCall) {
            return;
        }

        if (!selectedLead) {
            showToast({
                tone: "error",
                message: "No lead selected.",
            });
            return;
        }

        setCallLoggerConfirmAction("voicemail");
    };

    const closeCallLoggerConfirm = () => {
        if (isLoggingAnyCall) {
            return;
        }

        setCallLoggerConfirmAction(null);
    };

    const confirmCallLoggerAction = () => {
        if (!callLoggerConfirmAction) {
            return;
        }

        switch (callLoggerConfirmAction) {
            case "connected":
                handleLogConnectedCall();
                break;
            case "not_connected":
                handleLogNotConnected();
                break;
            case "voicemail":
                handleLogVoicemail();
                break;
        }

        setCallLoggerConfirmAction(null);
    };

    const handleLogConnectedCall = () => {
        if (isLoggingAnyCall) {
            return;
        }

        if (!selectedLead) {
            showToast({
                tone: "error",
                message: "No lead selected.",
            });
            return;
        }

        const currentEmployeeId = getCurrentEmployeeIdForCall();

        if (!currentEmployeeId) {
            showToast({
                tone: "error",
                message: "Logged-in employee not found. Please log out and log back in.",
            });
            return;
        }

        logConnectedCallMutation.mutate({
            leadId: selectedLead._id,
            employeeId: currentEmployeeId,
        });
    };

    const handleLogNotConnected = () => {
        if (isLoggingAnyCall) {
            return;
        }

        if (!selectedLead) {
            showToast({
                tone: "error",
                message: "No lead selected.",
            });
            return;
        }

        const currentEmployeeId = getCurrentEmployeeIdForCall();

        if (!currentEmployeeId) {
            showToast({
                tone: "error",
                message: "Logged-in employee not found. Please log out and log back in.",
            });
            return;
        }

        logNotConnectedMutation.mutate({
            leadId: selectedLead._id,
            employeeId: currentEmployeeId,
        });
    };

    const handleLogVoicemail = () => {
        if (isLoggingAnyCall) {
            return;
        }

        if (!selectedLead) {
            showToast({
                tone: "error",
                message: "No lead selected.",
            });
            return;
        }

        const currentEmployeeId = getCurrentEmployeeIdForCall();

        if (!currentEmployeeId) {
            showToast({
                tone: "error",
                message: "Logged-in employee not found. Please log out and log back in.",
            });
            return;
        }

        logVoicemailMutation.mutate({
            leadId: selectedLead._id,
            employeeId: currentEmployeeId,
        });
    };


    return (
        <MainLayout>
            <section className="employee-leads-page -m-4 min-h-[calc(100vh-5.5rem)] p-4 2xl:-m-6 2xl:p-6">
                <div className="border-b border-white/10">
                    <div className="flex flex-col gap-3 py-3 xl:flex-row xl:items-end xl:justify-between">
                        <div className="content-scroll flex min-w-0 items-end gap-5 overflow-x-auto">
                            {visibleTabs.map((tab) => {
                                const isActive = tab === activeTab;
                                const tabCount = getTabCount(tab);

                                return (
                                    <button
                                        key={tab}
                                        className={[
                                            "relative flex h-10 shrink-0 items-center gap-2 px-1 text-sm font-semibold transition",
                                            isActive ? "text-[#9b5cff]" : "text-white/60 hover:text-white",
                                        ].join(" ")}
                                        type="button"
                                        onClick={() => {
                                            setIsGlobalLeadSearch(false);
                                            clearNavbarLeadSearchParams();
                                            setActiveTab(tab);
                                        }}
                                    >
                                        <span>{getTabLabel(tab)}</span>
                                        <span className="rounded-md bg-white/[0.06] px-1.5 py-0.5 text-[0.68rem] font-semibold text-white/35">
                                            {tabCount}
                                        </span>
                                        {isActive && <span className="absolute inset-x-0 bottom-0 h-0.5 rounded-full bg-[#842cff]" />}
                                    </button>
                                );
                            })}
                        </div>
                        {canAddLeads && (
                            <button
                                className="flex h-9 w-fit items-center gap-2 rounded-lg bg-[linear-gradient(135deg,#842cff,#4a0ebd)] px-3 text-xs font-semibold text-white transition hover:brightness-110"
                                type="button"
                                onClick={openLeadModal}
                            >
                                <FiPlus className="size-4" aria-hidden="true" />
                                Add Lead
                            </button>
                        )}
                    </div>
                </div>

                <div className="grid h-[calc(100vh-12rem)] min-h-[32rem] gap-5 pt-5 lg:grid-cols-[minmax(16rem,20rem)_1fr]">
                    <section className="employee-leads-list-panel flex min-h-0 flex-col overflow-hidden rounded-lg border border-white/10 bg-[#f100ff30]">
                        <div className="flex min-h-14 items-center justify-between gap-3 border-b border-black/10 px-5 py-3">
                            <h2 className="min-w-0 text-base font-semibold leading-tight text-black">{canViewAllLeads ? "Leads" : "My Leads"}</h2>
                            <div className="grid shrink-0 grid-cols-[auto_auto_auto] items-center gap-2">
                                <button
                                    className={[
                                        "flex h-8 min-w-0 items-center gap-1.5 rounded-lg border px-2.5 text-xs font-semibold transition",
                                        showFavoritesOnly
                                            ? "border-amber-400/45 bg-amber-300/30 text-black"
                                            : "border-black/10 bg-white/45 text-black/70 hover:bg-white/65 hover:text-black",
                                    ].join(" ")}
                                    type="button"
                                    aria-pressed={showFavoritesOnly}
                                    title={showFavoritesOnly ? "Showing favorites" : "Show favorites"}
                                    onClick={() => setShowFavoritesOnly((current) => !current)}
                                >
                                    <FiStar className="size-3.5 shrink-0" fill={showFavoritesOnly ? "currentColor" : "none"} aria-hidden="true" />
                                    <span className="hidden sm:inline">Favorites</span>
                                </button>
                                <span className="flex h-8 min-w-8 items-center justify-center rounded-lg border border-black/10 bg-white/45 px-2 text-xs font-semibold text-black">
                                    {filteredLeads.length}
                                </span>
                                <span className="flex h-8 items-center rounded-lg border border-black/10 bg-white/45 px-2 text-xs font-semibold text-black">
                                    <span className="hidden sm:inline">Contacted&nbsp;</span>{contactedTodayCount}
                                </span>
                            </div>
                        </div>
                        {(canSearchLeads || leadStateOptions.length > 0) && (
                            <div className="grid gap-2 border-b border-white/10 p-3">
                                {canSearchLeads && (
                                    <label className="flex h-9 min-w-0 items-center gap-2 rounded-lg border border-white/10 bg-black/20 px-3 text-white/45 focus-within:border-[#842cff] focus-within:ring-2 focus-within:ring-[#842cff]/20">
                                        <FiSearch className="size-3.5 shrink-0" aria-hidden="true" />
                                        <input
                                            className="h-full min-w-0 flex-1 bg-transparent text-xs font-semibold text-white outline-none placeholder:text-white/30"
                                            value={leadSearch}
                                            onChange={(event) => {
                                                setIsGlobalLeadSearch(false);
                                                clearNavbarLeadSearchParams();
                                                setLeadSearch(event.target.value);
                                            }}
                                            placeholder="Search leads"
                                        />
                                    </label>
                                )}
                                <select
                                    className="h-9 min-w-0 rounded-lg border border-white/10 bg-black/20 px-3 text-xs font-semibold text-white outline-none transition hover:bg-black/30 focus:border-[#842cff] focus:ring-2 focus:ring-[#842cff]/20 disabled:cursor-not-allowed disabled:opacity-70"
                                    value={leadStateFilter}
                                    onChange={(event) => {
                                        setLeadStateFilter(event.target.value);
                                        setActiveCategoryTab("ALL");
                                    }}
                                    disabled={isLoading || leadStateOptions.length === 0}
                                    aria-label="Filter leads by state"
                                >
                                    <option value="ALL">All states</option>
                                    {leadStateOptions.map((option) => (
                                        <option key={option.code} value={option.code}>
                                            {option.name}
                                        </option>
                                    ))}
                                </select>
                            </div>
                        )}
                        {canUseLeadCategories && (
                            <div className="content-scroll flex gap-2 overflow-x-auto border-b border-white/10 px-4 py-3">
                                {categoryTabs.map((category) => {
                                    const isActive = category === activeCategoryTab;

                                    return (
                                        <button
                                            key={category}
                                            className={[
                                                "h-8 shrink-0 rounded-lg border px-3 text-xs font-semibold transition",
                                                isActive
                                                    ? "border-[#54a0ff] bg-[#54a0ff] text-white"
                                                    : "border-[#2e86de] bg-[#2e86de] text-white hover:border-[#1f6fbf] hover:bg-[#1f6fbf]",
                                            ].join(" ")}
                                            type="button"
                                            onClick={() => setActiveCategoryTab(category)}
                                        >
                                            {category === "ALL" ? "All" : category}
                                        </button>
                                    );
                                })}
                            </div>
                        )}

                        <div className="content-scroll min-h-0 flex-1 divide-y divide-white/10 overflow-y-auto" onScroll={handleLeadListScroll}>
                            {isLoading && <p className="px-5 py-6 text-sm text-white/45">{canViewAllLeads ? "Loading leads..." : "Loading assigned leads..."}</p>}
                            {isError && <p className="px-5 py-6 text-sm text-red-200">{canViewAllLeads ? "Unable to load leads." : "Unable to load assigned leads."}</p>}
                            {!isLoading && !isError && filteredLeads.length === 0 && (
                                <p className="px-5 py-6 text-sm text-white/45">{canViewAllLeads ? "No leads in this tab." : "No leads assigned to you in this tab."}</p>
                            )}
                            {filteredLeads.map((lead) => {
                                const isFavorite = isLeadFavorite(lead, employeeId);
                                const isCallPriority = isCallPriorityLead(lead);
                                const isScheduledToday = isScheduledForToday(lead);
                                const wasCommentedToday = hasManualCommentToday(lead);

                                return (
                                    <div
                                        key={lead._id}
                                        className={[
                                            "flex w-full items-center gap-2 px-3 py-3 transition",
                                            selectedLead?._id === lead._id ? "bg-white/[0.07]" : "hover:bg-white/[0.04]",
                                        ].join(" ")}
                                    >
                                        <button
                                            className={[
                                                "flex size-9 shrink-0 items-center justify-center rounded-lg border transition",
                                                isFavorite
                                                    ? "border-amber-300/45 bg-amber-300/15 text-amber-200"
                                                    : "border-white/10 bg-white/[0.04] text-white/35 hover:bg-white/[0.08] hover:text-white/70",
                                            ].join(" ")}
                                            type="button"
                                            aria-label={`${isFavorite ? "Remove favorite from" : "Mark favorite"} ${lead.leadName || lead.businessName}`}
                                            title={isFavorite ? "Remove favorite" : "Mark favorite"}
                                            disabled={toggleFavoriteMutation.isPending}
                                            onClick={() => toggleFavorite(lead)}
                                        >
                                            <FiStar className="size-4" fill={isFavorite ? "currentColor" : "none"} aria-hidden="true" />
                                        </button>
                                        <button
                                            className="flex min-w-0 flex-1 items-center justify-between gap-3 text-left"
                                            type="button"
                                            onClick={() => selectLead(lead._id)}
                                        >
                                            <span className="min-w-0 flex-1">
                                                <span className="block truncate text-sm font-semibold text-white">
                                                    {lead.leadName || lead.businessName}
                                                </span>
                                                <span className="mt-1 block truncate text-xs text-white/45">{lead.businessName}</span>
                                            </span>
                                            <span className="w-[42%] min-w-0 max-w-[7.5rem] shrink-0 text-right">
                                                <span className="block truncate text-xs font-semibold text-white/45" title={canUseLeadCategories ? lead.category || lead.source : lead.source}>
                                                    {canUseLeadCategories ? lead.category || lead.source : lead.source}
                                                </span>
                                                <span className="mt-1 grid grid-cols-[0.875rem_minmax(0,1fr)] items-center gap-1.5 text-left text-xs font-semibold text-[#5f27cd]">
                                                    <span className="flex size-3.5 items-center justify-center" aria-hidden="true">
                                                        {isCallPriority ? (
                                                            <FiCheckCircle className="size-3.5 text-sky-400" />
                                                        ) : isScheduledToday ? (
                                                            <FiClock className="size-3.5 text-red-400" />
                                                        ) : wasCommentedToday ? (
                                                            <FiCheckCircle className="size-3.5 text-sky-400" />
                                                        ) : null}
                                                    </span>
                                                    <span className="truncate">{lead.status}</span>
                                                </span>
                                            </span>
                                        </button>
                                    </div>
                                );
                            })}
                            {isFetchingMoreLeads && (
                                <p className="px-5 py-4 text-center text-xs font-semibold text-white/40">
                                    Loading leads... {leads.length.toLocaleString()} / {(leadPageData?.total || leads.length).toLocaleString()}
                                </p>
                            )}
                            {!isLoading && !hasMoreLeads && leads.length > 0 && (
                                <p className="px-5 py-4 text-center text-xs text-white/30">End of loaded leads</p>
                            )}
                        </div>
                    </section>

                    <section className="employee-lead-detail-area flex min-h-0 flex-col overflow-hidden">
                        <div className="flex min-h-14 flex-wrap items-center justify-between gap-3 px-1 py-1">
                            <div>
                                <h2 className="text-base font-semibold text-white">Lead Details</h2>
                                <p className="mt-1 text-xs text-white/40">Assigned to you</p>
                            </div>
                            {selectedLead && selectedLead.status !== "Archived" && !canViewAllLeads && (
                                <button
                                    className="flex h-9 items-center gap-2 rounded-lg border border-white/10 bg-white/[0.06] px-3 text-xs font-semibold text-white/70 transition hover:border-red-400/30 hover:bg-red-400/10 hover:text-red-100 disabled:cursor-not-allowed disabled:opacity-60"
                                    type="button"
                                    onClick={handleArchiveLead}
                                    disabled={archiveLeadMutation.isPending || Boolean(activeLeadAction)}
                                >
                                    <FiArchive className="size-4" aria-hidden="true" />
                                    {activeLeadAction === "archive" ? "Saving & archiving..." : "Archive"}
                                </button>
                            )}
                        </div>

                        {showLeadMiniTabs && leadHistory.length > 0 && (
                            <div className="bg-black/10 px-4 pt-2">
                                <div className="content-scroll flex gap-1 overflow-x-auto">
                                    {leadHistory.map((lead) => {
                                        const isActive = selectedLead?._id === lead._id;

                                        return (
                                            <div
                                                key={lead._id}
                                                className={[
                                                    "group flex h-10 max-w-52 shrink-0 items-center rounded-t-lg border border-b-0 text-xs font-semibold transition",
                                                    isActive
                                                        ? "border-white/15 bg-[#090b13] text-white"
                                                        : "border-white/10 bg-white/[0.04] text-white/55 hover:bg-white/[0.07] hover:text-white",
                                                ].join(" ")}
                                                title={lead.leadName || lead.businessName}
                                            >
                                                <button
                                                    className="min-w-0 flex-1 truncate px-3 text-left"
                                                    type="button"
                                                    onClick={() => selectLead(lead._id)}
                                                >
                                                    {lead.leadName || lead.businessName}
                                                </button>
                                                <button
                                                    className="mr-2 flex size-5 shrink-0 items-center justify-center rounded text-white/45 transition hover:bg-white/10 hover:text-white"
                                                    type="button"
                                                    aria-label={`Close ${lead.leadName || lead.businessName}`}
                                                    onClick={() => closeLeadHistory(lead._id)}
                                                >
                                                    <FiX className="size-3.5" aria-hidden="true" />
                                                </button>
                                            </div>
                                        );
                                    })}
                                </div>
                            </div>
                        )}

                        {selectedLead ? (
                            <div className="content-scroll grid min-h-0 flex-1 gap-5 overflow-y-auto p-5 pr-3 xl:grid-cols-[minmax(0,1fr)_20rem]">
                                <div className="space-y-5">
                                    <div className="relative rounded-lg border border-white/10 bg-white/[0.04] p-5">
                                        <div className="grid gap-4 pr-0 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-start sm:pr-40">
                                            <div className="min-w-0 sm:order-1">
                                                <p className="text-sm text-white/45">Lead Name</p>
                                                {isDetailEditing ? (
                                                    <div className="mt-2 grid gap-2 sm:grid-cols-2">
                                                        <input
                                                            className="h-10 rounded-lg border border-white/10 bg-black/20 px-3 text-sm font-semibold text-white outline-none transition placeholder:text-white/30 focus:border-[#842cff] focus:ring-2 focus:ring-[#842cff]/20"
                                                            value={detailDraft.leadName}
                                                            onChange={(event) => updateDetailDraft("leadName", event.target.value)}
                                                            placeholder="Lead name"
                                                        />
                                                        <input
                                                            className="h-10 rounded-lg border border-white/10 bg-black/20 px-3 text-sm font-semibold text-white outline-none transition placeholder:text-white/30 focus:border-[#842cff] focus:ring-2 focus:ring-[#842cff]/20"
                                                            value={detailDraft.position}
                                                            onChange={(event) => updateDetailDraft("position", event.target.value)}
                                                            placeholder="Position"
                                                        />
                                                    </div>
                                                ) : (
                                                    <>
                                                        <h3 className="mt-1 text-2xl font-semibold text-white">
                                                            {selectedLead.leadName || "No contact name"}
                                                        </h3>
                                                        <p className="mt-1 text-sm text-white/55">{selectedLead.position || "No position"}</p>
                                                    </>
                                                )}
                                            </div>

                                            <div className="flex items-center gap-2 sm:absolute sm:right-5 sm:top-5 sm:order-2 sm:justify-end">
                                                {isDetailEditing ? (
                                                    <>
                                                        <button
                                                            className="flex h-9 items-center gap-1.5 rounded-lg border border-white/10 bg-white/[0.06] px-3 text-xs font-semibold text-white/65 transition hover:bg-white/10 hover:text-white"
                                                            type="button"
                                                            disabled={updateDetailsMutation.isPending || Boolean(activeLeadAction)}
                                                            onClick={cancelDetailEdit}
                                                        >
                                                            <FiX className="size-3.5" aria-hidden="true" />
                                                            Cancel
                                                        </button>
                                                        <button
                                                            className="flex h-9 items-center gap-1.5 rounded-lg border border-[#842cff]/35 bg-[#842cff]/15 px-3 text-xs font-semibold text-[#d7c5ff] transition hover:bg-[#842cff]/25 disabled:cursor-not-allowed disabled:opacity-60"
                                                            type="button"
                                                            disabled={updateDetailsMutation.isPending || Boolean(activeLeadAction) || !detailDraft.businessName.trim()}
                                                            onClick={saveLeadDetails}
                                                        >
                                                            <FiSave className="size-3.5" aria-hidden="true" />
                                                            {activeLeadAction === "details" ? "Saving..." : "Save"}
                                                        </button>
                                                    </>
                                                ) : (
                                                    <>
                                                        <button
                                                            className={[
                                                                "flex size-9 items-center justify-center rounded-lg border transition",
                                                                isLeadFavorite(selectedLead, employeeId)
                                                                    ? "border-amber-300/45 bg-amber-300/15 text-amber-200"
                                                                    : "border-white/10 bg-white/[0.06] text-white/45 hover:bg-white/10 hover:text-white",
                                                            ].join(" ")}
                                                            type="button"
                                                            onClick={() => toggleFavorite(selectedLead)}
                                                            disabled={toggleFavoriteMutation.isPending}
                                                            aria-label={isLeadFavorite(selectedLead, employeeId) ? "Remove favorite" : "Mark favorite"}
                                                            title={isLeadFavorite(selectedLead, employeeId) ? "Remove favorite" : "Mark favorite"}
                                                        >
                                                            <FiStar className="size-4" fill={isLeadFavorite(selectedLead, employeeId) ? "currentColor" : "none"} aria-hidden="true" />
                                                        </button>
                                                        <button
                                                            className="flex size-9 items-center justify-center rounded-lg border border-white/10 bg-white/[0.06] text-white/70 transition hover:bg-white/10 hover:text-white"
                                                            type="button"
                                                            onClick={() => {
                                                                setDetailDraft(createLeadDetailDraft(selectedLead));
                                                                setIsDetailEditing(true);
                                                            }}
                                                            aria-label="Edit lead details"
                                                        >
                                                            <FiEdit2 className="size-4" aria-hidden="true" />
                                                        </button>
                                                    </>
                                                )}
                                                <a
                                                    className="flex size-9 items-center justify-center rounded-lg border border-white/10 bg-white/[0.06] text-white/70 transition hover:bg-white/10 hover:text-white"
                                                    href={`tel:${selectedLead.phone}`}
                                                    onClick={() => {
                                                        if (selectedLead.phone) {
                                                            if (selectedLead.status === "Follow up") {
                                                                startAutoCallPendingComment(
                                                                    employeeCode,
                                                                    selectedLead._id,
                                                                    getEmployeeCommentMarker(selectedLead.comments)
                                                                );
                                                            }
                                                            recordCallMutation.mutate(selectedLead._id);
                                                        }
                                                    }}
                                                    aria-label="Call lead"
                                                >
                                                    <FiPhone className="size-4" aria-hidden="true" />
                                                </a>
                                                <a
                                                    className="flex size-9 items-center justify-center rounded-lg border border-white/10 bg-white/[0.06] text-white/70 transition hover:bg-white/10 hover:text-white"
                                                    href={`mailto:${selectedLead.email}`}
                                                    aria-label="Email lead"
                                                >
                                                    <FiMail className="size-4" aria-hidden="true" />
                                                </a>
                                                <a
                                                    className="flex size-9 items-center justify-center rounded-lg border border-[#25d366]/30 bg-[#25d366]/10 text-[#7cf0a4] transition hover:bg-[#25d366]/20"
                                                    href={`https://wa.me/${whatsappPhone}`}
                                                    aria-label="WhatsApp lead"
                                                >
                                                    <FaWhatsapp className="size-4" aria-hidden="true" />
                                                </a>
                                            </div>
                                        </div>

                                        {isDetailEditing ? (
                                            <div className="mt-5 grid gap-3 md:grid-cols-2">
                                                {[
                                                    ["Business", "businessName", "Business name"],
                                                    ["Email", "email", "email@example.com"],
                                                    ["Phone Number", "phone", "Phone number"],
                                                    ["Website", "website", "https://example.com"],
                                                    ["Source", "source", "Manual"],
                                                    ...(canUseLeadCategories ? [["Category", "category", "Category"]] : []),
                                                ].map(([label, field, placeholder]) => (
                                                    <label key={field} className="block">
                                                        <span className="text-xs font-medium uppercase tracking-[0.14em] text-white/35">{label}</span>
                                                        <input
                                                            className="mt-2 h-10 w-full rounded-lg border border-white/10 bg-black/20 px-3 text-sm font-semibold text-white outline-none transition placeholder:text-white/30 focus:border-[#842cff] focus:ring-2 focus:ring-[#842cff]/20"
                                                            value={detailDraft[field as keyof LeadDetailDraft]}
                                                            onChange={(event) => updateDetailDraft(field as keyof LeadDetailDraft, event.target.value)}
                                                            placeholder={placeholder}
                                                        />
                                                    </label>
                                                ))}
                                                <label className="block md:col-span-2">
                                                    <span className="text-xs font-medium uppercase tracking-[0.14em] text-white/35">Business Address</span>
                                                    <textarea
                                                        className="mt-2 min-h-20 w-full resize-y rounded-lg border border-white/10 bg-black/20 px-3 py-3 text-sm font-semibold text-white outline-none transition placeholder:text-white/30 focus:border-[#842cff] focus:ring-2 focus:ring-[#842cff]/20"
                                                        value={detailDraft.businessAddress}
                                                        onChange={(event) => updateDetailDraft("businessAddress", event.target.value)}
                                                        placeholder="Business address"
                                                    />
                                                </label>
                                            </div>
                                        ) : (
                                            <div className="mt-5 grid gap-4 md:grid-cols-2">
                                                <div>
                                                    <p className="text-xs font-medium uppercase tracking-[0.14em] text-white/35">Business</p>
                                                    <p className="mt-2 text-sm font-semibold text-white">{selectedLead.businessName}</p>
                                                    <p className="mt-1 text-sm leading-6 text-white/55">
                                                        {selectedLead.businessAddress || "No address"}
                                                    </p>
                                                </div>
                                                <div className="space-y-4">
                                                    <div>
                                                        <p className="text-xs font-medium uppercase tracking-[0.14em] text-white/35">Email</p>
                                                        <p className="mt-2 truncate text-sm font-semibold text-white">
                                                            {selectedLead.email || "No email"}
                                                        </p>
                                                    </div>
                                                    <div>
                                                        <p className="text-xs font-medium uppercase tracking-[0.14em] text-white/35">
                                                            Phone Number
                                                        </p>
                                                        <p className="mt-2 text-sm font-semibold text-white">{selectedLead.phone || "No phone"}</p>
                                                    </div>
                                                </div>
                                            </div>
                                        )}
                                    </div>

                                    {/* Employee Leads page call logger card */}
                                    <div className="rounded-lg border border-white/10 bg-white/[0.04] p-4">
                                        <div className="flex flex-col gap-3">
                                            <div>
                                                <p className="text-xs font-medium uppercase tracking-[0.14em] text-white/35">
                                                    Calls
                                                </p>

                                                <p className="mt-1 text-xs text-white/45">
                                                    Connected calls: {selectedLeadCallCount}
                                                </p>

                                                <p className="mt-1 text-xs text-white/45">
                                                    Not connected: {selectedLeadCallNotConnectedCount}
                                                </p>

                                                <p className="mt-1 text-xs text-white/45">
                                                    Voicemails: {selectedLeadVoicemailCount}
                                                </p>

                                                <p className="mt-1 text-xs text-white/35">
                                                    Total attempts: {selectedLeadTotalCallAttempts}
                                                </p>

                                                {selectedLeadCallLogs.length > 0 && (
                                                    <p className="mt-1 text-xs text-white/35">
                                                        Last call:{" "}
                                                        {latestSelectedLeadCallLog?.calledAt
                                                            ? formatPhDateTime(latestSelectedLeadCallLog.calledAt)
                                                            : "No date"}
                                                    </p>
                                                )}
                                            </div>

                                            <div className="grid w-full grid-cols-3 gap-2">
                                                <button
                                                    className="admin-log-call-button flex h-10 min-w-0 items-center justify-center rounded-lg border border-[#f13453] bg-[#f13453] px-2 text-xs font-semibold text-white transition hover:border-[#db203f] hover:bg-[#db203f] disabled:cursor-not-allowed disabled:opacity-80"
                                                    type="button"
                                                    onClick={openLogNotConnectedConfirm}
                                                    disabled={!selectedLead || isLoggingAnyCall}
                                                >
                                                    {isLoggingNotConnected ? "Logging" : "Not connected"}
                                                </button>

                                                <button
                                                    className="admin-log-call-button flex h-10 min-w-0 items-center justify-center gap-1.5 rounded-lg border border-[#2563eb] bg-[#2563eb] px-2 text-xs font-semibold text-white transition hover:border-[#1d4ed8] hover:bg-[#1d4ed8] disabled:cursor-not-allowed disabled:opacity-80"
                                                    type="button"
                                                    onClick={openLogVoicemailConfirm}
                                                    disabled={!selectedLead || isLoggingAnyCall}
                                                >
                                                    <FiVoicemail className="size-4" aria-hidden="true" />
                                                    {isLoggingVoicemail ? "Logging" : "Voicemail"}
                                                </button>

                                                <button
                                                    className="admin-log-call-button flex h-10 min-w-0 items-center justify-center rounded-lg border border-[#10ac84] bg-[#10ac84] px-2 text-xs font-semibold text-white transition hover:border-[#0b8f6e] hover:bg-[#0b8f6e] disabled:cursor-not-allowed disabled:opacity-80"
                                                    type="button"
                                                    onClick={openLogConnectedCallConfirm}
                                                    disabled={!selectedLead || isLoggingAnyCall}
                                                >
                                                    {isLoggingConnectedCall ? "Logging" : "Connected"}
                                                </button>
                                            </div>
                                        </div>
                                    </div>


                                    <div className="grid gap-2.5 sm:grid-cols-2 xl:grid-cols-3">
                                        {[
                                            ["Lead Source", selectedLead.source],
                                            ["Created By", selectedLead.createdByName || "System"],
                                            ...(canUseLeadCategories ? [["Filter", selectedLead.category || "All"]] : []),
                                            ["AI Score", selectedLead.aiScore ? `${selectedLead.aiScore}/100` : "Not scored"],
                                            ["Follow Up", selectedLead.status !== "Qualified" && selectedLead.followUpAt ? formatCstDateTime(selectedLead.followUpAt) : "None"],
                                            ["Status", selectedLead.status],
                                            ["Current Agent", getCurrentLeadAgent(selectedLead)],
                                            ["Previous Agent", getPreviousLeadAgent(selectedLead)],
                                            ["Website", selectedLead.website || "No website"],
                                        ].map(([label, value]) => (
                                            <div key={label} className="rounded-lg border border-white/10 bg-white/[0.04] px-3.5 py-3">
                                                <p className="text-[0.68rem] font-medium uppercase tracking-[0.12em] text-white/35">{label}</p>
                                                <p className="mt-1.5 truncate text-sm font-semibold text-white">{value}</p>
                                            </div>
                                        ))}
                                    </div>

                                    <div className="rounded-lg border border-white/10 bg-white/[0.04] p-4">
                                        <div className="flex items-center gap-2">
                                            <FiCalendar className="size-4 text-[#b78cff]" aria-hidden="true" />
                                            <p className="text-xs font-medium uppercase tracking-[0.14em] text-white/35">Schedule Follow Up</p>
                                        </div>
                                        <div className="mt-3 grid gap-3 sm:grid-cols-[minmax(0,14rem)_auto]">
                                            <input
                                                className="h-10 min-w-0 rounded-lg border border-white/10 bg-black/20 px-3 text-sm font-semibold text-white outline-none transition focus:border-[#842cff] focus:ring-2 focus:ring-[#842cff]/20"
                                                type="datetime-local"
                                                value={isStatusDraftQualified ? "" : followUpDateTime}
                                                min={getCurrentCstDateTimeInput()}
                                                onChange={(event) => setFollowUpDateTime(event.target.value)}
                                                disabled={isStatusDraftQualified || Boolean(activeLeadAction)}
                                            />
                                            <button
                                                className="flex h-10 items-center justify-center gap-2 rounded-lg border border-[#ff9f43] bg-[#ff9f43] px-4 text-sm font-semibold text-white shadow-sm shadow-[#ff9f43]/20 transition hover:border-[#f08a2b] hover:bg-[#f08a2b] disabled:cursor-not-allowed disabled:opacity-60"
                                                type="button"
                                                disabled={!followUpDateTime || scheduleFollowUpMutation.isPending || isStatusDraftQualified || Boolean(activeLeadAction)}
                                                onClick={handleScheduleFollowUp}
                                            >
                                                <FiCalendar className="size-4" aria-hidden="true" />
                                                {activeLeadAction === "schedule" ? "Saving & scheduling" : "Schedule"}
                                            </button>
                                        </div>
                                        <p className="mt-2 text-xs text-white/35">
                                            {isStatusDraftQualified
                                                ? selectedLead.followUpAt
                                                    ? "Save Qualified to clear the existing follow-up schedule."
                                                    : "Qualified leads have no follow-up schedule."
                                                : selectedLead.followUpAt
                                                    ? `Current follow-up: ${formatCstDateTime(selectedLead.followUpAt)}`
                                                    : "No follow-up scheduled."}
                                        </p>
                                    </div>

                                    <div className="rounded-lg border border-white/10 bg-white/[0.04] p-4">
                                        <div className="flex items-center gap-2">
                                            <FiCheckCircle className="size-4 text-[#b78cff]" aria-hidden="true" />
                                            <p className="text-xs font-medium uppercase tracking-[0.14em] text-white/35">Lead Status</p>
                                        </div>
                                        <div className="mt-3 grid gap-2 sm:grid-cols-[minmax(0,1fr)_8rem]">
                                            <select
                                                className="h-11 min-w-0 rounded-lg border border-white/10 bg-[#0d1018] px-3 text-sm font-semibold text-white outline-none transition focus:border-[#842cff] focus:ring-2 focus:ring-[#842cff]/20"
                                                value={statusDraft}
                                                onChange={(event) => setStatusDraft(event.target.value as LeadStatus)}
                                                disabled={updateStatusMutation.isPending || Boolean(activeLeadAction)}
                                            >
                                                {Array.from(new Set([...visibleEmployeeStatusOptions, selectedLead.status])).map((status) => (
                                                    <option key={status} value={status}>
                                                        {status}
                                                    </option>
                                                ))}
                                            </select>
                                            <button
                                                className="flex h-11 items-center justify-center gap-2 rounded-lg border border-[#10ac84] bg-[#10ac84] px-4 text-sm font-semibold text-white shadow-sm shadow-[#10ac84]/20 transition hover:border-[#0b8f6e] hover:bg-[#0b8f6e] disabled:cursor-not-allowed disabled:opacity-60"
                                                type="button"
                                                disabled={updateStatusMutation.isPending || Boolean(activeLeadAction) || !hasStatusUpdate}
                                                onClick={handleSaveStatus}
                                            >
                                                <FiSave className="size-4" aria-hidden="true" />
                                                {activeLeadAction === "status" ? "Saving" : isStatusDraftQualified && shouldClearQualifiedFollowUp ? "Reset" : "Save"}
                                            </button>
                                        </div>
                                        {updateStatusMutation.isPending && (
                                            <p className="mt-2 text-xs font-semibold text-[#9df6b7]">Updating status...</p>
                                        )}
                                    </div>

                                    <div className="rounded-lg border border-white/10 bg-white/[0.04] p-4">
                                        <div className="flex items-center gap-2">
                                            <FiUserPlus className="size-4 text-[#b78cff]" aria-hidden="true" />
                                            <p className="text-xs font-medium uppercase tracking-[0.14em] text-white/35">Re Assign</p>
                                        </div>
                                        <div className="mt-3 grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto]">
                                            <select
                                                className="h-10 min-w-0 rounded-lg border border-white/10 bg-[#0d1018] px-3 text-sm font-semibold text-white outline-none transition focus:border-[#842cff] focus:ring-2 focus:ring-[#842cff]/20"
                                                value={passAgentId}
                                                onChange={(event) => setPassAgentId(event.target.value)}
                                                disabled={Boolean(activeLeadAction)}
                                            >
                                                <option value="">Select agent</option>
                                                {passableAgents.map((employee) => (
                                                    <option key={employee._id} value={employee._id}>
                                                        {employee.name} {employee.team ? `- ${employee.team}` : ""}
                                                    </option>
                                                ))}
                                            </select>
                                            <button
                                                className="flex h-10 items-center justify-center gap-2 rounded-lg border border-[#2e86de] bg-[#2e86de] px-4 text-sm font-semibold text-white shadow-sm shadow-[#2e86de]/20 transition hover:border-[#1f6fbf] hover:bg-[#1f6fbf] disabled:cursor-not-allowed disabled:opacity-60"
                                                type="button"
                                                disabled={!passAgentId || passLeadMutation.isPending || Boolean(activeLeadAction)}
                                                onClick={requestPassLead}
                                            >
                                                <FiUserPlus className="size-4" aria-hidden="true" />
                                                Re Assign
                                            </button>
                                        </div>
                                        <p className="mt-2 text-xs text-white/35">Re assigning removes this lead from your active list and assigns it to the selected agent.</p>
                                    </div>

                                    <div className="rounded-lg border border-white/10 bg-white/[0.04] p-4">
                                        <div className="flex items-center gap-2">
                                            <FiMessageCircle className="size-4 text-[#b78cff]" aria-hidden="true" />
                                            <p className="text-xs font-medium uppercase tracking-[0.14em] text-white/35">Comments</p>
                                        </div>

                                        <div className="mt-3 grid gap-3">
                                            {(selectedLead.comments || []).length > 0 ? (
                                                selectedLead.comments?.map((comment) => (
                                                    <article key={comment._id || `${comment.createdAt}-${comment.body}`} className="rounded-lg border border-white/10 bg-black/20 p-3">
                                                        <div className="flex flex-wrap items-center justify-between gap-2">
                                                            <p className="text-sm font-semibold text-white">{comment.authorName || "Employee"}</p>
                                                            <p className="text-xs text-white/35">
                                                                {comment.createdAt ? formatPhDateTime(comment.createdAt) : ""}
                                                            </p>
                                                        </div>
                                                        <p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-white/65">{comment.body}</p>
                                                    </article>
                                                ))
                                            ) : (
                                                <p className="text-sm leading-6 text-white/65">{selectedLead.notes || "No comments yet."}</p>
                                            )}
                                        </div>

                                        <div className="mt-4">
                                            <textarea
                                                className="min-h-28 w-full resize-y rounded-lg border border-white/10 bg-black/20 px-3 py-3 text-sm font-medium text-white outline-none transition placeholder:text-white/30 focus:border-[#842cff] focus:ring-2 focus:ring-[#842cff]/20"
                                                value={commentDraft}
                                                onChange={(event) => setCommentDraft(event.target.value)}
                                                onKeyDown={(event) => {
                                                    if (event.ctrlKey && event.key === "Enter") {
                                                        event.preventDefault();
                                                        saveComment();
                                                    }
                                                }}
                                                placeholder="Add a note for this lead..."
                                                disabled={addCommentMutation.isPending || Boolean(activeLeadAction)}
                                            />
                                            <div className="mt-3 flex justify-end">
                                                <button
                                                    className="flex h-10 items-center gap-2 rounded-lg border border-[#10ac84] bg-[#10ac84] px-4 text-sm font-semibold text-white shadow-sm shadow-[#10ac84]/20 transition hover:border-[#0b8f6e] hover:bg-[#0b8f6e] disabled:cursor-not-allowed disabled:opacity-60"
                                                    type="button"
                                                    disabled={addCommentMutation.isPending || Boolean(activeLeadAction) || !commentDraft.trim()}
                                                    onClick={saveComment}
                                                >
                                                    <FiSave className="size-4" aria-hidden="true" />
                                                    {addCommentMutation.isPending ? "Saving..." : "Add Note"}
                                                </button>
                                            </div>
                                        </div>
                                    </div>

                                </div>
                                <aside className="flex min-h-0">
                                    <div className="flex max-h-full min-h-[24rem] w-full flex-col rounded-lg border border-slate-300 bg-white/75 p-4 xl:sticky xl:top-0">
                                        <p className="text-xs font-medium uppercase tracking-[0.14em] !text-slate-600">Activity</p>
                                        <div className="mt-4 flex-1 space-y-5 overflow-y-auto pr-1">
                                            {activity.map((item, index) => (
                                                <div key={`${item.label}-${item.createdAt || index}`} className="flex gap-3">
                                                    <span
                                                        className={[
                                                            "mt-1 size-2 shrink-0 rounded-full",
                                                            item.status === "Current" ? "bg-[#842cff]" : "bg-slate-400",
                                                        ].join(" ")}
                                                    />
                                                    <div className="min-w-0 flex-1">
                                                        <div className="flex flex-wrap items-center gap-2">
                                                            <p className="text-sm font-semibold !text-slate-950">{item.label}</p>
                                                            <span className="rounded bg-slate-200 px-1.5 py-0.5 text-[0.65rem] font-semibold uppercase tracking-[0.12em] !text-slate-700">
                                                                {item.status}
                                                            </span>
                                                        </div>
                                                        <p className="mt-1 whitespace-pre-line text-xs font-medium leading-5 !text-slate-700">{item.detail}</p>
                                                        {item.createdAt && (
                                                            <p className="mt-1 text-[0.68rem] font-semibold uppercase tracking-[0.1em] !text-slate-500">
                                                                {formatPhDateTime(item.createdAt)}
                                                            </p>
                                                        )}
                                                    </div>
                                                </div>
                                            ))}
                                        </div>
                                    </div>
                                </aside>
                            </div>
                        ) : (
                            <div className="p-6 text-sm text-white/45">Select an assigned lead to view details.</div>
                        )}
                    </section>
                </div>
            </section>
            {isLeadModalOpen && (
                <div
                    className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4 backdrop-blur-sm"
                    onPointerDown={(event) => {
                        if (event.target === event.currentTarget) {
                            closeLeadModal();
                        }
                    }}
                >
                    <section className="max-h-[92vh] w-full max-w-[34rem] overflow-hidden rounded-lg border border-white/10 bg-[#0d1018] shadow-2xl shadow-black/40" onPointerDown={(event) => event.stopPropagation()}>
                        <div className="flex items-start justify-between gap-4 border-b border-white/10 px-5 py-4">
                            <div>
                                <p className="text-xs font-medium uppercase tracking-[0.14em] text-white/35">New Lead</p>
                                <h3 className="mt-1 text-lg font-semibold text-white">Add Lead</h3>
                            </div>
                            <button
                                className="flex size-9 items-center justify-center rounded-lg border border-white/10 bg-white/[0.05] text-white/60 transition hover:bg-white/10 hover:text-white"
                                type="button"
                                onClick={closeLeadModal}
                                aria-label="Close add lead"
                            >
                                <FiX className="size-4" aria-hidden="true" />
                            </button>
                        </div>
                        <form onSubmit={handleSaveLead}>
                            <div className="content-scroll grid max-h-[68vh] gap-4 overflow-y-auto p-5 sm:grid-cols-2">
                                {[
                                    ["Business Name", "businessName", "Business name", true],
                                    ["Lead Name", "leadName", "Contact name", false],
                                    ["Position", "position", "Owner, manager, etc.", false],
                                    ["Phone", "phone", "Phone number", false],
                                    ["Email", "email", "lead@company.com", false],
                                    ["Website", "website", "https://example.com", false],
                                    ...(canUseLeadCategories ? [["Category", "category", "Bar / Pub", false]] : []),
                                    ["Source", "source", "Manual", false],
                                ].map(([label, field, placeholder, required]) => (
                                    <label key={field as string} className="block">
                                        <span className="text-xs font-medium uppercase tracking-[0.14em] text-white/35">
                                            {label} {required ? "" : <span className="normal-case tracking-normal text-white/25">(optional)</span>}
                                        </span>
                                        <input
                                            className="mt-2 h-10 w-full rounded-lg border border-white/10 bg-black/20 px-3 text-sm font-semibold text-white outline-none transition placeholder:text-white/30 focus:border-[#842cff] focus:ring-2 focus:ring-[#842cff]/20"
                                            value={String(leadForm[field as keyof LeadInput] || "")}
                                            onChange={(event) => updateLeadForm(field as keyof LeadInput, event.target.value)}
                                            placeholder={placeholder as string}
                                            required={Boolean(required)}
                                        />
                                    </label>
                                ))}
                                <label className="block sm:col-span-2">
                                    <span className="text-xs font-medium uppercase tracking-[0.14em] text-white/35">Business Address</span>
                                    <textarea
                                        className="mt-2 min-h-20 w-full resize-y rounded-lg border border-white/10 bg-black/20 px-3 py-3 text-sm font-semibold text-white outline-none transition placeholder:text-white/30 focus:border-[#842cff] focus:ring-2 focus:ring-[#842cff]/20"
                                        value={leadForm.businessAddress}
                                        onChange={(event) => updateLeadForm("businessAddress", event.target.value)}
                                        placeholder="Business address"
                                    />
                                </label>
                                <label className="block sm:col-span-2">
                                    <span className="text-xs font-medium uppercase tracking-[0.14em] text-white/35">Notes</span>
                                    <textarea
                                        className="mt-2 min-h-24 w-full resize-y rounded-lg border border-white/10 bg-black/20 px-3 py-3 text-sm font-semibold text-white outline-none transition placeholder:text-white/30 focus:border-[#842cff] focus:ring-2 focus:ring-[#842cff]/20"
                                        value={leadForm.notes}
                                        onChange={(event) => updateLeadForm("notes", event.target.value)}
                                        placeholder="Call notes, context, or next step"
                                    />
                                </label>
                            </div>
                            <div className="flex justify-end gap-2 border-t border-white/10 px-5 py-4">
                                <button
                                    className="h-10 rounded-lg border border-white/10 bg-white/[0.06] px-4 text-sm font-semibold text-white/65 transition hover:bg-white/10 hover:text-white"
                                    type="button"
                                    onClick={closeLeadModal}
                                    disabled={createLeadMutation.isPending}
                                >
                                    Cancel
                                </button>
                                <button
                                    className="flex h-10 items-center gap-2 rounded-lg bg-[linear-gradient(135deg,#842cff,#4a0ebd)] px-4 text-sm font-semibold text-white transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-60"
                                    type="submit"
                                    disabled={createLeadMutation.isPending}
                                >
                                    <FiPlus className="size-4" aria-hidden="true" />
                                    {createLeadMutation.isPending ? "Adding..." : "Add Lead"}
                                </button>
                            </div>
                        </form>
                    </section>
                </div>
            )}
            {passConfirm && (
                <div
                    className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4 backdrop-blur-sm"
                    onPointerDown={(event) => {
                        if (event.target === event.currentTarget && !activeLeadAction) {
                            setPassConfirm(null);
                        }
                    }}
                >
                    <section className="w-full max-w-[25rem] rounded-lg border border-white/10 bg-[#0d1018] shadow-2xl shadow-black/40" onPointerDown={(event) => event.stopPropagation()}>
                        <div className="flex items-start gap-3 border-b border-white/10 px-5 py-4">
                            <div className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-[#842cff]/30 bg-[#842cff]/15 text-[#d7c5ff]">
                                <FiUserPlus className="size-4" aria-hidden="true" />
                            </div>
                            <div>
                                <h3 className="text-base font-semibold text-white">Confirm Re Assign</h3>
                                <p className="mt-1 text-sm leading-6 text-white/50">
                                    Re assign <span className="font-semibold text-white">{passConfirm.lead.leadName || passConfirm.lead.businessName}</span> to{" "}
                                    <span className="font-semibold text-white">{passConfirm.agent.name}</span>?
                                </p>
                            </div>
                        </div>
                        <div className="flex justify-end gap-2 px-5 py-4">
                            <button
                                className="h-9 rounded-lg border border-white/10 bg-white/[0.06] px-3 text-sm font-semibold text-white/65 transition hover:bg-white/10 hover:text-white"
                                type="button"
                                disabled={passLeadMutation.isPending || Boolean(activeLeadAction)}
                                onClick={() => setPassConfirm(null)}
                            >
                                Cancel
                            </button>
                            <button
                                className="h-9 rounded-lg bg-[linear-gradient(135deg,#842cff,#4a0ebd)] px-3 text-sm font-semibold text-white transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-60"
                                type="button"
                                disabled={passLeadMutation.isPending || Boolean(activeLeadAction)}
                                onClick={confirmPassLead}
                            >
                                {activeLeadAction === "assignment" ? "Saving & re assigning..." : "Confirm Re Assign"}
                            </button>
                        </div>
                    </section>
                </div>
            )}

            {callLoggerConfirmAction && selectedLead && (
                <div
                    className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/45 px-4 py-6 backdrop-blur-sm"
                    onMouseDown={(event) => {
                        if (event.target === event.currentTarget) {
                            closeCallLoggerConfirm();
                        }
                    }}
                >
                    <section
                        className="w-full max-w-md rounded-xl border border-slate-200 bg-white p-5 text-slate-900 shadow-2xl shadow-slate-950/25"
                        role="dialog"
                        aria-modal="true"
                        aria-labelledby="call-logger-confirm-title"
                    >
                        <div className="flex items-start justify-between gap-4">
                            <div>
                                <p className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">
                                    Confirm Call Logger
                                </p>

                                <h3
                                    id="call-logger-confirm-title"
                                    className="mt-2 text-lg font-semibold text-slate-950"
                                >
                                    Confirm {requestedCallLoggerLabel}
                                </h3>
                            </div>

                            <button
                                type="button"
                                className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-slate-200 bg-slate-100 text-slate-500 transition hover:bg-slate-200 hover:text-slate-900"
                                onClick={closeCallLoggerConfirm}
                                aria-label="Close confirmation"
                                disabled={isLoggingAnyCall}
                            >
                                <FiX className="size-4" aria-hidden="true" />
                            </button>
                        </div>

                        <p className="mt-4 text-sm leading-6 text-slate-600">
                            Are you sure you want to mark{" "}
                            <span className="font-semibold text-slate-950">
                                {selectedLeadDisplayName}
                            </span>{" "}
                            as{" "}
                            <span
                                className={
                                    callLoggerConfirmAction === "not_connected"
                                        ? "font-semibold text-[#e11d48]"
                                        : callLoggerConfirmAction === "voicemail"
                                          ? "font-semibold text-[#2563eb]"
                                          : "font-semibold text-[#0f8f70]"
                                }
                            >
                                {requestedCallLoggerLabel}
                            </span>
                            ?
                        </p>

                        <div className="mt-5 flex flex-wrap justify-end gap-3">
                            <button
                                type="button"
                                className="flex h-10 items-center justify-center rounded-lg border border-slate-200 bg-white px-4 text-sm font-semibold text-slate-700 transition hover:bg-slate-100 hover:text-slate-950 disabled:cursor-not-allowed disabled:opacity-70"
                                onClick={closeCallLoggerConfirm}
                                disabled={isLoggingAnyCall}
                            >
                                Cancel
                            </button>

                            <button
                                type="button"
                                className={[
                                    "flex h-10 items-center justify-center rounded-lg px-4 text-sm font-semibold text-white transition disabled:cursor-not-allowed disabled:opacity-70",
                                    callLoggerConfirmAction === "not_connected"
                                        ? "border border-[#f13453] bg-[#f13453] hover:border-[#db203f] hover:bg-[#db203f]"
                                        : callLoggerConfirmAction === "voicemail"
                                          ? "border border-[#2563eb] bg-[#2563eb] hover:border-[#1d4ed8] hover:bg-[#1d4ed8]"
                                          : "border border-[#10ac84] bg-[#10ac84] hover:border-[#0b8f6e] hover:bg-[#0b8f6e]",
                                ].join(" ")}
                                onClick={confirmCallLoggerAction}
                                disabled={isLoggingAnyCall}
                            >
                                {isLoggingAnyCall ? "Logging" : "Yes, confirm"}
                            </button>
                        </div>
                    </section>
                </div>
            )}
        </MainLayout>
    );
}
