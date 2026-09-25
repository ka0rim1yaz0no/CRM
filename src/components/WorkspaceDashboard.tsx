import { useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "react-router";
import {
    FiAlertCircle,
    FiBell,
    FiBriefcase,
    FiCalendar,
    FiCheckCircle,
    FiChevronDown,
    FiChevronLeft,
    FiChevronRight,
    FiClock,
    FiFileText,
    FiMessageCircle,
    FiPhoneCall,
    FiTarget,
    FiX,
} from "react-icons/fi";
import { getEmployeeSummary, normalizeEmployeeAvailabilityStatus, type Employee } from "../api/employees";
import { getEmployeeAttendance, type AttendanceRecord } from "../api/attendance";
import { getEmployeeNotices } from "../api/notices";
import { getAgentLeadDashboard, getEmployeeLeadLogs, getMyLeadCallSummary, getMyLeadCounts, getMyLeads, type AgentLeadMonthlyRow, type AgentLeadProgress, type EmployeeLeadLog, type LeadCallStat, type LeadCountResult, type LeadStatus } from "../api/leads";
import { getTasks, type CrmTask, type TaskStatus } from "../api/tasks";
import { getKnowledgeBaseEntries, type KnowledgeBaseEntry } from "../api/knowledgeBase";
import { formatPhDate, formatPhDateTime, formatPhTime } from "../lib/dateTime";
import { isAttendanceTimeOutUndertime } from "../lib/attendanceSlots";
import { getPlainTextFromRichText } from "../lib/richText";
import { getAuthUser } from "../api/authStorage";

type WorkspaceDashboardProps = {
    userName: string;
    mode: "employee" | "admin";
    employee?: Employee | null;
};

type DashboardStat = {
    label: string;
    value: number | string;
    detail: string;
    tone: "violet" | "emerald" | "amber" | "rose" | "sky";
    icon: typeof FiTarget;
};

type MonthlyQualifiedLead = AgentLeadMonthlyRow["qualifiedLeads"][number];

function getQualifiedLeadSearchLabel(lead: MonthlyQualifiedLead) {
    return lead.leadName || lead.businessName || lead.assignedAgentName || "";
}

function getQualifiedLeadPath(lead: MonthlyQualifiedLead) {
    const params = new URLSearchParams({
        scope: "all",
        lead: lead.leadId,
    });
    const searchLabel = getQualifiedLeadSearchLabel(lead);

    if (searchLabel) {
        params.set("leadSearch", searchLabel);
    }

    return `/leads?${params.toString()}`;
}

const numberFormatter = new Intl.NumberFormat("en-US");
const monthLabelFormatter = new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric" });
const dateRangeLabelFormatter = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" });
const taskStatuses: TaskStatus[] = ["Todo", "In Progress", "Done", "Blocked"];
const leadStatuses: LeadStatus[] = ["NEW", "Follow up", "Qualified", "Ongoing Negotiation", "Completed", "Dead"];
const agentRowsPerPage = 5;
const monthlyRowsPerPage = 5;

const statToneClass: Record<DashboardStat["tone"], string> = {
    violet: "border-violet-200 bg-violet-50 text-violet-700",
    emerald: "border-emerald-200 bg-emerald-50 text-emerald-700",
    amber: "border-amber-200 bg-amber-50 text-amber-700",
    rose: "border-rose-200 bg-rose-50 text-rose-700",
    sky: "border-sky-200 bg-sky-50 text-sky-700",
};

const statusBarClass: Record<TaskStatus, string> = {
    Todo: "bg-slate-400",
    "In Progress": "bg-violet-500",
    Done: "bg-emerald-500",
    Blocked: "bg-rose-500",
};

const priorityClass: Record<string, string> = {
    Low: "border-slate-200 bg-slate-50 text-slate-700",
    Medium: "border-sky-200 bg-sky-50 text-sky-700",
    High: "border-amber-200 bg-amber-50 text-amber-700",
    Urgent: "border-rose-200 bg-rose-50 text-rose-700",
};

const dashboardOverviewPanelClass = "min-h-[17rem] rounded-lg border border-slate-200 bg-white p-5 shadow-sm";

function formatNumber(value?: number) {
    return numberFormatter.format(value || 0);
}

function getMonthInputValue(date: Date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");

    return `${year}-${month}`;
}

function formatMonthLabel(monthKey?: string) {
    const [yearValue, monthValue] = String(monthKey || "").split("-").map(Number);

    if (!yearValue || !monthValue) {
        return "Selected month";
    }

    return monthLabelFormatter.format(new Date(yearValue, monthValue - 1, 1));
}

function formatDateInputValue(date: Date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");

    return `${year}-${month}-${day}`;
}

function parseDateInputValue(value?: string) {
    const [yearValue, monthValue, dayValue] = String(value || "").split("-").map(Number);

    if (!yearValue || !monthValue || !dayValue) {
        return null;
    }

    return new Date(yearValue, monthValue - 1, dayValue);
}

function getMonthlyDashboardDateRange(monthKey?: string) {
    const [yearValue, monthValue] = String(monthKey || "").split("-").map(Number);

    if (!yearValue || !monthValue) {
        const today = new Date();
        return {
            dateFrom: formatDateInputValue(new Date(today.getFullYear(), today.getMonth(), 3)),
            dateTo: formatDateInputValue(new Date(today.getFullYear(), today.getMonth() + 1, 2)),
        };
    }

    return {
        dateFrom: formatDateInputValue(new Date(yearValue, monthValue - 1, 3)),
        dateTo: formatDateInputValue(new Date(yearValue, monthValue, 2)),
    };
}

function formatDateRangeLabel(dateFrom: string, dateTo: string) {
    const start = parseDateInputValue(dateFrom);
    const end = parseDateInputValue(dateTo);

    if (!start || !end) {
        return "Selected range";
    }

    return `${dateRangeLabelFormatter.format(start)} - ${dateRangeLabelFormatter.format(end)}`;
}

function getPaginationNumbers(currentPage: number, totalPages: number) {
    const pages = new Set([1, totalPages, currentPage - 1, currentPage, currentPage + 1]);

    return Array.from(pages)
        .filter((page) => page >= 1 && page <= totalPages)
        .sort((first, second) => first - second);
}

function employeeNameSet(employee?: Employee | null) {
    if (!employee) return [];
    return Array.from(new Set([employee.name, employee.employeeCode, ...(employee.aliases || [])].filter(Boolean)));
}

function countOpenTasks(tasks: CrmTask[]) {
    return tasks.filter((task) => task.status !== "Done").length;
}

function countDueTasks(tasks: CrmTask[]) {
    const now = Date.now();
    return tasks.filter((task) => task.status !== "Done" && task.dueAt && new Date(task.dueAt).getTime() <= now).length;
}

function countUnreadNotices(notices: Array<{ isRead: boolean }>) {
    return notices.filter((notice) => !notice.isRead).length;
}

function leadCount(counts: LeadCountResult | undefined, key: LeadStatus | "ALL" | "ContactedToday") {
    return Number(counts?.[key] || 0);
}

function latestAttendance(records: AttendanceRecord[]) {
    return [...records].sort((first, second) => new Date(second.timeIn || second.createdAt).getTime() - new Date(first.timeIn || first.createdAt).getTime());
}

function statusBadgeClass(value?: string) {
    const status = normalizeEmployeeAvailabilityStatus(value);

    if (status === "ONLINE") return "border-emerald-200 bg-emerald-50 text-emerald-700";
    if (status === "BREAK" || status === "LUNCH") return "border-amber-200 bg-amber-50 text-amber-700";
    if (status === "OFF THE PHONE") return "border-sky-200 bg-sky-50 text-sky-700";
    return "border-slate-200 bg-slate-50 text-slate-700";
}

function formatDateOrDash(value?: string | null) {
    return value ? formatPhDate(value) : "-";
}

function formatActivityTime(value?: string | null) {
    return value ? formatPhDateTime(value) : "No timestamp";
}

function StatCard({ stat }: { stat: DashboardStat }) {
    const Icon = stat.icon;

    return (
        <article className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
            <div className="flex items-start justify-between gap-4">
                <span className={`flex size-11 items-center justify-center rounded-lg border ${statToneClass[stat.tone]}`}>
                    <Icon className="size-5" aria-hidden="true" />
                </span>
                <span className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-semibold text-slate-600">PH Time</span>
            </div>
            <p className="mt-4 text-sm font-semibold text-slate-600">{stat.label}</p>
            <p className="mt-2 text-3xl font-semibold text-slate-950">{stat.value}</p>
            <p className="mt-2 text-xs font-semibold text-slate-500">{stat.detail}</p>
        </article>
    );
}

function DashboardEmptyPanel({ title, message }: { title: string; message: string }) {
    return (
        <div className="rounded-lg border border-dashed border-slate-300 bg-slate-50 p-4 text-sm text-slate-500">
            <p className="font-semibold text-slate-700">{title}</p>
            <p className="mt-1">{message}</p>
        </div>
    );
}

function AgentProgressRow({ agent }: { agent: AgentLeadProgress }) {
    const currentTotal = agent.newLeads + agent.followUps + agent.qualified + agent.dead;

    return (
        <tr className="text-sm text-slate-700 transition hover:bg-slate-50">
            <td className="min-w-[13rem] px-3 py-3">
                <div className="flex items-center gap-3">
                    <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-violet-600 text-sm font-semibold text-white">
                        {agent.employeeName.slice(0, 1).toUpperCase()}
                    </span>
                    <div className="min-w-0">
                        <p className="truncate font-semibold text-slate-950">{agent.employeeName}</p>
                        <p className="mt-0.5 truncate text-xs text-slate-500">{agent.role} · {agent.team}</p>
                    </div>
                </div>
            </td>
            <td className="px-3 py-3 text-center font-semibold text-slate-950">{formatNumber(currentTotal)}</td>
            <td className="px-3 py-3 text-center">{formatNumber(agent.newLeads)}</td>
            <td className="px-3 py-3 text-center">{formatNumber(agent.followUps)}</td>
            <td className="px-3 py-3 text-center">{formatNumber(agent.qualified)}</td>
            <td className="px-3 py-3 text-center">{formatNumber(agent.dead)}</td>
        </tr>
    );
}

function MonthlyAgentRow({ row, onQualifiedClick }: { row: AgentLeadMonthlyRow; onQualifiedClick: (row: AgentLeadMonthlyRow) => void }) {
    return (
        <tr className="text-sm text-slate-700 transition hover:bg-violet-50/35">
            <td className="min-w-0 px-2 py-3">
                <div className="flex min-w-0 items-center gap-2">
                    <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-violet-100 text-xs font-semibold text-violet-700">
                        {row.employeeName.slice(0, 1).toUpperCase()}
                    </span>
                    <div className="min-w-0">
                        <p className="truncate font-semibold text-slate-900">{row.employeeName}</p>
                        <p className="mt-0.5 truncate text-xs text-slate-500">{row.role} · {row.team}</p>
                    </div>
                </div>
            </td>
            <td className="px-2 py-3 text-center font-semibold text-slate-900">{formatNumber(row.leadsAdded)}</td>
            <td className="px-2 py-3 text-center">{formatNumber(row.followUps)}</td>
            <td className="px-2 py-3 text-center">
                {row.qualified > 0 ? (
                    <button
                        type="button"
                        className="inline-flex min-w-8 items-center justify-center rounded-md border border-emerald-200 bg-emerald-50 px-2 py-1 text-sm font-semibold text-emerald-700 transition hover:border-emerald-400 hover:bg-emerald-100 focus:outline-none focus:ring-2 focus:ring-emerald-300"
                        onClick={() => onQualifiedClick(row)}
                        aria-label={`View ${formatNumber(row.qualified)} qualified leads for ${row.employeeName}`}
                    >
                        {formatNumber(row.qualified)}
                    </button>
                ) : (
                    formatNumber(row.qualified)
                )}
            </td>
            <td className="px-2 py-3 text-center">{formatNumber(row.archiveDead)}</td>
            <td className="px-2 py-3 text-center">{formatNumber(row.comments)}</td>
            <td className="px-2 py-3 text-center">{formatNumber(row.touchedLeads)}</td>
            <td className="px-2 py-3 text-center">
                <span className="inline-flex max-w-full justify-center rounded-md bg-violet-100 px-2 py-1 text-xs font-semibold text-violet-700">
                    {formatNumber(row.productivityScore)}
                </span>
            </td>
        </tr>
    );
}

function QualifiedLeadsModal({ row, onClose }: { row: AgentLeadMonthlyRow; onClose: () => void }) {
    const leads = row.qualifiedLeads || [];

    return createPortal(
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/65 px-4 py-6 backdrop-blur-sm">
            <section className="flex max-h-[86vh] w-full max-w-4xl flex-col overflow-hidden rounded-lg border border-slate-300 bg-white text-slate-950 shadow-2xl shadow-slate-950/30">
                <div className="flex items-start justify-between gap-4 border-b border-slate-200 bg-slate-50 px-5 py-4">
                    <div className="min-w-0">
                        <p className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">Qualified Leads</p>
                        <h3 className="mt-1 truncate text-lg font-semibold">{row.employeeName}</h3>
                        <p className="mt-1 text-sm text-slate-600">
                            Showing {formatNumber(leads.length)} records included in the dashboard qualified count.
                        </p>
                    </div>
                    <button
                        type="button"
                        className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-slate-300 bg-white text-slate-700 transition hover:border-violet-500 hover:text-violet-700"
                        onClick={onClose}
                        aria-label="Close qualified leads"
                    >
                        <FiX className="size-4" aria-hidden="true" />
                    </button>
                </div>
                <div className="overflow-y-auto p-4">
                    {leads.length === 0 ? (
                        <DashboardEmptyPanel title="No qualified lead details" message="This row has no qualified lead records attached to the current dashboard response." />
                    ) : (
                        <div className="overflow-hidden rounded-lg border border-slate-300">
                            <table className="w-full min-w-[46rem] table-fixed border-separate border-spacing-0">
                                <colgroup>
                                    <col className="w-[28%]" />
                                    <col className="w-[28%]" />
                                    <col className="w-[14%]" />
                                    <col className="w-[14%]" />
                                    <col className="w-[16%]" />
                                </colgroup>
                                <thead className="bg-slate-50 text-[0.68rem] uppercase tracking-[0.12em] text-slate-500">
                                    <tr>
                                        <th className="px-3 py-3 text-left font-semibold">Lead</th>
                                        <th className="px-3 py-3 text-left font-semibold">Business</th>
                                        <th className="px-3 py-3 text-left font-semibold">Category</th>
                                        <th className="px-3 py-3 text-left font-semibold">Source</th>
                                        <th className="px-3 py-3 text-left font-semibold">Qualified At</th>
                                    </tr>
                                </thead>
                                <tbody className="divide-y divide-slate-200">
                                    {leads.map((lead: MonthlyQualifiedLead) => {
                                        const leadPath = getQualifiedLeadPath(lead);

                                        return (
                                            <tr key={lead.leadId} className="text-sm text-slate-700 transition hover:bg-violet-50/70">
                                                <td className="p-0">
                                                    <Link className="block px-3 py-3" to={leadPath}>
                                                        <p className="truncate font-semibold text-slate-950">{lead.leadName || "No contact name"}</p>
                                                        <p className="mt-0.5 truncate text-xs text-slate-500">{lead.status}</p>
                                                    </Link>
                                                </td>
                                                <td className="p-0">
                                                    <Link className="block px-3 py-3" to={leadPath}>
                                                        <p className="truncate font-semibold text-slate-800">{lead.businessName || "No business"}</p>
                                                        <p className="mt-0.5 truncate text-xs text-slate-500">{lead.assignedAgentName || row.employeeName}</p>
                                                    </Link>
                                                </td>
                                                <td className="p-0">
                                                    <Link className="block px-3 py-3" to={leadPath}>{lead.category || "Uncategorized"}</Link>
                                                </td>
                                                <td className="p-0">
                                                    <Link className="block px-3 py-3" to={leadPath}>{lead.source || "Manual"}</Link>
                                                </td>
                                                <td className="p-0">
                                                    <Link className="block px-3 py-3" to={leadPath}>{lead.statusAt ? formatPhDateTime(lead.statusAt) : "No date"}</Link>
                                                </td>
                                            </tr>
                                        );
                                    })}
                                </tbody>
                            </table>
                        </div>
                    )}
                </div>
            </section>
        </div>,
        document.body
    );
}

function EmployeeAgentProductivity() {
    const [selectedMonth, setSelectedMonth] = useState(() => getMonthInputValue(new Date()));
    const [isMonthMenuOpen, setIsMonthMenuOpen] = useState(false);
    const [agentPage, setAgentPage] = useState(1);
    const [monthlyPage, setMonthlyPage] = useState(1);
    const [qualifiedLeadRow, setQualifiedLeadRow] = useState<AgentLeadMonthlyRow | null>(null);
    const selectedMonthlyRange = useMemo(() => getMonthlyDashboardDateRange(selectedMonth), [selectedMonth]);
    const monthlyRangeLabel = useMemo(() => formatDateRangeLabel(selectedMonthlyRange.dateFrom, selectedMonthlyRange.dateTo), [selectedMonthlyRange]);
    const dashboardQuery = useQuery({
        queryKey: ["employee-agent-lead-dashboard", selectedMonth, selectedMonthlyRange.dateFrom, selectedMonthlyRange.dateTo],
        queryFn: () => getAgentLeadDashboard({ month: selectedMonth, dateFrom: selectedMonthlyRange.dateFrom, dateTo: selectedMonthlyRange.dateTo }),
        refetchInterval: 60_000,
    });

    const agents = dashboardQuery.data?.agents || [];
    const monthlyAgents = dashboardQuery.data?.monthlyAgents || [];
    const monthOptions = useMemo(() => {
        return Array.from(new Set([selectedMonth, dashboardQuery.data?.selectedMonth || "", ...(dashboardQuery.data?.monthOptions || [])]))
            .filter(Boolean)
            .sort((first, second) => second.localeCompare(first));
    }, [dashboardQuery.data?.monthOptions, dashboardQuery.data?.selectedMonth, selectedMonth]);
    const totalAgentPages = Math.max(Math.ceil(agents.length / agentRowsPerPage), 1);
    const currentAgentPage = Math.min(agentPage, totalAgentPages);
    const visibleAgents = useMemo(() => {
        const startIndex = (currentAgentPage - 1) * agentRowsPerPage;

        return agents.slice(startIndex, startIndex + agentRowsPerPage);
    }, [agents, currentAgentPage]);
    const agentPageNumbers = getPaginationNumbers(currentAgentPage, totalAgentPages);
    const agentPageStart = agents.length === 0 ? 0 : (currentAgentPage - 1) * agentRowsPerPage + 1;
    const agentPageEnd = Math.min(currentAgentPage * agentRowsPerPage, agents.length);
    const totalMonthlyPages = Math.max(Math.ceil(monthlyAgents.length / monthlyRowsPerPage), 1);
    const currentMonthlyPage = Math.min(monthlyPage, totalMonthlyPages);
    const visibleMonthlyAgents = useMemo(() => {
        const startIndex = (currentMonthlyPage - 1) * monthlyRowsPerPage;

        return monthlyAgents.slice(startIndex, startIndex + monthlyRowsPerPage);
    }, [monthlyAgents, currentMonthlyPage]);
    const monthlyPageNumbers = getPaginationNumbers(currentMonthlyPage, totalMonthlyPages);
    const monthlyPageStart = monthlyAgents.length === 0 ? 0 : (currentMonthlyPage - 1) * monthlyRowsPerPage + 1;
    const monthlyPageEnd = Math.min(currentMonthlyPage * monthlyRowsPerPage, monthlyAgents.length);
    const monthlyTotals = useMemo(() => {
        return monthlyAgents.reduce(
            (totals, row) => ({
                comments: totals.comments + row.comments,
                touchedLeads: totals.touchedLeads + row.touchedLeads,
            }),
            { comments: 0, touchedLeads: 0 }
        );
    }, [monthlyAgents]);

    return (
        <section className="overflow-hidden rounded-lg border border-slate-200 bg-white text-slate-950 shadow-sm">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 bg-slate-50 px-5 py-4">
                <div>
                    <p className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">Agent Productivity</p>
                    <h2 className="mt-1 text-base font-semibold">Lead progress by agent</h2>
                </div>
            </div>
            <div className="overflow-x-auto">
                <table className="w-full min-w-[46rem] table-fixed border-separate border-spacing-0">
                    <colgroup>
                        <col className="w-[38%]" />
                        <col className="w-[10%]" />
                        <col className="w-[9%]" />
                        <col className="w-[15%]" />
                        <col className="w-[13%]" />
                        <col className="w-[15%]" />
                    </colgroup>
                    <thead className="bg-white text-[0.68rem] uppercase tracking-[0.12em] text-slate-500">
                        <tr>
                            <th className="px-3 py-3 text-left font-semibold">Agent</th>
                            <th className="px-3 py-3 text-center font-semibold">Total</th>
                            <th className="px-3 py-3 text-center font-semibold">NEW</th>
                            <th className="px-3 py-3 text-center font-semibold">FOLLOW UP</th>
                            <th className="px-3 py-3 text-center font-semibold">QUALIFIED</th>
                            <th className="px-3 py-3 text-center font-semibold">ARCHIVE/DEAD</th>
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-200">
                        {dashboardQuery.isLoading && (
                            <tr>
                                <td className="px-4 py-8 text-center text-sm text-slate-500" colSpan={6}>Loading agent metrics...</td>
                            </tr>
                        )}
                        {!dashboardQuery.isLoading && agents.length === 0 && (
                            <tr>
                                <td className="px-4 py-8" colSpan={6}>
                                    <DashboardEmptyPanel title="No agent lead data yet" message="Agent rows will appear after lead assignments or activity are available." />
                                </td>
                            </tr>
                        )}
                        {visibleAgents.map((agent) => <AgentProgressRow key={agent.employeeId} agent={agent} />)}
                        {!dashboardQuery.isLoading && visibleAgents.length > 0 && visibleAgents.length < agentRowsPerPage && Array.from({ length: agentRowsPerPage - visibleAgents.length }).map((_, index) => (
                            <tr key={`employee-agent-placeholder-${index}`} aria-hidden="true" className="pointer-events-none">
                                <td className="h-[4.5rem] px-3 py-0" colSpan={6} />
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
            {!dashboardQuery.isLoading && agents.length > 0 && (
                <div className="flex flex-col gap-3 border-t border-slate-200 bg-white px-5 py-3 sm:flex-row sm:items-center sm:justify-between">
                    <p className="text-xs font-semibold text-slate-500">
                        Showing {agentPageStart} to {agentPageEnd} of {formatNumber(agents.length)} agents
                    </p>
                    <div className="flex items-center gap-1">
                        <button type="button" className="flex size-8 items-center justify-center rounded-lg border border-slate-300 bg-white text-slate-500 transition hover:border-violet-500 hover:text-violet-700 disabled:cursor-not-allowed disabled:opacity-40" onClick={() => setAgentPage((page) => Math.max(page - 1, 1))} disabled={currentAgentPage === 1} aria-label="Previous agent page">
                            <FiChevronLeft className="size-4" aria-hidden="true" />
                        </button>
                        {agentPageNumbers.map((page) => (
                            <button
                                key={page}
                                type="button"
                                className={[
                                    "flex size-8 items-center justify-center rounded-lg border text-sm font-semibold transition",
                                    currentAgentPage === page ? "border-violet-600 bg-violet-600 text-white" : "border-slate-300 bg-white text-slate-600 hover:border-violet-500 hover:text-violet-700",
                                ].join(" ")}
                                onClick={() => setAgentPage(page)}
                                aria-label={`Agent page ${page}`}
                                aria-current={currentAgentPage === page ? "page" : undefined}
                            >
                                {page}
                            </button>
                        ))}
                        <button type="button" className="flex size-8 items-center justify-center rounded-lg border border-slate-300 bg-white text-slate-500 transition hover:border-violet-500 hover:text-violet-700 disabled:cursor-not-allowed disabled:opacity-40" onClick={() => setAgentPage((page) => Math.min(page + 1, totalAgentPages))} disabled={currentAgentPage === totalAgentPages} aria-label="Next agent page">
                            <FiChevronRight className="size-4" aria-hidden="true" />
                        </button>
                    </div>
                </div>
            )}

            <div className="border-t border-slate-200 bg-slate-50/80 px-5 py-4">
                <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                    <div>
                        <p className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">Monthly Data</p>
                        <h2 className="mt-1 text-base font-semibold text-slate-900">Agent activity for {monthlyRangeLabel}</h2>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                        <span className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-semibold text-slate-600">
                            {formatNumber(monthlyTotals.touchedLeads)} touched · {formatNumber(monthlyTotals.comments)} comments
                        </span>
                        <div
                            className="relative"
                            onBlur={(event) => {
                                if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
                                    setIsMonthMenuOpen(false);
                                }
                            }}
                        >
                            <button
                                type="button"
                                className="flex h-10 min-w-[12rem] items-center justify-between gap-3 rounded-lg border border-slate-300 bg-white px-3 text-left text-sm font-semibold text-slate-800 shadow-sm transition hover:border-violet-500 focus:outline-none focus:ring-2 focus:ring-violet-200"
                                onClick={() => setIsMonthMenuOpen((isOpen) => !isOpen)}
                                aria-haspopup="menu"
                                aria-expanded={isMonthMenuOpen}
                            >
                                <span className="flex min-w-0 items-center gap-2">
                                    <FiCalendar className="size-4 shrink-0 text-violet-700" aria-hidden="true" />
                                    <span className="truncate">{formatMonthLabel(selectedMonth)}</span>
                                </span>
                                <FiChevronDown className={["size-4 shrink-0 text-slate-500 transition", isMonthMenuOpen ? "rotate-180" : ""].join(" ")} aria-hidden="true" />
                            </button>
                            {isMonthMenuOpen && (
                                <div className="absolute right-0 z-20 mt-2 max-h-72 w-full overflow-y-auto rounded-lg border border-slate-300 bg-white p-1 text-sm shadow-xl shadow-slate-950/15" role="menu">
                                    {monthOptions.map((month) => {
                                        const isSelected = month === selectedMonth;

                                        return (
                                            <button
                                                key={month}
                                                type="button"
                                                className={[
                                                    "flex w-full items-center justify-between rounded-md px-3 py-2 text-left font-semibold transition",
                                                    isSelected ? "bg-violet-600 text-white" : "text-slate-700 hover:bg-violet-50 hover:text-violet-700",
                                                ].join(" ")}
                                                onClick={() => {
                                                    setSelectedMonth(month);
                                                    setAgentPage(1);
                                                    setMonthlyPage(1);
                                                    setIsMonthMenuOpen(false);
                                                }}
                                                role="menuitemradio"
                                                aria-checked={isSelected}
                                            >
                                                <span>{formatMonthLabel(month)}</span>
                                                {isSelected && <span className="text-xs text-white/80">Selected</span>}
                                            </button>
                                        );
                                    })}
                                </div>
                            )}
                        </div>
                    </div>
                </div>
                <div className="mt-4 overflow-x-auto rounded-lg border border-slate-300 bg-white">
                    <table className="w-full min-w-0 table-fixed border-separate border-spacing-0">
                        <colgroup>
                            <col className="w-[31%]" />
                            <col className="w-[10%]" />
                            <col className="w-[11%]" />
                            <col className="w-[10%]" />
                            <col className="w-[12%]" />
                            <col className="w-[10%]" />
                            <col className="w-[10%]" />
                            <col className="w-[6%]" />
                        </colgroup>
                        <thead className="bg-white text-[0.62rem] uppercase tracking-[0.08em] text-slate-500">
                            <tr>
                                <th className="px-2 py-3 text-left font-semibold">Agent</th>
                                <th className="px-2 py-3 text-center font-semibold">Added</th>
                                <th className="px-2 py-3 text-center font-semibold">Follow Up</th>
                                <th className="px-2 py-3 text-center font-semibold">Qualified</th>
                                <th className="px-2 py-3 text-center font-semibold">Archive/Dead</th>
                                <th className="px-2 py-3 text-center font-semibold">Comments</th>
                                <th className="px-2 py-3 text-center font-semibold">Touched</th>
                                <th className="px-2 py-3 text-center font-semibold">Score</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-200">
                            {dashboardQuery.isLoading && (
                                <tr>
                                    <td className="px-4 py-8 text-center text-sm text-slate-500" colSpan={8}>Loading monthly metrics...</td>
                                </tr>
                            )}
                            {!dashboardQuery.isLoading && monthlyAgents.length === 0 && (
                                <tr>
                                    <td className="px-4 py-8" colSpan={8}>
                                        <DashboardEmptyPanel title="No monthly data yet" message="Choose another month or wait for lead activity to appear here." />
                                    </td>
                                </tr>
                            )}
                            {visibleMonthlyAgents.map((row) => (
                                <MonthlyAgentRow key={row.employeeId} row={row} onQualifiedClick={setQualifiedLeadRow} />
                            ))}
                            {!dashboardQuery.isLoading && visibleMonthlyAgents.length > 0 && visibleMonthlyAgents.length < monthlyRowsPerPage && Array.from({ length: monthlyRowsPerPage - visibleMonthlyAgents.length }).map((_, index) => (
                                <tr key={`employee-monthly-placeholder-${index}`} aria-hidden="true" className="pointer-events-none">
                                    <td className="h-[4.5rem] px-3 py-0" colSpan={8} />
                                </tr>
                            ))}
                        </tbody>
                    </table>
                    {!dashboardQuery.isLoading && monthlyAgents.length > 0 && (
                        <div className="flex flex-col gap-3 border-t border-slate-300 bg-white px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
                            <p className="text-xs font-semibold text-slate-500">
                                Showing {monthlyPageStart} to {monthlyPageEnd} of {formatNumber(monthlyAgents.length)} monthly rows
                            </p>
                            <div className="flex items-center gap-1">
                                <button type="button" className="flex size-8 items-center justify-center rounded-lg border border-slate-300 bg-white text-slate-500 transition hover:border-violet-500 hover:text-violet-700 disabled:cursor-not-allowed disabled:opacity-40" onClick={() => setMonthlyPage((page) => Math.max(page - 1, 1))} disabled={currentMonthlyPage === 1} aria-label="Previous monthly data page">
                                    <FiChevronLeft className="size-4" aria-hidden="true" />
                                </button>
                                {monthlyPageNumbers.map((page) => (
                                    <button
                                        key={page}
                                        type="button"
                                        className={[
                                            "flex size-8 items-center justify-center rounded-lg border text-sm font-semibold transition",
                                            currentMonthlyPage === page ? "border-violet-600 bg-violet-600 text-white" : "border-slate-300 bg-white text-slate-600 hover:border-violet-500 hover:text-violet-700",
                                        ].join(" ")}
                                        onClick={() => setMonthlyPage(page)}
                                        aria-label={`Monthly data page ${page}`}
                                        aria-current={currentMonthlyPage === page ? "page" : undefined}
                                    >
                                        {page}
                                    </button>
                                ))}
                                <button type="button" className="flex size-8 items-center justify-center rounded-lg border border-slate-300 bg-white text-slate-500 transition hover:border-violet-500 hover:text-violet-700 disabled:cursor-not-allowed disabled:opacity-40" onClick={() => setMonthlyPage((page) => Math.min(page + 1, totalMonthlyPages))} disabled={currentMonthlyPage === totalMonthlyPages} aria-label="Next monthly data page">
                                    <FiChevronRight className="size-4" aria-hidden="true" />
                                </button>
                            </div>
                        </div>
                    )}
                </div>
            </div>
            {dashboardQuery.isError && (
                <div className="border-t border-rose-200 bg-rose-50 px-5 py-3 text-sm font-semibold text-rose-700">
                    Agent productivity data could not be loaded.
                </div>
            )}
            {qualifiedLeadRow && <QualifiedLeadsModal row={qualifiedLeadRow} onClose={() => setQualifiedLeadRow(null)} />}
        </section>
    );
}

function AnnouncementsPanel({ announcements }: { announcements: KnowledgeBaseEntry[] }) {
    const visibleAnnouncements = announcements.filter((announcement) => announcement.status === "Active").slice(0, 3);

    return (
        <section className={`${dashboardOverviewPanelClass} xl:col-span-2`}>
            <div className="flex items-center justify-between gap-3">
                <div>
                    <p className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">Announcements</p>
                    <h2 className="mt-1 text-base font-semibold text-slate-950">Latest updates from admin</h2>
                </div>
                <Link className="rounded-lg border border-slate-200 px-3 py-2 text-sm font-semibold text-slate-700 transition hover:bg-slate-50" to="/announcements">
                    View all
                </Link>
            </div>

            <div className="mt-5 grid gap-3 md:grid-cols-3">
                {visibleAnnouncements.map((announcement) => (
                    <Link
                        key={announcement._id}
                        className="group min-h-32 rounded-lg border border-slate-200 bg-slate-50 px-3 py-3 transition hover:border-violet-300 hover:bg-white hover:shadow-sm focus:outline-none focus:ring-2 focus:ring-violet-200"
                        to={`/announcements/${announcement._id}`}
                    >
                        <div className="flex items-start justify-between gap-3">
                            <FiFileText className="mt-0.5 size-4 shrink-0 text-violet-600 transition group-hover:text-violet-700" aria-hidden="true" />
                        </div>
                        <h3 className="mt-3 line-clamp-2 text-sm font-semibold leading-5 text-slate-950">{announcement.title}</h3>
                        <p className="mt-2 line-clamp-3 whitespace-pre-line text-xs leading-5 text-slate-600">
                            {getPlainTextFromRichText(announcement.description, "No details provided.")}
                        </p>
                    </Link>
                ))}
                {visibleAnnouncements.length === 0 && (
                    <p className="rounded-lg border border-dashed border-slate-300 bg-slate-50 p-4 text-sm text-slate-500 md:col-span-3">
                        No announcements yet.
                    </p>
                )}
            </div>
        </section>
    );
}

function TaskOverview({ tasks }: { tasks: CrmTask[] }) {
    const maxCount = Math.max(1, ...taskStatuses.map((status) => tasks.filter((task) => task.status === status).length));

    return (
        <section className={`${dashboardOverviewPanelClass} xl:col-span-2`}>
            <div className="flex items-center justify-between gap-3">
                <div>
                    <p className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">Tasks</p>
                    <h2 className="mt-1 text-base font-semibold text-slate-950">Assigned work overview</h2>
                </div>
                <Link className="rounded-lg border border-slate-200 px-3 py-2 text-sm font-semibold text-slate-700 transition hover:bg-slate-50" to="/tasks">
                    View tasks
                </Link>
            </div>

            <div className="mt-5 grid gap-3">
                {taskStatuses.map((status) => {
                    const count = tasks.filter((task) => task.status === status).length;
                    const width = `${Math.max(7, Math.round((count / maxCount) * 100))}%`;

                    return (
                        <div key={status}>
                            <div className="mb-1 flex items-center justify-between text-sm">
                                <span className="font-semibold text-slate-700">{status}</span>
                                <span className="text-slate-500">{count}</span>
                            </div>
                            <div className="h-3 overflow-hidden rounded-full bg-slate-100">
                                <div className={`h-full rounded-full ${statusBarClass[status]}`} style={{ width }} />
                            </div>
                        </div>
                    );
                })}
            </div>
        </section>
    );
}

function LeadProgress({ counts }: { counts?: LeadCountResult }) {
    const total = Math.max(1, leadCount(counts, "ALL"));

    return (
        <section className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
            <div className="flex items-center justify-between gap-3">
                <div>
                    <p className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">Leads</p>
                    <h2 className="mt-1 text-base font-semibold text-slate-950">Pipeline progress</h2>
                </div>
                <Link className="text-sm font-semibold text-violet-700 hover:text-violet-900" to="/leads">
                    Open leads
                </Link>
            </div>

            <div className="mt-5 space-y-3">
                {leadStatuses.map((status) => {
                    const count = leadCount(counts, status);
                    const percent = Math.round((count / total) * 100);

                    return (
                        <div key={status}>
                            <div className="mb-1 flex items-center justify-between text-sm">
                                <span className="font-semibold text-slate-700">{status}</span>
                                <span className="text-slate-500">{count}</span>
                            </div>
                            <div className="h-2.5 overflow-hidden rounded-full bg-slate-100">
                                <div className="h-full rounded-full bg-violet-500" style={{ width: `${Math.max(count ? 6 : 0, percent)}%` }} />
                            </div>
                        </div>
                    );
                })}
            </div>
        </section>
    );
}

const ATTENDANCE_BREAK_LIMITS_MS: Partial<Record<AttendanceRecord["source"], number>> = {
    "Break Out": 15 * 60 * 1000,
    "Lunch Break Out": 60 * 60 * 1000,
};

const SHIFT_START_HOUR = 23;
const SHIFT_LENGTH_MS = 9 * 60 * 60 * 1000;
const SHIFT_MORNING_CUTOFF_HOUR = 12;

function getAttendanceTimestamp(record?: AttendanceRecord | null) {
    const timestamp = record?.timeIn || record?.createdAt;
    const value = timestamp ? new Date(timestamp).getTime() : 0;

    return Number.isNaN(value) ? 0 : value;
}

function getDateValue(value?: string | null) {
    const timestamp = value ? new Date(value).getTime() : 0;
    return Number.isNaN(timestamp) ? 0 : timestamp;
}

function formatAttendanceDuration(milliseconds: number) {
    const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000));
    const days = Math.floor(totalSeconds / 86400);
    const hours = Math.floor((totalSeconds % 86400) / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;

    if (days > 0) {
        return `${days}d ${String(hours).padStart(2, "0")}h ${String(minutes).padStart(2, "0")}m ${String(seconds).padStart(2, "0")}s`;
    }

    if (hours > 0) {
        return `${hours}h ${String(minutes).padStart(2, "0")}m ${String(seconds).padStart(2, "0")}s`;
    }

    if (minutes > 0) {
        return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
    }

    return `${seconds}s`;
}

function getAttendanceStatusText(record: AttendanceRecord) {
    return String(record.attendanceStatus || (isAttendanceTimeOutUndertime(record) ? "Undertime" : "")).trim().toLowerCase();
}

function getAttendanceStatusLabel(record: AttendanceRecord) {
    return record.attendanceStatus || (isAttendanceTimeOutUndertime(record) ? "Undertime" : "No status");
}

function getBreakReturnSource(source?: AttendanceRecord["source"]) {
    if (source === "Break Out") return "Break In";
    if (source === "Lunch Break Out") return "Lunch Break In";
    return "";
}

type AttendanceOverBreakRow = {
    id: string;
    label: string;
    startedAt: string;
    endedAt: string | null;
    durationMs: number;
    allowedMs: number;
    overMs: number;
    isOpen: boolean;
};

type AttendanceShiftRow = {
    id: string;
    shiftDateValue: string;
    shiftStart: Date;
    shiftEnd: Date;
    records: AttendanceRecord[];
    overBreakRows: AttendanceOverBreakRow[];
    totalOverBreakMs: number;
    lateRecords: AttendanceRecord[];
    underTimeRecords: AttendanceRecord[];
    firstTimeIn: AttendanceRecord | null;
    lastTimeOut: AttendanceRecord | null;
};

function getShiftStartDateFromTimestamp(value?: string | null) {
    const date = value ? new Date(value) : new Date();

    if (Number.isNaN(date.getTime())) {
        return new Date(0);
    }

    const shiftStart = new Date(date);

    // Attendance day is an overnight work day. Any punch before noon belongs to
    // the previous night's 11PM shift. Punches from noon onward belong to that
    // date's 11PM shift. This prevents 8:01 AM time-outs from being moved to
    // the next 11PM shift.
    if (date.getHours() < SHIFT_MORNING_CUTOFF_HOUR) {
        shiftStart.setDate(shiftStart.getDate() - 1);
    }

    shiftStart.setHours(SHIFT_START_HOUR, 0, 0, 0);
    return shiftStart;
}

function getShiftEndDate(shiftStart: Date) {
    return new Date(shiftStart.getTime() + SHIFT_LENGTH_MS);
}

function getShiftDateValueFromStart(shiftStart: Date) {
    return formatDateInputValue(new Date(shiftStart.getFullYear(), shiftStart.getMonth(), shiftStart.getDate()));
}

function getCurrentShiftDateValue() {
    return getShiftDateValueFromStart(getShiftStartDateFromTimestamp(new Date().toISOString()));
}

function getShiftLabel(row: AttendanceShiftRow) {
    return `${formatPhDateTime(row.shiftStart.toISOString())} to ${formatPhDateTime(row.shiftEnd.toISOString())}`;
}

function isTimeInSource(source?: AttendanceRecord["source"]) {
    return source === "Login" || source === "Time In";
}

function isTimeOutSource(source?: AttendanceRecord["source"]) {
    return source === "Logout" || source === "Time Out";
}

function getChronologicalAttendance(records: AttendanceRecord[]) {
    return [...records].sort((first, second) => getAttendanceTimestamp(first) - getAttendanceTimestamp(second));
}

function getLatestAttendanceInShift(records: AttendanceRecord[]) {
    return [...records].sort((first, second) => getAttendanceTimestamp(second) - getAttendanceTimestamp(first));
}

function findBreakEndRecord(records: AttendanceRecord[], startIndex: number, returnSource: string) {
    const startRecord = records[startIndex];
    const startedAtMs = getAttendanceTimestamp(startRecord);

    for (let index = startIndex + 1; index < records.length; index += 1) {
        const candidate = records[index];
        const candidateMs = getAttendanceTimestamp(candidate);

        if (candidateMs <= startedAtMs) {
            continue;
        }

        if (candidate.source === returnSource) {
            return { record: candidate, isReturned: true };
        }

        // A time-out closes any open break/lunch. A new break/lunch without a
        // matching return also closes the previous open segment at that punch so
        // the calculation never runs until today's Date.now() by mistake.
        if (
            isTimeOutSource(candidate.source) ||
            candidate.source === "Break Out" ||
            candidate.source === "Lunch Break Out" ||
            isTimeInSource(candidate.source)
        ) {
            return { record: candidate, isReturned: false };
        }
    }

    return { record: null, isReturned: false };
}

function buildOverBreakRows(records: AttendanceRecord[], shiftEnd: Date, isCurrentOpenShift: boolean) {
    const ascendingRecords = getChronologicalAttendance(records);
    const rows: AttendanceOverBreakRow[] = [];

    ascendingRecords.forEach((record, index) => {
        const allowedMs = ATTENDANCE_BREAK_LIMITS_MS[record.source];
        const returnSource = getBreakReturnSource(record.source);

        if (!allowedMs || !returnSource) {
            return;
        }

        const startedAtMs = getAttendanceTimestamp(record);
        const breakEnd = findBreakEndRecord(ascendingRecords, index, returnSource);
        const fallbackEndMs = isCurrentOpenShift ? Date.now() : shiftEnd.getTime();
        const endedAtMs = breakEnd.record ? getAttendanceTimestamp(breakEnd.record) : fallbackEndMs;
        const safeEndedAtMs = Math.max(startedAtMs, endedAtMs);
        const durationMs = Math.max(0, safeEndedAtMs - startedAtMs);
        const overMs = Math.max(0, durationMs - allowedMs);

        if (overMs <= 0) {
            return;
        }

        rows.push({
            id: record._id,
            label: record.source === "Lunch Break Out" ? "Lunch Break" : "Break",
            startedAt: record.timeIn,
            endedAt: breakEnd.record?.timeIn || new Date(safeEndedAtMs).toISOString(),
            durationMs,
            allowedMs,
            overMs,
            isOpen: !breakEnd.record && isCurrentOpenShift,
        });
    });

    return rows.sort((first, second) => getDateValue(first.startedAt) - getDateValue(second.startedAt));
}

type AttendanceShiftDraft = {
    shiftDateValue: string;
    shiftStart: Date;
    shiftEnd: Date;
    records: AttendanceRecord[];
};

function createShiftDraftFromRecord(record: AttendanceRecord): AttendanceShiftDraft {
    const shiftStart = getShiftStartDateFromTimestamp(record.timeIn || record.createdAt);

    return {
        shiftDateValue: getShiftDateValueFromStart(shiftStart),
        shiftStart,
        shiftEnd: getShiftEndDate(shiftStart),
        records: [],
    };
}

function buildAttendanceShiftRows(records: AttendanceRecord[]) {
    const chronologicalRecords = getChronologicalAttendance(records);
    const shiftDrafts: AttendanceShiftDraft[] = [];
    const orphanRowsByDate = new Map<string, AttendanceShiftDraft>();
    let activeShift: AttendanceShiftDraft | null = null;

    chronologicalRecords.forEach((record) => {
        if (isTimeInSource(record.source)) {
            activeShift = createShiftDraftFromRecord(record);
            activeShift.records.push(record);
            shiftDrafts.push(activeShift);
            return;
        }

        if (activeShift) {
            activeShift.records.push(record);

            if (isTimeOutSource(record.source)) {
                activeShift = null;
            }

            return;
        }

        // Fallback for imported/old data that has break or time-out records but
        // no time-in record available in the returned API payload.
        const fallbackShiftStart = getShiftStartDateFromTimestamp(record.timeIn || record.createdAt);
        const fallbackShiftDateValue = getShiftDateValueFromStart(fallbackShiftStart);

        if (!orphanRowsByDate.has(fallbackShiftDateValue)) {
            orphanRowsByDate.set(fallbackShiftDateValue, {
                shiftDateValue: fallbackShiftDateValue,
                shiftStart: fallbackShiftStart,
                shiftEnd: getShiftEndDate(fallbackShiftStart),
                records: [],
            });
        }

        orphanRowsByDate.get(fallbackShiftDateValue)!.records.push(record);
    });

    return [...shiftDrafts, ...Array.from(orphanRowsByDate.values())]
        .filter((draft) => draft.records.length > 0)
        .map((draft) => {
            const sortedShiftRecords = getLatestAttendanceInShift(draft.records);
            const ascendingShiftRecords = getChronologicalAttendance(draft.records);
            const latestRecord = ascendingShiftRecords[ascendingShiftRecords.length - 1];
            const isCurrentOpenShift = Boolean(
                latestRecord &&
                !ascendingShiftRecords.some((record) => isTimeOutSource(record.source)) &&
                draft.shiftDateValue === getCurrentShiftDateValue()
            );
            const overBreakRows = buildOverBreakRows(draft.records, draft.shiftEnd, isCurrentOpenShift);
            const lateRecords = sortedShiftRecords.filter((record) => getAttendanceStatusText(record).includes("late"));
            const underTimeRecords = sortedShiftRecords.filter((record) => {
                const statusText = getAttendanceStatusText(record);

                return statusText.includes("under") || statusText.includes("undertime");
            });
            const firstTimeIn = ascendingShiftRecords.find((record) => isTimeInSource(record.source)) || ascendingShiftRecords[0] || null;
            const lastTimeOut = sortedShiftRecords.find((record) => isTimeOutSource(record.source)) || null;

            return {
                id: draft.shiftDateValue,
                shiftDateValue: draft.shiftDateValue,
                shiftStart: draft.shiftStart,
                shiftEnd: draft.shiftEnd,
                records: sortedShiftRecords,
                overBreakRows,
                totalOverBreakMs: overBreakRows.reduce((total, row) => total + row.overMs, 0),
                lateRecords,
                underTimeRecords,
                firstTimeIn,
                lastTimeOut,
            };
        })
        .sort((first, second) => first.shiftStart.getTime() - second.shiftStart.getTime());
}

function AttendancePanel({ employee, attendance }: { employee?: Employee | null; attendance: AttendanceRecord[] }) {
    const status = normalizeEmployeeAvailabilityStatus(employee?.availabilityStatus);
    const todayDateValue = getCurrentShiftDateValue();
    const [selectedAttendanceDate, setSelectedAttendanceDate] = useState("");
    const [attendanceDateFrom, setAttendanceDateFrom] = useState("");
    const [attendanceDateTo, setAttendanceDateTo] = useState("");
    const [selectedShiftRow, setSelectedShiftRow] = useState<AttendanceShiftRow | null>(null);
    const sortedAllAttendance = useMemo(() => latestAttendance(attendance), [attendance]);
    const allShiftRows = useMemo(() => buildAttendanceShiftRows(sortedAllAttendance), [sortedAllAttendance]);
    const filteredShiftRows = useMemo(() => {
        const exactDateStart = selectedAttendanceDate ? getDateStart(selectedAttendanceDate) : null;
        const exactDateEnd = selectedAttendanceDate ? getDateEnd(selectedAttendanceDate) : null;
        const rangeStart = !selectedAttendanceDate && attendanceDateFrom ? getDateStart(attendanceDateFrom) : null;
        const rangeEnd = !selectedAttendanceDate && attendanceDateTo ? getDateEnd(attendanceDateTo) : null;

        return allShiftRows.filter((row) => {
            const shiftDateTime = getDateStart(row.shiftDateValue)?.getTime() || row.shiftStart.getTime();

            if (exactDateStart && shiftDateTime < exactDateStart.getTime()) return false;
            if (exactDateEnd && shiftDateTime > exactDateEnd.getTime()) return false;
            if (rangeStart && shiftDateTime < rangeStart.getTime()) return false;
            if (rangeEnd && shiftDateTime > rangeEnd.getTime()) return false;

            return true;
        });
    }, [allShiftRows, selectedAttendanceDate, attendanceDateFrom, attendanceDateTo]);
    const totalOverBreakMs = filteredShiftRows.reduce((total, row) => total + row.totalOverBreakMs, 0);
    const totalOverBreakCount = filteredShiftRows.reduce((total, row) => total + row.overBreakRows.length, 0);
    const totalLateCount = filteredShiftRows.reduce((total, row) => total + row.lateRecords.length, 0);
    const totalUnderTimeCount = filteredShiftRows.reduce((total, row) => total + row.underTimeRecords.length, 0);
    const hasAttendanceFilter = Boolean(selectedAttendanceDate || attendanceDateFrom || attendanceDateTo);
    const filterSummary = selectedAttendanceDate
        ? `Selected shift date: ${formatDateOrDash(selectedAttendanceDate)}`
        : attendanceDateFrom || attendanceDateTo
            ? `Shift date range: ${attendanceDateFrom ? formatDateOrDash(attendanceDateFrom) : "Start"} to ${attendanceDateTo ? formatDateOrDash(attendanceDateTo) : "End"}`
            : "Showing all attendance shifts";
    const clearAttendanceFilters = () => {
        setSelectedAttendanceDate("");
        setAttendanceDateFrom("");
        setAttendanceDateTo("");
    };
    const applyTodayAttendanceFilter = () => {
        setSelectedAttendanceDate(todayDateValue);
        setAttendanceDateFrom("");
        setAttendanceDateTo("");
    };
    const metricCards = [
        {
            label: "Over break",
            value: formatAttendanceDuration(totalOverBreakMs),
            detail: `${formatNumber(totalOverBreakCount)} break/lunch violation${totalOverBreakCount === 1 ? "" : "s"}`,
            className: "border-rose-200 bg-rose-50 text-rose-700",
        },
        {
            label: "Under time",
            value: formatNumber(totalUnderTimeCount),
            detail: "Records marked undertime inside selected shift rows",
            className: "border-amber-200 bg-amber-50 text-amber-700",
        },
        {
            label: "Late times",
            value: formatNumber(totalLateCount),
            detail: "Records marked late inside selected shift rows",
            className: "border-violet-200 bg-violet-50 text-violet-700",
        },
    ];

    return (
        <section className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
            <div className="flex items-start justify-between gap-3">
                <div>
                    <p className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">Attendance</p>
                    <h2 className="mt-1 text-base font-semibold text-slate-950">Attendance by shift</h2>
                    <p className="mt-1 text-xs text-slate-500">
                        One row equals one full shift: 11:00 PM shift date to 8:00 AM next day. Showing {formatNumber(filteredShiftRows.length)} of {formatNumber(allShiftRows.length)} shift row{allShiftRows.length === 1 ? "" : "s"}.
                    </p>
                </div>
                <span className={`rounded-full border px-3 py-1 text-xs font-bold ${statusBadgeClass(status)}`}>{status}</span>
            </div>

            <div className="mt-5 grid gap-3 sm:grid-cols-3">
                {metricCards.map((item) => (
                    <article key={item.label} className={`rounded-lg border px-3 py-3 ${item.className}`}>
                        <p className="text-[0.65rem] font-bold uppercase tracking-[0.12em] opacity-80">{item.label}</p>
                        <p className="mt-2 text-xl font-semibold">{item.value}</p>
                        <p className="mt-1 text-xs font-semibold opacity-80">{item.detail}</p>
                    </article>
                ))}
            </div>

            <div className="mt-5 rounded-lg border border-slate-200 bg-slate-50 p-4">
                <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
                    <div>
                        <p className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">Shift Filter</p>
                        <p className="mt-1 text-sm font-semibold text-slate-800">{filterSummary}</p>
                        <p className="mt-1 text-xs text-slate-500">Date means the shift start date. Example: 06/16/2026 means 11:00 PM 06/16/2026 to 8:00 AM 06/17/2026.</p>
                    </div>

                    <div className="grid w-full gap-3 sm:grid-cols-2 lg:w-auto lg:grid-cols-[10rem_10rem_10rem_auto]">
                        <label className="text-xs font-semibold text-slate-600">
                            Shift Date
                            <input
                                type="date"
                                value={selectedAttendanceDate}
                                onChange={(event) => {
                                    setSelectedAttendanceDate(event.target.value);
                                    if (event.target.value) {
                                        setAttendanceDateFrom("");
                                        setAttendanceDateTo("");
                                    }
                                }}
                                className="mt-1 h-10 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm font-semibold text-slate-800 shadow-sm focus:border-violet-500 focus:outline-none focus:ring-2 focus:ring-violet-200"
                            />
                        </label>

                        <label className="text-xs font-semibold text-slate-600">
                            Shift From
                            <input
                                type="date"
                                value={attendanceDateFrom}
                                onChange={(event) => {
                                    setAttendanceDateFrom(event.target.value);
                                    if (event.target.value) {
                                        setSelectedAttendanceDate("");
                                    }
                                }}
                                className="mt-1 h-10 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm font-semibold text-slate-800 shadow-sm focus:border-violet-500 focus:outline-none focus:ring-2 focus:ring-violet-200"
                            />
                        </label>

                        <label className="text-xs font-semibold text-slate-600">
                            Shift To
                            <input
                                type="date"
                                value={attendanceDateTo}
                                onChange={(event) => {
                                    setAttendanceDateTo(event.target.value);
                                    if (event.target.value) {
                                        setSelectedAttendanceDate("");
                                    }
                                }}
                                className="mt-1 h-10 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm font-semibold text-slate-800 shadow-sm focus:border-violet-500 focus:outline-none focus:ring-2 focus:ring-violet-200"
                            />
                        </label>

                        <div className="flex items-end gap-2">
                            <button
                                type="button"
                                className="inline-flex h-10 items-center justify-center rounded-lg border border-violet-200 bg-white px-3 text-xs font-bold text-violet-700 transition hover:border-violet-500 hover:bg-violet-50"
                                onClick={applyTodayAttendanceFilter}
                            >
                                Today
                            </button>
                            <button
                                type="button"
                                className="inline-flex h-10 items-center justify-center rounded-lg border border-slate-300 bg-white px-3 text-xs font-bold text-slate-600 transition hover:border-slate-500 hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-50"
                                onClick={clearAttendanceFilters}
                                disabled={!hasAttendanceFilter}
                            >
                                Clear
                            </button>
                        </div>
                    </div>
                </div>
            </div>

            <div className="mt-5 overflow-hidden rounded-lg border border-slate-300 bg-white">
                <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 bg-slate-50 px-4 py-3">
                    <div>
                        <p className="text-xs font-semibold uppercase tracking-[0.12em] text-slate-500">Shift Attendance Table</p>
                        <p className="mt-1 text-xs text-slate-500">Click View to open every punch, issue, and break detail inside that shift. {filterSummary}</p>
                    </div>
                    <span className="rounded-full bg-white px-2.5 py-1 text-[0.65rem] font-bold text-slate-500">Shift 11PM-8AM · Break 15m · Lunch 1h</span>
                </div>

                <div className="content-scroll max-h-[34rem] overflow-auto">
                    <table className="w-full min-w-[70rem] table-fixed border-separate border-spacing-0 text-left text-sm">
                        <colgroup>
                            <col className="w-[12%]" />
                            <col className="w-[24%]" />
                            <col className="w-[12%]" />
                            <col className="w-[12%]" />
                            <col className="w-[8%]" />
                            <col className="w-[9%]" />
                            <col className="w-[9%]" />
                            <col className="w-[10%]" />
                        </colgroup>
                        <thead className="sticky top-0 z-10 bg-white text-[0.68rem] uppercase tracking-[0.12em] text-slate-500 shadow-sm">
                            <tr>
                                <th className="px-3 py-3 font-semibold">Shift Date</th>
                                <th className="px-3 py-3 font-semibold">Shift Window</th>
                                <th className="px-3 py-3 font-semibold">Time In</th>
                                <th className="px-3 py-3 font-semibold">Time Out</th>
                                <th className="px-3 py-3 text-center font-semibold">Records</th>
                                <th className="px-3 py-3 text-center font-semibold">Late</th>
                                <th className="px-3 py-3 text-center font-semibold">Under</th>
                                <th className="px-3 py-3 font-semibold">Over Break</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-200">
                            {filteredShiftRows.map((row) => (
                                <tr key={row.id} className="text-slate-700 transition hover:bg-violet-50/40" onClick={() => setSelectedShiftRow(row)}>
                                    <td className="px-3 py-3 font-semibold text-slate-900">{formatDateOrDash(row.shiftDateValue)}</td>
                                    <td className="px-3 py-3">
                                        <p className="font-semibold text-slate-950">{getShiftLabel(row)}</p>
                                        <p className="mt-0.5 text-xs text-slate-500">11:00 PM to 8:00 AM next day</p>
                                    </td>
                                    <td className="px-3 py-3">{row.firstTimeIn ? formatPhTime(row.firstTimeIn.timeIn) : "-"}</td>
                                    <td className="px-3 py-3">{row.lastTimeOut ? formatPhTime(row.lastTimeOut.timeIn) : "No time out"}</td>
                                    <td className="px-3 py-3 text-center font-semibold text-slate-950">{formatNumber(row.records.length)}</td>
                                    <td className="px-3 py-3 text-center">
                                        <span className={row.lateRecords.length ? "inline-flex rounded-full bg-violet-100 px-2 py-1 text-xs font-bold text-violet-700" : "text-xs font-semibold text-slate-400"}>
                                            {row.lateRecords.length ? formatNumber(row.lateRecords.length) : "0"}
                                        </span>
                                    </td>
                                    <td className="px-3 py-3 text-center">
                                        <span className={row.underTimeRecords.length ? "inline-flex rounded-full bg-amber-100 px-2 py-1 text-xs font-bold text-amber-700" : "text-xs font-semibold text-slate-400"}>
                                            {row.underTimeRecords.length ? formatNumber(row.underTimeRecords.length) : "0"}
                                        </span>
                                    </td>
                                    <td className="px-3 py-3">
                                        {row.totalOverBreakMs > 0 ? (
                                            <div>
                                                <p className="font-semibold text-rose-700">{formatAttendanceDuration(row.totalOverBreakMs)}</p>
                                                <p className="mt-0.5 text-xs text-slate-500">{formatNumber(row.overBreakRows.length)} violation{row.overBreakRows.length === 1 ? "" : "s"}</p>
                                            </div>
                                        ) : (
                                            <span className="text-xs font-semibold text-slate-400">-</span>
                                        )}
                                    </td>
                                </tr>
                            ))}
                            {filteredShiftRows.length === 0 && (
                                <tr>
                                    <td className="px-4 py-8 text-center text-sm text-slate-500" colSpan={8}>
                                        No attendance shifts found.
                                    </td>
                                </tr>
                            )}
                        </tbody>
                    </table>
                </div>
            </div>

            {selectedShiftRow && (
                <AttendanceShiftDetailsModal
                    row={selectedShiftRow}
                    onClose={() => setSelectedShiftRow(null)}
                />
            )}
        </section>
    );
}

function AttendanceShiftDetailsModal({ row, onClose }: { row: AttendanceShiftRow; onClose: () => void }) {
    const chronologicalShiftRecords = [...row.records].sort(
        (first, second) => getAttendanceTimestamp(first) - getAttendanceTimestamp(second)
    );
    const chronologicalOverBreakRows = [...row.overBreakRows].sort(
        (first, second) => getDateValue(first.startedAt) - getDateValue(second.startedAt)
    );

    return createPortal(
        <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/65 px-4 py-6 backdrop-blur-sm"
            onMouseDown={(event) => {
                if (event.target === event.currentTarget) {
                    onClose();
                }
            }}
        >
            <section
                className="flex max-h-[88vh] w-full max-w-6xl flex-col overflow-hidden rounded-lg border border-slate-300 bg-white text-slate-950 shadow-2xl shadow-slate-950/30"
                role="dialog"
                aria-modal="true"
                aria-labelledby="attendance-shift-details-title"
            >
                <div className="flex items-start justify-between gap-4 border-b border-slate-200 bg-slate-50 px-5 py-4">
                    <div className="min-w-0">
                        <p className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">Attendance Shift Details</p>
                        <h3 id="attendance-shift-details-title" className="mt-1 truncate text-lg font-semibold text-slate-950">
                            {formatDateOrDash(row.shiftDateValue)} Shift
                        </h3>
                        <p className="mt-1 text-sm text-slate-600">{getShiftLabel(row)}</p>
                    </div>
                    <button
                        type="button"
                        className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-slate-300 bg-white text-slate-700 transition hover:border-violet-500 hover:text-violet-700"
                        onClick={onClose}
                        aria-label="Close attendance shift details"
                    >
                        <FiX className="size-4" aria-hidden="true" />
                    </button>
                </div>

                <div className="content-scroll overflow-y-auto p-5">
                    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
                        <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
                            <p className="text-[0.65rem] font-bold uppercase tracking-[0.12em] text-slate-500">Shift Window</p>
                            <p className="mt-1 text-sm font-semibold text-slate-950">11PM to 8AM</p>
                        </div>
                        <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
                            <p className="text-[0.65rem] font-bold uppercase tracking-[0.12em] text-slate-500">Records</p>
                            <p className="mt-1 text-sm font-semibold text-slate-950">{formatNumber(row.records.length)}</p>
                        </div>
                        <div className="rounded-lg border border-violet-200 bg-violet-50 p-3 text-violet-700">
                            <p className="text-[0.65rem] font-bold uppercase tracking-[0.12em] opacity-80">Late</p>
                            <p className="mt-1 text-sm font-semibold">{formatNumber(row.lateRecords.length)}</p>
                        </div>
                        <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-amber-700">
                            <p className="text-[0.65rem] font-bold uppercase tracking-[0.12em] opacity-80">Undertime</p>
                            <p className="mt-1 text-sm font-semibold">{formatNumber(row.underTimeRecords.length)}</p>
                        </div>
                        <div className="rounded-lg border border-rose-200 bg-rose-50 p-3 text-rose-700">
                            <p className="text-[0.65rem] font-bold uppercase tracking-[0.12em] opacity-80">Over Break</p>
                            <p className="mt-1 text-sm font-semibold">{formatAttendanceDuration(row.totalOverBreakMs)}</p>
                        </div>
                    </div>

                    <div className="mt-5 overflow-hidden rounded-lg border border-slate-300 bg-white">
                        <div className="border-b border-slate-200 bg-slate-50 px-4 py-3">
                            <p className="text-xs font-semibold uppercase tracking-[0.12em] text-slate-500">All Punches Inside This Shift</p>
                        </div>
                        <div className="overflow-x-auto">
                            <table className="w-full min-w-[64rem] table-fixed border-separate border-spacing-0 text-left text-sm">
                                <colgroup>
                                    <col className="w-[16%]" />
                                    <col className="w-[12%]" />
                                    <col className="w-[18%]" />
                                    <col className="w-[18%]" />
                                    <col className="w-[18%]" />
                                    <col className="w-[18%]" />
                                </colgroup>
                                <thead className="bg-white text-[0.68rem] uppercase tracking-[0.12em] text-slate-500">
                                    <tr>
                                        <th className="px-3 py-3 font-semibold">Date</th>
                                        <th className="px-3 py-3 font-semibold">Time</th>
                                        <th className="px-3 py-3 font-semibold">Punch</th>
                                        <th className="px-3 py-3 font-semibold">Attendance Status</th>
                                        <th className="px-3 py-3 font-semibold">Issue</th>
                                        <th className="px-3 py-3 font-semibold">Record ID</th>
                                    </tr>
                                </thead>
                                <tbody className="divide-y divide-slate-200">
                                    {chronologicalShiftRecords.map((record) => {
                                        const statusText = getAttendanceStatusText(record);
                                        const isLate = statusText.includes("late");
                                        const isUnderTime = statusText.includes("under") || statusText.includes("undertime");
                                        const overBreakRow = row.overBreakRows.find((item) => item.id === record._id);

                                        return (
                                            <tr key={record._id} className="text-slate-700">
                                                <td className="px-3 py-3 font-semibold text-slate-900">{formatDateOrDash(record.timeIn)}</td>
                                                <td className="px-3 py-3">{formatPhTime(record.timeIn)}</td>
                                                <td className="px-3 py-3 font-semibold text-slate-950">{record.source || "Attendance"}</td>
                                                <td className="px-3 py-3">{getAttendanceStatusLabel(record)}</td>
                                                <td className="px-3 py-3">
                                                    <div className="flex flex-wrap gap-1.5">
                                                        {isLate && <span className="rounded-full bg-violet-100 px-2 py-1 text-[0.65rem] font-bold uppercase tracking-[0.08em] text-violet-700">Late</span>}
                                                        {isUnderTime && <span className="rounded-full bg-amber-100 px-2 py-1 text-[0.65rem] font-bold uppercase tracking-[0.08em] text-amber-700">Undertime</span>}
                                                        {overBreakRow && <span className="rounded-full bg-rose-100 px-2 py-1 text-[0.65rem] font-bold uppercase tracking-[0.08em] text-rose-700">Over Break</span>}
                                                        {!isLate && !isUnderTime && !overBreakRow && <span className="text-xs font-semibold text-slate-400">None</span>}
                                                    </div>
                                                </td>
                                                <td className="px-3 py-3 text-xs text-slate-500">{record._id}</td>
                                            </tr>
                                        );
                                    })}
                                </tbody>
                            </table>
                        </div>
                    </div>

                    <div className="mt-5 rounded-lg border border-slate-300 bg-white p-4">
                        <div className="flex flex-wrap items-center justify-between gap-3">
                            <p className="text-xs font-semibold uppercase tracking-[0.12em] text-slate-500">Over Break Details</p>
                            <span className="rounded-full bg-slate-100 px-2.5 py-1 text-[0.65rem] font-bold text-slate-500">Break 15m · Lunch 1h</span>
                        </div>

                        <div className="mt-3 space-y-2">
                            {chronologicalOverBreakRows.map((item) => (
                                <article key={item.id} className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-3 text-sm text-rose-700">
                                    <div className="flex flex-wrap items-start justify-between gap-3">
                                        <div>
                                            <p className="font-semibold text-rose-800">{item.label} over by {formatAttendanceDuration(item.overMs)}</p>
                                            <p className="mt-1 text-xs">Used {formatAttendanceDuration(item.durationMs)} of {formatAttendanceDuration(item.allowedMs)}</p>
                                            <p className="mt-1 text-xs text-slate-600">{formatPhDateTime(item.startedAt)} to {item.endedAt ? formatPhDateTime(item.endedAt) : "Open break"}</p>
                                        </div>
                                        <span className="rounded-full bg-white px-2 py-1 text-[0.65rem] font-bold uppercase tracking-[0.08em] text-rose-700">
                                            {item.isOpen ? "Open" : "Closed"}
                                        </span>
                                    </div>
                                </article>
                            ))}
                            {row.overBreakRows.length === 0 && (
                                <p className="rounded-lg border border-dashed border-slate-300 bg-slate-50 p-4 text-sm text-slate-500">No over-break records for this shift.</p>
                            )}
                        </div>
                    </div>
                </div>
            </section>
        </div>,
        document.body
    );
}

function AttendanceRecordDetailsModal({
    record,
    overBreakRow,
    onClose,
}: {
    record: AttendanceRecord;
    overBreakRow: AttendanceOverBreakRow | null;
    onClose: () => void;
}) {
    const statusText = getAttendanceStatusText(record);
    const isLate = statusText.includes("late");
    const isUnderTime = statusText.includes("under") || statusText.includes("undertime");
    const recordWithMeta = record as AttendanceRecord & {
        createdAt?: string | null;
        updatedAt?: string | null;
        notes?: string | null;
        remarks?: string | null;
    };

    return createPortal(
        <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/65 px-4 py-6 backdrop-blur-sm"
            onMouseDown={(event) => {
                if (event.target === event.currentTarget) {
                    onClose();
                }
            }}
        >
            <section
                className="flex max-h-[86vh] w-full max-w-2xl flex-col overflow-hidden rounded-lg border border-slate-300 bg-white text-slate-950 shadow-2xl shadow-slate-950/30"
                role="dialog"
                aria-modal="true"
                aria-labelledby="attendance-record-details-title"
            >
                <div className="flex items-start justify-between gap-4 border-b border-slate-200 bg-slate-50 px-5 py-4">
                    <div className="min-w-0">
                        <p className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">Attendance Record Details</p>
                        <h3 id="attendance-record-details-title" className="mt-1 truncate text-lg font-semibold text-slate-950">
                            {record.source || "Attendance"}
                        </h3>
                        <p className="mt-1 text-sm text-slate-600">{formatPhDateTime(record.timeIn)}</p>
                    </div>
                    <button
                        type="button"
                        className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-slate-300 bg-white text-slate-700 transition hover:border-violet-500 hover:text-violet-700"
                        onClick={onClose}
                        aria-label="Close attendance record details"
                    >
                        <FiX className="size-4" aria-hidden="true" />
                    </button>
                </div>

                <div className="content-scroll overflow-y-auto p-5">
                    <div className="grid gap-3 sm:grid-cols-2">
                        <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
                            <p className="text-[0.65rem] font-bold uppercase tracking-[0.12em] text-slate-500">Date</p>
                            <p className="mt-1 text-sm font-semibold text-slate-950">{formatDateOrDash(record.timeIn)}</p>
                        </div>
                        <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
                            <p className="text-[0.65rem] font-bold uppercase tracking-[0.12em] text-slate-500">Time</p>
                            <p className="mt-1 text-sm font-semibold text-slate-950">{formatPhTime(record.timeIn)}</p>
                        </div>
                        <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
                            <p className="text-[0.65rem] font-bold uppercase tracking-[0.12em] text-slate-500">Punch Type</p>
                            <p className="mt-1 text-sm font-semibold text-slate-950">{record.source || "Attendance"}</p>
                        </div>
                        <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
                            <p className="text-[0.65rem] font-bold uppercase tracking-[0.12em] text-slate-500">Attendance Status</p>
                            <p className="mt-1 text-sm font-semibold text-slate-950">{getAttendanceStatusLabel(record)}</p>
                        </div>
                    </div>

                    <div className="mt-4 rounded-lg border border-slate-200 bg-white p-3">
                        <p className="text-[0.65rem] font-bold uppercase tracking-[0.12em] text-slate-500">Flags</p>
                        <div className="mt-2 flex flex-wrap gap-2">
                            {isLate && <span className="rounded-full bg-violet-100 px-2.5 py-1 text-xs font-bold text-violet-700">Late</span>}
                            {isUnderTime && <span className="rounded-full bg-amber-100 px-2.5 py-1 text-xs font-bold text-amber-700">Undertime</span>}
                            {overBreakRow && <span className="rounded-full bg-rose-100 px-2.5 py-1 text-xs font-bold text-rose-700">Over Break</span>}
                            {!isLate && !isUnderTime && !overBreakRow && <span className="text-sm font-semibold text-slate-500">No issues found for this record.</span>}
                        </div>
                    </div>

                    {overBreakRow && (
                        <div className="mt-4 rounded-lg border border-rose-200 bg-rose-50 p-3 text-rose-800">
                            <p className="text-[0.65rem] font-bold uppercase tracking-[0.12em]">Over Break Details</p>
                            <div className="mt-3 grid gap-3 sm:grid-cols-2">
                                <div>
                                    <p className="text-xs font-semibold opacity-80">Break Type</p>
                                    <p className="text-sm font-semibold">{overBreakRow.label}</p>
                                </div>
                                <div>
                                    <p className="text-xs font-semibold opacity-80">Over By</p>
                                    <p className="text-sm font-semibold">{formatAttendanceDuration(overBreakRow.overMs)}</p>
                                </div>
                                <div>
                                    <p className="text-xs font-semibold opacity-80">Used Time</p>
                                    <p className="text-sm font-semibold">{formatAttendanceDuration(overBreakRow.durationMs)}</p>
                                </div>
                                <div>
                                    <p className="text-xs font-semibold opacity-80">Allowed Time</p>
                                    <p className="text-sm font-semibold">{formatAttendanceDuration(overBreakRow.allowedMs)}</p>
                                </div>
                                <div>
                                    <p className="text-xs font-semibold opacity-80">Started</p>
                                    <p className="text-sm font-semibold">{formatPhDateTime(overBreakRow.startedAt)}</p>
                                </div>
                                <div>
                                    <p className="text-xs font-semibold opacity-80">Ended</p>
                                    <p className="text-sm font-semibold">{overBreakRow.endedAt ? formatPhDateTime(overBreakRow.endedAt) : "Still running"}</p>
                                </div>
                            </div>
                        </div>
                    )}

                    <div className="mt-4 rounded-lg border border-slate-200 bg-slate-50 p-3">
                        <p className="text-[0.65rem] font-bold uppercase tracking-[0.12em] text-slate-500">Other Details</p>
                        <dl className="mt-3 grid gap-3 text-sm sm:grid-cols-2">
                            <div>
                                <dt className="text-xs font-semibold text-slate-500">Record ID</dt>
                                <dd className="mt-1 break-all font-semibold text-slate-800">{record._id}</dd>
                            </div>
                            <div>
                                <dt className="text-xs font-semibold text-slate-500">Created At</dt>
                                <dd className="mt-1 font-semibold text-slate-800">{recordWithMeta.createdAt ? formatPhDateTime(recordWithMeta.createdAt) : "No date"}</dd>
                            </div>
                            <div>
                                <dt className="text-xs font-semibold text-slate-500">Updated At</dt>
                                <dd className="mt-1 font-semibold text-slate-800">{recordWithMeta.updatedAt ? formatPhDateTime(recordWithMeta.updatedAt) : "No date"}</dd>
                            </div>
                            <div>
                                <dt className="text-xs font-semibold text-slate-500">Remarks</dt>
                                <dd className="mt-1 font-semibold text-slate-800">{recordWithMeta.remarks || recordWithMeta.notes || "No remarks"}</dd>
                            </div>
                        </dl>
                    </div>
                </div>
            </section>
        </div>,
        document.body
    );
}
void AttendanceRecordDetailsModal;

function RecentActivity({ logs }: { logs: EmployeeLeadLog[] }) {
    return (
        <section className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
            <div className="flex items-center justify-between gap-3">
                <div>
                    <p className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">Activity</p>
                    <h2 className="mt-1 text-base font-semibold text-slate-950">Recent lead actions</h2>
                </div>
                <FiMessageCircle className="size-5 text-violet-600" aria-hidden="true" />
            </div>

            <div className="mt-5 space-y-3">
                {logs.slice(0, 5).map((log) => (
                    <article key={log.id} className="rounded-lg border border-slate-200 bg-white px-3 py-2">
                        <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0">
                                <p className="truncate text-sm font-semibold text-slate-950">{log.action}</p>
                                <p className="mt-1 line-clamp-2 text-xs leading-5 text-slate-600">{log.detail || log.leadName}</p>
                            </div>
                            <span className="shrink-0 rounded-full bg-slate-100 px-2 py-1 text-[0.65rem] font-bold uppercase tracking-[0.08em] text-slate-600">{log.status}</span>
                        </div>
                        <p className="mt-2 text-xs text-slate-500">{formatActivityTime(log.createdAt)}</p>
                    </article>
                ))}
                {logs.length === 0 && <p className="rounded-lg border border-dashed border-slate-300 bg-slate-50 p-4 text-sm text-slate-500">No lead activity yet.</p>}
            </div>
        </section>
    );
}

function MyTasksTable({ tasks }: { tasks: CrmTask[] }) {
    const visibleTasks = [...tasks]
        .sort((first, second) => {
            const firstDone = first.status === "Done" ? 1 : 0;
            const secondDone = second.status === "Done" ? 1 : 0;
            if (firstDone !== secondDone) return firstDone - secondDone;
            return new Date(first.dueAt || first.createdAt || 0).getTime() - new Date(second.dueAt || second.createdAt || 0).getTime();
        })
        .slice(0, 6);

    return (
        <section className="overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm xl:col-span-2">
            <div className="flex items-center justify-between gap-3 px-5 py-4">
                <div>
                    <p className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">My Tasks</p>
                    <h2 className="mt-1 text-base font-semibold text-slate-950">Next work items</h2>
                </div>
                <Link className="text-sm font-semibold text-violet-700 hover:text-violet-900" to="/tasks">
                    View all
                </Link>
            </div>
            <div className="overflow-x-auto">
                <table className="w-full min-w-[44rem] text-left text-sm">
                    <thead className="border-y border-slate-200 bg-slate-50 text-xs font-semibold uppercase tracking-[0.12em] text-slate-500">
                        <tr>
                            <th className="px-5 py-3">Task</th>
                            <th className="px-5 py-3">Lead</th>
                            <th className="px-5 py-3">Due</th>
                            <th className="px-5 py-3">Priority</th>
                            <th className="px-5 py-3">Status</th>
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-200">
                        {visibleTasks.map((task) => (
                            <tr key={task._id} className="text-slate-700">
                                <td className="px-5 py-3 font-semibold text-slate-950">{task.title}</td>
                                <td className="px-5 py-3">{task.relatedLead?.businessName || task.relatedLead?.leadName || "-"}</td>
                                <td className="px-5 py-3">{formatDateOrDash(task.dueAt)}</td>
                                <td className="px-5 py-3">
                                    <span className={`rounded-full border px-2 py-1 text-xs font-semibold ${priorityClass[task.priority] || priorityClass.Medium}`}>{task.priority}</span>
                                </td>
                                <td className="px-5 py-3">
                                    <span className="rounded-full border border-slate-200 bg-slate-50 px-2 py-1 text-xs font-semibold text-slate-700">{task.status}</span>
                                </td>
                            </tr>
                        ))}
                        {visibleTasks.length === 0 && (
                            <tr>
                                <td className="px-5 py-8 text-center text-sm text-slate-500" colSpan={5}>
                                    No assigned tasks yet.
                                </td>
                            </tr>
                        )}
                    </tbody>
                </table>
            </div>
        </section>
    );
}

function EmployeeLeadCallsModal({
    row,
    onClose,
}: {
    row: EmployeeCallSummaryRow;
    onClose: () => void;
}) {

    const navigate = useNavigate();

    const openLead = (leadId: string) => {
        onClose();
        navigate(`/leads?lead=${leadId}`);
    };

    return createPortal(
        <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/65 px-4 py-6 backdrop-blur-sm"
            onMouseDown={(event) => {
                if (event.target === event.currentTarget) {
                    onClose();
                }
            }}
        >
            <section
                className="flex max-h-[86vh] w-full max-w-5xl flex-col overflow-hidden rounded-lg border border-slate-300 bg-white text-slate-950 shadow-2xl shadow-slate-950/30"
                role="dialog"
                aria-modal="true"
                aria-labelledby="employee-lead-calls-title"
            >
                <div className="flex items-start justify-between gap-4 border-b border-slate-200 bg-slate-50 px-5 py-4">
                    <div className="min-w-0">
                        <p className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">
                            Employee Lead Calls
                        </p>

                        <h3
                            id="employee-lead-calls-title"
                            className="mt-1 truncate text-lg font-semibold text-slate-950"
                        >
                            {row.employeeName}
                        </h3>

                        <p className="mt-1 text-sm text-slate-600">
                            Showing {formatNumber(row.leads.length)} lead record
                            {row.leads.length === 1 ? "" : "s"} and{" "}
                            {formatNumber(row.totalAttempts)} total attempt
                            {row.totalAttempts === 1 ? "" : "s"}.
                        </p>
                    </div>

                    <button
                        type="button"
                        className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-slate-300 bg-white text-slate-700 transition hover:border-[#842cff] hover:text-[#6426d9]"
                        onClick={onClose}
                        aria-label="Close employee lead calls"
                    >
                        <FiX className="size-4" aria-hidden="true" />
                    </button>
                </div>

                <div className="content-scroll overflow-y-auto p-4">
                    {row.leads.length === 0 ? (
                        <EmptyPanel
                            title="No lead call records"
                            message="This employee has no lead call records attached."
                        />
                    ) : (
                        <div className="overflow-x-auto rounded-lg border border-slate-300 bg-white">
                            <table className="w-full min-w-[60rem] table-fixed border-separate border-spacing-0">
                                <colgroup>
                                    <col className="w-[24%]" />
                                    <col className="w-[24%]" />
                                    <col className="w-[11%]" />
                                    <col className="w-[14%]" />
                                    <col className="w-[12%]" />
                                    <col className="w-[15%]" />
                                </colgroup>
                                <thead className="bg-slate-50 text-[0.68rem] uppercase tracking-[0.12em] text-slate-500">
                                    <tr>
                                        <th className="px-3 py-3 text-left font-semibold">Lead</th>
                                        <th className="px-3 py-3 text-left font-semibold">Business</th>
                                        <th className="px-3 py-3 text-center font-semibold">Connected</th>
                                        <th className="px-3 py-3 text-center font-semibold">Not Connected</th>
                                        <th className="px-3 py-3 text-center font-semibold">Voicemails</th>
                                        <th className="px-3 py-3 text-left font-semibold">Last Call</th>
                                    </tr>
                                </thead>
                                <tbody className="divide-y divide-slate-200">
                                    {row.leads.map((lead) => (
                                        <tr
                                            key={lead.leadId}
                                            role="link"
                                            tabIndex={0}
                                            className="cursor-pointer text-sm text-slate-700 transition hover:bg-emerald-50/60 focus:bg-emerald-50/60 focus:outline-none focus:ring-2 focus:ring-inset focus:ring-emerald-300"
                                            onClick={() => openLead(lead.leadId)}
                                            onKeyDown={(event) => {
                                                if (event.key === "Enter" || event.key === " ") {
                                                    event.preventDefault();
                                                    openLead(lead.leadId);
                                                }
                                            }}
                                        >
                                            <td className="px-3 py-3">
                                                <p className="truncate font-semibold text-slate-950">
                                                    {lead.leadName || "No lead name"}
                                                </p>

                                                <p className="mt-0.5 truncate text-xs text-slate-500">
                                                    {lead.leadId}
                                                </p>
                                            </td>

                                            <td className="px-3 py-3">
                                                <p className="truncate font-semibold text-slate-800">
                                                    {lead.businessName || "No business name"}
                                                </p>
                                            </td>

                                            <td className="px-3 py-3 text-center font-semibold text-slate-950">
                                                {formatNumber(lead.callCount)}
                                            </td>

                                            <td className="px-3 py-3 text-center font-semibold text-rose-600">
                                                {formatNumber(lead.callNotConnectedCount)}
                                            </td>

                                            <td className="px-3 py-3 text-center font-semibold text-blue-600">
                                                {formatNumber(lead.callVoicemailCount)}
                                            </td>

                                            <td className="px-3 py-3 text-sm text-slate-600">
                                                {lead.lastCallAt ? formatPhDateTime(lead.lastCallAt) : "No date"}
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    )}
                </div>
            </section>
        </div>,
        document.body
    );
}

function EmptyPanel({ title, message }: { title: string; message: string }) {
    return (
        <div className="rounded-lg border border-dashed border-slate-300 bg-slate-50 p-6 text-center">
            <p className="text-sm font-semibold text-slate-800">{title}</p>
            <p className="mt-1 text-sm text-slate-500">{message}</p>
        </div>
    );
}

type EmployeeLeadCallRow = {
    leadId: string;
    leadName: string;
    businessName: string;
    callCount: number;
    callNotConnectedCount: number;
    callVoicemailCount: number;
    totalAttempts: number;
    lastCallAt: string | null;
    callLogs: NonNullable<LeadCallStat["callLogs"]>;
};

type EmployeeCallSummaryRow = {
    employeeId: string;
    employeeName: string;
    employeeRole: string;
    employeeTeam: string;
    totalCalls: number;
    totalNotConnectedCalls: number;
    totalVoicemails: number;
    totalAttempts: number;
    lastCallAt: string | null;
    leads: EmployeeLeadCallRow[];
};

function getDateTimeValue(value?: string | null) {
    const timestamp = value ? new Date(value).getTime() : 0;
    return Number.isNaN(timestamp) ? 0 : timestamp;
}

function getLatestDateValue(first?: string | null, second?: string | null) {
    return getDateTimeValue(first) >= getDateTimeValue(second) ? first || null : second || null;
}

function getLeadCallStatLeadId(item: LeadCallStat) {
    if (typeof item.lead === "string") {
        return item.lead;
    }

    return item.lead?._id || item._id || `${item.leadName}-${item.businessName}`;
}

function buildEmployeeCallRows(leadCallStats: LeadCallStat[]): EmployeeCallSummaryRow[] {
    const rowsByEmployee = new Map<string, EmployeeCallSummaryRow>();

    leadCallStats.forEach((item) => {
        const leadId = getLeadCallStatLeadId(item);
        const leadName = item.leadName || "No lead name";
        const businessName = item.businessName || "No business name";

        (item.callLogs || []).forEach((log) => {
            const employeeId =
                getCallLogEmployeeId(log) ||
                `employee-name:${String(log.employeeName || "Employee")
                    .trim()
                    .toLowerCase()}`;

            if (!employeeId) {
                return;
            }

            const outcome =
                log.outcome === "not_connected"
                    ? "not_connected"
                    : log.outcome === "voicemail"
                      ? "voicemail"
                      : "connected";

            const calledAt =
                log.calledAt ||
                (outcome === "not_connected"
                    ? item.lastNotConnectedAt
                    : outcome === "voicemail"
                      ? item.lastVoicemailAt
                      : item.lastCallAt) ||
                item.updatedAt ||
                null;

            if (!rowsByEmployee.has(employeeId)) {
                rowsByEmployee.set(employeeId, {
                    employeeId,
                    employeeName: log.employeeName || "Employee",
                    employeeRole: log.employeeRole || "",
                    employeeTeam: log.employeeTeam || "",
                    totalCalls: 0,
                    totalNotConnectedCalls: 0,
                    totalVoicemails: 0,
                    totalAttempts: 0,
                    lastCallAt: null,
                    leads: [],
                });
            }

            const employeeRow = rowsByEmployee.get(employeeId)!;

            employeeRow.employeeName = log.employeeName || employeeRow.employeeName;
            employeeRow.employeeRole = log.employeeRole || employeeRow.employeeRole;
            employeeRow.employeeTeam = log.employeeTeam || employeeRow.employeeTeam;

            employeeRow.totalAttempts += 1;
            employeeRow.lastCallAt = getLatestDateValue(employeeRow.lastCallAt, calledAt);

            if (outcome === "not_connected") {
                employeeRow.totalNotConnectedCalls += 1;
            } else if (outcome === "voicemail") {
                employeeRow.totalVoicemails += 1;
            } else {
                employeeRow.totalCalls += 1;
            }

            let leadRow = employeeRow.leads.find((lead) => lead.leadId === leadId);

            if (!leadRow) {
                leadRow = {
                    leadId,
                    leadName,
                    businessName,
                    callCount: 0,
                    callNotConnectedCount: 0,
                    callVoicemailCount: 0,
                    totalAttempts: 0,
                    lastCallAt: null,
                    callLogs: [],
                };

                employeeRow.leads.push(leadRow);
            }

            leadRow.totalAttempts += 1;
            leadRow.lastCallAt = getLatestDateValue(leadRow.lastCallAt, calledAt);
            leadRow.callLogs.push({
                ...log,
                outcome,
                calledAt: calledAt || log.calledAt,
            });

            if (outcome === "not_connected") {
                leadRow.callNotConnectedCount += 1;
            } else if (outcome === "voicemail") {
                leadRow.callVoicemailCount += 1;
            } else {
                leadRow.callCount += 1;
            }
        });
    });

    return Array.from(rowsByEmployee.values())
        .map((employeeRow) => ({
            ...employeeRow,
            leads: employeeRow.leads.sort(
                (first, second) =>
                    getDateTimeValue(second.lastCallAt) -
                    getDateTimeValue(first.lastCallAt)
            ),
        }))
        .sort(
            (first, second) =>
                getDateTimeValue(second.lastCallAt) -
                getDateTimeValue(first.lastCallAt)
        );
}

function getAuthEmployeeId() {
    const authUser = getAuthUser() as {
        user?:
        | {
            _id?: string;
            id?: string;
        }
        | null;
    } | null;

    const user = authUser?.user;

    if (!user) {
        return "";
    }

    return String(user._id || user.id || "");
}

function getCallLogEmployeeId(log: LeadCallStat["callLogs"][number]) {
    if (typeof log.employee === "string") {
        return log.employee;
    }

    return log.employee?._id || "";
}

function getDateStart(value: string) {
    const date = parseDateInputValue(value);

    if (!date) {
        return null;
    }

    date.setHours(0, 0, 0, 0);
    return date;
}

function getDateEnd(value: string) {
    const date = parseDateInputValue(value);

    if (!date) {
        return null;
    }

    date.setHours(23, 59, 59, 999);
    return date;
}






// date picker helper
function formatTimeInputValue(date: Date) {
    const hours = String(date.getHours()).padStart(2, "0");
    const minutes = String(date.getMinutes()).padStart(2, "0");

    return `${hours}:${minutes}`;
}

function combineDateAndTime(dateValue: string, timeValue: string) {
    if (!dateValue) {
        return "";
    }

    const safeTime = timeValue || "00:00";

    return `${dateValue}T${safeTime}`;
}

function getCallLogTime(value?: string | null) {
    if (!value) {
        return 0;
    }

    const time = new Date(value).getTime();

    return Number.isNaN(time) ? 0 : time;
}

function isCallLogWithinDateTimeRange(
    calledAt: string | undefined,
    dateFrom: string,
    timeFrom: string,
    dateTo: string,
    timeTo: string
) {
    if (!calledAt) {
        return false;
    }

    const calledTime = getCallLogTime(calledAt);

    if (!calledTime) {
        return false;
    }

    const fromDateTime = dateFrom ? combineDateAndTime(dateFrom, timeFrom || "00:00") : "";
    const toDateTime = dateTo ? combineDateAndTime(dateTo, timeTo || "23:59") : "";

    const startTime = fromDateTime ? new Date(fromDateTime).getTime() : null;
    const endTime = toDateTime ? new Date(toDateTime).getTime() : null;

    if (startTime && calledTime < startTime) {
        return false;
    }

    if (endTime && calledTime > endTime) {
        return false;
    }

    return true;
}

function filterLeadCallStatsByDateTimeRange(
    leadCallStats: LeadCallStat[],
    dateFrom: string,
    timeFrom: string,
    dateTo: string,
    timeTo: string
) {
    return leadCallStats
        .map((item) => {
            const filteredCallLogs = (item.callLogs || []).filter((log) =>
                isCallLogWithinDateTimeRange(
                    log.calledAt,
                    dateFrom,
                    timeFrom,
                    dateTo,
                    timeTo
                )
            );

            const connectedLogs = filteredCallLogs.filter(
                (log) => (log.outcome || "connected") === "connected"
            );

            const notConnectedLogs = filteredCallLogs.filter(
                (log) => log.outcome === "not_connected"
            );

            const voicemailLogs = filteredCallLogs.filter(
                (log) => log.outcome === "voicemail"
            );

            const latestLog = [...filteredCallLogs].sort((first, second) => {
                return getCallLogTime(second.calledAt) - getCallLogTime(first.calledAt);
            })[0];

            return {
                ...item,
                callLogs: filteredCallLogs,
                callCount: connectedLogs.length,
                callNotConnectedCount: notConnectedLogs.length,
                callVoicemailCount: voicemailLogs.length,
                lastCallAt: latestLog?.calledAt || null,
            };
        })
        .filter((item) => item.callLogs.length > 0);
}

void buildEmployeeCallRows;
void filterLeadCallStatsByDateTimeRange;

export default function WorkspaceDashboard({ userName, employee }: WorkspaceDashboardProps) {
    const employeeId = employee?._id || "";

    const employeeQuery = useQuery({
        queryKey: ["employee-dashboard-profile", employeeId],
        queryFn: () => getEmployeeSummary(employeeId),
        enabled: Boolean(employeeId),
    });

    const currentEmployee = employeeQuery.data || employee || null;
    const names = useMemo(() => employeeNameSet(currentEmployee), [currentEmployee]);
    const namesKey = names.join("|");

    const tasksQuery = useQuery({
        queryKey: ["employee-dashboard-tasks", employeeId],
        queryFn: () => getTasks({ assignedTo: employeeId }),
        enabled: Boolean(employeeId),
    });

    const leadCountsQuery = useQuery({
        queryKey: ["employee-dashboard-lead-counts", employeeId, namesKey],
        queryFn: () => getMyLeadCounts({ employeeId, employeeNames: names }),
        enabled: Boolean(employeeId),
    });

    const queueQuery = useQuery({
        queryKey: ["employee-dashboard-lead-queue", employeeId, namesKey],
        queryFn: () => getMyLeads({ employeeId, employeeNames: names, page: 1, limit: 6, tab: "my" }),
        enabled: Boolean(employeeId),
    });

    const logsQuery = useQuery({
        queryKey: ["employee-dashboard-lead-logs", currentEmployee?.name || userName],
        queryFn: () => getEmployeeLeadLogs({ employee: currentEmployee?.name || userName, limit: 6 }),
        enabled: Boolean(currentEmployee?.name || userName),
    });

    const noticesQuery = useQuery({
        queryKey: ["employee-dashboard-notices", employeeId],
        queryFn: () => getEmployeeNotices(employeeId),
        enabled: Boolean(employeeId),
    });

    const attendanceQuery = useQuery({
        queryKey: ["employee-dashboard-attendance", employeeId],
        queryFn: () => getEmployeeAttendance(employeeId),
        enabled: Boolean(employeeId),
    });

    const announcementsQuery = useQuery({
        queryKey: ["employee-dashboard-announcements"],
        queryFn: () => getKnowledgeBaseEntries("Article"),
        enabled: Boolean(employeeId),
    });

    const tasks = tasksQuery.data || [];
    const announcements = announcementsQuery.data || [];
    const counts = leadCountsQuery.data;
    const notices = noticesQuery.data || [];
    const attendance = attendanceQuery.data || [];
    const queueLeads = queueQuery.data?.leads || [];
    const recentLogs = logsQuery.data || [];
    const openTasks = countOpenTasks(tasks);
    const dueTasks = countDueTasks(tasks);
    const unreadNotices = countUnreadNotices(notices);
    const isLoading = tasksQuery.isLoading || leadCountsQuery.isLoading || queueQuery.isLoading || noticesQuery.isLoading || attendanceQuery.isLoading || announcementsQuery.isLoading;
    const hasError = tasksQuery.isError || leadCountsQuery.isError || queueQuery.isError || noticesQuery.isError || attendanceQuery.isError || announcementsQuery.isError;

    const stats: DashboardStat[] = [
        {
            label: "Assigned Leads",
            value: leadCount(counts, "ALL"),
            detail: `${leadCount(counts, "Follow up")} follow-ups in queue`,
            tone: "violet",
            icon: FiTarget,
        },
        {
            label: "Contacted Today",
            value: leadCount(counts, "ContactedToday"),
            detail: "Leads already touched today",
            tone: "emerald",
            icon: FiPhoneCall,
        },
        {
            label: "Open Tasks",
            value: openTasks,
            detail: `${tasks.filter((task) => task.status === "In Progress").length} in progress`,
            tone: "sky",
            icon: FiBriefcase,
        },
        {
            label: "Due / Unread",
            value: `${dueTasks}/${unreadNotices}`,
            detail: "Due tasks / unread notices",
            tone: dueTasks || unreadNotices ? "amber" : "emerald",
            icon: dueTasks || unreadNotices ? FiAlertCircle : FiCheckCircle,
        },
    ];

    // call logger

    function getDateStart(value: string) {
        const date = parseDateInputValue(value);

        if (!date) {
            return null;
        }

        date.setHours(0, 0, 0, 0);
        return date;
    }

    function getDateEnd(value: string) {
        const date = parseDateInputValue(value);

        if (!date) {
            return null;
        }

        date.setHours(23, 59, 59, 999);
        return date;
    }

    function getCallLogTime(value?: string | null) {
        if (!value) {
            return 0;
        }

        const time = new Date(value).getTime();

        return Number.isNaN(time) ? 0 : time;
    }

    function isCallLogWithinDateRange(
        calledAt: string | undefined,
        dateFrom: string,
        dateTo: string
    ) {
        if (!calledAt) {
            return false;
        }

        const calledTime = getCallLogTime(calledAt);

        if (!calledTime) {
            return false;
        }

        const startDate = dateFrom ? getDateStart(dateFrom) : null;
        const endDate = dateTo ? getDateEnd(dateTo) : null;

        if (startDate && calledTime < startDate.getTime()) {
            return false;
        }

        if (endDate && calledTime > endDate.getTime()) {
            return false;
        }

        return true;
    }

    function getLatestCallLog(callLogs: LeadCallStat["callLogs"]) {
        return [...callLogs].sort((first, second) => {
            return getCallLogTime(second.calledAt) - getCallLogTime(first.calledAt);
        })[0];
    }

    function filterLeadCallStatsByDateRange(
        leadCallStats: LeadCallStat[],
        dateFrom: string,
        dateTo: string
    ) {
        return leadCallStats
            .map((item) => {
                const filteredCallLogs = (item.callLogs || []).filter((log) =>
                    isCallLogWithinDateRange(log.calledAt, dateFrom, dateTo)
                );

                const connectedLogs = filteredCallLogs.filter(
                    (log) => (log.outcome || "connected") === "connected"
                );

                const notConnectedLogs = filteredCallLogs.filter(
                    (log) => log.outcome === "not_connected"
                );

                const voicemailLogs = filteredCallLogs.filter(
                    (log) => log.outcome === "voicemail"
                );

                const latestLog = getLatestCallLog(filteredCallLogs);

                return {
                    ...item,
                    callLogs: filteredCallLogs,
                    callCount: connectedLogs.length,
                    callNotConnectedCount: notConnectedLogs.length,
                    callVoicemailCount: voicemailLogs.length,
                    lastCallAt: latestLog?.calledAt || null,
                };
            })
            .filter((item) => item.callLogs.length > 0);
    }
    void filterLeadCallStatsByDateRange;


    // call logger logic

    const authEmployeeId = useMemo(() => {
        return employeeId || getAuthEmployeeId();
    }, [employeeId]);

    const [selectedCallEmployeeRow, setSelectedCallEmployeeRow] =
        useState<EmployeeCallSummaryRow | null>(null);

    const [callFilterDateFrom, setCallFilterDateFrom] = useState("");

    const [callFilterTimeFrom, setCallFilterTimeFrom] = useState("23:00");

    const [callFilterDateTo, setCallFilterDateTo] = useState("");

    const [callFilterTimeTo, setCallFilterTimeTo] = useState("08:00");


    const leadCallStatsQuery = useQuery({
        queryKey: ["lead-call-summary", "me", authEmployeeId, callFilterDateFrom, callFilterTimeFrom, callFilterDateTo, callFilterTimeTo],
        queryFn: () => getMyLeadCallSummary({
            employeeId: authEmployeeId,
            from: callFilterDateFrom
                ? new Date(combineDateAndTime(callFilterDateFrom, callFilterTimeFrom || "00:00")).toISOString()
                : undefined,
            to: callFilterDateTo
                ? new Date(combineDateAndTime(callFilterDateTo, callFilterTimeTo || "23:59")).toISOString()
                : undefined,
        }),
        enabled: Boolean(authEmployeeId),
        refetchInterval: 60_000,
    });

    const employeeCallRows = useMemo(() => {
        return (leadCallStatsQuery.data || []).map((row) => ({
            ...row,
            leads: row.leads.map((lead) => ({ ...lead, callLogs: [] })),
        }));
    }, [leadCallStatsQuery.data]);

    const totalCallLeadCount = useMemo(
        () => new Set(employeeCallRows.flatMap((row) => row.leads.map((lead) => lead.leadId))).size,
        [employeeCallRows]
    );

    const totalLoggedLeadCalls = useMemo(() => {
        return employeeCallRows.reduce((total, item) => total + item.totalCalls, 0);
    }, [employeeCallRows]);

    const totalNotConnectedCalls = useMemo(() => {
        return employeeCallRows.reduce(
            (total, item) => total + item.totalNotConnectedCalls,
            0
        );
    }, [employeeCallRows]);

    const totalVoicemails = useMemo(() => {
        return employeeCallRows.reduce(
            (total, item) => total + item.totalVoicemails,
            0
        );
    }, [employeeCallRows]);

    const totalCallAttempts = useMemo(() => {
        return totalLoggedLeadCalls + totalNotConnectedCalls + totalVoicemails;
    }, [totalLoggedLeadCalls, totalNotConnectedCalls, totalVoicemails]);

    const clearCallFilters = () => {
        setCallFilterDateFrom("");
        setCallFilterTimeFrom("");
        setCallFilterDateTo("");
        setCallFilterTimeTo("");
    };

    const applyTodayCallFilter = () => {
        const today = new Date();
        const tomorrow = new Date(today);

        tomorrow.setDate(tomorrow.getDate() + 1);

        setCallFilterDateFrom(formatDateInputValue(today));
        setCallFilterTimeFrom("23:00");

        setCallFilterDateTo(formatDateInputValue(tomorrow));
        setCallFilterTimeTo("08:00");
    };

    const applyThisMonthCallFilter = () => {
        const today = new Date();
        const firstDay = new Date(today.getFullYear(), today.getMonth(), 1);

        setCallFilterDateFrom(formatDateInputValue(firstDay));
        setCallFilterTimeFrom("00:00");

        setCallFilterDateTo(formatDateInputValue(today));
        setCallFilterTimeTo(formatTimeInputValue(today));
    };

    if (!employeeId) {
        return (
            <section className="rounded-lg border border-amber-200 bg-amber-50 p-5 text-amber-800">
                <h1 className="text-lg font-semibold">Employee dashboard unavailable</h1>
                <p className="mt-2 text-sm">Log in with an employee code to view assigned leads, tasks, attendance, and notices.</p>
            </section>
        );
    }


    return (
        <section className="space-y-5 text-slate-950">
            <div className="flex flex-wrap items-start justify-between gap-4">
                <div>
                    <p className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">Employee Workspace</p>
                    <h1 className="mt-1 text-2xl font-semibold text-slate-950">Welcome back, {currentEmployee?.name || userName}</h1>
                    <p className="mt-1 text-sm text-slate-600">Your leads, tasks, attendance, and notices are loaded from the CRM database in PH time.</p>
                </div>
                <div className="flex flex-wrap gap-2">
                    <span className={`inline-flex h-10 items-center rounded-lg border px-3 text-sm font-bold ${statusBadgeClass(currentEmployee?.availabilityStatus)}`}>
                        {normalizeEmployeeAvailabilityStatus(currentEmployee?.availabilityStatus)}
                    </span>
                    <Link className="inline-flex h-10 items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 text-sm font-semibold text-slate-700 shadow-sm transition hover:bg-slate-50" to="/attendance">
                        <FiCalendar className="size-4" aria-hidden="true" />
                        Attendance
                    </Link>
                </div>
            </div>

            {isLoading && <p className="rounded-lg border border-slate-200 bg-white p-3 text-sm font-semibold text-slate-600">Loading dashboard data...</p>}
            {hasError && <p className="rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm font-semibold text-rose-700">Some dashboard data could not be loaded. The available sections are still shown.</p>}

            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
                {stats.map((stat) => (
                    <StatCard key={stat.label} stat={stat} />
                ))}
            </div>

            <div className="grid gap-4 xl:grid-cols-[1.2fr_0.8fr]">
                <AnnouncementsPanel announcements={announcements} />
                <div className="xl:col-span-2">
                    <EmployeeAgentProductivity />
                </div>

                {/* Call logger */}
                <div className="flex w-full flex-col col-span-2 rounded-lg border border-slate-200 bg-white p-4 text-slate-950 shadow-sm">
                    <div className="flex flex-wrap items-center justify-between gap-3 py-4 pb-6">
                        <div>
                            <p className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">
                                Log Call Counts
                            </p>

                            <h3 className="mt-1 text-base font-semibold text-slate-900">
                                {leadCallStatsQuery.isLoading || leadCallStatsQuery.isFetching
                                    ? "Loading call data"
                                    : `${formatNumber(totalLoggedLeadCalls)} connected calls`}
                            </h3>

                            <p className="mt-1 text-xs font-semibold text-rose-600">
                                {formatNumber(totalNotConnectedCalls)} not connected
                            </p>

                            <p className="mt-1 text-xs font-semibold text-blue-600">
                                {formatNumber(totalVoicemails)} voicemails
                            </p>

                            <p className="mt-1 text-xs font-semibold text-slate-500">
                                {formatNumber(totalCallAttempts)} total attempt
                                {totalCallAttempts === 1 ? "" : "s"}
                            </p>
                        </div>

                        <div className="flex flex-wrap items-center gap-3">
                            <label className="flex flex-col gap-1">
                                <span className="text-[0.65rem] font-semibold uppercase tracking-[0.12em] text-slate-500">
                                    From
                                </span>

                                <div className="flex gap-2">
                                    <input
                                        type="date"
                                        className="h-9 rounded-lg border border-slate-300 bg-white px-3 text-sm font-semibold text-slate-800 outline-none transition focus:border-[#842cff] focus:ring-2 focus:ring-[#842cff]/20"
                                        value={callFilterDateFrom}
                                        onChange={(event) => setCallFilterDateFrom(event.target.value)}
                                    />

                                    <input
                                        type="time"
                                        className="h-9 w-32 rounded-lg border border-slate-300 bg-white px-3 text-sm font-semibold text-slate-800 outline-none transition focus:border-[#842cff] focus:ring-2 focus:ring-[#842cff]/20"
                                        value={callFilterTimeFrom}
                                        onChange={(event) => setCallFilterTimeFrom(event.target.value)}
                                    />
                                </div>
                            </label>

                            <label className="flex flex-col gap-1">
                                <span className="text-[0.65rem] font-semibold uppercase tracking-[0.12em] text-slate-500">
                                    To
                                </span>

                                <div className="flex gap-2">
                                    <input
                                        type="date"
                                        className="h-9 rounded-lg border border-slate-300 bg-white px-3 text-sm font-semibold text-slate-800 outline-none transition focus:border-[#842cff] focus:ring-2 focus:ring-[#842cff]/20"
                                        value={callFilterDateTo}
                                        onChange={(event) => setCallFilterDateTo(event.target.value)}
                                    />

                                    <input
                                        type="time"
                                        className="h-9 w-32 rounded-lg border border-slate-300 bg-white px-3 text-sm font-semibold text-slate-800 outline-none transition focus:border-[#842cff] focus:ring-2 focus:ring-[#842cff]/20"
                                        value={callFilterTimeTo}
                                        onChange={(event) => setCallFilterTimeTo(event.target.value)}
                                    />
                                </div>
                            </label>

                            <button
                                type="button"
                                className="mt-5 h-9 rounded-lg border border-slate-300 bg-white px-3 text-sm font-semibold text-slate-700 transition hover:border-[#842cff]/40 hover:text-[#6426d9]"
                                onClick={applyTodayCallFilter}
                            >
                                Today
                            </button>

                            <button
                                type="button"
                                className="mt-5 h-9 rounded-lg border border-slate-300 bg-white px-3 text-sm font-semibold text-slate-700 transition hover:border-[#842cff]/40 hover:text-[#6426d9]"
                                onClick={applyThisMonthCallFilter}
                            >
                                This Month
                            </button>

                            <button
                                type="button"
                                className="mt-5 h-9 rounded-lg border border-slate-300 bg-white px-3 text-sm font-semibold text-slate-700 transition hover:border-[#842cff]/40 hover:text-[#6426d9] disabled:cursor-not-allowed disabled:opacity-50"
                                onClick={clearCallFilters}
                                disabled={
                                    !callFilterDateFrom &&
                                    !callFilterTimeFrom &&
                                    !callFilterDateTo &&
                                    !callFilterTimeTo
                                }
                            >
                                Clear
                            </button>

                            <span className="mt-5 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm font-semibold text-emerald-700">
                                {formatNumber(totalCallLeadCount)} lead
                                {totalCallLeadCount === 1 ? "" : "s"}
                            </span>

                            <Link
                                className="mt-5 inline-flex h-9 items-center gap-2 rounded-lg bg-[#842cff] px-3 text-sm font-semibold text-white transition hover:brightness-110"
                                to="/leads"
                            >
                                <FiTarget className="size-4" aria-hidden="true" />
                                Manage Leads
                            </Link>
                        </div>
                    </div>

                    {!authEmployeeId ? (
                        <div className="mt-4">
                            <EmptyPanel
                                title="User not found"
                                message="The logged-in user ID could not be found, so call data cannot be filtered."
                            />
                        </div>
                    ) : leadCallStatsQuery.isLoading || leadCallStatsQuery.isFetching ? (
                        <div className="mt-4">
                            <EmptyPanel
                                title="Loading call counts"
                                message="Getting your logged calls from the call stats table."
                            />
                        </div>
                    ) : employeeCallRows.length === 0 ? (
                        <div className="mt-4">
                            <EmptyPanel
                                title="No logged calls in this date range"
                                message="Try changing the From and To date filters, or log a call first."
                            />
                        </div>
                    ) : (
                        <div className="overflow-x-auto rounded-lg border border-slate-300 bg-white">
                            <table className="w-full min-w-[54rem] table-fixed border-separate border-spacing-0">
                                <colgroup>
                                    <col className="w-[25%]" />
                                    <col className="w-[12%]" />
                                    <col className="w-[15%]" />
                                    <col className="w-[14%]" />
                                    <col className="w-[12%]" />
                                    <col className="w-[22%]" />
                                </colgroup>

                                <thead className="bg-white text-[0.68rem] uppercase tracking-[0.12em] text-slate-500">
                                    <tr>
                                        <th className="px-3 py-3 text-left font-semibold">
                                            Employee
                                        </th>
                                        <th className="px-3 py-3 text-center font-semibold">
                                            Connected
                                        </th>
                                        <th className="px-3 py-3 text-center font-semibold">
                                            Not Connected
                                        </th>
                                        <th className="px-3 py-3 text-center font-semibold">
                                            Voicemails
                                        </th>
                                        <th className="px-3 py-3 text-center font-semibold">
                                            Leads
                                        </th>
                                        <th className="px-3 py-3 text-left font-semibold">
                                            Last Call
                                        </th>
                                    </tr>
                                </thead>

                                <tbody className="divide-y divide-slate-200">
                                    {employeeCallRows.map((row) => (
                                        <tr
                                            key={row.employeeId}
                                            className="text-sm text-slate-700 transition hover:bg-emerald-50/60"
                                        >
                                            <td className="px-3 py-3">
                                                <p className="truncate font-semibold text-slate-800">
                                                    {row.employeeName || "No employee"}
                                                </p>

                                                {(row.employeeRole || row.employeeTeam) && (
                                                    <p className="mt-0.5 truncate text-xs text-slate-500">
                                                        {[row.employeeRole, row.employeeTeam]
                                                            .filter(Boolean)
                                                            .join(" · ")}
                                                    </p>
                                                )}
                                            </td>

                                            <td className="px-3 py-3 text-center font-semibold text-slate-950">
                                                <button
                                                    type="button"
                                                    className="inline-flex h-8 items-center justify-center rounded-md border border-emerald-200 bg-emerald-50 px-3 text-xs font-semibold text-emerald-700 transition hover:border-emerald-400 hover:bg-emerald-100 focus:outline-none focus:ring-2 focus:ring-emerald-300"
                                                    onClick={() => setSelectedCallEmployeeRow(row)}
                                                >
                                                    {formatNumber(row.totalCalls)}
                                                </button>
                                            </td>

                                            <td className="px-3 py-3 text-center font-semibold text-rose-600">
                                                <button
                                                    type="button"
                                                    className="inline-flex h-8 items-center justify-center rounded-md border border-rose-200 bg-rose-50 px-3 text-xs font-semibold text-rose-700 transition hover:border-rose-400 hover:bg-rose-100 focus:outline-none focus:ring-2 focus:ring-rose-300"
                                                    onClick={() => setSelectedCallEmployeeRow(row)}
                                                >
                                                    {formatNumber(row.totalNotConnectedCalls)}
                                                </button>
                                            </td>

                                            <td className="px-3 py-3 text-center font-semibold text-blue-600">
                                                <button
                                                    type="button"
                                                    className="inline-flex h-8 items-center justify-center rounded-md border border-blue-200 bg-blue-50 px-3 text-xs font-semibold text-blue-700 transition hover:border-blue-400 hover:bg-blue-100 focus:outline-none focus:ring-2 focus:ring-blue-300"
                                                    onClick={() => setSelectedCallEmployeeRow(row)}
                                                >
                                                    {formatNumber(row.totalVoicemails)}
                                                </button>
                                            </td>

                                            <td className="px-3 py-3 text-center font-semibold text-slate-950">
                                                {formatNumber(row.leads.length)}
                                            </td>

                                            <td className="px-3 py-3 text-sm text-slate-600">
                                                {row.lastCallAt ? formatPhDateTime(row.lastCallAt) : "No date"}
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    )}
                </div>
                {/* Call logger */}
                <TaskOverview tasks={tasks} />
                <LeadProgress counts={counts} />
            </div>

            <div className="grid gap-4 xl:grid-cols-[0.9fr_1.1fr]">
                <section className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
                    <div className="flex items-center justify-between gap-3">
                        <div>
                            <p className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">Lead Queue</p>
                            <h2 className="mt-1 text-base font-semibold text-slate-950">Next leads to work</h2>
                        </div>
                        <Link className="text-sm font-semibold text-violet-700 hover:text-violet-900" to="/leads">
                            View queue
                        </Link>
                    </div>
                    <div className="mt-5 space-y-3">
                        {queueLeads.slice(0, 5).map((lead) => (
                            <article key={lead._id} className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
                                <div className="flex items-start justify-between gap-3">
                                    <div className="min-w-0">
                                        <p className="truncate text-sm font-semibold text-slate-950">{lead.businessName || lead.leadName || "Untitled lead"}</p>
                                        <p className="mt-1 truncate text-xs text-slate-500">{lead.source || "No source"}{lead.category ? ` • ${lead.category}` : ""}</p>
                                    </div>
                                    <span className="shrink-0 rounded-full border border-violet-200 bg-violet-50 px-2 py-1 text-[0.65rem] font-bold uppercase tracking-[0.08em] text-violet-700">{lead.status}</span>
                                </div>
                                {lead.followUpAt && (
                                    <p className="mt-2 inline-flex items-center gap-1 text-xs font-semibold text-amber-700">
                                        <FiClock className="size-3" aria-hidden="true" />
                                        {formatPhDateTime(lead.followUpAt)}
                                    </p>
                                )}
                            </article>
                        ))}
                        {queueLeads.length === 0 && <p className="rounded-lg border border-dashed border-slate-300 bg-slate-50 p-4 text-sm text-slate-500">No leads in your queue right now.</p>}
                    </div>
                </section>
            </div>

            <div className="grid gap-4 xl:grid-cols-[0.85fr_1.15fr]">
                <RecentActivity logs={recentLogs} />

                <section className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
                    <div className="flex items-center justify-between gap-3">
                        <div>
                            <p className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">Notices</p>
                            <h2 className="mt-1 text-base font-semibold text-slate-950">Latest messages from admin</h2>
                        </div>
                        <span className="inline-flex items-center gap-2 rounded-full bg-slate-100 px-2.5 py-1 text-xs font-semibold text-slate-600">
                            <FiBell className="size-3" aria-hidden="true" />
                            {unreadNotices} unread
                        </span>
                    </div>
                    <div className="mt-5 space-y-3">
                        {notices.slice(0, 4).map((notice) => (
                            <article key={notice._id} className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
                                <div className="flex items-start justify-between gap-3">
                                    <div className="min-w-0">
                                        <p className="truncate text-sm font-semibold text-slate-950">{notice.title}</p>
                                        <p className="mt-1 line-clamp-2 text-xs leading-5 text-slate-600">{notice.message}</p>
                                    </div>
                                    <span className="shrink-0 rounded-full bg-white px-2 py-1 text-[0.65rem] font-bold uppercase tracking-[0.08em] text-slate-600">{notice.severity}</span>
                                </div>
                                <p className="mt-2 text-xs text-slate-500">{formatPhDateTime(notice.createdAt)}</p>
                            </article>
                        ))}
                        {notices.length === 0 && <p className="rounded-lg border border-dashed border-slate-300 bg-slate-50 p-4 text-sm text-slate-500">No admin notices yet.</p>}
                    </div>
                </section>
            </div>
            <MyTasksTable tasks={tasks} />
            <AttendancePanel employee={currentEmployee} attendance={attendance} />

            {selectedCallEmployeeRow && (
                <EmployeeLeadCallsModal
                    row={selectedCallEmployeeRow}
                    onClose={() => setSelectedCallEmployeeRow(null)}
                />
            )}
        </section>
    );
}
