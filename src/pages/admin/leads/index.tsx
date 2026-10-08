import type { FormEvent, UIEvent } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
    FiAlertTriangle,
    FiArchive,
    FiCalendar,
    FiChevronLeft,
    FiChevronRight,
    FiCheckCircle,
    FiCheckSquare,
    FiClock,
    FiDownload,
    FiEdit2,
    FiExternalLink,
    FiMail,
    FiMapPin,
    FiMoreVertical,
    FiPhone,
    FiPlus,
    FiRefreshCw,
    FiRotateCcw,
    FiSave,
    FiSearch,
    FiShield,
    FiSquare,
    FiTrash2,
    FiUpload,
    FiUserPlus,
    FiX,
    FiZap,
} from "react-icons/fi";
import { FaWhatsapp } from "react-icons/fa";
import { useSearchParams } from "react-router";
import AdminLayout from "../adminLayout";
import { getEmployees, type Employee } from "../../../api/employees";
import {
    archiveLead,
    addLeadComment,
    assignLead,
    autoSearchTomTomPlacesLeads,
    autoAssignLead,
    bulkAssignLeads,
    bulkArchiveLeads,
    bulkPermanentlyDeleteArchivedLeads,
    bulkPermanentlyDeleteActiveLeads,
    bulkRestoreLeads,
    createLead,
    getAdminLeadCounts,
    getAdminLeads,
    getLead,
    getTomTomUsage,
    importLeads,
    permanentlyDeleteLead,
    reassignNewLeads,
    restoreLead,
    scheduleLeadFollowUp,
    searchAndImportTomTomPlaces,
    scoreLeadsByHighestPotential,
    updateLead,
    updateLeadStatus,
    type BusinessPlaceLead,
    type AdminLeadApiTab,
    type AdminLeadsPage,
    type Lead,
    type LeadImportInput,
    type LeadInput,
    type LeadStatus,
} from "../../../api/leads";
import { useClickOutside } from "../../../hooks/useClickOutside";
import { useToast } from "../../../components/ToastProvider";
import { formatCstDate, formatLeadScheduleDate, formatLeadScheduleDateTime, formatLeadScheduleDateTimeInput, formatPhDateTime, getCurrentLeadScheduleDateTimeInput, parseLeadScheduleDateTimeInput } from "../../../lib/dateTime";
import { getPhoneCallUrl } from "../../../lib/phoneNumber";
import { getSystemSettings } from "../../../api/systemSettings";

type AdminLeadTab = LeadStatus | "Unassigned" | "ALL";
type LeadQueueFilter = "ALL" | "NEW" | "Follow up";
type AllStatusFilter = "ALL" | Exclude<LeadStatus, "Archived">;
type LeadActionName = "archive" | "assignment" | "details" | "schedule" | "status";
type PlacesManualSearchInput = {
    textQuery: string;
    category: string;
    location: string;
    radiusMiles: number;
    maxResults?: number;
    maxRequests?: number;
};
type PlacesAutoSearchInput = {
    product: string;
    location: string;
    radiusMiles: number;
    maxResults: number;
    maxRequests?: number;
};

type LeadActionVerification =
    | {
        kind: "tomtom-manual";
        input: PlacesManualSearchInput;
    }
    | {
        kind: "tomtom-auto";
        input: PlacesAutoSearchInput;
    }
    | {
        kind: "reassign-new";
        leadCount: number;
    };

function getApiErrorStatus(error: unknown) {
    return Number((error as { response?: { status?: number } } | null)?.response?.status || 0);
}

function isAuthorizationError(error: unknown) {
    return [401, 403].includes(getApiErrorStatus(error));
}

const tabs: AdminLeadTab[] = [
    "NEW",
    "Qualified",
    "Ongoing Negotiation",
    "Completed",
    "Dead",
    "Archived",
    "Unassigned",
    "ALL",
];

const allStatusFilters: AllStatusFilter[] = ["ALL", "NEW", "Follow up", "Ongoing comms", "Qualified", "Ongoing Negotiation", "Completed", "Dead"];
const editableLeadStatuses: LeadStatus[] = ["NEW", "Follow up", "Qualified", "Ongoing Negotiation", "Completed", "Dead"];

const LEAD_PAGE_SIZE = 20;
const PH_TIME_OFFSET_HOURS = 8;
const calendarWeekdays = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];
const calendarMonthFormatter = new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric" });
const datePickerLabelFormatter = new Intl.DateTimeFormat("en-US", { month: "short", day: "2-digit", year: "numeric" });

function usesLeadQueueFilter(tab: AdminLeadTab) {
    return tab === "NEW" || tab === "Unassigned";
}

function getAdminLeadApiTab(tab: AdminLeadTab): AdminLeadApiTab {
    if (tab === "NEW") {
        return "leads";
    }

    if (tab === "Ongoing Negotiation") {
        return "negotiation";
    }

    return tab.toLowerCase() as AdminLeadApiTab;
}

function parseDateInputValue(value: string) {
    const normalizedValue = value.trim();

    if (!/^\d{4}-\d{2}-\d{2}$/.test(normalizedValue)) {
        return null;
    }

    const [year, month, day] = normalizedValue.split("-").map(Number);
    const date = new Date(year, month - 1, day);

    if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
        return null;
    }

    return date;
}

function formatDateInputValue(date: Date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");

    return `${year}-${month}-${day}`;
}

function formatDatePickerLabel(value: string) {
    const date = parseDateInputValue(value);
    return date ? datePickerLabelFormatter.format(date) : "Select date";
}

function addCalendarMonths(date: Date, delta: number) {
    return new Date(date.getFullYear(), date.getMonth() + delta, 1);
}

function getCalendarDates(viewMonth: Date) {
    const firstDay = new Date(viewMonth.getFullYear(), viewMonth.getMonth(), 1);
    const startDate = new Date(firstDay);
    startDate.setDate(firstDay.getDate() - firstDay.getDay());

    return Array.from({ length: 42 }, (_, index) => {
        const date = new Date(startDate);
        date.setDate(startDate.getDate() + index);
        return date;
    });
}

function LeadDatePicker({
    label,
    value,
    onChange,
    align = "left",
}: {
    label: string;
    value: string;
    onChange: (value: string) => void;
    align?: "left" | "right";
}) {
    const pickerRef = useRef<HTMLDivElement>(null);
    const selectedDate = parseDateInputValue(value);
    const [isOpen, setIsOpen] = useState(false);
    const [viewMonth, setViewMonth] = useState(() => selectedDate || new Date());
    const todayValue = formatDateInputValue(new Date());

    useClickOutside(pickerRef, () => setIsOpen(false), isOpen);

    useEffect(() => {
        if (isOpen) {
            setViewMonth(selectedDate || new Date());
        }
    }, [isOpen, selectedDate?.getTime()]);

    const calendarDates = getCalendarDates(viewMonth);
    const togglePicker = () => setIsOpen((open) => !open);

    return (
        <div ref={pickerRef} className="relative min-w-0">
            <button
                type="button"
                className={[
                    "group flex h-12 w-full min-w-0 items-center gap-2 rounded-lg border border-[#c7b8e8] bg-[#fbf9ff] px-2.5 text-left shadow-sm shadow-[#7c4ed8]/10 transition",
                    "hover:border-[#842cff]/55 hover:bg-white focus:outline-none focus:ring-2 focus:ring-[#842cff]/20",
                    isOpen ? "border-[#842cff]/70 bg-white ring-2 ring-[#842cff]/20" : "",
                ].join(" ")}
                onClick={togglePicker}
                aria-haspopup="dialog"
                aria-expanded={isOpen}
            >
                <span className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-slate-300 bg-white text-black shadow-sm shadow-slate-950/10">
                    <FiCalendar className="size-4" style={{ color: "#000000", stroke: "#000000" }} aria-hidden="true" />
                </span>
                <span className="min-w-0 flex-1">
                    <span className="block text-[9px] font-semibold uppercase tracking-[0.16em] text-black">{label}</span>
                    <span className="mt-0.5 block truncate text-xs font-semibold text-black">
                        {formatDatePickerLabel(value)}
                    </span>
                </span>
            </button>

            {isOpen && (
                <div
                    className={[
                        "absolute z-40 w-[17rem] rounded-xl border border-[#c7b8e8] bg-white p-3 text-slate-900 shadow-2xl shadow-[#4c2a86]/20",
                        "top-[calc(100%+0.45rem)]",
                        align === "right" ? "right-0" : "left-0",
                    ].join(" ")}
                    role="dialog"
                    aria-label={`${label} date picker`}
                >
                    <div className="flex items-center justify-between gap-2">
                        <button
                            type="button"
                            className="flex size-8 items-center justify-center rounded-lg border border-[#d8cef3] bg-[#f6f2ff] text-black transition hover:border-[#842cff]/50 hover:bg-[#efe8ff]"
                            onClick={() => setViewMonth((current) => addCalendarMonths(current, -1))}
                            aria-label="Previous month"
                        >
                            <FiChevronLeft className="size-4" style={{ color: "#000000", stroke: "#000000" }} aria-hidden="true" />
                        </button>
                        <p className="min-w-0 truncate text-sm font-semibold text-black">{calendarMonthFormatter.format(viewMonth)}</p>
                        <button
                            type="button"
                            className="flex size-8 items-center justify-center rounded-lg border border-[#d8cef3] bg-[#f6f2ff] text-black transition hover:border-[#842cff]/50 hover:bg-[#efe8ff]"
                            onClick={() => setViewMonth((current) => addCalendarMonths(current, 1))}
                            aria-label="Next month"
                        >
                            <FiChevronRight className="size-4" style={{ color: "#000000", stroke: "#000000" }} aria-hidden="true" />
                        </button>
                    </div>

                    <div className="mt-3 grid grid-cols-7 gap-1 text-center text-[10px] font-semibold uppercase tracking-[0.08em] text-black">
                        {calendarWeekdays.map((weekday) => (
                            <span key={weekday}>{weekday}</span>
                        ))}
                    </div>

                    <div className="mt-1 grid grid-cols-7 gap-1">
                        {calendarDates.map((date) => {
                            const dateValue = formatDateInputValue(date);
                            const isSelected = dateValue === value;
                            const isToday = dateValue === todayValue;
                            const isOutsideMonth = date.getMonth() !== viewMonth.getMonth();

                            const dayTextStyle = {
                                color: "#000000",
                                WebkitTextFillColor: "#000000",
                            };

                            return (
                                <button
                                    key={dateValue}
                                    type="button"
                                    className={[
                                        "flex aspect-square items-center justify-center rounded-lg border text-xs font-semibold transition",
                                        isSelected
                                            ? "border-[#842cff] bg-[#efe8ff] shadow-sm shadow-[#842cff]/20"
                                            : isToday
                                                ? "border-[#54a0ff]/70 bg-[#eaf4ff]"
                                                : isOutsideMonth
                                                    ? "border-transparent bg-white hover:border-[#d8cef3] hover:bg-[#f8f5ff]"
                                                    : "border-transparent bg-white hover:border-[#d8cef3] hover:bg-[#efe8ff]",
                                    ].join(" ")}
                                    onClick={() => {
                                        onChange(dateValue);
                                        setIsOpen(false);
                                    }}
                                >
                                    <span className="text-xs font-semibold" style={dayTextStyle}>
                                        {date.getDate()}
                                    </span>
                                </button>
                            );
                        })}
                    </div>

                    <div className="mt-3 flex items-center justify-between gap-2 border-t border-slate-200 pt-3">
                        <button
                            type="button"
                            className="h-8 rounded-lg border border-slate-200 bg-white px-3 text-xs font-semibold text-slate-600 transition hover:border-[#842cff]/35 hover:text-[#6426d9] disabled:cursor-not-allowed disabled:opacity-40"
                            onClick={() => onChange("")}
                            disabled={!value}
                        >
                            Clear
                        </button>
                        <button
                            type="button"
                            className="h-8 rounded-lg border border-[#842cff]/35 bg-[#842cff] px-3 text-xs font-semibold text-white transition hover:border-[#6426d9] hover:bg-[#6426d9]"
                            onClick={() => {
                                onChange(todayValue);
                                setViewMonth(new Date());
                            }}
                        >
                            Today
                        </button>
                    </div>
                </div>
            )}
        </div>
    );
}

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

function formatFilterLabel(value: string) {
    return value
        .trim()
        .replace(/\s+/g, " ")
        .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function getEditableLeadStatusLabel(status: LeadStatus) {
    if (status === "Follow up") return "FOLLOW UP";
    if (status === "Dead" || status === "Archived") return "ARCHIVE/DEAD";
    return status.toUpperCase();
}

function isSalesAssignableEmployee(employee: Pick<Employee, "role" | "team">) {
    return [employee.role, employee.team].some((value) =>
        String(value || "").trim().toLowerCase().includes("sales")
    );
}

function normalizeImportedStatus(value: string): LeadStatus {
    const normalizedValue = value.trim().toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ");
    const statusMap: Record<string, LeadStatus> = {
        new: "NEW",
        qualified: "Qualified",
        dead: "Dead",
        lost: "Dead",
        ongoing: "Ongoing comms",
        contacted: "Ongoing comms",
        "ongoing comms": "Ongoing comms",
        followup: "Follow up",
        "follow up": "Follow up",
        negotiation: "Ongoing Negotiation",
        "ongoing negotiation": "Ongoing Negotiation",
        completed: "Completed",
        complete: "Completed",
        done: "Completed",
        archived: "Archived",
    };

    return statusMap[normalizedValue] || "NEW";
}

function parseCsv(text: string) {
    const rows: string[][] = [];
    let row: string[] = [];
    let cell = "";
    let isQuoted = false;

    for (let index = 0; index < text.length; index += 1) {
        const char = text[index];
        const nextChar = text[index + 1];

        if (char === '"' && isQuoted && nextChar === '"') {
            cell += '"';
            index += 1;
            continue;
        }

        if (char === '"') {
            isQuoted = !isQuoted;
            continue;
        }

        if (char === "," && !isQuoted) {
            row.push(cell);
            cell = "";
            continue;
        }

        if ((char === "\n" || char === "\r") && !isQuoted) {
            if (char === "\r" && nextChar === "\n") {
                index += 1;
            }

            row.push(cell);
            if (row.some((value) => value.trim())) {
                rows.push(row);
            }
            row = [];
            cell = "";
            continue;
        }

        cell += char;
    }

    row.push(cell);
    if (row.some((value) => value.trim())) {
        rows.push(row);
    }

    return rows;
}

function normalizeCsvHeader(header: string) {
    return header
        .replace(/^\uFEFF/, "")
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, " ")
        .trim();
}

function getCsvValue(row: Record<string, string>, ...keys: string[]) {
    for (const key of keys) {
        const value = row[normalizeCsvHeader(key)]?.trim();

        if (value) {
            return value;
        }
    }

    return "";
}

function getRequestErrorMessage(error: unknown, fallback: string) {
    const responseMessage =
        typeof error === "object" && error && "response" in error
            ? (error as { response?: { data?: { message?: unknown } } }).response?.data?.message
            : "";

    if (typeof responseMessage === "string" && responseMessage.trim()) {
        return responseMessage;
    }

    return error instanceof Error && error.message ? error.message : fallback;
}

function parseLeadCsv(text: string): LeadImportInput[] {
    const rows = parseCsv(text);
    const headers = rows[0]?.map(normalizeCsvHeader) || [];

    if (headers.length === 0) {
        return [];
    }

    return rows.slice(1).map((values) => {
        const row = Object.fromEntries(headers.map((header, index) => [header, values[index] || ""]));
        const businessName = getCsvValue(row, "Business Name", "Company Name", "Company", "Name");

        return {
            leadName: getCsvValue(row, "Lead Name", "Contact Name", "Name"),
            businessName,
            businessAddress: getCsvValue(row, "Business Address", "Address"),
            email: getCsvValue(row, "Email", "Email Address", "E-mail", "E-mail Address"),
            phone: getCsvValue(row, "Phone", "Phone Number", "Phone No", "Phone No.", "Telephone", "Mobile", "Mobile Number", "Contact Number"),
            source: getCsvValue(row, "Source") || "CSV Import",
            category: getCsvValue(row, "Category", "Biz Type", "Business Type"),
            status: normalizeImportedStatus(getCsvValue(row, "Status")),
            assignedToName: getCsvValue(row, "Assigned To", "Assigned Agent", "Agent"),
            notes: getCsvValue(row, "Notes"),
            createdAt: getCsvValue(row, "Created At") || null,
            position: getCsvValue(row, "Position", "Title"),
            website: getCsvValue(row, "Website"),
            assignedAgent: null,
            assignedTeam: null,
            googlePlaceId: getCsvValue(row, "Google Place ID", "Google Place Id"),
        };
    }).filter((lead) => lead.businessName?.trim());
}

function getRelativeTime(value?: string | null) {
    if (!value) {
        return "";
    }

    const timestamp = new Date(value).getTime();

    if (Number.isNaN(timestamp)) {
        return "";
    }

    const diffMs = timestamp - Date.now();
    const absMs = Math.abs(diffMs);
    const minute = 60 * 1000;
    const hour = 60 * minute;
    const day = 24 * hour;
    const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });

    if (absMs < hour) {
        return formatter.format(Math.round(diffMs / minute), "minute");
    }

    if (absMs < day) {
        return formatter.format(Math.round(diffMs / hour), "hour");
    }

    return formatter.format(Math.round(diffMs / day), "day");
}

type LeadActivityItem = {
    label: string;
    detail: string;
    status: string;
    action?: string;
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
    if (!lead) return emptyLeadDetailDraft;

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
        action: "",
    }));

    if (lead.activity?.length) {
        return [
            ...lead.activity.map((item) => ({
                label: item.label,
                detail: item.detail,
                status: item.status,
                createdAt: item.createdAt,
                action: "",
            })),
            ...commentActivities,
        ];
    }

    const assignedName = lead.assignedAgent?.name || lead.assignedAgentName;
    const activities = [
        ...commentActivities,
        {
            label: "Lead created",
            detail: `${lead.source || "Manual"} lead added${lead.category ? ` under ${lead.category}` : ""}.`,
            status: "Done",
        },
        {
            label: "Assigned",
            detail: assignedName ? `${assignedName} owns this lead.` : "Waiting for an active agent assignment.",
            status: assignedName ? "Done" : "Next",
            action: assignedName ? "" : "assign",
        },
    ];

    if (lead.status !== "Qualified" && lead.followUpAt) {
        activities.push({
            label: "Follow-up scheduled",
            detail: `${formatLeadScheduleDateTime(lead.followUpAt)} (${getRelativeTime(lead.followUpAt)}).`,
            status: "Priority",
        });
    }

    if (lead.aiScore) {
        activities.push({
            label: "AI ranked",
            detail: `${lead.aiScore}/100 - ${lead.aiScoreReason || "Ranked by lead potential."}`,
            status: lead.aiScore >= 75 ? "High" : "Done",
            action: "score",
        });
    }

    activities.push({
        label: lead.status,
        detail:
            lead.status === "NEW"
                ? "Ready for first outreach."
                : lead.status === "Follow up"
                    ? "Follow-up is the next priority."
                    : `Lead is currently marked ${lead.status}.`,
        status: "Current",
    });

    return activities;
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

function toLeadInput(lead: Lead, notes: string, overrides: Partial<LeadInput> = {}): LeadInput {
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
        notes,
        followUpAt: lead.followUpAt,
        followUpNote: lead.followUpNote || "",
        followUpPriority: lead.followUpPriority || 0,
        aiScore: lead.aiScore || 0,
        aiScoreReason: lead.aiScoreReason || "",
        aiScoreSource: lead.aiScoreSource || "",
        aiScoredAt: lead.aiScoredAt,
        ...overrides,
    };
}

function mergeLeadPages(current: Lead[], next: Lead[]) {
    const leadsById = new Map([...current, ...next].map((lead) => [lead._id, lead]));
    return Array.from(leadsById.values());
}

function updateLeadPageData(current: AdminLeadsPage | undefined, updater: (leads: Lead[]) => Lead[]) {
    if (!current) {
        return current;
    }

    return {
        ...current,
        leads: updater(current.leads),
    };
}

function isScheduledForToday(lead: Lead) {
    return Boolean(lead.status !== "Qualified" && lead.followUpAt && formatLeadScheduleDate(lead.followUpAt) === formatLeadScheduleDate(new Date()));
}

function hasManualCommentToday(lead: Lead) {
    const today = formatCstDate(new Date());
    return (lead.comments || []).some(
        (comment) => comment.authorName !== "CSV Import" && formatCstDate(comment.createdAt) === today
    ) || (lead.activity || []).some(
        (item) => item.label.toLowerCase() === "comment added" && formatCstDate(item.createdAt) === today
    );
}

