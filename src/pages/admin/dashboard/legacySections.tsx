import { useMemo, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Link, useNavigate } from "react-router";
import { FiUsers, FiX } from "react-icons/fi";
import { normalizeEmployeeAvailabilityStatus, type Employee } from "../../../api/employees";
import { type AttendanceRecord } from "../../../api/attendance";
import { type AgentLeadActivity, type AgentLeadMonthlyRow, type AgentLeadProgress, type Lead } from "../../../api/leads";
import { formatPhDateTime, formatPhTime } from "../../../lib/dateTime";
import { dashboardWorkspaceEnabled } from "../../../lib/workspaceRollout";
import DashboardEmployeeName from "../../../components/DashboardEmployeeName";
import { formatNumber, formatDateInputValue, activityLabelClass, type LeadHistoryItem, getLeadDisplayName, type MonthlyQualifiedLead, getQualifiedLeadPath, latestAttendance, statusBadgeClass, formatDateOrDash, getAttendanceTimestamp, getDateValue, formatAttendanceDuration, getAttendanceStatusText, getAttendanceStatusLabel, type AttendanceOverBreakRow, type AttendanceShiftRow, type AttendanceEmployeeGroup, getCurrentShiftDateValue, getShiftLabel, buildAttendanceShiftRows, type EmployeeCallSummaryRow, getDateStart, getDateEnd } from "./legacyMath";

export function KpiCard({
    label,
    value,
    helper,
    icon: Icon,
    accent,
    detail,
}: {
    label: string;
    value: ReactNode;
    helper: string;
    icon: typeof FiUsers;
    accent: "green" | "blue" | "orange" | "purple";
    detail?: ReactNode;
}) {
    return (
        <article className={`dashboard-kpi-card dashboard-accent-${accent} rounded-lg border border-slate-300 bg-white p-4 text-slate-950 shadow-lg shadow-slate-950/10`}>
            <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                    <p className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">{label}</p>
                    <p className="mt-3 truncate text-2xl font-semibold">{value}</p>
                </div>
                <span className="dashboard-accent-icon flex size-10 shrink-0 items-center justify-center rounded-lg border border-violet-200 bg-violet-50 text-[#842cff]">
                    <Icon className="size-5" aria-hidden="true" />
                </span>
            </div>
            <p className="mt-2 text-sm leading-5 text-slate-600">{helper}</p>
            {detail}
        </article>
    );
}

export function EmptyPanel({ title, message }: { title: string; message: string }) {
    return (
        <div className="rounded-lg border border-dashed border-slate-300 bg-slate-50 p-6 text-center">
            <p className="text-sm font-semibold text-slate-800">{title}</p>
            <p className="mt-1 text-sm text-slate-500">{message}</p>
        </div>
    );
}