function isCallPriorityLead(lead: Lead) {
    return !isScheduledForToday(lead) && (lead.status === "NEW" || lead.status === "Follow up") && !hasManualCommentToday(lead);
}

function getDateInputBoundaryTimestamp(value: string, boundary: "start" | "end") {
    const normalizedValue = value.trim();

    if (!/^\d{4}-\d{2}-\d{2}$/.test(normalizedValue)) {
        return null;
    }

    const [year, month, day] = normalizedValue.split("-").map(Number);
    const safeDate = new Date(`${normalizedValue}T00:00:00.000Z`);

    if (
        Number.isNaN(safeDate.getTime()) ||
        safeDate.getUTCFullYear() !== year ||
        safeDate.getUTCMonth() !== month - 1 ||
        safeDate.getUTCDate() !== day
    ) {
        return null;
    }

    const timestamp =
        boundary === "start"
            ? Date.UTC(year, month - 1, day, -PH_TIME_OFFSET_HOURS, 0, 0, 0)
            : Date.UTC(year, month - 1, day, 23 - PH_TIME_OFFSET_HOURS, 59, 59, 999);

    return Number.isNaN(timestamp) ? null : timestamp;
}

function parseLeadTimestamp(value?: string | null) {
    if (!value) {
        return null;
    }

    const timestamp = new Date(value).getTime();

    return Number.isNaN(timestamp) ? null : timestamp;
}

function getQualifiedDateTimestamp(lead: Lead) {
    const qualifiedActivityTimes = (lead.activity || [])
        .filter((item) => {
            const text = `${item.status || ""} ${item.detail || ""}`.toLowerCase();
            return text.includes("qualified");
        })
        .map((item) => parseLeadTimestamp(item.createdAt))
        .filter((timestamp): timestamp is number => timestamp !== null);

    if (qualifiedActivityTimes.length > 0) {
        return Math.max(...qualifiedActivityTimes);
    }

    return parseLeadTimestamp(lead.createdAt);
}

function getRouteLeadTab(value: string): AdminLeadTab | null {
    const normalizedValue = value.trim().toLowerCase();
    const routeTabs: Record<string, AdminLeadTab> = {
        all: "ALL",
        leads: "NEW",
        new: "NEW",
        qualified: "Qualified",
        negotiation: "Ongoing Negotiation",
        "ongoing negotiation": "Ongoing Negotiation",
        dead: "Dead",
        archived: "Archived",
        unassigned: "Unassigned",
    };

    return routeTabs[normalizedValue] || null;
}

function escapeExcelHtml(value: unknown) {
    return String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;")
        .replace(/\r?\n/g, "<br />");
}

function slugifyExcelFilename(value: string) {
    return value
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "") || "leads";
}

function formatLeadExportDate(value?: Date | string | null) {
    return value ? formatPhDateTime(value) : "";
}

function formatLeadExportTimestamp(timestamp: number | null) {
    return timestamp === null ? "" : formatPhDateTime(new Date(timestamp));
}

function latestLeadActivity(lead: Lead) {
    const latest = [...(lead.activity || [])]
        .sort((first, second) => new Date(second.createdAt || 0).getTime() - new Date(first.createdAt || 0).getTime())[0];

    if (!latest) {
        return "";
    }

    const timestamp = formatLeadExportDate(latest.createdAt);
    return [latest.label, latest.detail, timestamp].filter(Boolean).join(" | ");
}

function latestLeadComment(lead: Lead) {
    const latest = [...(lead.comments || [])]
        .sort((first, second) => new Date(second.createdAt || 0).getTime() - new Date(first.createdAt || 0).getTime())[0];

    if (!latest) {
        return "";
    }

    const timestamp = formatLeadExportDate(latest.createdAt);
    return [latest.authorName, latest.body, timestamp].filter(Boolean).join(" | ");
}

const leadExportColumns: Array<{ header: string; value: (lead: Lead) => string | number }> = [
    { header: "Lead Name", value: (lead) => lead.leadName || "" },
    { header: "Position", value: (lead) => lead.position || "" },
    { header: "Business Name", value: (lead) => lead.businessName || "" },
    { header: "Business Address", value: (lead) => lead.businessAddress || "" },
    { header: "Email", value: (lead) => lead.email || "" },
    { header: "Phone", value: (lead) => lead.phone || "" },
    { header: "Website", value: (lead) => lead.website || "" },
    { header: "Source", value: (lead) => lead.source || "" },
    { header: "Category", value: (lead) => lead.category || "" },
    { header: "Status", value: (lead) => lead.status || "" },
    { header: "Assigned Agent", value: (lead) => getCurrentLeadAgent(lead) },
    { header: "Assigned Team", value: (lead) => lead.assignedTeam?.name || "" },
    { header: "Follow Up", value: (lead) => (lead.status !== "Qualified" ? formatLeadExportDate(lead.followUpAt) : "") },
    { header: "Qualified At", value: (lead) => (lead.status === "Qualified" ? formatLeadExportTimestamp(getQualifiedDateTimestamp(lead)) : "") },
    { header: "Created By", value: (lead) => lead.createdByName || lead.createdByType || "" },
    { header: "Created At", value: (lead) => formatLeadExportDate(lead.createdAt) },
    { header: "Updated At", value: (lead) => formatLeadExportDate(lead.updatedAt) },
    { header: "AI Score", value: (lead) => lead.aiScore || 0 },
    { header: "AI Score Reason", value: (lead) => lead.aiScoreReason || "" },
    { header: "Google Place ID", value: (lead) => lead.googlePlaceId || "" },
    { header: "Notes", value: (lead) => lead.notes || "" },
    { header: "Comments Count", value: (lead) => lead.comments?.length || 0 },
    { header: "Latest Comment", value: latestLeadComment },
    { header: "Latest Activity", value: latestLeadActivity },
];

function downloadLeadExcelFile(filename: string, sheetName: string, leads: Lead[]) {
    const safeSheetName = sheetName.replace(/[\\/?*:[\]]/g, " ").slice(0, 31) || "Leads";
    const headerHtml = leadExportColumns
        .map((column) => `<th style="background:#ede9fe;font-weight:700;border:1px solid #cbd5e1;">${escapeExcelHtml(column.header)}</th>`)
        .join("");
    const rowsHtml = leads
        .map((lead) => {
            const cells = leadExportColumns
                .map((column) => `<td style="mso-number-format:'\\@';border:1px solid #cbd5e1;vertical-align:top;">${escapeExcelHtml(column.value(lead))}</td>`)
                .join("");
            return `<tr>${cells}</tr>`;
        })
        .join("");
    const workbookHtml = `<!doctype html>
<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel" xmlns="http://www.w3.org/TR/REC-html40">
<head>
<meta charset="UTF-8" />
<!--[if gte mso 9]><xml><x:ExcelWorkbook><x:ExcelWorksheets><x:ExcelWorksheet><x:Name>${escapeExcelHtml(safeSheetName)}</x:Name><x:WorksheetOptions><x:DisplayGridlines/></x:WorksheetOptions></x:ExcelWorksheet></x:ExcelWorksheets></x:ExcelWorkbook></xml><![endif]-->
</head>
<body><table><thead><tr>${headerHtml}</tr></thead><tbody>${rowsHtml}</tbody></table></body>
</html>`;
    const blob = new Blob(["\ufeff", workbookHtml], { type: "application/vnd.ms-excel;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${filename}.xls`;
    link.click();
    URL.revokeObjectURL(url);
}

export default function AdminLeads() {
    const queryClient = useQueryClient();
    const { showToast } = useToast();
    const importInputRef = useRef<HTMLInputElement>(null);
    const [searchParams] = useSearchParams();
    const routeLeadId = searchParams.get("lead") || "";
    const [activeTab, setActiveTab] = useState<AdminLeadTab>("NEW");
    const [leadQueueFilter, setLeadQueueFilter] = useState<LeadQueueFilter>("ALL");
    const [allStatusFilter, setAllStatusFilter] = useState<AllStatusFilter>("ALL");
    const [activeCategoryTab, setActiveCategoryTab] = useState("ALL");
    const [leadSearch, setLeadSearch] = useState("");
    const [debouncedLeadSearch, setDebouncedLeadSearch] = useState("");
    const [assignedAgentFilter, setAssignedAgentFilter] = useState("ALL");
    const [leadStateFilter, setLeadStateFilter] = useState("ALL");
    const [dateFromFilter, setDateFromFilter] = useState("");
    const [dateToFilter, setDateToFilter] = useState("");
    const [, setLeadPage] = useState(1);
    const [hasMoreLeads, setHasMoreLeads] = useState(true);
    const [isFetchingMoreLeads, setIsFetchingMoreLeads] = useState(false);
    const leadListRef = useRef<HTMLDivElement>(null);
    const leadPageRef = useRef(1);
    const leadFetchInFlightRef = useRef(false);
    const leadQueryIdentityRef = useRef("");
    const [isExportingLeads, setIsExportingLeads] = useState(false);
    const shouldUseDateRangeFilter = activeTab === "Qualified";
    const effectiveDateFromFilter = shouldUseDateRangeFilter ? dateFromFilter : "";
    const effectiveDateToFilter = shouldUseDateRangeFilter ? dateToFilter : "";

    const {
        data: employees = [],
        isLoading: isEmployeesLoading,
    } = useQuery({
        queryKey: ["employees"],
        queryFn: getEmployees,
    });

    const activeEmployees = useMemo(
        () => employees.filter((employee) => employee.status !== "Archived"),
        [employees]
    );

    const selectedAgentName = useMemo(() => {
        if (
            assignedAgentFilter === "ALL" ||
            assignedAgentFilter === "UNASSIGNED" ||
            assignedAgentFilter.startsWith("manual:")
        ) {
            return "";
        }

        return activeEmployees.find((employee) => employee._id === assignedAgentFilter)?.name || "";
    }, [activeEmployees, assignedAgentFilter]);

    const leadQueryParams = useMemo(() => {
        const params: Parameters<typeof getAdminLeads>[0] = {
            page: 1,
            limit: LEAD_PAGE_SIZE,
            search: debouncedLeadSearch || undefined,
            tab: getAdminLeadApiTab(activeTab),
            queue: usesLeadQueueFilter(activeTab) ? leadQueueFilter : undefined,
            statusFilter: activeTab === "ALL" ? allStatusFilter : undefined,
            dateFrom: effectiveDateFromFilter || undefined,
            dateTo: effectiveDateToFilter || undefined,
            state: leadStateFilter !== "ALL" ? leadStateFilter : undefined,
        };

        if (assignedAgentFilter !== "ALL") {
            if (assignedAgentFilter === "UNASSIGNED") {
                params.unassigned = true;
            } else if (assignedAgentFilter.startsWith("manual:")) {
                params.assignedAgentNames = [assignedAgentFilter.replace(/^manual:/, "")];
            } else {
                params.assignedAgent = assignedAgentFilter;

                if (selectedAgentName) {
                    params.assignedAgentNames = [selectedAgentName];
                }
            }
        }

        return params;
    }, [
        activeTab,
        allStatusFilter,
        assignedAgentFilter,
        debouncedLeadSearch,
        effectiveDateFromFilter,
        effectiveDateToFilter,
        leadStateFilter,
        leadQueueFilter,
        selectedAgentName,
    ]);

    const leadQueryKey = useMemo(
        () =>
            [
                "admin-leads",
                activeTab,
                leadQueueFilter,
                allStatusFilter,
                debouncedLeadSearch,
                assignedAgentFilter,
                leadStateFilter,
                effectiveDateFromFilter,
                effectiveDateToFilter,
                selectedAgentName,
            ] as const,
        [
            activeTab,
            leadQueueFilter,
            allStatusFilter,
            assignedAgentFilter,
            leadStateFilter,
            effectiveDateFromFilter,
            effectiveDateToFilter,
            debouncedLeadSearch,
            selectedAgentName,
        ]
    );
    const leadQueryIdentity = JSON.stringify(leadQueryKey);

    const { data: leadPageData, isLoading, isError } = useQuery({
        queryKey: leadQueryKey,
        queryFn: () => getAdminLeads(leadQueryParams),
    });

    const leads = leadPageData?.leads || [];
    const leadStateOptions = leadPageData?.stateOptions || [];

    const assignedAgentOptions = useMemo(() => {
        const optionMap = new Map<string, string>();
        const nameTracker = new Map<string, string>();

        const normalizeName = (name: string) =>
            name.trim().toLowerCase().replace(/\s+/g, " ");

        const addOption = (id: string, name: string) => {
            if (!name) return;

            const normalizedName = normalizeName(name);

            if (nameTracker.has(normalizedName)) return;

            const optionId = id || `manual:${normalizedName}`;

            nameTracker.set(normalizedName, optionId);
            optionMap.set(optionId, name.trim());
        };

        activeEmployees.forEach((employee) => {
            addOption(employee._id, employee.name);
        });

        leads.forEach((lead) => {
            const agentId = lead.assignedAgent?._id || "";
            const agentName = lead.assignedAgent?.name || lead.assignedAgentName || "";

            addOption(agentId, agentName);
        });

        return Array.from(optionMap.entries()).sort((first, second) =>
            first[1].localeCompare(second[1])
        );
    }, [activeEmployees, leads]);

    const salesAssignableEmployees = useMemo(
        () => activeEmployees.filter(isSalesAssignableEmployee).sort((first, second) => first.name.localeCompare(second.name)),
        [activeEmployees]
    );

    const { data: routeLead } = useQuery({
        queryKey: ["admin-route-lead", routeLeadId],
        queryFn: () => getLead(routeLeadId),
        enabled: Boolean(routeLeadId && !leads.some((lead) => lead._id === routeLeadId)),
    });

    const { data: systemSettings } = useQuery({
        queryKey: ["system-settings"],
        queryFn: getSystemSettings,
    });
    const [selectedLeadId, setSelectedLeadId] = useState<string | null>(null);
    const [leadHistoryIds, setLeadHistoryIds] = useState<string[]>([]);
    const [isLeadModalOpen, setIsLeadModalOpen] = useState(false);
    const [isPlacesOpen, setIsPlacesOpen] = useState(false);
    const [leadForm, setLeadForm] = useState<LeadInput>(emptyLead);
    const [placesQuery, setPlacesQuery] = useState("");
    const [placesProduct, setPlacesProduct] = useState("");
    const [placesCity, setPlacesCity] = useState("");
    const [placesState, setPlacesState] = useState("");
    const [placesRadiusMiles, setPlacesRadiusMiles] = useState("50");
    const [placesTargetLeads, setPlacesTargetLeads] = useState("all");
    const [placeResults, setPlaceResults] = useState<BusinessPlaceLead[]>([]);
    const [placesRejectedIrrelevantCount, setPlacesRejectedIrrelevantCount] = useState(0);
    const placesLocation = [placesCity.trim(), placesState.trim()].filter(Boolean).join(", ");
    const isAllMatchingLeadsTarget = placesTargetLeads === "all";
    const targetLeadCount = isAllMatchingLeadsTarget ? 10000 : Number(placesTargetLeads) || 1000;
    const tomTomUsageQuery = useQuery({
        queryKey: ["tomtom-usage"],
        queryFn: () => getTomTomUsage(),
        enabled: isPlacesOpen,
        staleTime: 30_000,
        retry: (failureCount, error) => !isAuthorizationError(error) && failureCount < 3,
        retryDelay: (attemptIndex) => Math.min(1_000 * 2 ** attemptIndex, 5_000),
        refetchInterval: (query) => isAuthorizationError(query.state.error) ? 10_000 : 15_000,
        refetchOnReconnect: true,
        refetchOnWindowFocus: true,
    });
    const bufferedTargetLeadCount = Math.ceil(targetLeadCount * 1.25);
    const tomTomEstimatedRequests = Math.min(
        Math.ceil(bufferedTargetLeadCount / 4),
        400
    );
    const tomTomManualEstimatedRequests = tomTomEstimatedRequests;
    const tomTomAutoEstimatedRequests = tomTomEstimatedRequests;
    const tomTomRemainingRequests = tomTomUsageQuery.data?.remaining;
    const tomTomGeocodingRemainingRequests = tomTomUsageQuery.data?.products.geocoding.remaining;
    const isTomTomBusinessSearchBudgetInsufficient = tomTomRemainingRequests !== undefined
        && tomTomEstimatedRequests > tomTomRemainingRequests;
    const isTomTomGeocodingBudgetInsufficient = Boolean(placesLocation)
        && tomTomGeocodingRemainingRequests !== undefined
        && tomTomGeocodingRemainingRequests < 1;
    const isTomTomBudgetInsufficient = isTomTomBusinessSearchBudgetInsufficient || isTomTomGeocodingBudgetInsufficient;
    const isTomTomUsageCheckUnavailable = tomTomUsageQuery.isError
        || Boolean(tomTomUsageQuery.data && !tomTomUsageQuery.data.configured);
    const isTomTomAuthorizationError = isAuthorizationError(tomTomUsageQuery.error);
    const isTomTomSearchBlocked = tomTomUsageQuery.isLoading
        || isTomTomUsageCheckUnavailable
        || isTomTomBudgetInsufficient;
    const [autoSearchLocations, setAutoSearchLocations] = useState<string[]>([]);
    const [isAiSorted, setIsAiSorted] = useState(false);
    const [aiSortUsedOpenAI, setAiSortUsedOpenAI] = useState(false);
    const [isScoreSaved, setIsScoreSaved] = useState(false);
    const [followUpDateTime, setFollowUpDateTime] = useState("");
    const [commentDraft, setCommentDraft] = useState("");
    const pendingCommentSaveRef = useRef<{ leadId: string; body: string; promise: Promise<Lead> } | null>(null);
    const leadActionPendingRef = useRef<LeadActionName | null>(null);
    const [activeLeadAction, setActiveLeadAction] = useState<LeadActionName | null>(null);
    const [isAssignEditing, setIsAssignEditing] = useState(false);
    const [assignmentEmployeeId, setAssignmentEmployeeId] = useState("");
    const [statusDraft, setStatusDraft] = useState<LeadStatus>("NEW");
    const [isDetailEditing, setIsDetailEditing] = useState(false);
    const [detailDraft, setDetailDraft] = useState<LeadDetailDraft>(emptyLeadDetailDraft);
    const [deleteTarget, setDeleteTarget] = useState<Lead | null>(null);
    const [importMessage, setImportMessage] = useState("");
    const [selectedBulkLeadIds, setSelectedBulkLeadIds] = useState<string[]>([]);
    const [bulkAction, setBulkAction] = useState<null | "archive" | "delete-active-selected" | "restore" | "delete-selected">(null);
    const [isBulkMenuOpen, setIsBulkMenuOpen] = useState(false);
    const [isBulkAssignMenuOpen, setIsBulkAssignMenuOpen] = useState(false);
    const [verificationAction, setVerificationAction] = useState<LeadActionVerification | null>(null);
    const [isVerificationAcknowledged, setIsVerificationAcknowledged] = useState(false);
    const [isVerificationChecking, setIsVerificationChecking] = useState(false);
    const [verificationError, setVerificationError] = useState("");
    const bulkMenuRef = useRef<HTMLDivElement>(null);
    useClickOutside(bulkMenuRef, () => {
        setIsBulkMenuOpen(false);
        setIsBulkAssignMenuOpen(false);
    }, isBulkMenuOpen);

    const invalidateLeads = async () => {
        leadPageRef.current = 1;
        leadFetchInFlightRef.current = false;
        setLeadPage(1);
        setHasMoreLeads(true);
        await queryClient.invalidateQueries({ queryKey: ["admin-leads"] });
        await queryClient.invalidateQueries({ queryKey: ["admin-lead-counts"] });
        await queryClient.invalidateQueries({ queryKey: ["leads"] });
        await queryClient.invalidateQueries({ queryKey: ["lead-counts"] });
        await queryClient.refetchQueries({ queryKey: ["admin-leads"] });
        await queryClient.refetchQueries({ queryKey: ["admin-lead-counts"] });
    };

    useEffect(() => {
        const timeoutId = window.setTimeout(() => {
            setDebouncedLeadSearch(leadSearch.trim());
        }, 250);

        return () => window.clearTimeout(timeoutId);
    }, [leadSearch]);

    useEffect(() => {
        const routeScope = searchParams.get("scope") || searchParams.get("tab") || "";
        const routeTab = getRouteLeadTab(routeScope);
        const routeLeadIdParam = searchParams.get("lead") || "";

        if (!routeTab && !routeLeadIdParam) {
            return;
        }

        if (routeTab) {
            setActiveTab(routeTab);
            setActiveCategoryTab("ALL");
            setAssignedAgentFilter("ALL");
            setLeadStateFilter("ALL");
            setLeadQueueFilter("ALL");
            setAllStatusFilter("ALL");
        }

        if (routeLeadIdParam) {
            setSelectedLeadId(routeLeadIdParam);
            setLeadHistoryIds((current) => (current.includes(routeLeadIdParam) ? current : [routeLeadIdParam, ...current].slice(0, 8)));
        }
    }, [searchParams]);

    useEffect(() => {
        leadQueryIdentityRef.current = leadQueryIdentity;
        leadPageRef.current = 1;
        leadFetchInFlightRef.current = false;
        setLeadPage(1);
        setHasMoreLeads(true);
        setIsFetchingMoreLeads(false);
        if (leadListRef.current) {
            leadListRef.current.scrollTop = 0;
        }
    }, [leadQueryIdentity]);

    useEffect(() => {
        if (leadStateFilter === "ALL" || leadStateOptions.length === 0) {
            return;
        }

        if (!leadStateOptions.some((option) => option.code === leadStateFilter)) {
            setLeadStateFilter("ALL");
        }
    }, [leadStateFilter, leadStateOptions]);

    useEffect(() => {
        if (activeTab !== "ALL") {
            setAllStatusFilter("ALL");
        }
    }, [activeTab]);

    const createLeadMutation = useMutation({
        mutationFn: createLead,
        onSuccess: invalidateLeads,
    });

    const importLeadsMutation = useMutation({
        mutationFn: importLeads,
        onSuccess: (result) => {
            if (result.leads.length > 0) {
                queryClient.setQueryData<AdminLeadsPage>(leadQueryKey, (current) =>
                    updateLeadPageData(current, (currentLeads) => mergeLeadPages(result.leads, currentLeads))
                );
            }
            setImportMessage(
                `Imported ${result.importedCount} lead${result.importedCount === 1 ? "" : "s"}${result.duplicateCount ? `, skipped ${result.duplicateCount} duplicate${result.duplicateCount === 1 ? "" : "s"}` : ""
                }`
            );
            invalidateLeads();
        },
        onError: (error) => {
            setImportMessage(getRequestErrorMessage(error, "Import failed. Check the CSV and try again."));
        },
    });

    const archiveLeadMutation = useMutation({
        mutationFn: (leadId: string) => archiveLead(leadId),
        onSuccess: () => {
            invalidateLeads();
            showToast({ tone: "success", message: "Lead archived." });
        },
        onError: (error) => {
            showToast({ tone: "error", message: getRequestErrorMessage(error, "Could not archive the lead.") });
        },
    });
    const restoreLeadMutation = useMutation({
        mutationFn: restoreLead,
        onSuccess: invalidateLeads,
    });
    const permanentlyDeleteLeadMutation = useMutation({
        mutationFn: permanentlyDeleteLead,
        onSuccess: invalidateLeads,
    });
    const bulkArchiveLeadsMutation = useMutation({
        mutationFn: bulkArchiveLeads,
        onSuccess: () => {
            setSelectedBulkLeadIds([]);
            invalidateLeads();
        },
    });
    const bulkRestoreLeadsMutation = useMutation({
        mutationFn: bulkRestoreLeads,
        onSuccess: () => {
            setSelectedBulkLeadIds([]);
            invalidateLeads();
        },
    });
    const bulkAssignLeadsMutation = useMutation({
        mutationFn: bulkAssignLeads,
        onSuccess: (result, variables) => {
            setSelectedBulkLeadIds([]);
            setIsBulkAssignMenuOpen(false);
            void invalidateLeads();

            const leadLabel = result.assignedCount === 1 ? "lead" : "leads";
            if (result.assignedCount === 0) {
                showToast({ tone: "info", message: "No lead assignments changed. Refresh the list and try again." });
                return;
            }

            showToast({
                tone: "success",
                message: variables.assignedAgent === "UNASSIGNED"
                    ? `Unassigned ${result.assignedCount.toLocaleString()} ${leadLabel}.`
                    : `Assigned ${result.assignedCount.toLocaleString()} ${leadLabel} to ${variables.assignedAgentName}. Assigned leads leave Unassigned but remain in NEW until their status changes.`,
            });
        },
        onError: (error) => {
            showToast({ tone: "error", message: getRequestErrorMessage(error, "Could not assign the selected leads.") });
        },
    });
    const bulkPermanentDeleteMutation = useMutation({
        mutationFn: bulkPermanentlyDeleteArchivedLeads,
        onSuccess: () => {
            setSelectedBulkLeadIds([]);
            invalidateLeads();
        },
    });
    const bulkPermanentDeleteActiveMutation = useMutation({
        mutationFn: bulkPermanentlyDeleteActiveLeads,
        onSuccess: () => {
            setSelectedBulkLeadIds([]);
            invalidateLeads();
        },
    });

    const openDeletePrompt = (lead: Lead) => {
        setDeleteTarget(lead);
    };

    const closeDeletePrompt = () => {
        setDeleteTarget(null);
    };

    const confirmDelete = () => {
        if (archiveLeadMutation.isPending || permanentlyDeleteLeadMutation.isPending) return;
        if (!deleteTarget) return;
        if (deleteTarget.status === "Archived") {
            permanentlyDeleteLeadMutation.mutate(deleteTarget._id, { onSuccess: closeDeletePrompt });
            return;
        }

        const leadId = deleteTarget._id;
        void runLeadActionAfterComment(leadId, "archive", async () => {
            await archiveLeadMutation.mutateAsync(leadId);
            closeDeletePrompt();
        });
    };

    const autoAssignLeadMutation = useMutation({
        mutationFn: autoAssignLead,
        onSuccess: (lead) => {
            queryClient.setQueryData<AdminLeadsPage>(leadQueryKey, (current) =>
                updateLeadPageData(current, (currentLeads) =>
                    currentLeads.map((currentLead) => (currentLead._id === lead._id ? lead : currentLead))
                )
            );
        },
    });

    const reassignNewLeadsMutation = useMutation({
        mutationFn: reassignNewLeads,
        onSuccess: (result) => {
            queryClient.setQueryData<AdminLeadsPage>(leadQueryKey, (current) => updateLeadPageData(current, (currentLeads) => {
                const reassignedLeadsById = new Map(result.leads.map((lead) => [lead._id, lead]));

                return currentLeads.map((lead) => reassignedLeadsById.get(lead._id) || lead);
            }));
            invalidateLeads();
            showToast({
                tone: "success",
                message: result.reassignedCount > 0
                    ? `Reassigned ${result.reassignedCount.toLocaleString()} new lead${result.reassignedCount === 1 ? "" : "s"}.`
                    : "There were no new leads to reassign.",
            });
        },
    });

    const scheduleFollowUpMutation = useMutation({
        mutationFn: ({ id, followUpAt }: { id: string; followUpAt: string }) =>
            scheduleLeadFollowUp(id, { followUpAt, followUpPriority: 100 }),
        onSuccess: (lead) => {
            queryClient.setQueryData<AdminLeadsPage>(leadQueryKey, (current) =>
                updateLeadPageData(current, (currentLeads) =>
                    currentLeads.map((currentLead) => (currentLead._id === lead._id ? lead : currentLead))
                )
            );
            setFollowUpDateTime(formatLeadScheduleDateTimeInput(lead.followUpAt) || getCurrentLeadScheduleDateTimeInput());
        },
        onError: (error) => {
            showToast({ tone: "error", message: getRequestErrorMessage(error, "Could not schedule the follow-up.") });
        },
    });

    const addCommentMutation = useMutation({
        mutationFn: ({ leadId, body }: { leadId: string; body: string }) =>
            addLeadComment(leadId, { body, authorName: "Admin", authorType: "admin" }),
        onMutate: (variables) => {
            const previousLeadPage = queryClient.getQueryData<AdminLeadsPage>(leadQueryKey);
            const optimisticComment = {
                _id: `pending-${Date.now()}`,
                authorName: "Admin",
                authorType: "admin" as const,
                body: variables.body,
                createdAt: new Date().toISOString(),
            };

            queryClient.setQueryData<AdminLeadsPage>(leadQueryKey, (current) =>
                updateLeadPageData(current, (currentLeads) =>
                    currentLeads.map((lead) =>
                        lead._id === variables.leadId
                            ? { ...lead, comments: [...(lead.comments || []), optimisticComment] }
                            : lead
                    )
                )
            );
            setCommentDraft((current) => (current.trim() === variables.body ? "" : current));

            return { previousLeadPage };
        },
        onSuccess: (lead, variables) => {
            queryClient.setQueryData<AdminLeadsPage>(leadQueryKey, (current) =>
                updateLeadPageData(current, (currentLeads) =>
                    currentLeads.map((currentLead) => (currentLead._id === lead._id ? lead : currentLead))
                )
            );
            setCommentDraft((current) => (current.trim() === variables.body ? "" : current));
            void queryClient.invalidateQueries({ queryKey: ["admin-lead-counts"] });
            void queryClient.invalidateQueries({ queryKey: ["lead-counts"] });
            showToast({ tone: "success", message: "Note added to the lead." });
        },
        onError: (error, variables, context) => {
            if (context?.previousLeadPage) {
                queryClient.setQueryData(leadQueryKey, context.previousLeadPage);
            }
            setCommentDraft((current) => current || variables.body);
            showToast({ tone: "error", message: getRequestErrorMessage(error, "Could not add the note. Please try again.") });
        },
    });

    const saveAssignmentMutation = useMutation({
        mutationFn: ({
            lead,
            assignedAgent,
            assignedAgentName,
        }: {
            lead: Lead;
            assignedAgent: string;
            assignedAgentName: string;
        }) =>
            assignLead(lead._id, {
                assignedAgent,
                assignedAgentName,
                activityActorName: "Admin",
                activityActorType: "admin",
            }),
        onSuccess: (lead) => {
            queryClient.setQueryData<AdminLeadsPage>(leadQueryKey, (current) =>
                updateLeadPageData(current, (currentLeads) =>
                    currentLeads.map((currentLead) => (currentLead._id === lead._id ? lead : currentLead))
                )
            );
            setIsAssignEditing(false);
            void invalidateLeads();
            showToast({ tone: "success", message: `Lead assigned to ${lead.assignedAgent?.name || lead.assignedAgentName}.` });
        },
        onError: (error) => {
            showToast({ tone: "error", message: getRequestErrorMessage(error, "Could not assign the lead.") });
        },
    });

    const updateStatusMutation = useMutation({
        mutationFn: ({ id, status }: { id: string; status: LeadStatus }) =>
            updateLeadStatus(id, status, { activityActorName: "Admin", activityActorType: "admin" }),
        onSuccess: (lead) => {
            queryClient.setQueryData<AdminLeadsPage>(leadQueryKey, (current) =>
                updateLeadPageData(current, (currentLeads) =>
                    currentLeads.map((currentLead) => (currentLead._id === lead._id ? lead : currentLead))
                )
            );
            setStatusDraft(lead.status);
            setFollowUpDateTime(formatLeadScheduleDateTimeInput(lead.followUpAt) || getCurrentLeadScheduleDateTimeInput());
            void invalidateLeads();
        },
        onError: (error) => {
            showToast({ tone: "error", message: getRequestErrorMessage(error, "Could not update the lead status.") });
        },
    });

    const updateDetailsMutation = useMutation({
        mutationFn: async ({ lead, draft }: { lead: Lead; draft: LeadDetailDraft }) => {
            const currentLead = await getLead(lead._id);
            return updateLead(
                currentLead._id,
                toLeadInput(
                    currentLead,
                    currentLead.notes || "",
                    {
                        ...draft,
                        businessName: draft.businessName.trim(),
                        activityActorName: "Admin",
                        activityActorType: "admin",
                    }
                )
            );
        },
        onSuccess: (lead) => {
            queryClient.setQueryData<AdminLeadsPage>(leadQueryKey, (current) =>
                updateLeadPageData(current, (currentLeads) =>
                    currentLeads.map((currentLead) => (currentLead._id === lead._id ? lead : currentLead))
                )
            );
            setDetailDraft(createLeadDetailDraft(lead));
            setIsDetailEditing(false);
        },
        onError: (error) => {
            showToast({ tone: "error", message: getRequestErrorMessage(error, "Could not save the lead details.") });
        },
    });

    const searchAndImportPlacesMutation = useMutation({
        mutationFn: (input: PlacesManualSearchInput) => searchAndImportTomTomPlaces(input),
        onSuccess: (result) => {
            setPlaceResults(result.places);
            setPlacesRejectedIrrelevantCount(result.rejectedIrrelevantCount || 0);
            setAutoSearchLocations(result.searchedLocations || []);
            invalidateLeads();
            void tomTomUsageQuery.refetch();
            showToast({
                tone: "success",
                message: `Saved ${result.places.length.toLocaleString()} relevant lead${result.places.length === 1 ? "" : "s"}${result.rejectedIrrelevantCount ? ` and excluded ${result.rejectedIrrelevantCount.toLocaleString()} unrelated result${result.rejectedIrrelevantCount === 1 ? "" : "s"}` : ""}.`,
            });
        },
        onError: () => {
            void tomTomUsageQuery.refetch();
        },
    });

    const autoSearchPlacesMutation = useMutation({
        mutationFn: (input: PlacesAutoSearchInput) => autoSearchTomTomPlacesLeads(input),
        onSuccess: (result) => {
            setPlaceResults(result.places);
            setPlacesRejectedIrrelevantCount(result.rejectedIrrelevantCount || 0);
            setAutoSearchLocations(result.searchedLocations || []);
            setActiveCategoryTab(formatFilterLabel(result.product));
            invalidateLeads();
            queryClient.setQueryData<AdminLeadsPage>(leadQueryKey, (current) =>
                updateLeadPageData(current, (currentLeads) =>
                    mergeLeadPages(result.leads, currentLeads).sort((first, second) => (second.aiScore || 0) - (first.aiScore || 0))
                )
            );
            setIsAiSorted(true);
            setIsScoreSaved(true);
            void tomTomUsageQuery.refetch();
            showToast({
                tone: "success",
                message: `Saved ${result.places.length.toLocaleString()} relevant lead${result.places.length === 1 ? "" : "s"}${result.rejectedIrrelevantCount ? ` and excluded ${result.rejectedIrrelevantCount.toLocaleString()} unrelated result${result.rejectedIrrelevantCount === 1 ? "" : "s"}` : ""}.`,
            });
        },
        onError: () => {
            void tomTomUsageQuery.refetch();
        },
    });

    const scoreLeadsMutation = useMutation({
        mutationFn: scoreLeadsByHighestPotential,
        onSuccess: async (result) => {
            queryClient.setQueryData<AdminLeadsPage>(leadQueryKey, (current) => updateLeadPageData(current, (currentLeads) => {
                const scoredLeadsById = new Map(result.leads.map((lead) => [lead._id, lead]));
                const untouchedLeads = currentLeads.filter((lead) => !scoredLeadsById.has(lead._id));

                return [...result.leads, ...untouchedLeads];
            }));
            await queryClient.invalidateQueries({ queryKey: ["admin-leads"] });
            setIsAiSorted(true);
            setAiSortUsedOpenAI(result.usedAi);
            setIsScoreSaved(true);
        },
    });

    const categoryTabs = useMemo(() => {
        const categoryNames = new Map<string, string>();
        const categorySource =
            activeTab === "NEW"
                ? leads.filter((lead) => (leadQueueFilter === "ALL" ? lead.status === "NEW" || lead.status === "Follow up" : lead.status === leadQueueFilter))
                : activeTab === "Unassigned"
                    ? leads.filter((lead) => (leadQueueFilter === "ALL" ? lead.status !== "Archived" && lead.status !== "Dead" : lead.status === leadQueueFilter))
                    : leads;

        categorySource.forEach((lead) => {
            const category = formatFilterLabel(lead.category || "");

            if (category) {
                categoryNames.set(category.toLowerCase(), category);
            }
        });

        return ["ALL", ...Array.from(categoryNames.values()).sort((a, b) => a.localeCompare(b))];
    }, [activeTab, leadQueueFilter, leads]);
    const isAgentDropdownLoading = isEmployeesLoading || isLoading;



    const leadCountParams = useMemo(() => {
        const params: Parameters<typeof getAdminLeadCounts>[0] = {
            search: debouncedLeadSearch || undefined,
            state: leadStateFilter !== "ALL" ? leadStateFilter : undefined,
        };

        if (assignedAgentFilter !== "ALL") {
            if (assignedAgentFilter === "UNASSIGNED") {
                params.unassigned = true;
            } else if (assignedAgentFilter.startsWith("manual:")) {
                params.assignedAgentNames = [
                    assignedAgentFilter.replace(/^manual:/, ""),
                ];
            } else {
                params.assignedAgent = assignedAgentFilter;
                params.assignedAgentNames = selectedAgentName
                    ? [selectedAgentName]
                    : [];
            }
        }

        return params;
    }, [assignedAgentFilter, debouncedLeadSearch, leadStateFilter, selectedAgentName]);

    const { data: leadCounts = {} } = useQuery({
        queryKey: ["admin-lead-counts", leadCountParams],
        queryFn: () => getAdminLeadCounts(leadCountParams),
    });

    const reassignLeadCountsQuery = useQuery({
        queryKey: ["admin-lead-counts", "reassign-verification"],
        queryFn: () => getAdminLeadCounts(),
        staleTime: 15_000,
    });

    const filteredLeads = useMemo(() => {
        const dateFromTimestamp = getDateInputBoundaryTimestamp(effectiveDateFromFilter, "start");
        const dateToTimestamp = getDateInputBoundaryTimestamp(effectiveDateToFilter, "end");
        const hasDateRangeFilter = dateFromTimestamp !== null || dateToTimestamp !== null;

        const visibleLeads = leads.filter((lead) => {
            const assignedAgentId = lead.assignedAgent?._id || "";
            const assignedAgentName = lead.assignedAgent?.name || lead.assignedAgentName || "";
            const isUnassigned = !assignedAgentId && !assignedAgentName.trim();
            const matchesStatus =
                activeTab === "ALL"
                    ? lead.status !== "Archived" && (allStatusFilter === "ALL" || lead.status === allStatusFilter)
                    : activeTab === "NEW"
                        ? leadQueueFilter === "ALL"
                            ? lead.status === "NEW" || lead.status === "Follow up"
                            : lead.status === leadQueueFilter
                        : activeTab === "Unassigned"
                            ? isUnassigned && (leadQueueFilter === "ALL" ? lead.status !== "Archived" && lead.status !== "Dead" : lead.status === leadQueueFilter)
                            : lead.status === activeTab;
            const matchesCategory =
                activeCategoryTab === "ALL" || formatFilterLabel(lead.category || "").toLowerCase() === activeCategoryTab.toLowerCase();
            const selectedAgentNameNormalized = selectedAgentName
                .trim()
                .toLowerCase()
                .replace(/\s+/g, " ");

            const assignedAgentNameNormalized = assignedAgentName
                .trim()
                .toLowerCase()
                .replace(/\s+/g, " ");

            const matchesAgent =
                assignedAgentFilter === "ALL" ||
                (assignedAgentFilter === "UNASSIGNED" && isUnassigned) ||
                assignedAgentFilter === assignedAgentId ||
                assignedAgentFilter === `manual:${assignedAgentNameNormalized}` ||
                (
                    Boolean(selectedAgentNameNormalized) &&
                    assignedAgentNameNormalized === selectedAgentNameNormalized
                );
            const leadDateTimestamp = activeTab === "Qualified" ? getQualifiedDateTimestamp(lead) : parseLeadTimestamp(lead.createdAt);
            const matchesDateRange =
                !hasDateRangeFilter ||
                (leadDateTimestamp !== null &&
                    (dateFromTimestamp === null || leadDateTimestamp >= dateFromTimestamp) &&
                    (dateToTimestamp === null || leadDateTimestamp <= dateToTimestamp));

            return matchesStatus && matchesCategory && matchesAgent && matchesDateRange;
        });

        if (!isAiSorted) {
            return visibleLeads;
        }

        return [...visibleLeads].sort((first, second) => (second.aiScore || 0) - (first.aiScore || 0));
    }, [activeCategoryTab, activeTab, allStatusFilter, assignedAgentFilter, effectiveDateFromFilter, effectiveDateToFilter, isAiSorted, leadQueueFilter, leads, selectedAgentName]);

    const selectableLeadIds = useMemo(() => {
        if (activeTab === "ALL" || activeTab === "Unassigned" || activeTab === "NEW") {
            return filteredLeads
                .filter((lead) => lead.status !== "Archived")
                .map((lead) => lead._id);
        }

        if (activeTab === "Archived") {
            return filteredLeads
                .filter((lead) => lead.status === "Archived")
                .map((lead) => lead._id);
        }

        return [];
    }, [activeTab, filteredLeads]);
    const getTabLabel = (tab: AdminLeadTab) => (tab === "NEW" ? "Leads" : tab);
    const getLeadQueueFilterLabel = (filter: LeadQueueFilter) => {
        if (filter === "ALL") {
            return "All";
        }

        return filter === "NEW" ? "New" : "Follow up";
    };
    const activeTabTotalCount =
        leadPageData?.total ??
        (activeTab === "NEW"
            ? leadQueueFilter === "ALL"
                ? (leadCounts.NEW || 0) + (leadCounts["Follow up"] || 0)
                : leadCounts[leadQueueFilter] || 0
            : activeTab === "Unassigned"
                ? leadQueueFilter === "ALL"
                    ? leadCounts.Unassigned || leads.length
                    : leadCounts[leadQueueFilter] || leads.length
                : leadCounts[activeTab] || leadCounts.ALL || leads.length);
    const getTabCount = (tab: AdminLeadTab) => {
        if (tab === activeTab) {
            return activeCategoryTab === "ALL" ? activeTabTotalCount : filteredLeads.length;
        }

        if (tab === "NEW") {
            return (leadCounts.NEW || 0) + (leadCounts["Follow up"] || 0);
        }

        return leadCounts[tab] || 0;
    };
    const selectableLeadCount = selectableLeadIds.length;
    const selectedBulkCount = selectedBulkLeadIds.length;
    const selectedBulkLabel = String(selectedBulkCount);
    const areAllVisibleLeadsSelected = selectableLeadIds.length > 0 && selectableLeadIds.every((leadId) => selectedBulkLeadIds.includes(leadId));

    const selectedRouteLead = routeLead?._id === selectedLeadId ? routeLead : null;
    const selectedLead = leads.find((lead) => lead._id === selectedLeadId) || selectedRouteLead || filteredLeads[0] || null;
    const leadHistory = leadHistoryIds
        .map((leadId) => leads.find((lead) => lead._id === leadId) || (routeLead?._id === leadId ? routeLead : undefined))
        .filter((lead): lead is Lead => Boolean(lead));
    const showLeadMiniTabs = systemSettings?.adminLeadMiniTabsEnabled !== false;

    const selectLead = (leadId: string) => {
        setSelectedLeadId(leadId);
        if (!showLeadMiniTabs) {
            return;
        }

        setLeadHistoryIds((current) => {
            if (current.includes(leadId)) {
                return current;
            }

            return [leadId, ...current].slice(0, 8);
        });
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
        setSelectedBulkLeadIds([]);
        setIsBulkMenuOpen(false);
    }, [activeTab, activeCategoryTab, assignedAgentFilter, leadSearch]);

    useEffect(() => {
        if (!isLoading && leadPageData) {
            leadPageRef.current = Math.max(leadPageData.page || 1, 1);
            setLeadPage(leadPageRef.current);
            setHasMoreLeads(leadPageData.hasMore);
        }
    }, [isLoading, leadPageData]);

    const toggleBulkLead = (leadId: string) => {
        setSelectedBulkLeadIds((current) => (current.includes(leadId) ? current.filter((id) => id !== leadId) : [...current, leadId]));
    };

    const toggleAllVisibleLeads = () => {
        setSelectedBulkLeadIds((current) => {
            if (areAllVisibleLeadsSelected) {
                return current.filter((leadId) => !selectableLeadIds.includes(leadId));
            }

            return Array.from(new Set([...current, ...selectableLeadIds]));
        });
    };

    const closeBulkPrompt = () => setBulkAction(null);

    const confirmBulkAction = () => {
        if (
            bulkArchiveLeadsMutation.isPending ||
            bulkRestoreLeadsMutation.isPending ||
            bulkPermanentDeleteActiveMutation.isPending ||
            bulkPermanentDeleteMutation.isPending
        ) {
            return;
        }

        if (bulkAction === "archive") {
            bulkArchiveLeadsMutation.mutate(selectedBulkLeadIds, { onSuccess: closeBulkPrompt });
            return;
        }

        if (bulkAction === "delete-active-selected") {
            bulkPermanentDeleteActiveMutation.mutate(selectedBulkLeadIds, { onSuccess: closeBulkPrompt });
            return;
        }

        if (bulkAction === "restore") {
            bulkRestoreLeadsMutation.mutate(selectedBulkLeadIds, { onSuccess: closeBulkPrompt });
            return;
        }

        if (bulkAction === "delete-selected") {
            bulkPermanentDeleteMutation.mutate(selectedBulkLeadIds, { onSuccess: closeBulkPrompt });
            return;
        }

    };

    const openLeadModal = () => {
        setLeadForm(emptyLead);
        setIsLeadModalOpen(true);
    };

    const closeLeadModal = () => {
        setLeadForm(emptyLead);
        setIsLeadModalOpen(false);
    };

    const handleSaveLead = (event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();

        if (createLeadMutation.isPending) {
            return;
        }

        if (!leadForm.businessName.trim()) {
            return;
        }

        createLeadMutation.mutate(leadForm);
        closeLeadModal();
    };

    const handleLeadImport = async (file: File | null) => {
        if (!file) {
            return;
        }

        try {
            setImportMessage("Reading CSV...");
            const text = await file.text();
            const importedLeads = parseLeadCsv(text);

            if (importedLeads.length === 0) {
                setImportMessage("No valid leads found in CSV.");
                return;
            }

            importLeadsMutation.mutate(importedLeads);
        } catch {
            setImportMessage("Could not read the CSV file.");
        } finally {
            if (importInputRef.current) {
                importInputRef.current.value = "";
            }
        }
    };

    const handleExportLeads = async () => {
        if (isExportingLeads) {
            return;
        }

        setIsExportingLeads(true);

        try {
            const exportLimit = Math.min(Math.max(activeTabTotalCount, filteredLeads.length, LEAD_PAGE_SIZE), 10000);
            const exportPage = await getAdminLeads({
                ...leadQueryParams,
                page: 1,
                limit: exportLimit,
                exportFile: true,
            });
            const categoryFilteredLeads =
                activeCategoryTab === "ALL"
                    ? exportPage.leads
                    : exportPage.leads.filter((lead) => formatFilterLabel(lead.category || "").toLowerCase() === activeCategoryTab.toLowerCase());
            const exportLeads = isAiSorted
                ? [...categoryFilteredLeads].sort((first, second) => (second.aiScore || 0) - (first.aiScore || 0))
                : categoryFilteredLeads;

            if (exportLeads.length === 0) {
                showToast({ tone: "info", message: "No leads found for this tab export." });
                return;
            }

            const tabLabel = getTabLabel(activeTab);
            const categoryLabel = activeCategoryTab === "ALL" ? "" : `-${activeCategoryTab}`;
            const filename = slugifyExcelFilename(`admin-leads-${tabLabel}${categoryLabel}-${new Date().toISOString().slice(0, 10)}`);
            downloadLeadExcelFile(filename, `${tabLabel} Leads`, exportLeads);
            showToast({ tone: "success", message: `Exported ${exportLeads.length.toLocaleString()} lead${exportLeads.length === 1 ? "" : "s"} to Excel.` });

            if (exportPage.hasMore) {
                showToast({ tone: "info", message: "Export reached the 10,000-row limit. Narrow filters to export the rest." });
            }
        } catch {
            showToast({ tone: "error", message: "Could not export leads. Please try again." });
        } finally {
            setIsExportingLeads(false);
        }
    };

    const fetchMoreLeads = async () => {
        if (leadFetchInFlightRef.current || isLoading || !hasMoreLeads) {
            return;
        }

        const requestIdentity = leadQueryIdentityRef.current;
        const nextPage = leadPageRef.current + 1;
        leadFetchInFlightRef.current = true;
        setIsFetchingMoreLeads(true);

        try {
            const nextLeadPage = await getAdminLeads({
                ...leadQueryParams,
                page: nextPage,
                limit: LEAD_PAGE_SIZE,
            });

            if (requestIdentity !== leadQueryIdentityRef.current) {
                return;
            }

            queryClient.setQueryData<AdminLeadsPage>(leadQueryKey, (current) => {
                if (!current) {
                    return nextLeadPage;
                }

                return {
                    ...nextLeadPage,
                    leads: mergeLeadPages(current.leads, nextLeadPage.leads),
                };
            });
            leadPageRef.current = nextPage;
            setLeadPage(nextPage);
            setHasMoreLeads(nextLeadPage.hasMore);
        } catch (error) {
            showToast({ tone: "error", message: getRequestErrorMessage(error, "Could not load more leads. Please try again.") });
        } finally {
            if (requestIdentity === leadQueryIdentityRef.current) {
                leadFetchInFlightRef.current = false;
                setIsFetchingMoreLeads(false);
            }
        }
    };

    const handleLeadListScroll = (event: UIEvent<HTMLDivElement>) => {
        const target = event.currentTarget;
        const remainingScroll = target.scrollHeight - target.scrollTop - target.clientHeight;

        if (remainingScroll < 160) {
            fetchMoreLeads();
        }
    };

    const openActionVerification = (action: LeadActionVerification) => {
        setVerificationError("");
        setIsVerificationAcknowledged(false);
        setVerificationAction(action);
    };

    const closeActionVerification = () => {
        if (isVerificationChecking) return;
        setVerificationAction(null);
        setVerificationError("");
        setIsVerificationAcknowledged(false);
    };

    const handleOpenReassignVerification = async () => {
        if (reassignNewLeadsMutation.isPending || reassignLeadCountsQuery.isFetching) return;

        const countResult = await reassignLeadCountsQuery.refetch();
        const leadCount = countResult.data?.NEW || 0;

        if (countResult.isError) {
            showToast({ tone: "error", message: "Could not verify the current new-lead count. Please try again." });
            return;
        }

        if (leadCount === 0) {
            showToast({ tone: "info", message: "There are no new leads to reassign." });
            return;
        }

        openActionVerification({ kind: "reassign-new", leadCount });
    };

    const confirmVerifiedAction = async () => {
        if (!verificationAction || !isVerificationAcknowledged || isVerificationChecking) return;

        setIsVerificationChecking(true);
        setVerificationError("");

        try {
            if (verificationAction.kind === "reassign-new") {
                const countResult = await reassignLeadCountsQuery.refetch();
                const leadCount = countResult.data?.NEW || 0;

                if (countResult.isError) {
                    setVerificationError("The current new-lead count could not be verified. No assignments were changed.");
                    return;
                }

                if (leadCount === 0) {
                    setVerificationError("There are no new leads left to reassign.");
                    return;
                }

                setVerificationAction(null);
                setIsVerificationAcknowledged(false);
                reassignNewLeadsMutation.mutate();
                return;
            }

            const usageResult = await tomTomUsageQuery.refetch();
            const requiredRequests = verificationAction.input.maxRequests || 0;

            if (usageResult.isError || !usageResult.data?.configured) {
                setVerificationError("TomTom usage could not be verified. The search was not started.");
                return;
            }

            if (usageResult.data.remaining < requiredRequests) {
                setVerificationError(
                    `Only ${usageResult.data.remaining.toLocaleString()} requests remain, but this search can use up to ${requiredRequests.toLocaleString()}. Choose a smaller target.`
                );
                return;
            }

            const verifiedAction = verificationAction;
            setVerificationAction(null);
            setIsVerificationAcknowledged(false);
            setPlaceResults([]);
            setPlacesRejectedIrrelevantCount(0);
            setAutoSearchLocations([]);

            if (verifiedAction.kind === "tomtom-manual") {
                setActiveCategoryTab(verifiedAction.input.category);
                searchAndImportPlacesMutation.mutate(verifiedAction.input);
                return;
            }

            setActiveCategoryTab(formatFilterLabel(verifiedAction.input.product));
            autoSearchPlacesMutation.mutate(verifiedAction.input);
        } finally {
            setIsVerificationChecking(false);
        }
    };

    const handlePlacesSearch = (event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        if (isTomTomSearchBlocked) return;

        const requestedCategory = placesQuery.trim();
        const location = placesLocation;
        const radiusMiles = Number(placesRadiusMiles);

        if (!requestedCategory) {
            showToast({ tone: "error", message: "Enter a business type before searching." });
            return;
        }

        if (!Number.isFinite(radiusMiles) || radiusMiles < 1 || radiusMiles > 50) {
            showToast({ tone: "error", message: "Use a search radius from 1 to 50 miles." });
            return;
        }

        const category = formatFilterLabel(requestedCategory);
        const textQuery = [category, location].filter(Boolean).join(" in ");

        if (textQuery.trim()) {
            openActionVerification({
                kind: "tomtom-manual",
                input: {
                textQuery,
                category,
                location,
                radiusMiles,
                maxResults: targetLeadCount,
                maxRequests: tomTomManualEstimatedRequests,
                },
            });
        }
    };

    const handleAutoPlacesSearch = () => {
        if (isTomTomSearchBlocked) return;

        const product = placesProduct.trim();
        const location = placesLocation;
        const radiusMiles = Number(placesRadiusMiles);

        if (!product) {
            showToast({ tone: "error", message: "Enter a product before finding matching leads." });
            return;
        }

        if (!Number.isFinite(radiusMiles) || radiusMiles < 1 || radiusMiles > 50) {
            showToast({ tone: "error", message: "Use a search radius from 1 to 50 miles." });
            return;
        }

        openActionVerification({
            kind: "tomtom-auto",
            input: {
                product,
                location,
                radiusMiles,
                maxResults: targetLeadCount,
                maxRequests: tomTomAutoEstimatedRequests,
            },
        });
    };

    const placesMutationError = searchAndImportPlacesMutation.error || autoSearchPlacesMutation.error;
    const placesErrorMessage = (placesMutationError as { response?: { data?: { message?: string } } } | null)?.response?.data?.message;
    const isTomTomUnavailable = isTomTomUsageCheckUnavailable;

    const leadPhone = selectedLead?.phone || "";
    const whatsappPhone = leadPhone.replace(/\D/g, "");
    const leadActivity = selectedLead ? getLeadActivity(selectedLead) : [];
    const isQualifiedStatusDraft = statusDraft === "Qualified";
    const shouldClearQualifiedFollowUp = Boolean(selectedLead && selectedLead.status === "Qualified" && selectedLead.followUpAt);
    const hasStatusUpdate = Boolean(selectedLead && (statusDraft !== selectedLead.status || (isQualifiedStatusDraft && selectedLead.followUpAt)));

    const startCommentSave = (leadId: string, body: string) => {
        const currentPendingSave = pendingCommentSaveRef.current;

        if (currentPendingSave?.leadId === leadId) {
            return currentPendingSave.promise;
        }

        const promise = addCommentMutation.mutateAsync({ leadId, body });
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
        setCommentDraft("");
        setIsAssignEditing(false);
        setIsDetailEditing(false);
        setDetailDraft(createLeadDetailDraft(selectedLead));
    }, [selectedLead?._id]);

    useEffect(() => {
        const selectedSalesEmployee = salesAssignableEmployees.find((employee) => employee._id === selectedLead?.assignedAgent?._id);
        setAssignmentEmployeeId(selectedSalesEmployee?._id || "");
    }, [salesAssignableEmployees, selectedLead?._id, selectedLead?.assignedAgent?._id]);

    useEffect(() => {
        setStatusDraft(selectedLead?.status || "NEW");
    }, [selectedLead?._id, selectedLead?.status]);

    useEffect(() => {
        setFollowUpDateTime(formatLeadScheduleDateTimeInput(selectedLead?.followUpAt) || getCurrentLeadScheduleDateTimeInput());
    }, [selectedLead?._id, selectedLead?.followUpAt]);

    const handleAiSort = () => {
        if (scoreLeadsMutation.isPending) {
            return;
        }

        const leadIds = filteredLeads.map((lead) => lead._id);

        if (leadIds.length > 0) {
            scoreLeadsMutation.mutate(leadIds);
        }
    };
    const handleScheduleFollowUp = () => {
        if (scheduleFollowUpMutation.isPending) {
            return;
        }

        if (!selectedLead || !followUpDateTime) {
            return;
        }

        if (selectedLead.status === "Qualified" || statusDraft === "Qualified") {
            showToast({ tone: "error", message: "Qualified leads do not use follow-up schedules." });
            return;
        }

        const scheduledDate = parseLeadScheduleDateTimeInput(followUpDateTime);

        if (!scheduledDate) {
            showToast({ tone: "error", message: "Use a valid follow-up date and time." });
            return;
        }

        const leadId = selectedLead._id;
        void runLeadActionAfterComment(leadId, "schedule", () =>
            scheduleFollowUpMutation.mutateAsync({ id: leadId, followUpAt: scheduledDate.toISOString() })
        );
    };
    const handleSaveComment = () => {
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
    const handleSaveAssignment = () => {
        if (saveAssignmentMutation.isPending) {
            return;
        }

        const selectedSalesEmployee = salesAssignableEmployees.find((employee) => employee._id === assignmentEmployeeId);

        if (!selectedLead || !selectedSalesEmployee) {
            return;
        }

        const assignment = {
            lead: selectedLead,
            assignedAgent: selectedSalesEmployee._id,
            assignedAgentName: selectedSalesEmployee.name,
        };
        void runLeadActionAfterComment(selectedLead._id, "assignment", () =>
            saveAssignmentMutation.mutateAsync(assignment)
        );
    };
    const cancelAssignmentEdit = () => {
        const selectedSalesEmployee = salesAssignableEmployees.find((employee) => employee._id === selectedLead?.assignedAgent?._id);
        setAssignmentEmployeeId(selectedSalesEmployee?._id || "");
        setIsAssignEditing(false);
    };

    const handleSaveStatus = () => {
        if (updateStatusMutation.isPending || !selectedLead || !hasStatusUpdate) {
            return;
        }

        const leadId = selectedLead._id;
        const nextStatus = statusDraft;
        void runLeadActionAfterComment(leadId, "status", () =>
            updateStatusMutation.mutateAsync({ id: leadId, status: nextStatus })
        );
    };

    const updateDetailDraft = (field: keyof LeadDetailDraft, value: string) => {
        setDetailDraft((current) => ({ ...current, [field]: value }));
    };

    const cancelDetailEdit = () => {
        setDetailDraft(createLeadDetailDraft(selectedLead));
        setIsDetailEditing(false);
    };

    const handleSaveDetails = () => {
        if (updateDetailsMutation.isPending) {
            return;
        }

        if (!selectedLead || !detailDraft.businessName.trim()) {
            return;
        }

        const lead = selectedLead;
        const draft = { ...detailDraft };
        void runLeadActionAfterComment(lead._id, "details", () =>
            updateDetailsMutation.mutateAsync({ lead, draft })
        );
    };

    const handleActivityAction = (action?: string) => {
        if (!selectedLead || !action) {
            return;
        }

        if (action === "assign") {
            if (autoAssignLeadMutation.isPending) return;
            autoAssignLeadMutation.mutate(selectedLead._id);
            return;
        }

        if (action === "score") {
            if (scoreLeadsMutation.isPending) return;
            scoreLeadsMutation.mutate([selectedLead._id]);
            return;
        }

        if (action === "follow-up") {
            document.getElementById("lead-follow-up-input")?.focus();
        }
    };

    const queueCountQueryParams = useMemo(() => {
        const params = {
            ...leadQueryParams,
            page: 1,
            limit: 10000,
            queue: "ALL" as LeadQueueFilter,
        };

        return params;
    }, [
        activeTab,
        allStatusFilter,
        assignedAgentFilter,
        debouncedLeadSearch,
        effectiveDateFromFilter,
        effectiveDateToFilter,
        leadStateFilter,
        leadQueryParams,
    ]);

    useQuery({
        queryKey: [
            "admin-lead-queue-counts",
            activeTab,
            allStatusFilter,
            assignedAgentFilter,
            debouncedLeadSearch,
            effectiveDateFromFilter,
            effectiveDateToFilter,
            leadStateFilter,
        ],
        queryFn: () => getAdminLeads(queueCountQueryParams),
        enabled: usesLeadQueueFilter(activeTab),
    });


    const newLeadCount = leadCounts.NEW || 0;
    const followUpLeadCount = leadCounts["Follow up"] || 0;

    const queueFilterCounts: Record<LeadQueueFilter, number> = {
        ALL: newLeadCount + followUpLeadCount,
        NEW: newLeadCount,
        "Follow up": followUpLeadCount,
    };

    return (
        <AdminLayout>
            <section className="admin-leads-page -m-4 min-h-[calc(100vh-5.5rem)] p-4 2xl:-m-6 2xl:p-6">
                <div className="border-b border-white/10">
                    <div className="flex flex-col gap-3 py-3 2xl:flex-row 2xl:items-end 2xl:justify-between">
                        <div className="content-scroll flex min-w-0 items-end gap-5 overflow-x-auto">
                            {tabs.map((tab) => {
                                const isActive = tab === activeTab;

                                return (
                                    <button
                                        key={tab}
                                        className={[
                                            "relative h-10 shrink-0 px-1 text-sm font-medium transition",
                                            isActive ? "text-[#9b5cff]" : "text-white/60 hover:text-white",
                                        ].join(" ")}
                                        type="button"
                                        onClick={() => {
                                            setActiveTab(tab);
                                            setActiveCategoryTab("ALL");
                                            if (tab !== "NEW") {
                                                setLeadQueueFilter("ALL");
                                            }
                                        }}
                                    >
                                        <span className="inline-flex items-center gap-1.5">
                                            {getTabLabel(tab)}
                                            <span
                                                className={[
                                                    "rounded-md px-1.5 py-0.5 text-[0.65rem] font-semibold",
                                                    isActive ? "bg-[#842cff]/20 text-[#d7c3ff]" : "bg-white/[0.06] text-white/35",
                                                ].join(" ")}
                                            >
                                                {getTabCount(tab)}
                                            </span>
                                        </span>
                                        {isActive && <span className="absolute inset-x-0 bottom-0 h-0.5 rounded-full bg-[#842cff]" />}
                                    </button>
                                );
                            })}
                        </div>

                        <div className="flex shrink-0 flex-wrap items-center gap-2">
                            <input
                                ref={importInputRef}
                                className="hidden"
                                type="file"
                                accept=".csv,text/csv"
                                onChange={(event) => void handleLeadImport(event.target.files?.[0] || null)}
                            />
                            <button
                                className="flat-action-button flat-action-import flex h-9 items-center gap-2 rounded-lg border border-[#10ac84] bg-[#10ac84] px-3 text-xs font-semibold text-white shadow-sm shadow-[#10ac84]/20 transition hover:border-[#0b8f6e] hover:bg-[#0b8f6e] disabled:cursor-not-allowed disabled:opacity-100"
                                type="button"
                                onClick={() => importInputRef.current?.click()}
                                disabled={importLeadsMutation.isPending}
                                title="Import leads from CSV"
                            >
                                <FiUpload
                                    className={["size-4", importLeadsMutation.isPending ? "animate-pulse" : ""].join(" ")}
                                    aria-hidden="true"
                                />
                                {importLeadsMutation.isPending ? "Importing" : "Import"}
                            </button>
                            <button
                                className="flat-action-button flex h-9 items-center gap-2 rounded-lg border border-[#1dd1a1] bg-white px-3 text-xs font-semibold !text-black shadow-sm shadow-[#1dd1a1]/15 transition hover:border-[#10ac84] hover:bg-[#ecfff8] disabled:cursor-not-allowed disabled:opacity-70"
                                type="button"
                                onClick={() => void handleExportLeads()}
                                disabled={isExportingLeads || isLoading}
                                title={`Export ${getTabLabel(activeTab)} tab to Excel`}
                            >
                                <FiDownload
                                    className={["size-4 !text-black", isExportingLeads ? "animate-bounce" : ""].join(" ")}
                                    aria-hidden="true"
                                />
                                {isExportingLeads ? "Exporting" : "Export Excel"}
                            </button>
                            <button
                                className="flat-action-button flat-action-reassign flex h-9 items-center gap-2 rounded-lg border border-[#2e86de] bg-[#2e86de] px-3 text-xs font-semibold text-white shadow-sm shadow-[#2e86de]/20 transition hover:border-[#1f6fbf] hover:bg-[#1f6fbf] disabled:cursor-not-allowed disabled:opacity-100"
                                type="button"
                                onClick={() => void handleOpenReassignVerification()}
                                disabled={reassignNewLeadsMutation.isPending || reassignLeadCountsQuery.isFetching || (reassignLeadCountsQuery.data?.NEW || 0) === 0}
                                title="Reassign all new leads"
                            >
                                <FiRefreshCw
                                    className={["size-4", reassignNewLeadsMutation.isPending ? "animate-spin" : ""].join(" ")}
                                    aria-hidden="true"
                                />
                                {reassignNewLeadsMutation.isPending
                                    ? "Assigning"
                                    : reassignLeadCountsQuery.isFetching
                                        ? "Verifying"
                                        : "Reassign new"}
                            </button>
                            <button
                                className="flat-action-button flat-action-auto-update flex h-9 items-center gap-2 rounded-lg border border-[#ff9f43] bg-[#ff9f43] px-3 text-xs font-semibold text-white shadow-sm shadow-[#ff9f43]/20 transition hover:border-[#e67f1d] hover:bg-[#e67f1d]"
                                type="button"
                                onClick={() => {
                                    setPlacesProduct("");
                                    setPlacesQuery("");
                                    setPlaceResults([]);
                                    setPlacesRejectedIrrelevantCount(0);
                                    setAutoSearchLocations([]);
                                    searchAndImportPlacesMutation.reset();
                                    autoSearchPlacesMutation.reset();
                                    setIsPlacesOpen(true);
                                }}
                            >
                                <FiMapPin className="size-4" aria-hidden="true" />
                                Auto update leads
                            </button>
                            <button
                                className="canada-action-add flex h-9 items-center gap-2 rounded-lg border border-[#5f27cd] bg-[#5f27cd] px-3 text-xs font-semibold text-white shadow-sm shadow-[#5f27cd]/20 transition hover:border-[#4f1fb0] hover:bg-[#4f1fb0]"
                                type="button"
                                onClick={openLeadModal}
                            >
                                <FiPlus className="size-4" aria-hidden="true" />
                                Add Lead
                            </button>
                        </div>
                    </div>
                    {importMessage && (
                        <p className="pb-2 text-right text-xs font-semibold text-white/45">
                            {importMessage}
                        </p>
                    )}
                </div>

                <div className="grid h-[calc(100vh-15rem)] min-h-[24rem] gap-4 pt-4 xl:h-[calc(100vh-14rem)] xl:grid-cols-[minmax(15rem,19rem)_1fr] 2xl:h-[calc(100vh-12rem)] 2xl:gap-5 2xl:pt-5">
                    <section className="admin-leads-list-panel relative z-30 flex min-h-0 flex-col overflow-visible rounded-lg border border-white/10 bg-[#f100ff30]">
                        <div className="flex h-14 items-center justify-between border-b border-white/10 px-5">
                            <div>
                                <h2 className="text-base font-semibold text-white">Leads</h2>
                                {isAiSorted && (
                                    <p className="mt-0.5 text-[0.68rem] font-semibold text-[#9df6b7]">
                                        {isScoreSaved ? "Scores saved" : aiSortUsedOpenAI ? "AI ranked" : "Local AI fallback"}
                                    </p>
                                )}
                            </div>
                            <div className="relative flex items-center gap-2">
                                <button
                                    className="flex h-8 items-center gap-1.5 rounded-lg border border-[#00d2d3] bg-[#00d2d3] px-2.5 text-xs font-semibold text-white transition hover:border-[#01a3a4] hover:bg-[#01a3a4] disabled:cursor-not-allowed disabled:opacity-80"
                                    type="button"
                                    onClick={handleAiSort}
                                    disabled={scoreLeadsMutation.isPending || filteredLeads.length === 0}
                                >
                                    <FiZap className="size-3.5" aria-hidden="true" />
                                    {scoreLeadsMutation.isPending ? "Saving" : isScoreSaved ? "Saved" : "AI sort"}
                                </button>
                                <span className="rounded-md bg-white/[0.06] px-2 py-1 text-xs font-medium text-white/55">
                                    {filteredLeads.length}
                                </span>
                                {(activeTab === "ALL" || activeTab === "Unassigned" || activeTab === "Archived" || activeTab === "NEW") && (
                                    <div ref={bulkMenuRef} className="relative">
                                        <button
                                            className="flex size-8 items-center justify-center rounded-lg border border-white/10 bg-white/[0.04] text-white/55 transition hover:bg-white/[0.08] hover:text-white"
                                            type="button"
                                            onClick={() => {
                                                setIsBulkMenuOpen((isOpen) => !isOpen);
                                                setIsBulkAssignMenuOpen(false);
                                            }}
                                            aria-label="Lead bulk actions"
                                        >
                                            <FiMoreVertical className="size-4" aria-hidden="true" />
                                        </button>
                                        {isBulkMenuOpen && (
                                            <div className="absolute right-0 top-10 z-50 w-52 overflow-visible rounded-lg border border-white/10 bg-[#0d1018] p-1 shadow-2xl shadow-black/40">
                                                <button
                                                    className="flex h-9 w-full items-center justify-between rounded-md px-3 text-left text-xs font-semibold text-white/70 transition hover:bg-white/[0.06] hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
                                                    type="button"
                                                    onClick={() => {
                                                        toggleAllVisibleLeads();
                                                    }}
                                                    disabled={selectableLeadCount === 0}
                                                >
                                                    <span className="flex items-center gap-2">
                                                        {areAllVisibleLeadsSelected ? <FiCheckSquare className="size-3.5 text-[#9b5cff]" aria-hidden="true" /> : <FiSquare className="size-3.5" aria-hidden="true" />}
                                                        {areAllVisibleLeadsSelected ? "Clear selection" : "Select all"}
                                                    </span>
                                                    <span className="text-white/35">{selectedBulkLabel}</span>
                                                </button>
                                                {(activeTab === "ALL" || activeTab === "Unassigned" || activeTab === "NEW") && (
                                                    <>
                                                        <div className="relative">
                                                            <button
                                                                className="flex h-9 w-full items-center justify-between rounded-md px-3 text-left text-xs font-semibold !text-black transition hover:bg-[#2e86de]/15 hover:!text-black disabled:cursor-not-allowed disabled:!text-black disabled:opacity-100"
                                                                type="button"
                                                                disabled={selectedBulkCount === 0 || bulkAssignLeadsMutation.isPending}
                                                                onClick={() => setIsBulkAssignMenuOpen((isOpen) => !isOpen)}
                                                            >
                                                                <span className="flex items-center gap-2">
                                                                    <FiUserPlus className="size-3.5 !text-black" aria-hidden="true" />
                                                                    Assign to
                                                                </span>
                                                                <FiChevronRight className="size-3.5 !text-black" aria-hidden="true" />
                                                            </button>
                                                            {isBulkAssignMenuOpen && (
                                                                <div className="bulk-assign-submenu absolute left-[calc(100%+0.35rem)] top-0 z-[60] max-h-64 w-60 overflow-y-auto rounded-lg border border-slate-300 bg-white p-1 text-slate-950 shadow-2xl shadow-black/25">
                                                                    <button
                                                                        className="flex min-h-9 w-full flex-col items-start justify-center rounded-md px-3 py-2 text-left text-xs font-semibold !text-slate-950 transition hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-50"
                                                                        type="button"
                                                                        disabled={bulkAssignLeadsMutation.isPending}
                                                                        onClick={() => {
                                                                            bulkAssignLeadsMutation.mutate({
                                                                                leadIds: selectedBulkLeadIds,
                                                                                assignedAgent: "UNASSIGNED",
                                                                                assignedAgentName: "",
                                                                            });
                                                                            setIsBulkMenuOpen(false);
                                                                            setIsBulkAssignMenuOpen(false);
                                                                        }}
                                                                    >
                                                                        <span>Unassign</span>
                                                                        <span className="mt-0.5 text-[0.65rem] font-medium !text-slate-500">Clear assigned agent</span>
                                                                    </button>
                                                                    <div className="my-1 h-px bg-slate-200" />
                                                                    {salesAssignableEmployees.length === 0 && (
                                                                        <p className="px-3 py-2 text-xs font-semibold !text-slate-500">No active Sales employees in this business</p>
                                                                    )}
                                                                    {salesAssignableEmployees.map((employee) => (
                                                                        <button
                                                                            key={employee._id}
                                                                            className="flex min-h-9 w-full flex-col items-start justify-center rounded-md px-3 py-2 text-left text-xs font-semibold !text-slate-950 transition hover:bg-sky-50 disabled:cursor-not-allowed disabled:opacity-50"
                                                                            type="button"
                                                                            disabled={bulkAssignLeadsMutation.isPending}
                                                                            onClick={() => {
                                                                                bulkAssignLeadsMutation.mutate({
                                                                                    leadIds: selectedBulkLeadIds,
                                                                                    assignedAgent: employee._id,
                                                                                    assignedAgentName: employee.name,
                                                                                });
                                                                                setIsBulkMenuOpen(false);
                                                                                setIsBulkAssignMenuOpen(false);
                                                                            }}
                                                                        >
                                                                            <span>{employee.name}</span>
                                                                            <span className="mt-0.5 text-[0.65rem] font-medium !text-slate-500">
                                                                                {[employee.role, employee.team].filter(Boolean).join(" · ") || "Agent"}
                                                                            </span>
                                                                        </button>
                                                                    ))}
                                                                </div>
                                                            )}
                                                        </div>
                                                        <button
                                                            className="flex h-9 w-full items-center gap-2 rounded-md px-3 text-left text-xs font-semibold text-white/70 transition hover:bg-red-500/10 hover:text-red-100 disabled:cursor-not-allowed disabled:opacity-40"
                                                            type="button"
                                                            disabled={selectedBulkCount === 0 || bulkArchiveLeadsMutation.isPending}
                                                            onClick={() => {
                                                                setBulkAction("archive");
                                                                setIsBulkMenuOpen(false);
                                                                setIsBulkAssignMenuOpen(false);
                                                            }}
                                                        >
                                                            <FiArchive className="size-3.5" aria-hidden="true" />
                                                            Archive selected
                                                        </button>
                                                        <button
                                                            className="flex h-9 w-full items-center gap-2 rounded-md px-3 text-left text-xs font-semibold text-white/70 transition hover:bg-red-500/10 hover:text-red-100 disabled:cursor-not-allowed disabled:opacity-40"
                                                            type="button"
                                                            disabled={selectedBulkCount === 0 || bulkPermanentDeleteActiveMutation.isPending}
                                                            onClick={() => {
                                                                setBulkAction("delete-active-selected");
                                                                setIsBulkMenuOpen(false);
                                                                setIsBulkAssignMenuOpen(false);
                                                            }}
                                                        >
                                                            <FiTrash2 className="size-3.5" aria-hidden="true" />
                                                            Delete selected
                                                        </button>
                                                    </>
                                                )}
                                                {activeTab === "Archived" && (
                                                    <>
                                                        <button
                                                            className="flex h-9 w-full items-center gap-2 rounded-md px-3 text-left text-xs font-semibold text-white/70 transition hover:bg-emerald-400/10 hover:text-emerald-100 disabled:cursor-not-allowed disabled:opacity-40"
                                                            type="button"
                                                            disabled={selectedBulkCount === 0 || bulkRestoreLeadsMutation.isPending}
                                                            onClick={() => {
                                                                setBulkAction("restore");
                                                                setIsBulkMenuOpen(false);
                                                            }}
                                                        >
                                                            <FiRotateCcw className="size-3.5" aria-hidden="true" />
                                                            Restore selected
                                                        </button>
                                                        <button
                                                            className="flex h-9 w-full items-center gap-2 rounded-md px-3 text-left text-xs font-semibold text-white/70 transition hover:bg-red-500/10 hover:text-red-100 disabled:cursor-not-allowed disabled:opacity-40"
                                                            type="button"
                                                            disabled={selectedBulkCount === 0 || bulkPermanentDeleteMutation.isPending}
                                                            onClick={() => {
                                                                setBulkAction("delete-selected");
                                                                setIsBulkMenuOpen(false);
                                                            }}
                                                        >
                                                            <FiTrash2 className="size-3.5" aria-hidden="true" />
                                                            Delete selected
                                                        </button>
                                                    </>
                                                )}
                                            </div>
                                        )}
                                    </div>
                                )}
                            </div>
                        </div>

                        <div className="grid gap-2.5 border-b border-white/10 bg-black/[0.04] px-4 py-3">
                            <label className="flex h-9 min-w-0 items-center gap-2 rounded-lg border border-white/12 bg-white/[0.08] px-3 text-white/45 shadow-sm shadow-black/5 focus-within:border-[#842cff]/70 focus-within:bg-white/[0.11] focus-within:ring-2 focus-within:ring-[#842cff]/20">
                                <FiSearch className="size-3.5 shrink-0" aria-hidden="true" />
                                <input
                                    className="h-full min-w-0 flex-1 bg-transparent text-xs font-semibold text-white outline-none placeholder:text-white/30"
                                    value={leadSearch}
                                    onChange={(event) => setLeadSearch(event.target.value)}
                                    placeholder="Search leads"
                                />
                            </label>
                            <div className={usesLeadQueueFilter(activeTab) || activeTab === "ALL" ? "grid grid-cols-2 gap-2" : "grid gap-2"}>
                                <select
                                    className="h-9 min-w-0 rounded-lg border border-white/12 bg-[#16101f] px-3 text-xs font-semibold text-white outline-none transition hover:bg-[#1b1227] focus:border-[#842cff]/70 focus:ring-2 focus:ring-[#842cff]/20"
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
                                <select
                                    className="h-9 min-w-0 rounded-lg border border-white/12 bg-[#16101f] px-3 text-xs font-semibold text-white outline-none transition hover:bg-[#1b1227] focus:border-[#842cff]/70 focus:ring-2 focus:ring-[#842cff]/20"
                                    value={assignedAgentFilter}
                                    onChange={(e) => setAssignedAgentFilter(e.target.value)}
                                    disabled={isAgentDropdownLoading}
                                >
                                    {isAgentDropdownLoading ? (
                                        <option value="">Loading agents...</option>
                                    ) : (
                                        <>
                                            <option value="ALL">All</option>
                                            <option value="UNASSIGNED">Unassigned</option>

                                            {assignedAgentOptions.map(([id, name]) => (
                                                <option key={id} value={id}>
                                                    {name}
                                                </option>
                                            ))}
                                        </>
                                    )}
                                </select>
                                {usesLeadQueueFilter(activeTab) && (
                                    <select
                                        className="h-9 min-w-0 rounded-lg border border-white/12 bg-[#16101f] px-3 text-xs font-semibold text-white outline-none transition hover:bg-[#1b1227] focus:border-[#842cff]/70 focus:ring-2 focus:ring-[#842cff]/20"
                                        value={leadQueueFilter}
                                        onChange={(event) => {
                                            setLeadQueueFilter(event.target.value as LeadQueueFilter);
                                            setActiveCategoryTab("ALL");
                                        }}
                                        aria-label="Filter leads by status"
                                    >
                                        {(["ALL", "NEW", "Follow up"] as LeadQueueFilter[]).map((filter) => {
                                            const count = queueFilterCounts[filter];

                                            return (
                                                <option key={filter} value={filter}>
                                                    {filter === "ALL"
                                                        ? "All statuses"
                                                        : `${getLeadQueueFilterLabel(filter)} (${count})`}
                                                </option>
                                            );
                                        })}
                                    </select>
                                )}
                                {activeTab === "ALL" && (
                                    <select
                                        className="h-9 min-w-0 rounded-lg border border-white/12 bg-[#16101f] px-3 text-xs font-semibold text-white outline-none transition hover:bg-[#1b1227] focus:border-[#842cff]/70 focus:ring-2 focus:ring-[#842cff]/20"
                                        value={allStatusFilter}
                                        onChange={(event) => {
                                            setAllStatusFilter(event.target.value as AllStatusFilter);
                                            setActiveCategoryTab("ALL");
                                        }}
                                        aria-label="Filter all leads by status"
                                    >
                                        {allStatusFilters.map((status) => (
                                            <option key={status} value={status}>
                                                {status === "ALL" ? "All statuses" : `${status} (${leadCounts[status] || 0})`}
                                            </option>
                                        ))}
                                    </select>
                                )}
                            </div>
                            {shouldUseDateRangeFilter && (
                                <div className="grid grid-cols-2 gap-2">
                                    <LeadDatePicker label="From" value={dateFromFilter} onChange={setDateFromFilter} />
                                    <LeadDatePicker label="To" value={dateToFilter} onChange={setDateToFilter} align="right" />
                                </div>
                            )}
                        </div>

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

                        <div ref={leadListRef} className="content-scroll min-h-0 flex-1 divide-y divide-white/10 overflow-y-auto overscroll-contain [scrollbar-gutter:stable]" onScroll={handleLeadListScroll}>
                            {isLoading && <p className="px-5 py-6 text-sm text-white/45">Loading leads...</p>}
                            {isError && <p className="px-5 py-6 text-sm text-red-200">Unable to load leads.</p>}
                            {!isLoading && !isError && filteredLeads.length === 0 && (
                                <p className="px-5 py-6 text-sm text-white/45">No leads in this tab.</p>
                            )}
                            {filteredLeads.map((lead) => {
                                const isBulkSelectable =
                                    ((activeTab === "ALL" ||
                                        activeTab === "Unassigned" ||
                                        activeTab === "NEW") &&
                                        lead.status !== "Archived") ||
                                    (activeTab === "Archived" && lead.status === "Archived");
                                const isBulkSelected = selectedBulkLeadIds.includes(lead._id);
                                const isCallPriority = isCallPriorityLead(lead);
                                const isScheduledToday = isScheduledForToday(lead);
                                const wasCommentedToday = hasManualCommentToday(lead);

                                return (
                                    <div
                                        key={lead._id}
                                        className={[
                                            "flex w-full items-center gap-3 px-5 py-4 transition",
                                            selectedLead?._id === lead._id ? "bg-white/[0.07]" : "hover:bg-white/[0.04]",
                                        ].join(" ")}
                                    >
                                        {isBulkSelectable && (
                                            <button
                                                className="flex size-5 shrink-0 items-center justify-center rounded border border-white/15 bg-black/20 text-white/60 transition hover:border-[#842cff]/60 hover:text-white"
                                                type="button"
                                                onClick={() => toggleBulkLead(lead._id)}
                                                aria-label={isBulkSelected ? "Unselect lead" : "Select lead"}
                                            >
                                                {isBulkSelected ? <FiCheckSquare className="size-4 text-[#9b5cff]" aria-hidden="true" /> : <FiSquare className="size-4" aria-hidden="true" />}
                                            </button>
                                        )}
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
                                                <span className="block truncate text-xs font-semibold text-white/45" title={lead.category || lead.source}>
                                                    {lead.category || lead.source}
                                                </span>
                                                <span className="mt-1 grid grid-cols-[0.875rem_minmax(0,1fr)] items-center gap-1.5 text-left text-xs text-[#9b5cff]">
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
                                                {isAiSorted && (
                                                    <span className="mt-1 block text-xs font-semibold text-[#9df6b7]">
                                                        {lead.aiScore || 0}/100
                                                    </span>
                                                )}
                                            </span>
                                        </button>
                                    </div>
                                );
                            })}
                            {!isLoading && !isError && isFetchingMoreLeads && (
                                <p className="px-5 py-4 text-center text-xs font-semibold text-white/35">
                                    Loading leads... {leads.length.toLocaleString()} / {activeTabTotalCount.toLocaleString()}
                                </p>
                            )}
                            {!isLoading && !isError && !isFetchingMoreLeads && filteredLeads.length > 0 && hasMoreLeads && (
                                <div className="flex justify-center px-5 py-4">
                                    <button
                                        className="h-9 rounded-lg border border-white/15 bg-white/[0.04] px-4 text-xs font-semibold text-white/70 transition hover:bg-white/[0.08] hover:text-white"
                                        type="button"
                                        onClick={() => void fetchMoreLeads()}
                                    >
                                        Load more leads
                                    </button>
                                </div>
                            )}
                            {!isLoading && !isError && filteredLeads.length > 0 && !hasMoreLeads && (
                                <p className="px-5 py-4 text-center text-xs font-semibold text-white/25">End of list</p>
                            )}
                        </div>
                    </section>

                    <section className="admin-lead-detail-area flex min-h-0 flex-col overflow-hidden">
                        <div className="flex min-h-14 flex-wrap items-center justify-between gap-3 px-1 py-1">
                            <div>
                                <h2 className="text-base font-semibold text-white">Lead Details</h2>
                                <p className="mt-1 text-xs text-white/40">Admin profile</p>
                            </div>

                            {selectedLead && (
                                <div className="flex items-center gap-2">
                                    {selectedLead.status === "Archived" ? (
                                        <>
                                            <button
                                                className="flex h-10 items-center gap-2 rounded-lg border border-emerald-300/20 bg-emerald-400/10 px-3 text-sm font-semibold text-emerald-100/80 transition hover:bg-emerald-400/15 hover:text-emerald-50 disabled:opacity-60"
                                                type="button"
                                                onClick={() => restoreLeadMutation.mutate(selectedLead._id)}
                                                disabled={restoreLeadMutation.isPending}
                                            >
                                                <FiRotateCcw className="size-4" aria-hidden="true" />
                                                Restore
                                            </button>
                                            <button
                                                className="flex h-10 items-center gap-2 rounded-lg border border-red-400/25 bg-red-500/10 px-3 text-sm font-semibold text-red-100/80 transition hover:bg-red-500/15 hover:text-red-50"
                                                type="button"
                                                onClick={() => openDeletePrompt(selectedLead)}
                                            >
                                                <FiTrash2 className="size-4" aria-hidden="true" />
                                                Delete
                                            </button>
                                        </>
                                    ) : (
                                        <button
                                            className="archive-lead-button flex h-10 items-center gap-2 rounded-lg border border-[#ee5253] bg-[#ee5253] px-3 text-sm font-semibold text-white shadow-sm shadow-[#ee5253]/20 transition hover:border-[#d94546] hover:bg-[#d94546] disabled:cursor-not-allowed disabled:opacity-60"
                                            type="button"
                                            onClick={() => openDeletePrompt(selectedLead)}
                                            disabled={Boolean(activeLeadAction)}
                                        >
                                            <FiArchive className="size-4" aria-hidden="true" />
                                            Archive
                                        </button>
                                    )}
                                </div>
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
                                                <a
                                                    className="flex size-9 items-center justify-center rounded-lg border border-[#10ac84] bg-[#10ac84] text-white transition hover:border-[#0b8f6e] hover:bg-[#0b8f6e]"
                                                    href={getPhoneCallUrl(selectedLead.phone)}
                                                    aria-label="Call lead"
                                                    title="Call lead"
                                                >
                                                    <FiPhone className="size-4" aria-hidden="true" />
                                                </a>
                                                <a
                                                    className="flex size-9 items-center justify-center rounded-lg border border-[#2e86de] bg-[#2e86de] text-white transition hover:border-[#1f6fbf] hover:bg-[#1f6fbf]"
                                                    href={`mailto:${selectedLead.email}`}
                                                    aria-label="Email lead"
                                                >
                                                    <FiMail className="size-4" aria-hidden="true" />
                                                </a>
                                                <a
                                                    className="flex size-9 items-center justify-center rounded-lg border border-[#1dd1a1] bg-[#1dd1a1] text-white transition hover:border-[#10ac84] hover:bg-[#10ac84]"
                                                    href={`https://wa.me/${whatsappPhone}`}
                                                    aria-label="WhatsApp lead"
                                                >
                                                    <FaWhatsapp className="size-4" aria-hidden="true" />
                                                </a>
                                                <button
                                                    className="flex size-9 items-center justify-center rounded-lg border border-[#5f27cd] bg-[#5f27cd] text-white transition hover:border-[#4f1fb0] hover:bg-[#4f1fb0]"
                                                    type="button"
                                                    aria-label="Edit lead"
                                                    onClick={() => {
                                                        setDetailDraft(createLeadDetailDraft(selectedLead));
                                                        setIsDetailEditing(true);
                                                    }}
                                                    disabled={Boolean(activeLeadAction)}
                                                >
                                                    <FiEdit2 className="size-4" aria-hidden="true" />
                                                </button>
                                            </div>
                                        </div>

                                        <div className="mt-5 grid gap-4 md:grid-cols-2">
                                            <div>
                                                <p className="text-xs font-medium uppercase tracking-[0.14em] text-white/35">Business</p>
                                                {isDetailEditing ? (
                                                    <div className="mt-2 space-y-2">
                                                        <input
                                                            className="h-10 w-full rounded-lg border border-white/10 bg-black/20 px-3 text-sm font-semibold text-white outline-none transition placeholder:text-white/30 focus:border-[#842cff] focus:ring-2 focus:ring-[#842cff]/20"
                                                            value={detailDraft.businessName}
                                                            onChange={(event) => updateDetailDraft("businessName", event.target.value)}
                                                            placeholder="Business name"
                                                        />
                                                        <textarea
                                                            className="min-h-20 w-full resize-y rounded-lg border border-white/10 bg-black/20 px-3 py-2 text-sm font-semibold leading-6 text-white outline-none transition placeholder:text-white/30 focus:border-[#842cff] focus:ring-2 focus:ring-[#842cff]/20"
                                                            value={detailDraft.businessAddress}
                                                            onChange={(event) => updateDetailDraft("businessAddress", event.target.value)}
                                                            placeholder="Business address"
                                                        />
                                                    </div>
                                                ) : (
                                                    <>
                                                        <p className="mt-2 text-sm font-semibold text-white">{selectedLead.businessName}</p>
                                                        <p className="mt-1 text-sm leading-6 text-white/55">
                                                            {selectedLead.businessAddress || "No address"}
                                                        </p>
                                                    </>
                                                )}
                                            </div>
                                            <div className="space-y-4">
                                                <div>
                                                    <p className="text-xs font-medium uppercase tracking-[0.14em] text-white/35">Email</p>
                                                    {isDetailEditing ? (
                                                        <input
                                                            className="mt-2 h-10 w-full rounded-lg border border-white/10 bg-black/20 px-3 text-sm font-semibold text-white outline-none transition placeholder:text-white/30 focus:border-[#842cff] focus:ring-2 focus:ring-[#842cff]/20"
                                                            value={detailDraft.email}
                                                            onChange={(event) => updateDetailDraft("email", event.target.value)}
                                                            placeholder="Email"
                                                        />
                                                    ) : (
                                                        <p className="mt-2 truncate text-sm font-semibold text-white">
                                                            {selectedLead.email || "No email"}
                                                        </p>
                                                    )}
                                                </div>
                                                <div>
                                                    <p className="text-xs font-medium uppercase tracking-[0.14em] text-white/35">
                                                        Phone Number
                                                    </p>
                                                    {isDetailEditing ? (
                                                        <input
                                                            className="mt-2 h-10 w-full rounded-lg border border-white/10 bg-black/20 px-3 text-sm font-semibold text-white outline-none transition placeholder:text-white/30 focus:border-[#842cff] focus:ring-2 focus:ring-[#842cff]/20"
                                                            value={detailDraft.phone}
                                                            onChange={(event) => updateDetailDraft("phone", event.target.value)}
                                                            placeholder="Phone"
                                                        />
                                                    ) : (
                                                        <p className="mt-2 text-sm font-semibold text-white">{selectedLead.phone || "No phone"}</p>
                                                    )}
                                                </div>
                                            </div>
                                        </div>
                                        {isDetailEditing && (
                                            <div className="mt-4 grid gap-3 border-t border-white/10 pt-4 sm:grid-cols-2">
                                                <input
                                                    className="h-10 rounded-lg border border-white/10 bg-black/20 px-3 text-sm font-semibold text-white outline-none transition placeholder:text-white/30 focus:border-[#842cff] focus:ring-2 focus:ring-[#842cff]/20"
                                                    value={detailDraft.website}
                                                    onChange={(event) => updateDetailDraft("website", event.target.value)}
                                                    placeholder="Website"
                                                />
                                                <input
                                                    className="h-10 rounded-lg border border-white/10 bg-black/20 px-3 text-sm font-semibold text-white outline-none transition placeholder:text-white/30 focus:border-[#842cff] focus:ring-2 focus:ring-[#842cff]/20"
                                                    value={detailDraft.source}
                                                    onChange={(event) => updateDetailDraft("source", event.target.value)}
                                                    placeholder="Source"
                                                />
                                                <input
                                                    className="h-10 rounded-lg border border-white/10 bg-black/20 px-3 text-sm font-semibold text-white outline-none transition placeholder:text-white/30 focus:border-[#842cff] focus:ring-2 focus:ring-[#842cff]/20"
                                                    value={detailDraft.category}
                                                    onChange={(event) => updateDetailDraft("category", event.target.value)}
                                                    placeholder="Category"
                                                />
                                                <div className="flex justify-end gap-2">
                                                    <button
                                                        className="h-10 rounded-lg border border-[#576574] bg-[#576574] px-3 text-sm font-semibold text-white transition hover:border-[#3f4b55] hover:bg-[#3f4b55]"
                                                        type="button"
                                                        onClick={cancelDetailEdit}
                                                        disabled={updateDetailsMutation.isPending || Boolean(activeLeadAction)}
                                                    >
                                                        Cancel
                                                    </button>
                                                    <button
                                                        className="h-10 rounded-lg border border-[#10ac84] bg-[#10ac84] px-3 text-sm font-semibold text-white transition hover:border-[#0b8f6e] hover:bg-[#0b8f6e] disabled:cursor-not-allowed disabled:opacity-80"
                                                        type="button"
                                                        onClick={handleSaveDetails}
                                                        disabled={updateDetailsMutation.isPending || Boolean(activeLeadAction) || !detailDraft.businessName.trim()}
                                                    >
                                                        {activeLeadAction === "details" ? "Saving" : "Save"}
                                                    </button>
                                                </div>
                                            </div>
                                        )}
                                    </div>

                                    <div className="rounded-lg border border-white/10 bg-white/[0.04] p-4">
                                        <div className="grid gap-4 2xl:grid-cols-[minmax(12rem,0.75fr)_minmax(0,1.25fr)]">
                                            <div className="rounded-lg border border-white/10 bg-black/10 p-3">
                                                <div className="flex items-center justify-between gap-3">
                                                    <p className="text-xs font-medium uppercase tracking-[0.14em] text-white/35">
                                                        Assigned Agent
                                                    </p>
                                                    {!isAssignEditing && (
                                                        <button
                                                            className="rounded-md border border-[#2e86de] bg-[#2e86de] px-2 py-1 text-xs font-semibold text-white transition hover:border-[#1f6fbf] hover:bg-[#1f6fbf]"
                                                            type="button"
                                                            onClick={() => setIsAssignEditing(true)}
                                                            disabled={Boolean(activeLeadAction)}
                                                        >
                                                            {selectedLead.assignedAgent || selectedLead.assignedAgentName ? "Edit" : "Assign"}
                                                        </button>
                                                    )}
                                                </div>
                                                {!isAssignEditing ? (
                                                    <p className="mt-3 text-sm font-semibold text-white">
                                                        {selectedLead.assignedAgent?.name || selectedLead.assignedAgentName || "Unassigned"}
                                                    </p>
                                                ) : (
                                                    <div className="mt-3 space-y-2">
                                                        <select
                                                            className="h-10 w-full rounded-lg border border-white/10 bg-[#0d1018] px-3 text-sm font-semibold text-white outline-none transition focus:border-[#842cff] focus:ring-2 focus:ring-[#842cff]/20"
                                                            value={assignmentEmployeeId}
                                                            onChange={(event) => {
                                                                const employeeId = event.target.value;
                                                                setAssignmentEmployeeId(employeeId);
                                                            }}
                                                            disabled={Boolean(activeLeadAction)}
                                                        >
                                                            <option value="" disabled>
                                                                {salesAssignableEmployees.length ? "Select Sales employee" : "No Sales employees available"}
                                                            </option>
                                                            {salesAssignableEmployees.map((employee) => (
                                                                <option key={employee._id} value={employee._id}>
                                                                    {employee.name} ({employee.role || employee.team || "Sales"})
                                                                </option>
                                                            ))}
                                                        </select>
                                                        <p className="text-xs font-medium text-white/35">
                                                            Employees with Sales in their role or department can be assigned.
                                                        </p>
                                                        <div className="flex gap-2">
                                                            <button
                                                                className="h-9 rounded-lg border border-[#576574] bg-[#576574] px-3 text-xs font-semibold text-white transition hover:border-[#3f4b55] hover:bg-[#3f4b55]"
                                                                type="button"
                                                                onClick={cancelAssignmentEdit}
                                                                disabled={saveAssignmentMutation.isPending || Boolean(activeLeadAction)}
                                                            >
                                                                Cancel
                                                            </button>
                                                            <button
                                                                className="h-9 rounded-lg border border-[#10ac84] bg-[#10ac84] px-3 text-xs font-semibold text-white transition hover:border-[#0b8f6e] hover:bg-[#0b8f6e] disabled:cursor-not-allowed disabled:opacity-80"
                                                                type="button"
                                                                onClick={handleSaveAssignment}
                                                                disabled={saveAssignmentMutation.isPending || Boolean(activeLeadAction) || !assignmentEmployeeId}
                                                            >
                                                                {activeLeadAction === "assignment" ? "Saving" : "Save"}
                                                            </button>
                                                        </div>
                                                    </div>
                                                )}
                                            </div>

                                            <div className="grid gap-3">
                                                <div className="rounded-lg border border-white/10 bg-black/10 p-3">
                                                    <p className="text-xs font-medium uppercase tracking-[0.14em] text-white/35">
                                                        Lead Status
                                                    </p>
                                                    <div className="mt-2 grid gap-2 sm:grid-cols-[minmax(0,1fr)_7rem]">
                                                        <select
                                                            className="h-11 w-full min-w-0 rounded-lg border border-white/10 bg-[#0d1018] px-3 text-sm font-semibold text-white outline-none transition focus:border-[#842cff] focus:ring-2 focus:ring-[#842cff]/20"
                                                            value={statusDraft}
                                                            onChange={(event) => setStatusDraft(event.target.value as LeadStatus)}
                                                            disabled={Boolean(activeLeadAction)}
                                                        >
                                                            {Array.from(new Set([...editableLeadStatuses, selectedLead.status])).map((status) => (
                                                                <option key={status} value={status}>
                                                                    {getEditableLeadStatusLabel(status)}
                                                                </option>
                                                            ))}
                                                        </select>
                                                        <button
                                                            className="h-11 rounded-lg border border-[#10ac84] bg-[#10ac84] px-3 text-xs font-semibold text-white transition hover:border-[#0b8f6e] hover:bg-[#0b8f6e] disabled:cursor-not-allowed disabled:opacity-70"
                                                            type="button"
                                                            onClick={handleSaveStatus}
                                                            disabled={updateStatusMutation.isPending || Boolean(activeLeadAction) || !hasStatusUpdate}
                                                        >
                                                            {activeLeadAction === "status" ? "Saving" : shouldClearQualifiedFollowUp ? "Reset" : "Save"}
                                                        </button>
                                                    </div>
                                                </div>

                                                <div className="rounded-lg border border-white/10 bg-black/10 p-3">
                                                    <p className="text-xs font-medium uppercase tracking-[0.14em] text-white/35">
                                                        Follow Up (Eastern Time)
                                                    </p>
                                                    <div className="mt-2 grid gap-2 sm:grid-cols-[minmax(0,1fr)_7rem]">
                                                        <input
                                                            id="lead-follow-up-input"
                                                            className="h-11 min-w-0 rounded-lg border border-white/10 bg-black/20 px-3 text-sm font-semibold text-white outline-none transition focus:border-[#842cff] focus:ring-2 focus:ring-[#842cff]/20"
                                                            type="datetime-local"
                                                            value={isQualifiedStatusDraft ? "" : followUpDateTime}
                                                            min={getCurrentLeadScheduleDateTimeInput()}
                                                            onChange={(event) => setFollowUpDateTime(event.target.value)}
                                                            disabled={isQualifiedStatusDraft || Boolean(activeLeadAction)}
                                                        />
                                                        <button
                                                            className="admin-follow-up-schedule-button flex h-11 min-w-0 items-center justify-center rounded-lg border border-[#ff9f43] bg-[#ff9f43] px-3 text-sm font-semibold text-white transition hover:border-[#e67f1d] hover:bg-[#e67f1d] disabled:cursor-not-allowed disabled:opacity-80"
                                                            type="button"
                                                            onClick={handleScheduleFollowUp}
                                                            disabled={!followUpDateTime || scheduleFollowUpMutation.isPending || isQualifiedStatusDraft || Boolean(activeLeadAction)}
                                                        >
                                                            {activeLeadAction === "schedule" ? "Saving" : "Schedule"}
                                                        </button>
                                                    </div>
                                                    <p className="mt-2 text-xs text-white/45">
                                                        {isQualifiedStatusDraft
                                                            ? shouldClearQualifiedFollowUp
                                                                ? "Save to clear the existing follow-up schedule."
                                                                : "Qualified leads have no follow-up schedule."
                                                            : selectedLead.followUpAt
                                                                ? `Next: ${formatLeadScheduleDateTime(selectedLead.followUpAt)}`
                                                                : "No follow-up scheduled"}
                                                    </p>
                                                </div>
                                            </div>
                                        </div>
                                    </div>

                                    <div className="rounded-lg border border-white/10 bg-white/[0.04] p-4">
                                        <div className="flex flex-wrap items-center justify-between gap-3">
                                            <div>
                                                <p className="text-xs font-medium uppercase tracking-[0.14em] text-white/35">Comments</p>
                                                <p className="mt-1 text-xs text-white/45">Internal lead notes</p>
                                            </div>
                                        </div>
                                        <div className="mt-3 grid gap-3">
                                            {selectedLead.notes && (
                                                <div className="rounded-lg border border-white/10 bg-black/20 p-3">
                                                    <p className="text-xs font-semibold uppercase tracking-[0.12em] text-white/35">Original notes</p>
                                                    <p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-white/70">{selectedLead.notes}</p>
                                                </div>
                                            )}
                                            {(selectedLead.comments || []).map((comment) => (
                                                <article key={comment._id || `${comment.createdAt}-${comment.body}`} className="rounded-lg border border-white/10 bg-black/20 p-3">
                                                    <div className="flex flex-wrap items-center justify-between gap-2">
                                                        <p className="text-sm font-semibold text-white">{comment.authorName || "Admin"}</p>
                                                        <p className="text-xs text-white/35">
                                                            {comment.createdAt ? formatPhDateTime(comment.createdAt) : ""}
                                                        </p>
                                                    </div>
                                                    <p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-white/65">{comment.body}</p>
                                                </article>
                                            ))}
                                            {!selectedLead.notes && (selectedLead.comments || []).length === 0 && (
                                                <p className="text-sm text-white/45">No comments yet.</p>
                                            )}
                                        </div>
                                        <textarea
                                            className="mt-4 min-h-24 w-full resize-y rounded-lg border border-white/10 bg-black/20 p-3 text-sm leading-6 text-white outline-none transition placeholder:text-white/30 focus:border-[#842cff] focus:ring-2 focus:ring-[#842cff]/20"
                                            value={commentDraft}
                                            onChange={(event) => setCommentDraft(event.target.value)}
                                            onKeyDown={(event) => {
                                                if (event.ctrlKey && event.key === "Enter") {
                                                    event.preventDefault();
                                                    handleSaveComment();
                                                }
                                            }}
                                            placeholder="Add a new note..."
                                            disabled={addCommentMutation.isPending || Boolean(activeLeadAction)}
                                        />
                                        <div className="mt-3 flex justify-end">
                                            <button
                                                className="flex h-9 items-center gap-2 rounded-lg border border-[#2e86de] bg-[#2e86de] px-3 text-xs font-semibold text-white transition hover:border-[#1f6fbf] hover:bg-[#1f6fbf] disabled:cursor-not-allowed disabled:opacity-80"
                                                type="button"
                                                onClick={handleSaveComment}
                                                disabled={!selectedLead || addCommentMutation.isPending || Boolean(activeLeadAction) || !commentDraft.trim()}
                                            >
                                                <FiSave className="size-3.5" aria-hidden="true" />
                                                {addCommentMutation.isPending ? "Saving..." : "Add Note"}
                                            </button>
                                        </div>
                                    </div>

                                    <div className="grid gap-2.5 sm:grid-cols-2 xl:grid-cols-3">
                                        {[
                                            ["Lead Source", selectedLead.source],
                                            ["Created By", selectedLead.createdByName || "System"],
                                            ["Filter", selectedLead.category || "All"],
                                            ["AI Score", selectedLead.aiScore ? `${selectedLead.aiScore}/100` : "Not scored"],
                                            ["AI Reason", selectedLead.aiScoreReason || "No score yet"],
                                            ["Follow Up", selectedLead.status !== "Qualified" && selectedLead.followUpAt ? formatLeadScheduleDateTime(selectedLead.followUpAt) : "None"],
                                            ["Status", selectedLead.status],
                                            ["Current Agent", getCurrentLeadAgent(selectedLead)],
                                            ["Previous Agent", getPreviousLeadAgent(selectedLead)],
                                            ["Team", selectedLead.assignedTeam?.name || "Unassigned"],
                                            ["Website", selectedLead.website || "No website"],
                                            ["Place ID", selectedLead.googlePlaceId || "Manual"],
                                            ["Next Process", selectedLead.status],
                                        ].map(([label, value]) => (
                                            <div key={label} className="rounded-lg border border-white/10 bg-white/[0.04] px-3.5 py-3">
                                                <p className="text-[0.68rem] font-medium uppercase tracking-[0.12em] text-white/35">
                                                    {label}
                                                </p>
                                                <p className="mt-1.5 truncate text-sm font-semibold text-white">{value}</p>
                                            </div>
                                        ))}
                                    </div>
                                </div>

                                <aside className="flex min-h-0">
                                    <div className="flex max-h-full min-h-[24rem] w-full flex-col rounded-lg border border-slate-300 bg-white/75 p-4 xl:sticky xl:top-0">
                                        <p className="text-xs font-medium uppercase tracking-[0.14em] !text-slate-600">Activity</p>
                                        <div className="mt-4 flex-1 space-y-5 overflow-y-auto pr-1">
                                            {leadActivity.map((item, index) => (
                                                <div key={`${item.label}-${item.createdAt || index}`} className="flex gap-3">
                                                    <span
                                                        className={[
                                                            "mt-1 size-2 shrink-0 rounded-full",
                                                            item.status === "Current"
                                                                ? "bg-[#842cff]"
                                                                : item.status === "Priority" || item.status === "High"
                                                                    ? "bg-[#fbbf24]"
                                                                    : "bg-slate-400",
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
                                                        {item.action && (
                                                            <button
                                                                className={[
                                                                    "mt-2 h-8 rounded-lg border px-3 text-xs font-semibold text-white transition disabled:cursor-not-allowed disabled:opacity-80",
                                                                    item.action === "assign"
                                                                        ? "border-[#10ac84] bg-[#10ac84] hover:border-[#0b8f6e] hover:bg-[#0b8f6e]"
                                                                        : item.action === "score"
                                                                            ? "border-[#00d2d3] bg-[#00d2d3] hover:border-[#01a3a4] hover:bg-[#01a3a4]"
                                                                            : "border-[#ff9f43] bg-[#ff9f43] hover:border-[#e67f1d] hover:bg-[#e67f1d]",
                                                                ].join(" ")}
                                                                type="button"
                                                                onClick={() => handleActivityAction(item.action)}
                                                                disabled={
                                                                    (item.action === "assign" && autoAssignLeadMutation.isPending) ||
                                                                    (item.action === "score" && scoreLeadsMutation.isPending)
                                                                }
                                                            >
                                                                {item.action === "assign"
                                                                    ? autoAssignLeadMutation.isPending
                                                                        ? "Assigning"
                                                                        : "Auto assign"
                                                                    : item.action === "score"
                                                                        ? scoreLeadsMutation.isPending
                                                                            ? "Scoring"
                                                                            : "Rescore"
                                                                        : "Schedule follow-up"}
                                                            </button>
                                                        )}
                                                    </div>
                                                </div>
                                            ))}
                                        </div>
                                    </div>
                                </aside>
                            </div>
                        ) : (
                            <div className="p-6 text-sm text-white/45">Select a lead to view details.</div>
                        )}
                    </section>
                </div>
            </section>

            {isPlacesOpen && (
                <div
                    className="modal-backdrop-enter fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4 backdrop-blur-sm"
                    onMouseDown={(event) => {
                        if (event.target === event.currentTarget) {
                            setIsPlacesOpen(false);
                        }
                    }}
                >
                    <section className="modal-panel-enter flex max-h-[88vh] w-full max-w-[50rem] flex-col rounded-lg border border-white/10 bg-[#0d1018] shadow-2xl shadow-black/40">
                        <div className="flex items-center justify-between border-b border-white/10 px-5 py-3.5">
                            <div>
                                <h3 className="text-base font-semibold text-white">Business search</h3>
                                <p className="mt-1 text-sm text-white/45">Find call-ready businesses and save unique leads.</p>
                            </div>
                            <button
                                className="flex size-8 items-center justify-center rounded-lg border border-white/10 bg-white/[0.06] text-white/70 transition hover:bg-white/10 hover:text-white"
                                type="button"
                                aria-label="Close places modal"
                                onClick={() => setIsPlacesOpen(false)}
                            >
                                <FiX className="size-4" aria-hidden="true" />
                            </button>
                        </div>

                        <form className="grid gap-3 border-b border-white/10 p-4" onSubmit={handlePlacesSearch}>
                            <div className={`grid min-h-[6.5rem] gap-3 rounded-lg border p-3 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] md:items-center ${isTomTomUnavailable ? "border-red-400/30 bg-red-400/10" : isTomTomBudgetInsufficient ? "border-amber-400/35 bg-amber-400/10" : "border-sky-400/25 bg-sky-400/10"}`}>
                                <div className="min-w-0">
                                    <div className="flex min-h-6 flex-wrap items-center gap-2">
                                        <span className="text-xs font-semibold uppercase tracking-[0.14em] text-sky-200">TomTom free requests this month</span>
                                        {tomTomUsageQuery.data?.evaluationMode && (
                                            <span className="rounded-md border border-amber-300/25 bg-amber-300/10 px-2 py-0.5 text-[0.68rem] font-semibold text-amber-100">Free-tier guard</span>
                                        )}
                                    </div>
                                    <p className="mt-1 min-h-5 text-sm font-semibold tabular-nums text-white">
                                        {tomTomUsageQuery.isLoading
                                            ? "Checking allowance..."
                                            : tomTomUsageQuery.data
                                                ? `${tomTomUsageQuery.data.remaining.toLocaleString()} lead-search requests remaining`
                                                : "Usage unavailable"}
                                    </p>
                                    <p className="mt-1 break-words text-xs leading-5 text-white/45">
                                        {tomTomUsageQuery.isError
                                            ? isTomTomAuthorizationError
                                                ? "This admin session could not be verified. Retry after signing in again."
                                                : "Usage check was interrupted. Retrying automatically; searches resume after it reconnects."
                                            : isTomTomUnavailable
                                            ? "Add TOMTOM_API_KEY to backend/.env before searching."
                                            : tomTomUsageQuery.data
                                                ? `Discover: ${tomTomUsageQuery.data.products.discover.remaining.toLocaleString()} / Search: ${tomTomUsageQuery.data.products.search.remaining.toLocaleString()} / Suggest: ${tomTomUsageQuery.data.products.suggest.remaining.toLocaleString()} / Details: ${tomTomUsageQuery.data.products.details.remaining.toLocaleString()} / Geocoding: ${tomTomUsageQuery.data.products.geocoding.remaining.toLocaleString()}.`
                                                : "Hard free-tier caps reset monthly in UTC; paid overage is blocked."}
                                    </p>
                                    {tomTomUsageQuery.isError && (
                                        <button
                                            className="mt-2 inline-flex h-8 items-center gap-2 rounded-lg border border-red-300/25 bg-red-300/10 px-3 text-xs font-semibold text-red-100 transition hover:bg-red-300/15 disabled:cursor-wait disabled:opacity-60"
                                            type="button"
                                            disabled={tomTomUsageQuery.isFetching}
                                            onClick={() => void tomTomUsageQuery.refetch()}
                                        >
                                            <FiRefreshCw className={`size-3.5 ${tomTomUsageQuery.isFetching ? "animate-spin" : ""}`} aria-hidden="true" />
                                            {tomTomUsageQuery.isFetching ? "Reconnecting..." : "Retry now"}
                                        </button>
                                    )}
                                </div>
                                <div className="min-w-0 text-left md:text-right">
                                    <p className="text-xs uppercase tracking-[0.14em] text-white/35">Next search estimate</p>
                                    <p className="mt-1 min-h-5 break-words text-sm font-semibold leading-5 tabular-nums text-white">
                                        Filter: up to {tomTomManualEstimatedRequests} business search{placesLocation ? " + 1 Geocoding" : ""} / Best leads: up to {tomTomAutoEstimatedRequests} business search{placesLocation ? " + 1 Geocoding" : ""}
                                    </p>
                                </div>
                                <p className={`min-h-5 text-xs font-semibold sm:col-span-2 ${isTomTomBudgetInsufficient ? "text-amber-200" : "text-transparent"}`} aria-live="polite">
                                    {isTomTomBudgetInsufficient
                                        ? isTomTomGeocodingBudgetInsufficient
                                            ? "The monthly Geocoding allowance is exhausted. Wait for the UTC monthly reset."
                                            : `Only ${tomTomRemainingRequests?.toLocaleString()} lead-search requests remain across the free TomTom pools. Select a smaller target or wait for the UTC monthly reset.`
                                        : "\u00a0"}
                                </p>
                            </div>

                            <div className="rounded-lg border border-[#842cff]/20 bg-[#842cff]/10 p-3">
                                <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_12rem_minmax(10rem,auto)]">
                                    <label>
                                        <span className="text-xs font-medium uppercase tracking-[0.14em] text-white/35">Product</span>
                                        <input
                                            className="mt-2 h-10 w-full rounded-lg border border-white/10 bg-black/20 px-3 text-sm font-semibold text-white outline-none transition placeholder:text-white/30 focus:border-[#842cff] focus:ring-2 focus:ring-[#842cff]/20"
                                            value={placesProduct}
                                            onChange={(event) => setPlacesProduct(event.target.value)}
                                            placeholder="Enter a product or business type"
                                        />
                                    </label>
                                    <label>
                                        <span className="text-xs font-medium uppercase tracking-[0.14em] text-white/35">Lead target</span>
                                        <select
                                            className="mt-2 h-10 w-full rounded-lg border border-white/10 bg-black/20 px-3 text-sm font-semibold text-white outline-none transition focus:border-[#842cff] focus:ring-2 focus:ring-[#842cff]/20"
                                            value={placesTargetLeads}
                                            onChange={(event) => setPlacesTargetLeads(event.target.value)}
                                        >
                                            <option value="250">250 leads</option>
                                            <option value="500">500 leads</option>
                                            <option value="1000">1,000 leads</option>
                                            <option value="1500">1,500 leads</option>
                                            <option value="all">All matching leads</option>
                                        </select>
                                    </label>
                                    <button
                                        className="mt-6 flex min-h-10 min-w-0 items-center justify-center gap-2 rounded-lg border border-[#842cff]/40 bg-[#842cff]/25 px-3 py-2 text-center text-sm font-semibold leading-5 text-white transition hover:bg-[#842cff]/35 disabled:cursor-not-allowed disabled:opacity-60"
                                        type="button"
                                        disabled={autoSearchPlacesMutation.isPending || searchAndImportPlacesMutation.isPending || isTomTomSearchBlocked}
                                        onClick={handleAutoPlacesSearch}
                                    >
                                        <FiZap className="size-4" aria-hidden="true" />
                                        {autoSearchPlacesMutation.isPending
                                            ? isAllMatchingLeadsTarget
                                                ? "Finding all matching leads..."
                                                : `Finding ${targetLeadCount.toLocaleString()} leads...`
                                            : isAllMatchingLeadsTarget
                                                ? "Find all matching leads"
                                                : `Find ${targetLeadCount.toLocaleString()} leads`}
                                    </button>
                                </div>
                                <p className="mt-2 text-xs leading-5 text-white/45">
                                    Auto-search strictly checks each TomTom name and category against your product before saving, removes duplicates, and ranks likely buyers.
                                </p>
                            </div>

                            <div className="flex flex-col gap-3 md:flex-row">
                                <label className="flex h-11 min-w-0 flex-1 items-center gap-3 rounded-lg border border-white/10 bg-black/20 px-3 text-white/45 focus-within:border-[#842cff] focus-within:ring-2 focus-within:ring-[#842cff]/20">
                                    <FiSearch className="size-4 shrink-0" aria-hidden="true" />
                                    <input
                                        className="h-full min-w-0 flex-1 bg-transparent text-sm font-semibold text-white outline-none placeholder:text-white/30"
                                        value={placesQuery}
                                        onChange={(event) => setPlacesQuery(event.target.value)}
                                        placeholder="Movie theaters, malls, arcades..."
                                    />
                                </label>
                                <button
                                    className="flex h-11 items-center justify-center gap-2 rounded-lg bg-[linear-gradient(135deg,#842cff,#4a0ebd)] px-4 text-sm font-semibold text-white transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-60"
                                    type="submit"
                                    disabled={searchAndImportPlacesMutation.isPending || autoSearchPlacesMutation.isPending || isTomTomSearchBlocked}
                                >
                                    <FiMapPin className="size-4" aria-hidden="true" />
                                    {searchAndImportPlacesMutation.isPending
                                        ? "Saving matches..."
                                        : isAllMatchingLeadsTarget
                                            ? "Save all matches"
                                            : `Save up to ${targetLeadCount.toLocaleString()}`}
                                </button>
                            </div>

                            <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,0.75fr)_8rem]">
                                <label>
                                    <span className="text-xs font-medium uppercase tracking-[0.14em] text-white/35">City</span>
                                    <input
                                        className="mt-2 h-10 w-full rounded-lg border border-white/10 bg-black/20 px-3 text-sm font-semibold text-white outline-none transition placeholder:text-white/30 focus:border-[#842cff] focus:ring-2 focus:ring-[#842cff]/20"
                                        value={placesCity}
                                        onChange={(event) => setPlacesCity(event.target.value)}
                                        placeholder="Austin"
                                    />
                                </label>
                                <label>
                                    <span className="text-xs font-medium uppercase tracking-[0.14em] text-white/35">State</span>
                                    <input
                                        className="mt-2 h-10 w-full rounded-lg border border-white/10 bg-black/20 px-3 text-sm font-semibold text-white outline-none transition placeholder:text-white/30 focus:border-[#842cff] focus:ring-2 focus:ring-[#842cff]/20"
                                        value={placesState}
                                        onChange={(event) => setPlacesState(event.target.value)}
                                        placeholder="TX"
                                    />
                                </label>
                                <label>
                                    <span className="text-xs font-medium uppercase tracking-[0.14em] text-white/35">Radius</span>
                                    <div className="mt-2 flex h-10 rounded-lg border border-white/10 bg-black/20 focus-within:border-[#842cff] focus-within:ring-2 focus-within:ring-[#842cff]/20">
                                        <input
                                            className="min-w-0 flex-1 bg-transparent px-3 text-sm font-semibold text-white outline-none placeholder:text-white/30"
                                            type="number"
                                            min="1"
                                            max="50"
                                            step="1"
                                            value={placesRadiusMiles}
                                            onChange={(event) => setPlacesRadiusMiles(event.target.value)}
                                            placeholder="50"
                                        />
                                        <span className="flex items-center border-l border-white/10 px-3 text-xs font-semibold text-white/40">mi</span>
                                    </div>
                                    <p className="mt-1 text-[0.68rem] text-white/35">Max 50 mi</p>
                                </label>
                            </div>
                        </form>

                        <div className="content-scroll overflow-y-auto overflow-x-hidden p-4">
                            {(searchAndImportPlacesMutation.isError || autoSearchPlacesMutation.isError) && (
                                <p className="text-sm text-red-200">
                                    {placesErrorMessage || "TomTom search failed. Check TOMTOM_API_KEY in backend/.env."}
                                </p>
                            )}
                            {placesRejectedIrrelevantCount > 0 && (
                                <div className="mb-3 flex items-start gap-3 rounded-lg border border-sky-300/20 bg-sky-300/10 p-3">
                                    <FiShield className="mt-0.5 size-4 shrink-0 text-white/65" aria-hidden="true" />
                                    <p className="text-sm leading-5 text-white/70">
                                        Excluded {placesRejectedIrrelevantCount.toLocaleString()} unrelated TomTom result{placesRejectedIrrelevantCount === 1 ? "" : "s"} before saving.
                                    </p>
                                </div>
                            )}
                            {autoSearchLocations.length > 0 && (
                                <div className="mb-3 rounded-lg border border-white/10 bg-white/[0.035] p-3">
                                    <p className="text-xs font-semibold uppercase tracking-[0.14em] text-white/35">Nearby areas searched</p>
                                    <div className="mt-2 flex flex-wrap gap-2">
                                        {autoSearchLocations.map((location) => (
                                            <span key={location} className="rounded-md bg-[#10ac84]/15 px-2 py-1 text-xs font-semibold !text-black">
                                                {location}
                                            </span>
                                        ))}
                                    </div>
                                </div>
                            )}
                            {placeResults.length === 0 && !searchAndImportPlacesMutation.isError && !autoSearchPlacesMutation.isError && (
                                <p className="text-sm text-white/45">
                                    Search results will appear here and save to leads automatically.
                                </p>
                            )}
                            <div className="grid gap-3">
                                {placeResults.map((place) => (
                                    <article
                                        key={place.providerPlaceId || place.googlePlaceId || `${place.businessName}-${place.businessAddress}`}
                                        className="rounded-lg border border-white/10 bg-white/[0.04] p-4"
                                    >
                                        <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-start">
                                            <div className="min-w-0">
                                                <h4 className="truncate text-sm font-semibold text-white">{place.businessName}</h4>
                                                <p className="mt-1 text-xs leading-5 text-white/45">{place.businessAddress || "No address"}</p>
                                            </div>
                                            <span className="flex h-9 shrink-0 items-center justify-center gap-2 rounded-lg border border-[#10ac84] bg-[#10ac84] px-3 text-xs font-semibold text-white shadow-sm shadow-[#10ac84]/20">
                                                <FiPlus className="size-3.5" aria-hidden="true" />
                                                Saved
                                            </span>
                                        </div>
                                         <div className="mt-3 flex flex-wrap gap-3 text-xs text-white/45">
                                            {place.providerCategory && <span>{place.providerCategory}</span>}
                                            {place.matchedQuery && <span>Matched: {place.matchedQuery}</span>}
                                            {place.relevanceScore !== undefined && <span>{place.relevanceScore}% relevance</span>}
                                             {place.phone && <span>{place.phone}</span>}
                                            {place.website && (
                                                <a
                                                    className="flex items-center gap-1 transition hover:text-white"
                                                    href={place.website}
                                                    target="_blank"
                                                    rel="noreferrer"
                                                >
                                                    Website
                                                    <FiExternalLink className="size-3" aria-hidden="true" />
                                                </a>
                                            )}
                                        </div>
                                    </article>
                                ))}
                            </div>
                            {placeResults.length > 0 && (
                                <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-white/10 pt-4">
                                    <p className="text-xs text-white/45">Saved {placeResults.length} result{placeResults.length === 1 ? "" : "s"} to leads</p>
                                    <p className="text-xs text-white/35">Strict name, category, phone, and location checks were applied.</p>
                                </div>
                            )}
                        </div>
                    </section>
                </div>
            )}

            {verificationAction && (
                <div
                    className="modal-backdrop-enter fixed inset-0 z-[60] flex items-center justify-center bg-black/70 px-4 backdrop-blur-sm"
                    onMouseDown={(event) => {
                        if (event.target === event.currentTarget) {
                            closeActionVerification();
                        }
                    }}
                >
                    <form
                        className="modal-panel-enter w-full max-w-[34rem] overflow-hidden rounded-lg border border-sky-300/20 bg-[#0d1018] shadow-2xl shadow-black/50"
                        onSubmit={(event) => {
                            event.preventDefault();
                            void confirmVerifiedAction();
                        }}
                    >
                        <div className="border-b border-white/10 bg-sky-400/[0.08] px-5 py-4">
                            <div className="flex items-start justify-between gap-4">
                                <div className="flex min-w-0 items-start gap-3">
                                    <span className="flex size-11 shrink-0 items-center justify-center rounded-lg border border-sky-300/20 bg-sky-400/10 text-sky-100">
                                        <FiShield className="size-5" aria-hidden="true" />
                                    </span>
                                    <div className="min-w-0">
                                        <p className="text-xs font-medium uppercase tracking-[0.14em] text-white/55">Verification required</p>
                                        <h3 className="mt-1 text-lg font-semibold text-white">
                                            {verificationAction.kind === "reassign-new" ? "Verify lead reassignment" : "Verify business search"}
                                        </h3>
                                        <p className="mt-1 text-sm leading-5 text-white/55">
                                            Review the details below before this action is sent to the server.
                                        </p>
                                    </div>
                                </div>
                                <button
                                    className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-white/10 bg-black/20 text-white/60 transition hover:bg-white/10 hover:text-white disabled:cursor-wait disabled:opacity-50"
                                    type="button"
                                    onClick={closeActionVerification}
                                    disabled={isVerificationChecking}
                                    aria-label="Close verification"
                                >
                                    <FiX className="size-4" aria-hidden="true" />
                                </button>
                            </div>
                        </div>

                        <div className="grid gap-3 p-5">
                            {verificationAction.kind === "reassign-new" ? (
                                <>
                                    <div className="grid gap-3 sm:grid-cols-2">
                                        <div className="rounded-lg border border-white/10 bg-white/[0.035] p-4">
                                            <p className="text-xs font-semibold uppercase tracking-[0.14em] text-white/35">New leads</p>
                                            <p className="mt-2 text-xl font-semibold tabular-nums text-white">{verificationAction.leadCount.toLocaleString()}</p>
                                        </div>
                                        <div className="rounded-lg border border-white/10 bg-white/[0.035] p-4">
                                            <p className="text-xs font-semibold uppercase tracking-[0.14em] text-white/35">Action</p>
                                            <p className="mt-2 text-sm font-semibold text-white">Reassign all NEW leads</p>
                                        </div>
                                    </div>
                                    <p className="rounded-lg border border-amber-300/20 bg-amber-300/10 p-3 text-sm leading-6 text-white/70">
                                        Current assignments for every NEW lead will be replaced using the active auto-assignment rules.
                                    </p>
                                </>
                            ) : (
                                <>
                                    <div className="grid gap-3 sm:grid-cols-2">
                                        <div className="rounded-lg border border-white/10 bg-white/[0.035] p-4">
                                            <p className="text-xs font-semibold uppercase tracking-[0.14em] text-white/35">
                                                {verificationAction.kind === "tomtom-auto" ? "Product" : "Business type"}
                                            </p>
                                            <p className="mt-2 break-words text-sm font-semibold text-white">
                                                {verificationAction.kind === "tomtom-auto" ? verificationAction.input.product : verificationAction.input.category}
                                            </p>
                                            <p className="mt-1 break-words text-xs text-white/45">{verificationAction.input.location || "No city or state filter"}</p>
                                        </div>
                                        <div className="rounded-lg border border-white/10 bg-white/[0.035] p-4">
                                            <p className="text-xs font-semibold uppercase tracking-[0.14em] text-white/35">Maximum impact</p>
                                            <p className="mt-2 text-sm font-semibold tabular-nums text-white">
                                                Up to {(verificationAction.input.maxRequests || 0).toLocaleString()} requests
                                            </p>
                                            <p className="mt-1 text-xs tabular-nums text-white/45">
                                                {verificationAction.input.maxResults === 10000
                                                    ? "All matching leads"
                                                    : `Up to ${(verificationAction.input.maxResults || 0).toLocaleString()} leads`}
                                            </p>
                                        </div>
                                    </div>
                                    <p className="rounded-lg border border-sky-300/20 bg-sky-300/10 p-3 text-sm leading-6 text-white/70">
                                        The remaining TomTom allowance will be checked again before the search begins. Duplicate leads will not be added again.
                                    </p>
                                </>
                            )}

                            <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-white/10 bg-black/20 p-3">
                                <input
                                    className="mt-0.5 size-4 shrink-0 accent-[#2e86de]"
                                    type="checkbox"
                                    checked={isVerificationAcknowledged}
                                    onChange={(event) => {
                                        setIsVerificationAcknowledged(event.target.checked);
                                        setVerificationError("");
                                    }}
                                    disabled={isVerificationChecking}
                                />
                                <span className="text-sm leading-5 text-white/70">
                                    I verified these details and understand the action will update CRM data.
                                </span>
                            </label>

                            {verificationError && (
                                <p className="rounded-lg border border-red-300/20 bg-red-300/10 p-3 text-sm leading-5 text-red-100" role="alert">
                                    {verificationError}
                                </p>
                            )}
                        </div>

                        <div className="flex justify-end gap-2 border-t border-white/10 px-5 py-3.5">
                            <button
                                className="h-10 rounded-lg border border-white/10 bg-white/[0.05] px-4 text-sm font-semibold text-white/60 transition hover:bg-white/10 hover:text-white disabled:cursor-wait disabled:opacity-50"
                                type="button"
                                onClick={closeActionVerification}
                                disabled={isVerificationChecking}
                            >
                                Cancel
                            </button>
                            <button
                                className="flex h-10 items-center gap-2 rounded-lg bg-[#2e86de] px-4 text-sm font-semibold text-white transition hover:bg-[#1f6fbf] disabled:cursor-not-allowed disabled:opacity-50"
                                type="submit"
                                disabled={!isVerificationAcknowledged || isVerificationChecking}
                            >
                                <FiCheckCircle className={`size-4 ${isVerificationChecking ? "animate-pulse" : ""}`} aria-hidden="true" />
                                {isVerificationChecking
                                    ? "Verifying..."
                                    : verificationAction.kind === "reassign-new"
                                        ? "Verify and reassign"
                                        : "Verify and search"}
                            </button>
                        </div>
                    </form>
                </div>
            )}

            {isLeadModalOpen && (
                <div
                    className="modal-backdrop-enter fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4 backdrop-blur-sm"
                    onMouseDown={(event) => {
                        if (event.target === event.currentTarget) {
                            closeLeadModal();
                        }
                    }}
                >
                    <form
                        className="modal-panel-enter flex max-h-[88vh] w-full max-w-[34rem] flex-col rounded-lg border border-white/10 bg-[#0d1018] shadow-2xl shadow-black/40"
                        onSubmit={handleSaveLead}
                        onMouseDown={(event) => event.stopPropagation()}
                    >
                        <div className="flex items-center justify-between border-b border-white/10 px-5 py-3.5">
                            <div>
                                <h3 className="text-base font-semibold text-white">Add Lead</h3>
                                <p className="mt-1 text-sm text-white/45">Create a lead manually.</p>
                            </div>
                            <button
                                className="flex size-8 items-center justify-center rounded-lg border border-white/10 bg-white/[0.06] text-white/70 transition hover:bg-white/10 hover:text-white"
                                type="button"
                                aria-label="Close lead modal"
                                onClick={closeLeadModal}
                            >
                                <FiX className="size-4" aria-hidden="true" />
                            </button>
                        </div>

                        <div className="content-scroll grid gap-4 overflow-y-auto p-5 sm:grid-cols-2">
                            {[
                                ["Business Name", "businessName", "Acme Corp"],
                                ["Lead Name", "leadName", "Jane Doe"],
                                ["Position", "position", "Operations Manager"],
                                ["Phone", "phone", "+1 (415) 555-0101"],
                                ["Email", "email", "lead@company.com"],
                                ["Website", "website", "https://company.com"],
                            ].map(([label, key, placeholder]) => (
                                <label key={key}>
                                    <span className="text-xs font-medium uppercase tracking-[0.14em] text-white/35">{label}</span>
                                    <input
                                        className="mt-2 h-11 w-full rounded-lg border border-white/10 bg-black/20 px-3 text-sm font-semibold text-white outline-none transition placeholder:text-white/30 focus:border-[#842cff] focus:ring-2 focus:ring-[#842cff]/20"
                                        value={String(leadForm[key as keyof LeadInput] || "")}
                                        onChange={(event) => setLeadForm((lead) => ({ ...lead, [key]: event.target.value }))}
                                        placeholder={placeholder}
                                    />
                                </label>
                            ))}

                            <label className="sm:col-span-2">
                                <span className="text-xs font-medium uppercase tracking-[0.14em] text-white/35">Business Address</span>
                                <input
                                    className="mt-2 h-11 w-full rounded-lg border border-white/10 bg-black/20 px-3 text-sm font-semibold text-white outline-none transition placeholder:text-white/30 focus:border-[#842cff] focus:ring-2 focus:ring-[#842cff]/20"
                                    value={leadForm.businessAddress}
                                    onChange={(event) => setLeadForm((lead) => ({ ...lead, businessAddress: event.target.value }))}
                                    placeholder="Business address"
                                />
                            </label>

                            <label className="sm:col-span-2">
                                <span className="text-xs font-medium uppercase tracking-[0.14em] text-white/35">Status</span>
                                <div className="mt-2 grid gap-2 sm:grid-cols-3">
                                    {tabs.filter((tab): tab is LeadStatus => tab !== "ALL" && tab !== "Archived").map((status) => (
                                        <button
                                            key={status}
                                            className={[
                                                "h-10 rounded-lg border px-3 text-xs font-semibold transition",
                                                leadForm.status === status
                                                    ? "border-[#842cff] bg-[#842cff]/20 text-black"
                                                    : "border-white/10 bg-black/20 text-black hover:bg-white/[0.06] hover:text-black",
                                            ].join(" ")}
                                            type="button"
                                            onClick={() => setLeadForm((lead) => ({ ...lead, status }))}
                                        >
                                            {status}
                                        </button>
                                    ))}
                                </div>
                            </label>
                        </div>

                        <div className="flex justify-end gap-3 border-t border-white/10 px-5 py-3.5">
                            <button
                                className="h-10 rounded-lg border border-white/10 bg-white/[0.06] px-4 text-sm font-semibold text-white/70 transition hover:bg-white/10 hover:text-white"
                                type="button"
                                onClick={closeLeadModal}
                                disabled={createLeadMutation.isPending}
                            >
                                Cancel
                            </button>
                            <button
                                className="flex h-10 items-center gap-2 rounded-lg bg-[linear-gradient(135deg,#842cff,#4a0ebd)] px-4 text-sm font-semibold text-white transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-70"
                                type="submit"
                                disabled={createLeadMutation.isPending}
                            >
                                <FiPlus className="size-4" aria-hidden="true" />
                                {createLeadMutation.isPending ? "Adding..." : "Add Lead"}
                            </button>
                        </div>
                    </form>
                </div>
            )}

            {deleteTarget && (
                <div
                    className="modal-backdrop-enter fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4 backdrop-blur-sm"
                    onMouseDown={(event) => {
                        if (event.target === event.currentTarget && !activeLeadAction) {
                            closeDeletePrompt();
                        }
                    }}
                >
                    <div className="modal-panel-enter w-full max-w-[32rem] overflow-hidden rounded-lg border border-red-400/20 bg-[#0d1018] shadow-2xl shadow-red-950/30">
                        <div className="bg-[radial-gradient(circle_at_15%_20%,rgba(239,68,68,0.22),transparent_35%),linear-gradient(135deg,rgba(239,68,68,0.12),rgba(132,44,255,0.08))] px-5 py-4">
                            <div className="flex items-start justify-between gap-4">
                                <div className="flex items-start gap-3">
                                    <span className="flex size-11 shrink-0 items-center justify-center rounded-lg border border-red-300/20 bg-red-500/15 text-red-100">
                                        <FiAlertTriangle className="size-5" aria-hidden="true" />
                                    </span>
                                    <div>
                                        <p className="text-xs font-medium uppercase tracking-[0.14em] text-red-100/55">
                                            {deleteTarget.status === "Archived" ? "Delete Lead" : "Archive Lead"}
                                        </p>
                                        <h3 className="mt-1 text-lg font-semibold text-white">
                                            Are you sure?
                                        </h3>
                                        <p className="mt-1 text-sm text-red-50/60">
                                            {deleteTarget.status === "Archived"
                                                ? "This will permanently delete this archived lead."
                                                : "This will move the lead to the Archived tab."}
                                        </p>
                                    </div>
                                </div>
                                <button className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-white/10 bg-black/20 text-white/60 transition hover:bg-white/10 hover:text-white disabled:cursor-not-allowed disabled:opacity-60" type="button" onClick={closeDeletePrompt} disabled={Boolean(activeLeadAction)} aria-label="Close delete confirmation">
                                    <FiX className="size-4" aria-hidden="true" />
                                </button>
                            </div>
                        </div>
                        <div className="p-5">
                            <div className="rounded-lg border border-white/10 bg-white/[0.035] p-4">
                                <p className="text-xs font-semibold uppercase tracking-[0.14em] text-white/35">Selected Lead</p>
                                <p className="mt-2 text-sm font-semibold text-white">{deleteTarget.leadName || deleteTarget.businessName}</p>
                                <p className="mt-1 text-xs text-white/45">{deleteTarget.businessName}</p>
                            </div>
                            <div className="mt-3 rounded-lg border border-yellow-300/20 bg-yellow-300/10 p-3">
                                <p className="text-sm leading-6 text-yellow-50/75">
                                    Are you sure you want to {deleteTarget.status === "Archived" ? "permanently delete" : "archive"} {deleteTarget.leadName || deleteTarget.businessName}?
                                </p>
                            </div>
                        </div>
                        <div className="flex justify-end gap-2 border-t border-white/10 px-5 py-3">
                            <button className="h-10 rounded-lg border border-white/10 bg-white/[0.05] px-4 text-sm font-semibold text-white/60 transition hover:bg-white/10 hover:text-white disabled:cursor-not-allowed disabled:opacity-60" type="button" onClick={closeDeletePrompt} disabled={Boolean(activeLeadAction)}>Cancel</button>
                            <button
                                className="h-10 rounded-lg bg-red-500 px-4 text-sm font-semibold text-white transition hover:bg-red-400 disabled:opacity-60"
                                type="button"
                                onClick={confirmDelete}
                                disabled={archiveLeadMutation.isPending || permanentlyDeleteLeadMutation.isPending || Boolean(activeLeadAction)}
                            >
                                {deleteTarget.status === "Archived"
                                    ? "Delete Permanently"
                                    : activeLeadAction === "archive"
                                        ? "Saving note & archiving..."
                                        : "Archive Lead"}
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {bulkAction && (
                <div
                    className="modal-backdrop-enter fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4 backdrop-blur-sm"
                    onMouseDown={(event) => {
                        if (event.target === event.currentTarget) {
                            closeBulkPrompt();
                        }
                    }}
                >
                    <div className="modal-panel-enter w-full max-w-[32rem] overflow-hidden rounded-lg border border-red-400/20 bg-[#0d1018] shadow-2xl shadow-red-950/30">
                        <div className="bg-[radial-gradient(circle_at_15%_20%,rgba(239,68,68,0.22),transparent_35%),linear-gradient(135deg,rgba(239,68,68,0.12),rgba(132,44,255,0.08))] px-5 py-4">
                            <div className="flex items-start justify-between gap-4">
                                <div className="flex items-start gap-3">
                                    <span className="flex size-11 shrink-0 items-center justify-center rounded-lg border border-red-300/20 bg-red-500/15 text-red-100">
                                        <FiAlertTriangle className="size-5" aria-hidden="true" />
                                    </span>
                                    <div>
                                        <p className="text-xs font-medium uppercase tracking-[0.14em] text-red-100/55">Bulk Leads</p>
                                        <h3 className="mt-1 text-lg font-semibold text-white">Are you sure?</h3>
                                        <p className="mt-1 text-sm text-red-50/60">
                                            {bulkAction === "archive" && `This will move ${selectedBulkCount} selected lead${selectedBulkCount === 1 ? "" : "s"} to Archive.`}
                                            {bulkAction === "delete-active-selected" && `This will permanently delete ${selectedBulkCount} selected lead${selectedBulkCount === 1 ? "" : "s"}. This cannot be undone.`}
                                            {bulkAction === "restore" && `This will restore ${selectedBulkCount} selected archived lead${selectedBulkCount === 1 ? "" : "s"} to NEW.`}
                                            {bulkAction === "delete-selected" && `This will permanently delete ${selectedBulkCount} selected archived lead${selectedBulkCount === 1 ? "" : "s"}.`}
                                        </p>
                                    </div>
                                </div>
                                <button className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-white/10 bg-black/20 text-white/60 transition hover:bg-white/10 hover:text-white" type="button" onClick={closeBulkPrompt} aria-label="Close bulk confirmation">
                                    <FiX className="size-4" aria-hidden="true" />
                                </button>
                            </div>
                        </div>
                        <div className="p-5">
                            <div className="rounded-lg border border-white/10 bg-white/[0.035] p-4">
                                <p className="text-xs font-semibold uppercase tracking-[0.14em] text-white/35">Selected Action</p>
                                <p className="mt-2 text-sm font-semibold text-white">
                                    {bulkAction === "archive" && "Archive selected leads"}
                                    {bulkAction === "delete-active-selected" && "Permanently delete selected leads"}
                                    {bulkAction === "restore" && "Restore selected leads"}
                                    {bulkAction === "delete-selected" && "Permanently delete selected archived leads"}
                                </p>
                            </div>
                            <div className="mt-3 rounded-lg border border-yellow-300/20 bg-yellow-300/10 p-3">
                                <p className="text-sm leading-6 text-yellow-50/75">Are you sure?</p>
                            </div>
                        </div>
                        <div className="flex justify-end gap-2 border-t border-white/10 px-5 py-3">
                            <button className="h-10 rounded-lg border border-white/10 bg-white/[0.05] px-4 text-sm font-semibold text-white/60 transition hover:bg-white/10 hover:text-white" type="button" onClick={closeBulkPrompt}>Cancel</button>
                            <button
                                className="h-10 rounded-lg bg-red-500 px-4 text-sm font-semibold text-white transition hover:bg-red-400 disabled:opacity-60"
                                type="button"
                                onClick={confirmBulkAction}
                                disabled={
                                    bulkArchiveLeadsMutation.isPending ||
                                    bulkPermanentDeleteActiveMutation.isPending ||
                                    bulkRestoreLeadsMutation.isPending ||
                                    bulkPermanentDeleteMutation.isPending
                                }
                            >
                                Confirm
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </AdminLayout>
    );
}