export function AgentProgressRow({ agent }: { agent: AgentLeadProgress }) {
    return (
        <tr className="text-sm text-slate-700 transition hover:bg-slate-50">
            <td className="min-w-[13rem] px-3 py-3">
                <div className="flex items-center gap-3">
                    <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-[#842cff] text-sm font-semibold text-white">
                        {agent.employeeName.slice(0, 1).toUpperCase()}
                    </span>
                    <div className="min-w-0">
                        <p className="truncate font-semibold text-slate-950"><DashboardEmployeeName id={agent.employeeId} name={agent.employeeName} /></p>
                        <p className="mt-0.5 truncate text-xs text-slate-500">{[agent.role, agent.team, agent.businessName].filter(Boolean).join(" \u{b7} ")}</p>
                    </div>
                </div>
            </td>
            <td className="px-3 py-3 text-center font-semibold text-slate-950">{formatNumber(agent.assignedLeads)}</td>
            <td className="px-3 py-3 text-center">{formatNumber(agent.newLeads)}</td>
            <td className="px-3 py-3 text-center">{formatNumber(agent.followUps)}</td>
            <td className="px-3 py-3 text-center">{formatNumber(agent.callsToday)}</td>
            <td className="px-3 py-3 text-center">{formatNumber(agent.qualified)}</td>
            <td className="px-3 py-3 text-center">{formatNumber(agent.dead)}</td>
        </tr>
    );
}

export function MonthlyAgentRow({ row, onQualifiedClick }: { row: AgentLeadMonthlyRow; onQualifiedClick: (row: AgentLeadMonthlyRow) => void }) {
    return (
        <tr className="text-sm text-slate-700 transition hover:bg-violet-50/35">
            <td className="min-w-0 px-2 py-3">
                <div className="flex min-w-0 items-center gap-2">
                    <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-violet-100 text-xs font-semibold text-[#6426d9]">
                        {row.employeeName.slice(0, 1).toUpperCase()}
                    </span>
                    <div className="min-w-0">
                        <p className="truncate font-semibold text-slate-900"><DashboardEmployeeName id={row.employeeId} name={row.employeeName} /></p>
                        <p className="mt-0.5 truncate text-xs text-slate-500">{[row.role, row.team, row.businessName].filter(Boolean).join(" \u{b7} ")}</p>
                    </div>
                </div>
            </td>
            <td className="px-2 py-3 text-center font-semibold text-slate-900">{formatNumber(row.leadsAdded)}</td>
            <td className="px-2 py-3 text-center">{formatNumber(row.followUps)}</td>
            <td className="px-2 py-3 text-center">{formatNumber(row.calls)}</td>
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
                <span className="inline-flex max-w-full justify-center rounded-md bg-violet-100 px-2 py-1 text-xs font-semibold text-[#6426d9]">
                    {formatNumber(row.productivityScore)}
                </span>
            </td>
        </tr>
    );
}

export function QualifiedLeadsModal({ row, onClose }: { row: AgentLeadMonthlyRow; onClose: () => void }) {
    const leads = row.qualifiedLeads || [];

    return createPortal(
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/65 px-4 py-6 backdrop-blur-sm">
            <section className="flex max-h-[86vh] w-full max-w-4xl flex-col overflow-hidden rounded-lg border border-slate-300 bg-white text-slate-950 shadow-2xl shadow-slate-950/30">
                <div className="flex items-start justify-between gap-4 border-b border-slate-200 bg-slate-50 px-5 py-4">
                    <div className="min-w-0">
                        <p className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">Qualified Leads</p>
                        <h3 className="mt-1 truncate text-lg font-semibold"><DashboardEmployeeName id={row.employeeId} name={row.employeeName} /></h3>
                        <p className="mt-1 text-sm text-slate-600">
                            Showing {formatNumber(leads.length)} records included in the dashboard qualified count.
                        </p>
                    </div>
                    <button
                        type="button"
                        className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-slate-300 bg-white text-slate-700 transition hover:border-[#842cff] hover:text-[#6426d9]"
                        onClick={onClose}
                        aria-label="Close qualified leads"
                    >
                        <FiX className="size-4" aria-hidden="true" />
                    </button>
                </div>
                <div className="content-scroll overflow-y-auto p-4">
                    {leads.length === 0 ? (
                        <EmptyPanel title="No qualified lead details" message="This row has no qualified lead records attached to the current dashboard response." />
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

export function EmployeeLeadCallsModal({
    row,
    onClose,
}: {
    row: EmployeeCallSummaryRow;
    onClose: () => void;
}) {

    const navigate = useNavigate();

    const openLead = (leadId: string) => {
        onClose();
        navigate(`/admin/leads?lead=${leadId}`);
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
                            <DashboardEmployeeName id={row.employeeId} name={row.employeeName} />
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

export function ActivityItem({ item, onOpen }: { item: AgentLeadActivity; onOpen: (item: AgentLeadActivity) => void }) {
    const leadName = item.leadName || item.businessName || "Lead";
    const Container = dashboardWorkspaceEnabled ? "article" : "button";

    return (
        <Container
            type={dashboardWorkspaceEnabled ? undefined : "button"}
            className="cursor-pointer rounded-lg border border-slate-300 bg-white p-3 text-left transition hover:border-[#842cff] hover:bg-violet-50/40 focus:outline-none focus:ring-2 focus:ring-[#842cff]/35"
            onClick={dashboardWorkspaceEnabled ? undefined : () => onOpen(item)}
            aria-label={dashboardWorkspaceEnabled ? undefined : `Open transaction history for ${leadName}`}
        >
            <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                    <p className="truncate text-sm font-semibold text-slate-950"><DashboardEmployeeName id={item.employeeId || ""} name={item.employeeName} /></p>
                    <p className="mt-1 truncate text-xs text-slate-500">{leadName}</p>
                </div>
                <span className={`shrink-0 rounded-md border px-2 py-1 text-xs font-semibold ${activityLabelClass(item.action)}`}>
                    {item.action}
                </span>
            </div>
            <p className="mt-3 line-clamp-3 whitespace-pre-line text-sm leading-5 text-slate-700">{item.detail}</p>
            <p className="mt-2 text-xs font-semibold uppercase tracking-[0.12em] text-slate-400">
                {item.createdAt ? formatPhDateTime(item.createdAt) : "No time"}
            </p>
            {dashboardWorkspaceEnabled ? <button type="button" className="mt-3 inline-flex text-xs font-semibold text-[#842cff]" onClick={() => onOpen(item)}>View history</button> : <span className="mt-3 inline-flex text-xs font-semibold text-[#842cff]">View history</span>}
        </Container>
    );
}

export function LeadHistoryModal({
    activity,
    lead,
    history,
    isLoading,
    isError,
    onClose,
}: {
    activity: AgentLeadActivity;
    lead?: Lead;
    history: LeadHistoryItem[];
    isLoading: boolean;
    isError: boolean;
    onClose: () => void;
}) {
    const leadName = getLeadDisplayName(lead, activity);
    const assignedAgentName = lead?.assignedAgentName || lead?.assignedAgent?.name || activity.employeeName || "Unassigned";
    const status = lead?.status || activity.status;
    const latestTime = history[0]?.createdAt || activity.createdAt;

    return createPortal(
        <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 p-4"
            onMouseDown={(event) => {
                if (event.target === event.currentTarget) {
                    onClose();
                }
            }}
        >
            <section
                className="flex max-h-[88vh] w-full max-w-3xl flex-col overflow-hidden rounded-lg border border-slate-300 bg-white text-slate-950 shadow-2xl shadow-slate-950/30"
                role="dialog"
                aria-modal="true"
                aria-labelledby="lead-history-title"
            >
                <header className="flex items-start justify-between gap-4 border-b border-slate-200 px-5 py-4">
                    <div className="min-w-0">
                        <p className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">Transaction History</p>
                        <h3 id="lead-history-title" className="mt-1 truncate text-xl font-semibold text-slate-950">{leadName}</h3>
                        <p className="mt-1 truncate text-sm text-slate-600">{lead?.businessName || activity.businessName || "No business name"}</p>
                    </div>
                    <button
                        type="button"
                        className="flex size-10 shrink-0 items-center justify-center rounded-lg border border-slate-300 bg-white text-slate-700 transition hover:bg-slate-100"
                        onClick={onClose}
                        aria-label="Close transaction history"
                    >
                        <FiX className="size-5" aria-hidden="true" />
                    </button>
                </header>

                <div className="grid gap-3 border-b border-slate-200 bg-slate-50 px-5 py-4 sm:grid-cols-3">
                    <div className="rounded-lg border border-slate-300 bg-white p-3">
                        <p className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">Status</p>
                        <span className={`mt-2 inline-flex rounded-md border px-2 py-1 text-xs font-semibold ${activityLabelClass(status || "")}`}>
                            {status || "Unknown"}
                        </span>
                    </div>
                    <div className="rounded-lg border border-slate-300 bg-white p-3">
                        <p className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">Assigned Agent</p>
                        <p className="mt-2 truncate text-sm font-semibold text-slate-950">{assignedAgentName}</p>
                    </div>
                    <div className="rounded-lg border border-slate-300 bg-white p-3">
                        <p className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">Latest</p>
                        <p className="mt-2 text-sm font-semibold text-slate-950">{latestTime ? formatPhDateTime(latestTime) : "No time"}</p>
                    </div>
                </div>

                <div className="overflow-y-auto px-5 py-4">
                    {isLoading && <EmptyPanel title="Loading transaction history" message="Getting the latest lead activity." />}
                    {!activity.leadId && <EmptyPanel title="Lead history is unavailable" message="This activity record is missing its lead link." />}
                    {isError && <EmptyPanel title="Transaction history could not load" message="Please refresh and try opening this lead again." />}
                    {!isLoading && activity.leadId && !isError && history.length === 0 && (
                        <EmptyPanel title="No transaction history yet" message="Comments, status changes, schedules, and follow-ups will show here." />
                    )}
                    {!isLoading && activity.leadId && !isError && history.length > 0 && (
                        <div className="space-y-4">
                            {history.map((item) => (
                                <article key={item.id} className="relative border-l border-slate-200 pl-4">
                                    <span className={`absolute -left-[5px] top-1 size-2.5 rounded-full ${item.kind === "comment" ? "bg-sky-500" : "bg-[#842cff]"}`} />
                                    <div className="flex flex-wrap items-start justify-between gap-2">
                                        <div className="min-w-0">
                                            <p className="text-sm font-semibold text-slate-950">{item.label}</p>
                                            <p className="mt-1 text-xs text-slate-500">
                                                {item.actorName} &#183; {item.actorType}
                                            </p>
                                        </div>
                                        {item.status && (
                                            <span className={`shrink-0 rounded-md border px-2 py-1 text-xs font-semibold ${activityLabelClass(item.status)}`}>
                                                {item.status}
                                            </span>
                                        )}
                                    </div>
                                    <p className="mt-2 whitespace-pre-line text-sm leading-5 text-slate-700">{item.detail}</p>
                                    <p className="mt-2 text-xs font-semibold uppercase tracking-[0.12em] text-slate-400">
                                        {item.createdAt ? formatPhDateTime(item.createdAt) : "No time"}
                                    </p>
                                </article>
                            ))}
                        </div>
                    )}
                </div>
            </section>
        </div>,
        document.body
    );
}

export function AttendancePanel({
    employee,
    attendance,
    attendanceGroups = [],
    selectedAttendanceDate,
    attendanceDateFrom,
    attendanceDateTo,
    onSelectedAttendanceDateChange,
    onAttendanceDateFromChange,
    onAttendanceDateToChange,
    isPlaceholder = false,
}: {
    employee?: Employee | null;
    attendance: AttendanceRecord[];
    attendanceGroups?: AttendanceEmployeeGroup[];
    selectedAttendanceDate: string;
    attendanceDateFrom: string;
    attendanceDateTo: string;
    onSelectedAttendanceDateChange: (value: string) => void;
    onAttendanceDateFromChange: (value: string) => void;
    onAttendanceDateToChange: (value: string) => void;
    isPlaceholder?: boolean;
}) {
    const isAllEmployeesView = !employee && !isPlaceholder;
    const status = normalizeEmployeeAvailabilityStatus(employee?.availabilityStatus);
    const todayDateValue = getCurrentShiftDateValue();
    const [selectedShiftRow, setSelectedShiftRow] = useState<AttendanceShiftRow | null>(null);
    const sortedAllAttendance = useMemo(() => latestAttendance(attendance), [attendance]);
    const allShiftRows = useMemo(() => {
        if (attendanceGroups.length) {
            return attendanceGroups
                .flatMap((group) => buildAttendanceShiftRows(latestAttendance(group.attendance), group.employee))
                .filter((row) => Boolean(row.firstTimeIn))
                .sort((first, second) => first.shiftStart.getTime() - second.shiftStart.getTime());
        }

        return buildAttendanceShiftRows(sortedAllAttendance, employee);
    }, [attendanceGroups, employee, sortedAllAttendance]);
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
    const totalUnderTimeMs = filteredShiftRows.reduce((total, row) => total + row.underTimeMs, 0);
    const totalOffPhoneMs = filteredShiftRows.reduce((total, row) => total + row.totalOffPhoneMs, 0);
    const totalOffPhoneSessions = filteredShiftRows.reduce((total, row) => total + row.offPhoneSessions.length, 0);
    const hasAttendanceFilter = Boolean(selectedAttendanceDate || attendanceDateFrom || attendanceDateTo);
    const filterSummary = selectedAttendanceDate
        ? `Selected shift date: ${formatDateOrDash(selectedAttendanceDate)}`
        : attendanceDateFrom || attendanceDateTo
            ? `Shift date range: ${attendanceDateFrom ? formatDateOrDash(attendanceDateFrom) : "Start"} to ${attendanceDateTo ? formatDateOrDash(attendanceDateTo) : "End"}`
            : "Showing all attendance shifts";
    const clearAttendanceFilters = () => {
        onSelectedAttendanceDateChange("");
        onAttendanceDateFromChange("");
        onAttendanceDateToChange("");
    };
    const applyTodayAttendanceFilter = () => {
        onSelectedAttendanceDateChange(todayDateValue);
        onAttendanceDateFromChange("");
        onAttendanceDateToChange("");
    };
    const applyThisMonthAttendanceFilter = () => {
        const today = new Date();
        const monthStart = formatDateInputValue(new Date(today.getFullYear(), today.getMonth(), 1));

        onSelectedAttendanceDateChange("");
        onAttendanceDateFromChange(monthStart);
        onAttendanceDateToChange(todayDateValue);
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
            value: totalUnderTimeMs > 0 ? formatAttendanceDuration(totalUnderTimeMs) : formatNumber(totalUnderTimeCount),
            detail: totalUnderTimeMs > 0
                ? `${formatNumber(totalUnderTimeCount)} early time-out${totalUnderTimeCount === 1 ? "" : "s"} before shift end`
                : "Records marked undertime inside selected shift rows",
            className: "border-amber-200 bg-amber-50 text-amber-700",
        },
        {
            label: "Late times",
            value: formatNumber(totalLateCount),
            detail: "Records marked late inside selected shift rows",
            className: "border-violet-200 bg-violet-50 text-violet-700",
        },
        {
            label: "Off the Phone",
            value: formatAttendanceDuration(totalOffPhoneMs),
            detail: `${formatNumber(totalOffPhoneSessions)} session${totalOffPhoneSessions === 1 ? "" : "s"} in selected shifts`,
            className: "border-sky-200 bg-sky-50 text-sky-700",
        },
    ];
    const skeletonMetricCards = ["Over break", "Under time", "Late times", "Off the Phone"];
    const showEmployeeColumn = isAllEmployeesView;
    const attendanceTableColSpan = showEmployeeColumn ? 9 : 8;

    return (
        <section className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
            <div className="flex items-start justify-between gap-3">
                <div>
                    <p className="mt-1 text-xs text-slate-500">
                        {isPlaceholder ? (
                            "Loading 11:00 PM to 8:00 AM shift rows, late, undertime, and over-break details."
                        ) : isAllEmployeesView ? (
                            <>Today shows employees who timed in for the current 11:00 PM to 8:00 AM shift. Showing {formatNumber(filteredShiftRows.length)} employee shift row{filteredShiftRows.length === 1 ? "" : "s"}.</>
                        ) : (
                            <>One row equals one full shift: 11:00 PM shift date to 8:00 AM next day. Showing {formatNumber(filteredShiftRows.length)} of {formatNumber(allShiftRows.length)} shift row{allShiftRows.length === 1 ? "" : "s"}.</>
                        )}
                    </p>
                </div>
                {isAllEmployeesView ? (
                    <span className="rounded-full border border-violet-200 bg-violet-50 px-3 py-1 text-xs font-bold text-violet-700">TODAY</span>
                ) : (
                    <span className={`rounded-full border px-3 py-1 text-xs font-bold ${statusBadgeClass(status)}`}>{status}</span>
                )}
            </div>

            <div className="mt-5 rounded-lg border border-slate-200 bg-slate-50 p-4">
                <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
                    <div>
                        <p className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">Shift Filter</p>
                        <p className="mt-1 text-sm font-semibold text-slate-800">{isPlaceholder ? "Loading attendance" : isAllEmployeesView ? `All employees with time-in - ${filterSummary}` : filterSummary}</p>
                        <p className="mt-1 text-xs text-slate-500">Date means the shift start date. Example: 06/16/2026 means 11:00 PM 06/16/2026 to 8:00 AM 06/17/2026.</p>
                    </div>

                    <div className="grid w-full gap-3 sm:grid-cols-2 lg:w-auto lg:grid-cols-[10rem_10rem_10rem_auto]">
                        <label className="text-xs font-semibold text-slate-600">
                            Shift Date
                            <input
                                type="date"
                                disabled={isPlaceholder}
                                value={selectedAttendanceDate}
                                onChange={(event) => {
                                    onSelectedAttendanceDateChange(event.target.value);
                                    if (event.target.value) {
                                        onAttendanceDateFromChange("");
                                        onAttendanceDateToChange("");
                                    }
                                }}
                                className="mt-1 h-10 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm font-semibold text-slate-800 shadow-sm focus:border-violet-500 focus:outline-none focus:ring-2 focus:ring-violet-200"
                            />
                        </label>

                        <label className="text-xs font-semibold text-slate-600">
                            Shift From
                            <input
                                type="date"
                                disabled={isPlaceholder}
                                value={attendanceDateFrom}
                                onChange={(event) => {
                                    onAttendanceDateFromChange(event.target.value);
                                    if (event.target.value) {
                                        onSelectedAttendanceDateChange("");
                                    }
                                }}
                                className="mt-1 h-10 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm font-semibold text-slate-800 shadow-sm focus:border-violet-500 focus:outline-none focus:ring-2 focus:ring-violet-200"
                            />
                        </label>

                        <label className="text-xs font-semibold text-slate-600">
                            Shift To
                            <input
                                type="date"
                                disabled={isPlaceholder}
                                value={attendanceDateTo}
                                onChange={(event) => {
                                    onAttendanceDateToChange(event.target.value);
                                    if (event.target.value) {
                                        onSelectedAttendanceDateChange("");
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
                                disabled={isPlaceholder}
                            >
                                Today
                            </button>
                            <button
                                type="button"
                                className="inline-flex h-10 items-center justify-center rounded-lg border border-[#842cff]/30 bg-white px-3 text-xs font-bold text-[#6426d9] transition hover:border-[#842cff] hover:bg-violet-50"
                                onClick={applyThisMonthAttendanceFilter}
                                disabled={isPlaceholder}
                            >
                                This Month
                            </button>
                            <button
                                type="button"
                                className="inline-flex h-10 items-center justify-center rounded-lg border border-slate-300 bg-white px-3 text-xs font-bold text-slate-600 transition hover:border-slate-500 hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-50"
                                onClick={clearAttendanceFilters}
                                disabled={isPlaceholder || !hasAttendanceFilter}
                            >
                                Clear
                            </button>
                        </div>
                    </div>
                </div>
            </div>

            <div className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                {isPlaceholder
                    ? skeletonMetricCards.map((label) => (
                        <article key={label} className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-3">
                            <p className="text-[0.65rem] font-bold uppercase tracking-[0.12em] text-slate-400">{label}</p>
                            <div className="mt-3 h-6 w-20 animate-pulse rounded bg-slate-200" />
                            <div className="mt-3 h-3 w-40 max-w-full animate-pulse rounded bg-slate-200" />
                        </article>
                    ))
                    : metricCards.map((item) => (
                        <article key={item.label} className={`rounded-lg border px-3 py-3 ${item.className}`}>
                            <p className="text-[0.65rem] font-bold uppercase tracking-[0.12em] opacity-80">{item.label}</p>
                            <p className="mt-2 text-xl font-semibold">{item.value}</p>
                            <p className="mt-1 text-xs font-semibold opacity-80">{item.detail}</p>
                        </article>
                    ))}
            </div>

            <div className="mt-5 overflow-hidden rounded-lg border border-slate-300 bg-white">
                <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 bg-slate-50 px-4 py-3">
                    <div>
                        <p className="text-xs font-semibold uppercase tracking-[0.12em] text-slate-500">Shift Attendance Table</p>
                        <p className="mt-1 text-xs text-slate-500">{isPlaceholder ? "Select an employee above to load shift rows here." : <>Click View to open every punch, issue, and break detail inside that shift. {filterSummary}</>}</p>
                    </div>
                    <span className="rounded-full bg-white px-2.5 py-1 text-[0.65rem] font-bold text-slate-500">Shift 11PM-8AM &#183; Break 15m &#183; Lunch 1h</span>
                </div>

                <div className="content-scroll max-h-[34rem] overflow-auto">
                    <table className="w-full min-w-[84rem] table-fixed border-separate border-spacing-0 text-left text-sm">
                        <colgroup>
                            {showEmployeeColumn && <col className="w-[16%]" />}
                            <col className="w-[12%]" />
                            <col className={showEmployeeColumn ? "w-[22%]" : "w-[25%]"} />
                            <col className="w-[12%]" />
                            <col className="w-[12%]" />
                            <col className="w-[8%]" />
                            <col className="w-[8%]" />
                            <col className="w-[8%]" />
                            <col className="w-[10%]" />
                        </colgroup>
                        <thead className="sticky top-0 z-10 bg-white text-[0.68rem] uppercase tracking-[0.12em] text-slate-500 shadow-sm">
                            <tr>
                                {showEmployeeColumn && <th className="px-3 py-3 font-semibold">Employee</th>}
                                <th className="px-3 py-3 font-semibold">Shift Date</th>
                                <th className="px-3 py-3 font-semibold">Shift Window</th>
                                <th className="px-3 py-3 font-semibold">Time In</th>
                                <th className="px-3 py-3 font-semibold">Time Out</th>
                                <th className="px-3 py-3 text-center font-semibold">Late</th>
                                <th className="px-3 py-3 text-center font-semibold">Under</th>
                                <th className="px-3 py-3 font-semibold">Over Break</th>
                                <th className="px-3 py-3 font-semibold">Off the Phone</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-200">
                            {isPlaceholder && Array.from({ length: 4 }).map((_, index) => (
                                <tr key={`attendance-skeleton-${index}`} className="pointer-events-none">
                                    <td className="px-3 py-4"><div className="h-4 w-24 animate-pulse rounded bg-slate-200" /></td>
                                    <td className="px-3 py-4"><div className="h-4 w-20 animate-pulse rounded bg-slate-200" /></td>
                                    <td className="px-3 py-4"><div className="h-4 w-64 max-w-full animate-pulse rounded bg-slate-200" /><div className="mt-2 h-3 w-40 animate-pulse rounded bg-slate-200" /></td>
                                    <td className="px-3 py-4"><div className="h-4 w-20 animate-pulse rounded bg-slate-200" /></td>
                                    <td className="px-3 py-4"><div className="h-4 w-20 animate-pulse rounded bg-slate-200" /></td>
                                    <td className="px-3 py-4"><div className="mx-auto h-4 w-8 animate-pulse rounded bg-slate-200" /></td>
                                    <td className="px-3 py-4"><div className="mx-auto h-4 w-8 animate-pulse rounded bg-slate-200" /></td>
                                    <td className="px-3 py-4"><div className="h-4 w-24 animate-pulse rounded bg-slate-200" /></td>
                                </tr>
                            ))}
                            {!isPlaceholder && filteredShiftRows.map((row) => (
                                <tr key={row.id} className="text-slate-700 transition hover:bg-violet-50/40" onClick={() => setSelectedShiftRow(row)}>
                                    {showEmployeeColumn && (
                                        <td className="px-3 py-3">
                                            <p className="truncate font-semibold text-slate-950">{row.employee?.name || row.employee?.employeeCode || "Employee"}</p>
                                            <p className="mt-0.5 truncate text-xs text-slate-500">{[row.employee?.role, row.employee?.team].filter(Boolean).join(" \u{b7} ") || "No role"}</p>
                                        </td>
                                    )}
                                    <td className="px-3 py-3 font-semibold text-slate-900">{formatDateOrDash(row.shiftDateValue)}</td>
                                    <td className="px-3 py-3">
                                        <p className="font-semibold text-slate-950">{getShiftLabel(row)}</p>
                                        <p className="mt-0.5 text-xs text-slate-500">11:00 PM to 8:00 AM next day</p>
                                    </td>
                                    <td className="px-3 py-3">{row.firstTimeIn ? formatPhTime(row.firstTimeIn.timeIn) : "-"}</td>
                                    <td className="px-3 py-3">{row.lastTimeOut ? formatPhTime(row.lastTimeOut.timeIn) : "No time out"}</td>
                                    <td className="px-3 py-3 text-center">
                                        <span className={row.lateRecords.length ? "inline-flex rounded-full bg-violet-100 px-2 py-1 text-xs font-bold text-violet-700" : "text-xs font-semibold text-slate-400"}>
                                            {row.lateRecords.length ? formatNumber(row.lateRecords.length) : "0"}
                                        </span>
                                    </td>
                                    <td className="px-3 py-3 text-center">
                                        <span className={row.underTimeRecords.length ? "inline-flex rounded-full bg-amber-100 px-2 py-1 text-xs font-bold text-amber-700" : "text-xs font-semibold text-slate-400"}>
                                            {row.underTimeMs > 0 ? formatAttendanceDuration(row.underTimeMs) : row.underTimeRecords.length ? formatNumber(row.underTimeRecords.length) : "0"}
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
                                    <td className="px-3 py-3">
                                        {row.offPhoneSessions.length > 0 ? (
                                            <div>
                                                <p className="font-semibold text-sky-700">{formatAttendanceDuration(row.totalOffPhoneMs)}</p>
                                                <p className="mt-0.5 text-xs text-slate-500">{formatNumber(row.offPhoneSessions.length)} session{row.offPhoneSessions.length === 1 ? "" : "s"}</p>
                                            </div>
                                        ) : (
                                            <span className="text-xs font-semibold text-slate-400">-</span>
                                        )}
                                    </td>
                                </tr>
                            ))}
                            {!isPlaceholder && filteredShiftRows.length === 0 && (
                                <tr>
                                    <td className="px-4 py-8 text-center text-sm text-slate-500" colSpan={attendanceTableColSpan}>
                                        {isAllEmployeesView ? "No employees have timed in for the selected shift." : "No attendance shifts found."}
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
    const chronologicalOffPhoneSessions = [...row.offPhoneSessions].sort(
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
                            {row.employee ? `${row.employee.name || row.employee.employeeCode} - ` : ""}{formatDateOrDash(row.shiftDateValue)} Shift
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
                    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-6">
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
                            <p className="mt-1 text-sm font-semibold">{row.underTimeMs > 0 ? formatAttendanceDuration(row.underTimeMs) : formatNumber(row.underTimeRecords.length)}</p>
                        </div>
                        <div className="rounded-lg border border-rose-200 bg-rose-50 p-3 text-rose-700">
                            <p className="text-[0.65rem] font-bold uppercase tracking-[0.12em] opacity-80">Over Break</p>
                            <p className="mt-1 text-sm font-semibold">{formatAttendanceDuration(row.totalOverBreakMs)}</p>
                        </div>
                        <div className="rounded-lg border border-sky-200 bg-sky-50 p-3 text-sky-700">
                            <p className="text-[0.65rem] font-bold uppercase tracking-[0.12em] opacity-80">Off the Phone</p>
                            <p className="mt-1 text-sm font-semibold">{formatAttendanceDuration(row.totalOffPhoneMs)}</p>
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
                                        const isEarlyTimeOut = row.underTimeMs > 0 && row.lastTimeOut?._id === record._id;
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
                                                        {(isUnderTime || isEarlyTimeOut) && <span className="rounded-full bg-amber-100 px-2 py-1 text-[0.65rem] font-bold uppercase tracking-[0.08em] text-amber-700">Undertime</span>}
                                                        {overBreakRow && <span className="rounded-full bg-rose-100 px-2 py-1 text-[0.65rem] font-bold uppercase tracking-[0.08em] text-rose-700">Over Break</span>}
                                                        {!isLate && !isUnderTime && !isEarlyTimeOut && !overBreakRow && <span className="text-xs font-semibold text-slate-400">None</span>}
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

                    {row.underTimeMs > 0 && row.lastTimeOut && (
                        <div className="mt-5 rounded-lg border border-amber-200 bg-amber-50 p-4 text-amber-800">
                            <p className="text-xs font-semibold uppercase tracking-[0.12em]">Undertime Details</p>
                            <p className="mt-2 text-sm font-semibold">
                                Time out was {formatAttendanceDuration(row.underTimeMs)} before the scheduled shift end.
                            </p>
                            <p className="mt-1 text-xs text-slate-600">
                                {formatPhDateTime(row.lastTimeOut.timeIn)} to expected end {formatPhDateTime(row.shiftEnd.toISOString())}
                            </p>
                        </div>
                    )}

                    <div className="mt-5 rounded-lg border border-sky-200 bg-sky-50/50 p-4">
                        <div className="flex flex-wrap items-center justify-between gap-3">
                            <p className="text-xs font-semibold uppercase tracking-[0.12em] text-sky-700">Off the Phone Sessions</p>
                            <span className="rounded-full bg-white px-2.5 py-1 text-[0.65rem] font-bold text-sky-700">
                                {formatAttendanceDuration(row.totalOffPhoneMs)} total
                            </span>
                        </div>

                        <div className="mt-3 space-y-2">
                            {chronologicalOffPhoneSessions.map((session) => (
                                <article key={session.id} className="rounded-lg border border-sky-200 bg-white px-3 py-3 text-sm text-sky-800">
                                    <div className="flex flex-wrap items-start justify-between gap-3">
                                        <div>
                                            <p className="font-semibold">{session.nonBillable ? "Non-Billable Off the Phone" : "Off the Phone"} for {formatAttendanceDuration(session.durationMs)}</p>
                                            <p className="mt-1 text-xs text-slate-600">
                                                {formatPhDateTime(session.startedAt)} to {session.endedAt ? formatPhDateTime(session.endedAt) : "Still off the phone"}
                                            </p>
                                        </div>
                                        <span className="rounded-full bg-sky-50 px-2 py-1 text-[0.65rem] font-bold uppercase tracking-[0.08em] text-sky-700">
                                            {session.isOpen ? "Open" : "Closed"}
                                        </span>
                                    </div>
                                </article>
                            ))}
                            {chronologicalOffPhoneSessions.length === 0 && (
                                <p className="rounded-lg border border-dashed border-sky-200 bg-white p-4 text-sm text-slate-500">No Off the Phone records for this shift.</p>
                            )}
                        </div>
                    </div>

                    <div className="mt-5 rounded-lg border border-slate-300 bg-white p-4">
                        <div className="flex flex-wrap items-center justify-between gap-3">
                            <p className="text-xs font-semibold uppercase tracking-[0.12em] text-slate-500">Over Break Details</p>
                            <span className="rounded-full bg-slate-100 px-2.5 py-1 text-[0.65rem] font-bold text-slate-500">Break 15m &#183; Lunch 1h</span>
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
