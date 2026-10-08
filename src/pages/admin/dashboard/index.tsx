// import { useMemo, useState } from "react";
// import { createPortal } from "react-dom";
// import { Link, useNavigate } from "react-router";
// import { useQuery } from "@tanstack/react-query";
// import {
//     FiActivity,
//     FiBarChart2,
//     FiCalendar,
//     FiCheckCircle,
//     FiChevronDown,
//     FiChevronLeft,
//     FiChevronRight,
//     FiClock,
//     FiDownload,
//     FiMessageSquare,
//     FiPhoneCall,
//     FiRefreshCw,
//     FiTarget,
//     FiTrendingUp,
//     FiUserCheck,
//     FiUsers,
//     FiX,
// } from "react-icons/fi";
// import AdminLayout from "../adminLayout";
// import { getEmployeeSummaries, normalizeEmployeeAvailabilityStatus, type Employee } from "../../../api/employees";
// import { getAgentLeadDashboard, getLead, getLeadCallStats, type AgentLeadActivity, type AgentLeadMonthlyRow, type AgentLeadProgress, type Lead, type LeadCallStat } from "../../../api/leads";
// import { formatPhDateTime } from "../../../lib/dateTime";

// const numberFormatter = new Intl.NumberFormat("en-US");
// const monthLabelFormatter = new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric" });
// const dateRangeLabelFormatter = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" });
// const agentRowsPerPage = 5;
// const monthlyRowsPerPage = 5;
// type CallCountRange = "day" | "month";

// function formatNumber(value?: number) {
//     return numberFormatter.format(value || 0);
// }

// function getMonthInputValue(date: Date) {
//     const year = date.getFullYear();
//     const month = String(date.getMonth() + 1).padStart(2, "0");

//     return `${year}-${month}`;
// }

// function formatMonthLabel(monthKey?: string) {
//     const [yearValue, monthValue] = String(monthKey || "").split("-").map(Number);

//     if (!yearValue || !monthValue) {
//         return "Selected month";
//     }

//     return monthLabelFormatter.format(new Date(yearValue, monthValue - 1, 1));
// }

// function formatDateInputValue(date: Date) {
//     const year = date.getFullYear();
//     const month = String(date.getMonth() + 1).padStart(2, "0");
//     const day = String(date.getDate()).padStart(2, "0");

//     return `${year}-${month}-${day}`;
// }

// function parseDateInputValue(value?: string) {
//     const [yearValue, monthValue, dayValue] = String(value || "").split("-").map(Number);

//     if (!yearValue || !monthValue || !dayValue) {
//         return null;
//     }

//     return new Date(yearValue, monthValue - 1, dayValue);
// }

// function getMonthlyDashboardDateRange(monthKey?: string) {
//     const [yearValue, monthValue] = String(monthKey || "").split("-").map(Number);

//     if (!yearValue || !monthValue) {
//         const today = new Date();
//         return {
//             dateFrom: formatDateInputValue(new Date(today.getFullYear(), today.getMonth(), 3)),
//             dateTo: formatDateInputValue(new Date(today.getFullYear(), today.getMonth() + 1, 2)),
//         };
//     }

//     return {
//         dateFrom: formatDateInputValue(new Date(yearValue, monthValue - 1, 3)),
//         dateTo: formatDateInputValue(new Date(yearValue, monthValue, 2)),
//     };
// }

// function formatDateRangeLabel(dateFrom: string, dateTo: string) {
//     const start = parseDateInputValue(dateFrom);
//     const end = parseDateInputValue(dateTo);

//     if (!start || !end) {
//         return "Selected range";
//     }

//     return `${dateRangeLabelFormatter.format(start)} - ${dateRangeLabelFormatter.format(end)}`;
// }

// function formatSingleDateLabel(value: string) {
//     const date = parseDateInputValue(value);

//     return date ? dateRangeLabelFormatter.format(date) : "Selected date";
// }

// function csvCell(value: string | number | null | undefined) {
//     return `"${String(value ?? "").replaceAll('"', '""')}"`;
// }

// function downloadCsv(filename: string, rows: Array<Array<string | number | null | undefined>>) {
//     const csv = rows.map((row) => row.map(csvCell).join(",")).join("\n");
//     const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
//     const url = URL.createObjectURL(blob);
//     const link = document.createElement("a");
//     link.href = url;
//     link.download = filename;
//     link.click();
//     URL.revokeObjectURL(url);
// }

// function getPaginationNumbers(currentPage: number, totalPages: number) {
//     const pages = new Set([1, totalPages, currentPage - 1, currentPage, currentPage + 1]);

//     return Array.from(pages)
//         .filter((page) => page >= 1 && page <= totalPages)
//         .sort((first, second) => first - second);
// }

// function activityLabelClass(action: string) {
//     const normalizedAction = action.toLowerCase();
//     if (normalizedAction.includes("comment")) return "bg-sky-50 text-sky-700 border-sky-200";
//     if (normalizedAction.includes("status") || normalizedAction.includes("qualified")) return "bg-emerald-50 text-emerald-700 border-emerald-200";
//     if (normalizedAction.includes("schedule") || normalizedAction.includes("reschedule")) return "bg-violet-50 text-violet-700 border-violet-200";
//     return "bg-slate-50 text-slate-600 border-slate-300";
// }

// function availabilityClass(value?: string) {
//     const status = normalizeEmployeeAvailabilityStatus(value);

//     if (status === "ONLINE") return "border-emerald-200 bg-emerald-50 text-emerald-700";
//     if (status === "BREAK" || status === "LUNCH") return "border-amber-200 bg-amber-50 text-amber-700";
//     if (status === "OFF THE PHONE") return "border-sky-200 bg-sky-50 text-sky-700";

//     return "border-slate-200 bg-slate-100 text-slate-600";
// }

// function availabilityDotClass(value?: string) {
//     const status = normalizeEmployeeAvailabilityStatus(value);

//     if (status === "ONLINE") return "bg-emerald-500";
//     if (status === "BREAK" || status === "LUNCH") return "bg-amber-500";
//     if (status === "OFF THE PHONE") return "bg-sky-500";

//     return "bg-slate-400";
// }

// function availabilitySortRank(value?: string) {
//     const status = normalizeEmployeeAvailabilityStatus(value);

//     if (status === "ONLINE") return 0;
//     if (status === "BREAK") return 1;
//     if (status === "LUNCH") return 2;
//     if (status === "OFF THE PHONE") return 3;

//     return 4;
// }

// function personNameTokens(value?: string | null) {
//     return String(value || "")
//         .trim()
//         .toLowerCase()
//         .replace(/[^a-z0-9\s]/g, " ")
//         .replace(/\s+/g, " ")
//         .split(" ")
//         .filter((token) => token.length > 1);
// }

// function isLikelySamePersonName(first?: string | null, second?: string | null) {
//     const firstTokens = personNameTokens(first);
//     const secondTokens = personNameTokens(second);

//     if (firstTokens.length < 2 || secondTokens.length < 2) return false;

//     const firstFirstName = firstTokens[0];
//     const secondFirstName = secondTokens[0];
//     const firstLastName = firstTokens.at(-1);
//     const secondLastName = secondTokens.at(-1);

//     if (!firstLastName || firstLastName !== secondLastName) return false;

//     return (
//         (firstFirstName.length >= 4 && secondFirstName.startsWith(firstFirstName)) ||
//         (secondFirstName.length >= 4 && firstFirstName.startsWith(secondFirstName))
//     );
// }

// function isGenericAgentDisplay(row: { role?: string; team?: string }) {
//     return String(row.role || "").trim().toLowerCase() === "agent" && String(row.team || "").trim().toLowerCase() === "unassigned";
// }

// function latestDateValue(first?: string | null, second?: string | null) {
//     const firstTime = first ? new Date(first).getTime() : 0;
//     const secondTime = second ? new Date(second).getTime() : 0;

//     if (Number.isNaN(firstTime) && Number.isNaN(secondTime)) return null;
//     if (Number.isNaN(firstTime)) return second || null;
//     if (Number.isNaN(secondTime)) return first || null;

//     return firstTime >= secondTime ? first || null : second || null;
// }

// function findMergeTarget<T extends { employeeId: string; employeeName: string; role?: string; team?: string }>(rows: T[], row: T) {
//     return rows.find((currentRow) => {
//         if (currentRow.employeeId === row.employeeId) return true;
//         if (!isLikelySamePersonName(currentRow.employeeName, row.employeeName)) return false;

//         return isGenericAgentDisplay(currentRow) !== isGenericAgentDisplay(row);
//     });
// }

// function preferEmployeeDisplay<T extends { employeeName: string; employeeId: string; role?: string; team?: string }>(first: T, second: T) {
//     if (isGenericAgentDisplay(first) && !isGenericAgentDisplay(second)) return second;
//     if (!isGenericAgentDisplay(first) && isGenericAgentDisplay(second)) return first;

//     return first;
// }

// type LeadHistoryItem = {
//     id: string;
//     label: string;
//     detail: string;
//     actorName: string;
//     actorType: string;
//     status?: string;
//     createdAt: string;
//     kind: "activity" | "comment";
// };

// type OnlineStatusEmployeeRow = Pick<
//     AgentLeadProgress,
//     "employeeId" | "employeeName" | "role" | "team" | "availabilityStatus" | "assignedLeads"
// >;

// function isArchivedEmployee(employee: Employee) {
//     return String(employee.status || "").trim().toLowerCase() === "archived";
// }

// function buildOnlineStatusRows(employees: Employee[], agents: AgentLeadProgress[]): OnlineStatusEmployeeRow[] {
//     const agentById = new Map(agents.map((agent) => [agent.employeeId, agent]));
//     const agentByName = new Map(agents.map((agent) => [agent.employeeName.trim().toLowerCase(), agent]));

//     return employees
//         .filter((employee) => !isArchivedEmployee(employee))
//         .map((employee) => {
//             const matchedAgent = agentById.get(employee._id) || agentByName.get((employee.name || "").trim().toLowerCase());

//             return {
//                 employeeId: employee._id,
//                 employeeName: employee.name || employee.employeeCode || "Employee",
//                 role: employee.role || "Employee",
//                 team: employee.team || "Unassigned",
//                 availabilityStatus: employee.availabilityStatus || matchedAgent?.availabilityStatus || "OFFLINE",
//                 assignedLeads: matchedAgent?.assignedLeads || 0,
//             };
//         })
//         .sort((first, second) => {
//             const rankDifference = availabilitySortRank(first.availabilityStatus) - availabilitySortRank(second.availabilityStatus);

//             if (rankDifference !== 0) return rankDifference;

//             return first.employeeName.localeCompare(second.employeeName);
//         });
// }

// function mergeAgentProgressRows(rows: AgentLeadProgress[]) {
//     return rows.reduce<AgentLeadProgress[]>((mergedRows, row) => {
//         const target = findMergeTarget(mergedRows, row);

//         if (!target) {
//             mergedRows.push({ ...row });
//             return mergedRows;
//         }

//         const displayRow = preferEmployeeDisplay(target, row);
//         const mergedRow: AgentLeadProgress = {
//             ...displayRow,
//             assignedLeads: target.assignedLeads + row.assignedLeads,
//             newLeads: target.newLeads + row.newLeads,
//             followUps: target.followUps + row.followUps,
//             ongoing: target.ongoing + row.ongoing,
//             qualified: target.qualified + row.qualified,
//             negotiation: target.negotiation + row.negotiation,
//             dead: target.dead + row.dead,
//             dueFollowUps: target.dueFollowUps + row.dueFollowUps,
//             scheduledToday: target.scheduledToday + row.scheduledToday,
//             commentsToday: target.commentsToday + row.commentsToday,
//             callsToday: (target.callsToday || 0) + (row.callsToday || 0),
//             activityToday: target.activityToday + row.activityToday,
//             touchedLeadsToday: target.touchedLeadsToday + row.touchedLeadsToday,
//             productivityScore: target.productivityScore + row.productivityScore,
//             lastActivityAt: latestDateValue(target.lastActivityAt, row.lastActivityAt),
//             progressPercent: 0,
//         };

//         mergedRow.progressPercent =
//             mergedRow.assignedLeads > 0 ? Math.round(((mergedRow.followUps + mergedRow.qualified) / mergedRow.assignedLeads) * 100) : 0;

//         mergedRows[mergedRows.indexOf(target)] = mergedRow;
//         return mergedRows;
//     }, []);
// }

// function mergeAgentMonthlyRows(rows: AgentLeadMonthlyRow[]) {
//     return rows.reduce<AgentLeadMonthlyRow[]>((mergedRows, row) => {
//         const target = findMergeTarget(mergedRows, row);

//         if (!target) {
//             mergedRows.push({ ...row, qualifiedLeads: [...(row.qualifiedLeads || [])] });
//             return mergedRows;
//         }

//         const displayRow = preferEmployeeDisplay(target, row);
//         const qualifiedLeadsById = new Map<string, AgentLeadMonthlyRow["qualifiedLeads"][number]>();

//         [...(target.qualifiedLeads || []), ...(row.qualifiedLeads || [])].forEach((lead) => {
//             qualifiedLeadsById.set(lead.leadId, lead);
//         });

//         mergedRows[mergedRows.indexOf(target)] = {
//             ...displayRow,
//             leadsAdded: target.leadsAdded + row.leadsAdded,
//             followUps: target.followUps + row.followUps,
//             qualified: target.qualified + row.qualified,
//             archiveDead: target.archiveDead + row.archiveDead,
//             comments: target.comments + row.comments,
//             calls: (target.calls || 0) + (row.calls || 0),
//             actions: target.actions + row.actions,
//             touchedLeads: target.touchedLeads + row.touchedLeads,
//             productivityScore: target.productivityScore + row.productivityScore,
//             qualifiedLeads: Array.from(qualifiedLeadsById.values()),
//             lastActivityAt: latestDateValue(target.lastActivityAt, row.lastActivityAt),
//         };

//         return mergedRows;
//     }, []);
// }

// function getLeadDisplayName(lead?: Lead | null, fallback?: AgentLeadActivity | null) {
//     return lead?.leadName || lead?.businessName || fallback?.leadName || fallback?.businessName || "Lead";
// }

// function getLeadHistory(lead?: Lead | null): LeadHistoryItem[] {
//     if (!lead) return [];

//     const activity = (lead.activity || []).map((item, index) => ({
//         id: item._id || `activity-${index}-${item.createdAt}`,
//         label: item.label || "Lead activity",
//         detail: item.detail || "No details provided.",
//         actorName: item.actorName || "System",
//         actorType: item.actorType || "system",
//         status: item.status,
//         createdAt: item.createdAt,
//         kind: "activity" as const,
//     }));
//     const comments = (lead.comments || []).map((item, index) => ({
//         id: item._id || `comment-${index}-${item.createdAt}`,
//         label: "Comment",
//         detail: item.body || "No comment text.",
//         actorName: item.authorName || "Unknown",
//         actorType: item.authorType || "employee",
//         status: undefined,
//         createdAt: item.createdAt,
//         kind: "comment" as const,
//     }));

//     return [...activity, ...comments].sort((left, right) => {
//         const rightTime = new Date(right.createdAt || 0).getTime() || 0;
//         const leftTime = new Date(left.createdAt || 0).getTime() || 0;
//         return rightTime - leftTime;
//     });
// }

// function KpiCard({
//     label,
//     value,
//     helper,
//     icon: Icon,
//     accent,
// }: {
//     label: string;
//     value: string;
//     helper: string;
//     icon: typeof FiUsers;
//     accent: "green" | "blue" | "orange" | "purple";
// }) {
//     return (
//         <article className={`dashboard-kpi-card dashboard-accent-${accent} rounded-lg border border-slate-300 bg-white p-4 text-slate-950 shadow-lg shadow-slate-950/10`}>
//             <div className="flex items-start justify-between gap-3">
//                 <div className="min-w-0">
//                     <p className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">{label}</p>
//                     <p className="mt-3 truncate text-2xl font-semibold">{value}</p>
//                 </div>
//                 <span className="dashboard-accent-icon flex size-10 shrink-0 items-center justify-center rounded-lg border border-violet-200 bg-violet-50 text-[#842cff]">
//                     <Icon className="size-5" aria-hidden="true" />
//                 </span>
//             </div>
//             <p className="mt-2 text-sm leading-5 text-slate-600">{helper}</p>
//         </article>
//     );
// }

// function EmptyPanel({ title, message }: { title: string; message: string }) {
//     return (
//         <div className="rounded-lg border border-dashed border-slate-300 bg-slate-50 p-6 text-center">
//             <p className="text-sm font-semibold text-slate-800">{title}</p>
//             <p className="mt-1 text-sm text-slate-500">{message}</p>
//         </div>
//     );
// }

// function AgentProgressRow({ agent }: { agent: AgentLeadProgress }) {
//     const currentTotal = agent.newLeads + agent.followUps + agent.qualified + agent.dead;

//     return (
//         <tr className="text-sm text-slate-700 transition hover:bg-slate-50">
//             <td className="min-w-[13rem] px-3 py-3">
//                 <div className="flex items-center gap-3">
//                     <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-[#842cff] text-sm font-semibold text-white">
//                         {agent.employeeName.slice(0, 1).toUpperCase()}
//                     </span>
//                     <div className="min-w-0">
//                         <p className="truncate font-semibold text-slate-950">{agent.employeeName}</p>
//                         <p className="mt-0.5 truncate text-xs text-slate-500">{agent.role} · {agent.team}</p>
//                     </div>
//                 </div>
//             </td>
//             <td className="px-3 py-3 text-center font-semibold text-slate-950">{formatNumber(currentTotal)}</td>
//             <td className="px-3 py-3 text-center">{formatNumber(agent.newLeads)}</td>
//             <td className="px-3 py-3 text-center">{formatNumber(agent.followUps)}</td>
//             <td className="px-3 py-3 text-center">{formatNumber(agent.callsToday)}</td>
//             <td className="px-3 py-3 text-center">{formatNumber(agent.qualified)}</td>
//             <td className="px-3 py-3 text-center">{formatNumber(agent.dead)}</td>
//         </tr>
//     );
// }

// type MonthlyQualifiedLead = AgentLeadMonthlyRow["qualifiedLeads"][number];

// function getQualifiedLeadSearchLabel(lead: MonthlyQualifiedLead) {
//     return lead.leadName || lead.businessName || lead.assignedAgentName || "";
// }

// function getQualifiedLeadPath(lead: MonthlyQualifiedLead) {
//     const params = new URLSearchParams({
//         scope: "all",
//         lead: lead.leadId,
//     });
//     const searchLabel = getQualifiedLeadSearchLabel(lead);

//     if (searchLabel) {
//         params.set("leadSearch", searchLabel);
//     }

//     return `/admin/leads?${params.toString()}`;
// }

// function MonthlyAgentRow({ row, onQualifiedClick }: { row: AgentLeadMonthlyRow; onQualifiedClick: (row: AgentLeadMonthlyRow) => void }) {
//     return (
//         <tr className="text-sm text-slate-700 transition hover:bg-violet-50/35">
//             <td className="min-w-0 px-2 py-3">
//                 <div className="flex min-w-0 items-center gap-2">
//                     <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-violet-100 text-xs font-semibold text-[#6426d9]">
//                         {row.employeeName.slice(0, 1).toUpperCase()}
//                     </span>
//                     <div className="min-w-0">
//                         <p className="truncate font-semibold text-slate-900">{row.employeeName}</p>
//                         <p className="mt-0.5 truncate text-xs text-slate-500">{row.role} · {row.team}</p>
//                     </div>
//                 </div>
//             </td>
//             <td className="px-2 py-3 text-center font-semibold text-slate-900">{formatNumber(row.leadsAdded)}</td>
//             <td className="px-2 py-3 text-center">{formatNumber(row.followUps)}</td>
//             <td className="px-2 py-3 text-center">{formatNumber(row.calls)}</td>
//             <td className="px-2 py-3 text-center">
//                 {row.qualified > 0 ? (
//                     <button
//                         type="button"
//                         className="inline-flex min-w-8 items-center justify-center rounded-md border border-emerald-200 bg-emerald-50 px-2 py-1 text-sm font-semibold text-emerald-700 transition hover:border-emerald-400 hover:bg-emerald-100 focus:outline-none focus:ring-2 focus:ring-emerald-300"
//                         onClick={() => onQualifiedClick(row)}
//                         aria-label={`View ${formatNumber(row.qualified)} qualified leads for ${row.employeeName}`}
//                     >
//                         {formatNumber(row.qualified)}
//                     </button>
//                 ) : (
//                     formatNumber(row.qualified)
//                 )}
//             </td>
//             <td className="px-2 py-3 text-center">{formatNumber(row.archiveDead)}</td>
//             <td className="px-2 py-3 text-center">{formatNumber(row.comments)}</td>
//             <td className="px-2 py-3 text-center">{formatNumber(row.touchedLeads)}</td>
//             <td className="px-2 py-3 text-center">
//                 <span className="inline-flex max-w-full justify-center rounded-md bg-violet-100 px-2 py-1 text-xs font-semibold text-[#6426d9]">
//                     {formatNumber(row.productivityScore)}
//                 </span>
//             </td>
//         </tr>
//     );
// }

// function QualifiedLeadsModal({ row, onClose }: { row: AgentLeadMonthlyRow; onClose: () => void }) {
//     const leads = row.qualifiedLeads || [];

//     return createPortal(
//         <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/65 px-4 py-6 backdrop-blur-sm">
//             <section className="flex max-h-[86vh] w-full max-w-4xl flex-col overflow-hidden rounded-lg border border-slate-300 bg-white text-slate-950 shadow-2xl shadow-slate-950/30">
//                 <div className="flex items-start justify-between gap-4 border-b border-slate-200 bg-slate-50 px-5 py-4">
//                     <div className="min-w-0">
//                         <p className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">Qualified Leads</p>
//                         <h3 className="mt-1 truncate text-lg font-semibold">{row.employeeName}</h3>
//                         <p className="mt-1 text-sm text-slate-600">
//                             Showing {formatNumber(leads.length)} records included in the dashboard qualified count.
//                         </p>
//                     </div>
//                     <button
//                         type="button"
//                         className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-slate-300 bg-white text-slate-700 transition hover:border-[#842cff] hover:text-[#6426d9]"
//                         onClick={onClose}
//                         aria-label="Close qualified leads"
//                     >
//                         <FiX className="size-4" aria-hidden="true" />
//                     </button>
//                 </div>
//                 <div className="content-scroll overflow-y-auto p-4">
//                     {leads.length === 0 ? (
//                         <EmptyPanel title="No qualified lead details" message="This row has no qualified lead records attached to the current dashboard response." />
//                     ) : (
//                         <div className="overflow-hidden rounded-lg border border-slate-300">
//                             <table className="w-full min-w-[46rem] table-fixed border-separate border-spacing-0">
//                                 <colgroup>
//                                     <col className="w-[28%]" />
//                                     <col className="w-[28%]" />
//                                     <col className="w-[14%]" />
//                                     <col className="w-[14%]" />
//                                     <col className="w-[16%]" />
//                                 </colgroup>
//                                 <thead className="bg-slate-50 text-[0.68rem] uppercase tracking-[0.12em] text-slate-500">
//                                     <tr>
//                                         <th className="px-3 py-3 text-left font-semibold">Lead</th>
//                                         <th className="px-3 py-3 text-left font-semibold">Business</th>
//                                         <th className="px-3 py-3 text-left font-semibold">Category</th>
//                                         <th className="px-3 py-3 text-left font-semibold">Source</th>
//                                         <th className="px-3 py-3 text-left font-semibold">Qualified At</th>
//                                     </tr>
//                                 </thead>
//                                 <tbody className="divide-y divide-slate-200">
//                                     {leads.map((lead: MonthlyQualifiedLead) => {
//                                         const leadPath = getQualifiedLeadPath(lead);

//                                         return (
//                                             <tr key={lead.leadId} className="text-sm text-slate-700 transition hover:bg-violet-50/70">
//                                                 <td className="p-0">
//                                                     <Link className="block px-3 py-3" to={leadPath}>
//                                                         <p className="truncate font-semibold text-slate-950">{lead.leadName || "No contact name"}</p>
//                                                         <p className="mt-0.5 truncate text-xs text-slate-500">{lead.status}</p>
//                                                     </Link>
//                                                 </td>
//                                                 <td className="p-0">
//                                                     <Link className="block px-3 py-3" to={leadPath}>
//                                                         <p className="truncate font-semibold text-slate-800">{lead.businessName || "No business"}</p>
//                                                         <p className="mt-0.5 truncate text-xs text-slate-500">{lead.assignedAgentName || row.employeeName}</p>
//                                                     </Link>
//                                                 </td>
//                                                 <td className="p-0">
//                                                     <Link className="block px-3 py-3" to={leadPath}>{lead.category || "Uncategorized"}</Link>
//                                                 </td>
//                                                 <td className="p-0">
//                                                     <Link className="block px-3 py-3" to={leadPath}>{lead.source || "Manual"}</Link>
//                                                 </td>
//                                                 <td className="p-0">
//                                                     <Link className="block px-3 py-3" to={leadPath}>{lead.statusAt ? formatPhDateTime(lead.statusAt) : "No date"}</Link>
//                                                 </td>
//                                             </tr>
//                                         );
//                                     })}
//                                 </tbody>
//                             </table>
//                         </div>
//                     )}
//                 </div>
//             </section>
//         </div>,
//         document.body
//     );
// }

// function EmployeeLeadCallsModal({
//     row,
//     onClose,
// }: {
//     row: EmployeeCallSummaryRow;
//     onClose: () => void;
// }) {

//     const navigate = useNavigate();

//     const openLead = (leadId: string) => {
//         onClose();
//         navigate(`/admin/leads?lead=${leadId}`);
//     };

//     return createPortal(
//         <div
//             className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/65 px-4 py-6 backdrop-blur-sm"
//             onMouseDown={(event) => {
//                 if (event.target === event.currentTarget) {
//                     onClose();
//                 }
//             }}
//         >
//             <section
//                 className="flex max-h-[86vh] w-full max-w-5xl flex-col overflow-hidden rounded-lg border border-slate-300 bg-white text-slate-950 shadow-2xl shadow-slate-950/30"
//                 role="dialog"
//                 aria-modal="true"
//                 aria-labelledby="employee-lead-calls-title"
//             >
//                 <div className="flex items-start justify-between gap-4 border-b border-slate-200 bg-slate-50 px-5 py-4">
//                     <div className="min-w-0">
//                         <p className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">
//                             Employee Lead Calls
//                         </p>

//                         <h3
//                             id="employee-lead-calls-title"
//                             className="mt-1 truncate text-lg font-semibold text-slate-950"
//                         >
//                             {row.employeeName}
//                         </h3>

//                         <p className="mt-1 text-sm text-slate-600">
//                             Showing {formatNumber(row.leads.length)} lead record
//                             {row.leads.length === 1 ? "" : "s"} and{" "}
//                             {formatNumber(row.totalCalls)} total call
//                             {row.totalCalls === 1 ? "" : "s"}.
//                         </p>
//                     </div>

//                     <button
//                         type="button"
//                         className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-slate-300 bg-white text-slate-700 transition hover:border-[#842cff] hover:text-[#6426d9]"
//                         onClick={onClose}
//                         aria-label="Close employee lead calls"
//                     >
//                         <FiX className="size-4" aria-hidden="true" />
//                     </button>
//                 </div>

//                 <div className="content-scroll overflow-y-auto p-4">
//                     {row.leads.length === 0 ? (
//                         <EmptyPanel
//                             title="No lead call records"
//                             message="This employee has no lead call records attached."
//                         />
//                     ) : (
//                         <div className="overflow-x-auto rounded-lg border border-slate-300 bg-white">
//                             <table className="w-full min-w-[52rem] table-fixed border-separate border-spacing-0">
//                                 <colgroup>
//                                     <col className="w-[30%]" />
//                                     <col className="w-[30%]" />
//                                     <col className="w-[12%]" />
//                                     <col className="w-[14%]" />
//                                     <col className="w-[14%]" />
//                                 </colgroup>
//                                 <thead className="bg-slate-50 text-[0.68rem] uppercase tracking-[0.12em] text-slate-500">
//                                     <tr>
//                                         <th className="px-3 py-3 text-left font-semibold">Lead</th>
//                                         <th className="px-3 py-3 text-left font-semibold">Business</th>
//                                         <th className="px-3 py-3 text-center font-semibold">Calls</th>
//                                         <th className="px-3 py-3 text-center font-semibold">Not Connected</th>
//                                         <th className="px-3 py-3 text-left font-semibold">Last Call</th>
//                                     </tr>
//                                 </thead>
//                                 <tbody className="divide-y divide-slate-200">
//                                     {row.leads.map((lead) => (
//                                         <tr
//                                             key={lead.leadId}
//                                             role="link"
//                                             tabIndex={0}
//                                             className="cursor-pointer text-sm text-slate-700 transition hover:bg-emerald-50/60 focus:bg-emerald-50/60 focus:outline-none focus:ring-2 focus:ring-inset focus:ring-emerald-300"
//                                             onClick={() => openLead(lead.leadId)}
//                                             onKeyDown={(event) => {
//                                                 if (event.key === "Enter" || event.key === " ") {
//                                                     event.preventDefault();
//                                                     openLead(lead.leadId);
//                                                 }
//                                             }}
//                                         >
//                                             <td className="px-3 py-3">
//                                                 <p className="truncate font-semibold text-slate-950">
//                                                     {lead.leadName || "No lead name"}
//                                                 </p>

//                                                 <p className="mt-0.5 truncate text-xs text-slate-500">
//                                                     {lead.leadId}
//                                                 </p>
//                                             </td>

//                                             <td className="px-3 py-3">
//                                                 <p className="truncate font-semibold text-slate-800">
//                                                     {lead.businessName || "No business name"}
//                                                 </p>
//                                             </td>

//                                             <td className="px-3 py-3 text-center font-semibold text-slate-950">
//                                                 {formatNumber(lead.callCount)}
//                                             </td>

//                                             <td className="px-3 py-3 text-center font-semibold text-rose-600">
//                                                 {formatNumber(lead.callNotConnectedCount)}
//                                             </td>

//                                             <td className="px-3 py-3 text-sm text-slate-600">
//                                                 {lead.lastCallAt ? formatPhDateTime(lead.lastCallAt) : "No date"}
//                                             </td>
//                                         </tr>
//                                     ))}
//                                 </tbody>
//                             </table>
//                         </div>
//                     )}
//                 </div>
//             </section>
//         </div>,
//         document.body
//     );
// }

// function ActivityItem({ item, onOpen }: { item: AgentLeadActivity; onOpen: (item: AgentLeadActivity) => void }) {
//     const leadName = item.leadName || item.businessName || "Lead";

//     return (
//         <button
//             type="button"
//             className="cursor-pointer rounded-lg border border-slate-300 bg-white p-3 text-left transition hover:border-[#842cff] hover:bg-violet-50/40 focus:outline-none focus:ring-2 focus:ring-[#842cff]/35"
//             onClick={() => onOpen(item)}
//             aria-label={`Open transaction history for ${leadName}`}
//         >
//             <div className="flex items-start justify-between gap-3">
//                 <div className="min-w-0">
//                     <p className="truncate text-sm font-semibold text-slate-950">{item.employeeName}</p>
//                     <p className="mt-1 truncate text-xs text-slate-500">{leadName}</p>
//                 </div>
//                 <span className={`shrink-0 rounded-md border px-2 py-1 text-xs font-semibold ${activityLabelClass(item.action)}`}>
//                     {item.action}
//                 </span>
//             </div>
//             <p className="mt-3 line-clamp-3 whitespace-pre-line text-sm leading-5 text-slate-700">{item.detail}</p>
//             <p className="mt-2 text-xs font-semibold uppercase tracking-[0.12em] text-slate-400">
//                 {item.createdAt ? formatPhDateTime(item.createdAt) : "No time"}
//             </p>
//             <span className="mt-3 inline-flex text-xs font-semibold text-[#842cff]">View history</span>
//         </button>
//     );
// }

// function LeadHistoryModal({
//     activity,
//     lead,
//     history,
//     isLoading,
//     isError,
//     onClose,
// }: {
//     activity: AgentLeadActivity;
//     lead?: Lead;
//     history: LeadHistoryItem[];
//     isLoading: boolean;
//     isError: boolean;
//     onClose: () => void;
// }) {
//     const leadName = getLeadDisplayName(lead, activity);
//     const assignedAgentName = lead?.assignedAgentName || lead?.assignedAgent?.name || activity.employeeName || "Unassigned";
//     const status = lead?.status || activity.status;
//     const latestTime = history[0]?.createdAt || activity.createdAt;

//     return createPortal(
//         <div
//             className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 p-4"
//             onMouseDown={(event) => {
//                 if (event.target === event.currentTarget) {
//                     onClose();
//                 }
//             }}
//         >
//             <section
//                 className="flex max-h-[88vh] w-full max-w-3xl flex-col overflow-hidden rounded-lg border border-slate-300 bg-white text-slate-950 shadow-2xl shadow-slate-950/30"
//                 role="dialog"
//                 aria-modal="true"
//                 aria-labelledby="lead-history-title"
//             >
//                 <header className="flex items-start justify-between gap-4 border-b border-slate-200 px-5 py-4">
//                     <div className="min-w-0">
//                         <p className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">Transaction History</p>
//                         <h3 id="lead-history-title" className="mt-1 truncate text-xl font-semibold text-slate-950">{leadName}</h3>
//                         <p className="mt-1 truncate text-sm text-slate-600">{lead?.businessName || activity.businessName || "No business name"}</p>
//                     </div>
//                     <button
//                         type="button"
//                         className="flex size-10 shrink-0 items-center justify-center rounded-lg border border-slate-300 bg-white text-slate-700 transition hover:bg-slate-100"
//                         onClick={onClose}
//                         aria-label="Close transaction history"
//                     >
//                         <FiX className="size-5" aria-hidden="true" />
//                     </button>
//                 </header>

//                 <div className="grid gap-3 border-b border-slate-200 bg-slate-50 px-5 py-4 sm:grid-cols-3">
//                     <div className="rounded-lg border border-slate-300 bg-white p-3">
//                         <p className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">Status</p>
//                         <span className={`mt-2 inline-flex rounded-md border px-2 py-1 text-xs font-semibold ${activityLabelClass(status || "")}`}>
//                             {status || "Unknown"}
//                         </span>
//                     </div>
//                     <div className="rounded-lg border border-slate-300 bg-white p-3">
//                         <p className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">Assigned Agent</p>
//                         <p className="mt-2 truncate text-sm font-semibold text-slate-950">{assignedAgentName}</p>
//                     </div>
//                     <div className="rounded-lg border border-slate-300 bg-white p-3">
//                         <p className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">Latest</p>
//                         <p className="mt-2 text-sm font-semibold text-slate-950">{latestTime ? formatPhDateTime(latestTime) : "No time"}</p>
//                     </div>
//                 </div>

//                 <div className="overflow-y-auto px-5 py-4">
//                     {isLoading && <EmptyPanel title="Loading transaction history" message="Getting the latest lead activity." />}
//                     {!activity.leadId && <EmptyPanel title="Lead history is unavailable" message="This activity record is missing its lead link." />}
//                     {isError && <EmptyPanel title="Transaction history could not load" message="Please refresh and try opening this lead again." />}
//                     {!isLoading && activity.leadId && !isError && history.length === 0 && (
//                         <EmptyPanel title="No transaction history yet" message="Comments, status changes, schedules, and follow-ups will show here." />
//                     )}
//                     {!isLoading && activity.leadId && !isError && history.length > 0 && (
//                         <div className="space-y-4">
//                             {history.map((item) => (
//                                 <article key={item.id} className="relative border-l border-slate-200 pl-4">
//                                     <span className={`absolute -left-[5px] top-1 size-2.5 rounded-full ${item.kind === "comment" ? "bg-sky-500" : "bg-[#842cff]"}`} />
//                                     <div className="flex flex-wrap items-start justify-between gap-2">
//                                         <div className="min-w-0">
//                                             <p className="text-sm font-semibold text-slate-950">{item.label}</p>
//                                             <p className="mt-1 text-xs text-slate-500">
//                                                 {item.actorName} · {item.actorType}
//                                             </p>
//                                         </div>
//                                         {item.status && (
//                                             <span className={`shrink-0 rounded-md border px-2 py-1 text-xs font-semibold ${activityLabelClass(item.status)}`}>
//                                                 {item.status}
//                                             </span>
//                                         )}
//                                     </div>
//                                     <p className="mt-2 whitespace-pre-line text-sm leading-5 text-slate-700">{item.detail}</p>
//                                     <p className="mt-2 text-xs font-semibold uppercase tracking-[0.12em] text-slate-400">
//                                         {item.createdAt ? formatPhDateTime(item.createdAt) : "No time"}
//                                     </p>
//                                 </article>
//                             ))}
//                         </div>
//                     )}
//                 </div>
//             </section>
//         </div>,
//         document.body
//     );
// }

// type EmployeeLeadCallRow = {
//     leadId: string;
//     leadName: string;
//     businessName: string;
//     callCount: number;
//     callNotConnectedCount: number;
//     totalAttempts: number;
//     lastCallAt: string | null;
//     callLogs: NonNullable<LeadCallStat["callLogs"]>;
// };

// type EmployeeCallSummaryRow = {
//     employeeId: string;
//     employeeName: string;
//     employeeRole: string;
//     employeeTeam: string;
//     totalCalls: number;
//     totalNotConnectedCalls: number;
//     totalAttempts: number;
//     lastCallAt: string | null;
//     leads: EmployeeLeadCallRow[];
// };

// function getDateTimeValue(value?: string | null) {
//     const timestamp = value ? new Date(value).getTime() : 0;
//     return Number.isNaN(timestamp) ? 0 : timestamp;
// }

// function getLatestDateValue(first?: string | null, second?: string | null) {
//     return getDateTimeValue(first) >= getDateTimeValue(second) ? first || null : second || null;
// }

// function getLeadCallStatLeadId(item: LeadCallStat) {
//     if (typeof item.lead === "string") {
//         return item.lead;
//     }

//     return item.lead?._id || item._id || `${item.leadName}-${item.businessName}`;
// }

// function getCallLogEmployeeId(log: LeadCallStat["callLogs"][number]) {
//     if (typeof log.employee === "string") {
//         return log.employee;
//     }

//     return log.employee?._id || "";
// }

// function buildEmployeeCallRows(leadCallStats: LeadCallStat[]): EmployeeCallSummaryRow[] {
//     const rowsByEmployee = new Map<string, EmployeeCallSummaryRow>();

//     leadCallStats.forEach((item) => {
//         const leadId = getLeadCallStatLeadId(item);
//         const leadName = item.leadName || "No lead name";
//         const businessName = item.businessName || "No business name";

//         (item.callLogs || []).forEach((log) => {
//             const employeeId =
//                 getCallLogEmployeeId(log) ||
//                 `employee-name:${String(log.employeeName || "Employee").trim().toLowerCase()}`;

//             if (!employeeId) {
//                 return;
//             }

//             const outcome = log.outcome === "not_connected" ? "not_connected" : "connected";
//             const calledAt = log.calledAt || item.lastCallAt || null;

//             if (!rowsByEmployee.has(employeeId)) {
//                 rowsByEmployee.set(employeeId, {
//                     employeeId,
//                     employeeName: log.employeeName || "Employee",
//                     employeeRole: log.employeeRole || "",
//                     employeeTeam: log.employeeTeam || "",
//                     totalCalls: 0,
//                     totalNotConnectedCalls: 0,
//                     totalAttempts: 0,
//                     lastCallAt: null,
//                     leads: [],
//                 });
//             }

//             const employeeRow = rowsByEmployee.get(employeeId)!;

//             employeeRow.employeeName = log.employeeName || employeeRow.employeeName;
//             employeeRow.employeeRole = log.employeeRole || employeeRow.employeeRole;
//             employeeRow.employeeTeam = log.employeeTeam || employeeRow.employeeTeam;
//             employeeRow.totalAttempts += 1;
//             employeeRow.lastCallAt = getLatestDateValue(employeeRow.lastCallAt, calledAt);

//             if (outcome === "not_connected") {
//                 employeeRow.totalNotConnectedCalls += 1;
//             } else {
//                 employeeRow.totalCalls += 1;
//             }

//             let leadRow = employeeRow.leads.find((lead) => lead.leadId === leadId);

//             if (!leadRow) {
//                 leadRow = {
//                     leadId,
//                     leadName,
//                     businessName,
//                     callCount: 0,
//                     callNotConnectedCount: 0,
//                     totalAttempts: 0,
//                     lastCallAt: null,
//                     callLogs: [],
//                 };

//                 employeeRow.leads.push(leadRow);
//             }

//             leadRow.totalAttempts += 1;
//             leadRow.lastCallAt = getLatestDateValue(leadRow.lastCallAt, calledAt);
//             leadRow.callLogs.push(log);

//             if (outcome === "not_connected") {
//                 leadRow.callNotConnectedCount += 1;
//             } else {
//                 leadRow.callCount += 1;
//             }
//         });
//     });

//     return Array.from(rowsByEmployee.values())
//         .map((employeeRow) => ({
//             ...employeeRow,
//             leads: employeeRow.leads.sort(
//                 (first, second) =>
//                     getDateTimeValue(second.lastCallAt) - getDateTimeValue(first.lastCallAt)
//             ),
//         }))
//         .sort(
//             (first, second) =>
//                 getDateTimeValue(second.lastCallAt) - getDateTimeValue(first.lastCallAt)
//         );
// }

// function getDateStart(value: string) {
//     const date = parseDateInputValue(value);

//     if (!date) {
//         return null;
//     }

//     date.setHours(0, 0, 0, 0);
//     return date;
// }

// function getDateEnd(value: string) {
//     const date = parseDateInputValue(value);

//     if (!date) {
//         return null;
//     }

//     date.setHours(23, 59, 59, 999);
//     return date;
// }

// function isCallLogWithinDateRange(
//     calledAt: string | undefined,
//     dateFrom: string,
//     dateTo: string
// ) {
//     if (!calledAt) {
//         return false;
//     }

//     const calledTime = new Date(calledAt).getTime();

//     if (Number.isNaN(calledTime)) {
//         return false;
//     }

//     const startDate = getDateStart(dateFrom);
//     const endDate = getDateEnd(dateTo);

//     if (startDate && calledTime < startDate.getTime()) {
//         return false;
//     }

//     if (endDate && calledTime > endDate.getTime()) {
//         return false;
//     }

//     return true;
// }

// function filterLeadCallStatsByDateRange(
//     leadCallStats: LeadCallStat[],
//     dateFrom: string,
//     dateTo: string
// ) {
//     return leadCallStats
//         .map((item) => {
//             const filteredCallLogs = (item.callLogs || []).filter((log) =>
//                 isCallLogWithinDateRange(log.calledAt, dateFrom, dateTo)
//             );

//             const connectedLogs = filteredCallLogs.filter(
//                 (log) => (log.outcome || "connected") === "connected"
//             );

//             const notConnectedLogs = filteredCallLogs.filter(
//                 (log) => log.outcome === "not_connected"
//             );

//             const latestLog = [...filteredCallLogs].sort((first, second) => {
//                 const firstTime = first.calledAt ? new Date(first.calledAt).getTime() : 0;
//                 const secondTime = second.calledAt ? new Date(second.calledAt).getTime() : 0;

//                 return secondTime - firstTime;
//             })[0];

//             return {
//                 ...item,
//                 callLogs: filteredCallLogs,
//                 callCount: connectedLogs.length,
//                 callNotConnectedCount: notConnectedLogs.length,
//                 lastCallAt: latestLog?.calledAt || null,
//             };
//         })
//         .filter((item) => item.callLogs.length > 0);
// }

// export default function AdminDashboard() {
//     const [selectedActivity, setSelectedActivity] = useState<AgentLeadActivity | null>(null);
//     const [qualifiedLeadRow, setQualifiedLeadRow] = useState<AgentLeadMonthlyRow | null>(null);
//     const [selectedMonth, setSelectedMonth] = useState(() => getMonthInputValue(new Date()));
//     const [isMonthMenuOpen, setIsMonthMenuOpen] = useState(false);
//     const [callCountRange, setCallCountRange] = useState<CallCountRange>("day");
//     const [selectedCallDate, setSelectedCallDate] = useState(() => formatDateInputValue(new Date()));
//     const [selectedCallEmployeeId, setSelectedCallEmployeeId] = useState("all");
//     const [agentPage, setAgentPage] = useState(1);
//     const [monthlyPage, setMonthlyPage] = useState(1);
//     const selectedMonthlyRange = useMemo(() => getMonthlyDashboardDateRange(selectedMonth), [selectedMonth]);
//     const monthlyRangeLabel = useMemo(() => formatDateRangeLabel(selectedMonthlyRange.dateFrom, selectedMonthlyRange.dateTo), [selectedMonthlyRange]);
//     const { data, isLoading, isError, refetch, isFetching } = useQuery({
//         queryKey: ["agent-lead-dashboard", selectedMonth, selectedMonthlyRange.dateFrom, selectedMonthlyRange.dateTo, selectedCallDate],
//         queryFn: () => getAgentLeadDashboard({ month: selectedMonth, dateFrom: selectedMonthlyRange.dateFrom, dateTo: selectedMonthlyRange.dateTo, callDate: selectedCallDate }),
//         refetchInterval: 60_000,
//     });
//     const employeesQuery = useQuery({
//         queryKey: ["employees", "summary", "dashboard-online-status"],
//         queryFn: getEmployeeSummaries,
//         refetchInterval: 60_000,
//     });
//     const selectedLeadId = selectedActivity?.leadId || "";
//     const leadHistoryQuery = useQuery({
//         queryKey: ["dashboard-lead-history", selectedLeadId],
//         queryFn: () => getLead(selectedLeadId),
//         enabled: Boolean(selectedLeadId),
//     });
//     const agents = useMemo(() => mergeAgentProgressRows(data?.agents || []), [data?.agents]);
//     const monthlyAgents = useMemo(() => mergeAgentMonthlyRows(data?.monthlyAgents || []), [data?.monthlyAgents]);
//     const summary = data?.summary;
//     const totalAgentPages = Math.max(Math.ceil(agents.length / agentRowsPerPage), 1);
//     const currentAgentPage = Math.min(agentPage, totalAgentPages);
//     const visibleAgents = useMemo(() => {
//         const startIndex = (currentAgentPage - 1) * agentRowsPerPage;

//         return agents.slice(startIndex, startIndex + agentRowsPerPage);
//     }, [agents, currentAgentPage]);
//     const agentPageNumbers = getPaginationNumbers(currentAgentPage, totalAgentPages);
//     const agentPageStart = agents.length === 0 ? 0 : (currentAgentPage - 1) * agentRowsPerPage + 1;
//     const agentPageEnd = Math.min(currentAgentPage * agentRowsPerPage, agents.length);
//     const totalMonthlyPages = Math.max(Math.ceil(monthlyAgents.length / monthlyRowsPerPage), 1);
//     const currentMonthlyPage = Math.min(monthlyPage, totalMonthlyPages);
//     const visibleMonthlyAgents = useMemo(() => {
//         const startIndex = (currentMonthlyPage - 1) * monthlyRowsPerPage;

//         return monthlyAgents.slice(startIndex, startIndex + monthlyRowsPerPage);
//     }, [monthlyAgents, currentMonthlyPage]);
//     const monthlyPageNumbers = getPaginationNumbers(currentMonthlyPage, totalMonthlyPages);
//     const monthlyPageStart = monthlyAgents.length === 0 ? 0 : (currentMonthlyPage - 1) * monthlyRowsPerPage + 1;
//     const monthlyPageEnd = Math.min(currentMonthlyPage * monthlyRowsPerPage, monthlyAgents.length);
//     const topAgents = agents.slice(0, 5);
//     const onlineStatusAgents = useMemo(() => {
//         if (employeesQuery.data) {
//             return buildOnlineStatusRows(employeesQuery.data, agents);
//         }

//         return [...agents].sort((first, second) => {
//             const rankDifference = availabilitySortRank(first.availabilityStatus) - availabilitySortRank(second.availabilityStatus);

//             if (rankDifference !== 0) return rankDifference;

//             return first.employeeName.localeCompare(second.employeeName);
//         });
//     }, [agents, employeesQuery.data]);
//     const availableAgentCount = onlineStatusAgents.filter(
//         (agent) => normalizeEmployeeAvailabilityStatus(agent.availabilityStatus) !== "OFFLINE"
//     ).length;
//     const leadHistory = useMemo(() => getLeadHistory(leadHistoryQuery.data), [leadHistoryQuery.data]);
//     const pipelineTotals = useMemo(() => {
//         return agents.reduce(
//             (totals, agent) => ({
//                 total: totals.total + agent.newLeads + agent.followUps + agent.qualified + agent.dead,
//                 newLeads: totals.newLeads + agent.newLeads,
//                 followUps: totals.followUps + agent.followUps,
//                 qualified: totals.qualified + agent.qualified,
//                 dead: totals.dead + agent.dead,
//             }),
//             { total: 0, newLeads: 0, followUps: 0, qualified: 0, dead: 0 }
//         );
//     }, [agents]);
//     const pipelineBars = [
//         { label: "NEW", value: pipelineTotals.newLeads, color: "bg-slate-400" },
//         { label: "FOLLOW UP", value: pipelineTotals.followUps, color: "bg-violet-500" },
//         { label: "QUALIFIED", value: pipelineTotals.qualified, color: "bg-emerald-500" },
//         { label: "ARCHIVE/DEAD", value: pipelineTotals.dead, color: "bg-red-400" },
//     ];
//     const maxPipelineValue = Math.max(...pipelineBars.map((item) => item.value), 1);
//     const monthlyTotals = useMemo(() => {
//         return monthlyAgents.reduce(
//             (totals, row) => ({
//                 leadsAdded: totals.leadsAdded + row.leadsAdded,
//                 calls: totals.calls + (row.calls || 0),
//                 comments: totals.comments + row.comments,
//                 touchedLeads: totals.touchedLeads + row.touchedLeads,
//                 productivityScore: totals.productivityScore + row.productivityScore,
//             }),
//             { leadsAdded: 0, calls: 0, comments: 0, touchedLeads: 0, productivityScore: 0 }
//         );
//     }, [monthlyAgents]);
//     const dailyCallCount = summary?.callsToday ?? agents.reduce((total, agent) => total + (agent.callsToday || 0), 0);
//     const callEmployeeOptions = useMemo(() => {
//         const optionsById = new Map<string, { id: string; name: string }>();
//         const addOption = (id?: string, name?: string) => {
//             const normalizedId = String(id || "").trim();
//             const normalizedName = String(name || "").trim();

//             if (!normalizedId || !normalizedName || optionsById.has(normalizedId)) return;

//             optionsById.set(normalizedId, { id: normalizedId, name: normalizedName });
//         };

//         agents.forEach((agent) => addOption(agent.employeeId, agent.employeeName));
//         monthlyAgents.forEach((agent) => addOption(agent.employeeId, agent.employeeName));

//         return Array.from(optionsById.values()).sort((first, second) => first.name.localeCompare(second.name));
//     }, [agents, monthlyAgents]);
//     const selectedDailyCallCount = selectedCallEmployeeId === "all"
//         ? dailyCallCount
//         : agents.find((agent) => agent.employeeId === selectedCallEmployeeId)?.callsToday || 0;
//     const selectedMonthlyCallCount = selectedCallEmployeeId === "all"
//         ? monthlyTotals.calls
//         : monthlyAgents.find((agent) => agent.employeeId === selectedCallEmployeeId)?.calls || 0;
//     const selectedCallCount = callCountRange === "day" ? selectedDailyCallCount : selectedMonthlyCallCount;
//     const selectedCallEmployeeName = selectedCallEmployeeId === "all"
//         ? "All employees"
//         : callEmployeeOptions.find((employee) => employee.id === selectedCallEmployeeId)?.name || "Selected employee";
//     const selectedCallHelper = callCountRange === "day"
//         ? `${selectedCallEmployeeName} · calls logged ${formatSingleDateLabel(selectedCallDate)}`
//         : `${selectedCallEmployeeName} · calls logged ${monthlyRangeLabel}`;
//     const monthOptions = useMemo(() => {
//         return Array.from(new Set([selectedMonth, data?.selectedMonth || "", ...(data?.monthOptions || [])]))
//             .filter(Boolean)
//             .sort((first, second) => second.localeCompare(first));
//     }, [data?.monthOptions, data?.selectedMonth, selectedMonth]);
//     const handleExportMonthlyData = () => {
//         const rows = [
//             ["Date Range", "Agent", "Role", "Team", "Added", "Follow Up", "Calls", "Qualified", "Archive/Dead", "Comments", "Touched", "Score", "Last Activity"],
//             ...monthlyAgents.map((row) => [
//                 monthlyRangeLabel,
//                 row.employeeName,
//                 row.role,
//                 row.team,
//                 row.leadsAdded,
//                 row.followUps,
//                 row.calls || 0,
//                 row.qualified,
//                 row.archiveDead,
//                 row.comments,
//                 row.touchedLeads,
//                 row.productivityScore,
//                 row.lastActivityAt ? formatPhDateTime(row.lastActivityAt) : "",
//             ]),
//             [
//                 monthlyRangeLabel,
//                 "Total",
//                 "",
//                 "",
//                 monthlyTotals.leadsAdded,
//                 "",
//                 monthlyTotals.calls,
//                 "",
//                 "",
//                 monthlyTotals.comments,
//                 monthlyTotals.touchedLeads,
//                 monthlyTotals.productivityScore,
//                 "",
//             ],
//         ];

//         downloadCsv(`agent-monthly-data-${selectedMonthlyRange.dateFrom}-to-${selectedMonthlyRange.dateTo}.csv`, rows);
//     };

//     const leadCallStatsQuery = useQuery({
//         queryKey: ["lead-call-stats"],
//         queryFn: () => getLeadCallStats(100),
//         refetchInterval: 60_000,
//     });

//     const leadCallStats = leadCallStatsQuery.data || [];

//     const [selectedCallEmployeeRow, setSelectedCallEmployeeRow] = useState<EmployeeCallSummaryRow | null>(null);

//     const [callFilterDateFrom, setCallFilterDateFrom] = useState(() =>
//         formatDateInputValue(new Date())
//     );

//     const [callFilterDateTo, setCallFilterDateTo] = useState(() =>
//         formatDateInputValue(new Date())
//     );

//     const filteredLeadCallStats = useMemo(() => {
//         return filterLeadCallStatsByDateRange(
//             leadCallStats,
//             callFilterDateFrom,
//             callFilterDateTo
//         );
//     }, [leadCallStats, callFilterDateFrom, callFilterDateTo]);

//     const employeeCallRows = useMemo(() => {
//         return buildEmployeeCallRows(filteredLeadCallStats);
//     }, [filteredLeadCallStats]);

//     const totalLoggedLeadCalls = useMemo(() => {
//         return employeeCallRows.reduce((total, item) => total + item.totalCalls, 0);
//     }, [employeeCallRows]);

//     const totalNotConnectedCalls = useMemo(() => {
//         return employeeCallRows.reduce(
//             (total, item) => total + item.totalNotConnectedCalls,
//             0
//         );
//     }, [employeeCallRows]);

//     return (
//         <AdminLayout>
//             <section className="admin-dashboard-page min-h-full space-y-5">
//                 <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
//                     <div>
//                         <p className="text-xs font-semibold uppercase tracking-[0.16em] text-white/45">Admin Dashboard</p>
//                         <h2 className="mt-1 text-2xl font-semibold text-white">Agent Lead Progress</h2>
//                         <p className="mt-1 text-sm text-white/55">Live lead workload, movement, and productivity using PH time for today.</p>
//                     </div>
//                     <div className="flex flex-wrap items-center gap-2">
//                         <span className="rounded-lg border border-white/10 bg-white/[0.05] px-3 py-2 text-xs font-semibold text-white/55">
//                             Updated {data?.generatedAt ? formatPhDateTime(data.generatedAt) : "loading"}
//                         </span>
//                         <button
//                             className="inline-flex h-10 items-center gap-2 rounded-lg border border-white/10 bg-white px-3 text-sm font-semibold text-slate-950 transition hover:bg-slate-100 disabled:opacity-60"
//                             type="button"
//                             onClick={() => void refetch()}
//                             disabled={isFetching}
//                         >
//                             <FiRefreshCw className={["size-4", isFetching ? "animate-spin" : ""].join(" ")} aria-hidden="true" />
//                             Refresh
//                         </button>
//                     </div>
//                 </div>

//                 <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
//                     <KpiCard label="Active Agents" value={formatNumber(summary?.totalActiveAgents)} helper={`${formatNumber(summary?.onlineAgents)} online or available now`} icon={FiUsers} accent="green" />
//                     <KpiCard label="Open Leads" value={formatNumber(summary?.totalOpenLeads)} helper={`${formatNumber(summary?.unassignedLeads)} still unassigned`} icon={FiTarget} accent="blue" />
//                     <KpiCard label="Due Follow-ups" value={formatNumber(summary?.dueFollowUps)} helper={`${formatNumber(summary?.touchedLeadsToday)} leads touched today`} icon={FiClock} accent="orange" />
//                     <KpiCard label="Productivity Today" value={formatNumber(summary?.activityToday)} helper={`${formatNumber(summary?.commentsToday)} employee comments logged`} icon={FiTrendingUp} accent="purple" />
//                 </div>

//                 {isError && (
//                     <section className="rounded-lg border border-red-200 bg-red-50 p-4 text-red-700">
//                         <p className="font-semibold">Dashboard data could not load.</p>
//                         <p className="mt-1 text-sm">Please refresh after the backend is running.</p>
//                     </section>
//                 )}

//                 <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_18rem] 2xl:grid-cols-[minmax(0,1fr)_20rem]">
//                     <section className="dashboard-panel-accent dashboard-accent-green overflow-hidden rounded-lg border border-slate-300 bg-white text-slate-950 shadow-lg shadow-slate-950/10">
//                         <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-300 bg-slate-50 px-4 py-4">
//                             <div>
//                                 <p className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">Agent Productivity</p>
//                                 <h3 className="mt-1 text-base font-semibold">Lead progress by agent</h3>
//                             </div>
//                             <Link className="inline-flex h-9 items-center gap-2 rounded-lg bg-[#842cff] px-3 text-sm font-semibold text-white transition hover:brightness-110" to="/admin/leads">
//                                 <FiTarget className="size-4" aria-hidden="true" />
//                                 Manage Leads
//                             </Link>
//                         </div>
//                         <div className="overflow-x-auto">
//                             <table className="w-full min-w-[50rem] table-fixed border-separate border-spacing-0">
//                                 <colgroup>
//                                     <col className="w-[35%]" />
//                                     <col className="w-[9%]" />
//                                     <col className="w-[8%]" />
//                                     <col className="w-[13%]" />
//                                     <col className="w-[9%]" />
//                                     <col className="w-[12%]" />
//                                     <col className="w-[14%]" />
//                                 </colgroup>
//                                 <thead className="bg-white text-[0.68rem] uppercase tracking-[0.12em] text-slate-500">
//                                     <tr>
//                                         <th className="px-3 py-3 text-left font-semibold">Agent</th>
//                                         <th className="px-3 py-3 text-center font-semibold">Total</th>
//                                         <th className="px-3 py-3 text-center font-semibold">NEW</th>
//                                         <th className="px-3 py-3 text-center font-semibold">FOLLOW UP</th>
//                                         <th className="px-3 py-3 text-center font-semibold">CALLS</th>
//                                         <th className="px-3 py-3 text-center font-semibold">QUALIFIED</th>
//                                         <th className="px-3 py-3 text-center font-semibold">ARCHIVE/DEAD</th>
//                                     </tr>
//                                 </thead>
//                                 <tbody className="divide-y divide-slate-200">
//                                     {isLoading && (
//                                         <tr>
//                                             <td className="px-4 py-8 text-center text-sm text-slate-500" colSpan={7}>Loading agent metrics...</td>
//                                         </tr>
//                                     )}
//                                     {!isLoading && agents.length === 0 && (
//                                         <tr>
//                                             <td className="px-4 py-8" colSpan={7}>
//                                                 <EmptyPanel title="No agent lead data yet" message="Agents will appear here after they have lead assignments or lead activity." />
//                                             </td>
//                                         </tr>
//                                     )}
//                                     {visibleAgents.map((agent) => <AgentProgressRow key={agent.employeeId} agent={agent} />)}
//                                     {!isLoading && visibleAgents.length > 0 && visibleAgents.length < agentRowsPerPage && Array.from({ length: agentRowsPerPage - visibleAgents.length }).map((_, index) => (
//                                         <tr key={`agent-placeholder-${index}`} aria-hidden="true" className="pointer-events-none">
//                                             <td className="h-[4.5rem] px-3 py-0" colSpan={7} />
//                                         </tr>
//                                     ))}
//                                 </tbody>
//                             </table>
//                         </div>
//                         {!isLoading && agents.length > 0 && (
//                             <div className="flex flex-col gap-3 border-t border-slate-300 bg-white px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
//                                 <p className="text-xs font-semibold text-slate-500">
//                                     Showing {agentPageStart} to {agentPageEnd} of {formatNumber(agents.length)} agents
//                                 </p>
//                                 <div className="flex items-center gap-1">
//                                     <button
//                                         type="button"
//                                         className="flex size-8 items-center justify-center rounded-lg border border-slate-300 bg-white text-slate-500 transition hover:border-[#842cff] hover:text-[#6426d9] disabled:cursor-not-allowed disabled:opacity-40"
//                                         onClick={() => setAgentPage((page) => Math.max(page - 1, 1))}
//                                         disabled={currentAgentPage === 1}
//                                         aria-label="Previous agent page"
//                                     >
//                                         <FiChevronLeft className="size-4" aria-hidden="true" />
//                                     </button>
//                                     {agentPageNumbers.map((page, index) => {
//                                         const previousPage = agentPageNumbers[index - 1];
//                                         const hasGap = previousPage && page - previousPage > 1;

//                                         return (
//                                             <span key={page} className="flex items-center gap-1">
//                                                 {hasGap && <span className="px-1 text-xs font-semibold text-slate-400">...</span>}
//                                                 <button
//                                                     type="button"
//                                                     className={[
//                                                         "flex size-8 items-center justify-center rounded-lg border text-sm font-semibold transition",
//                                                         currentAgentPage === page
//                                                             ? "border-[#842cff] bg-[#842cff] text-white"
//                                                             : "border-slate-300 bg-white text-slate-600 hover:border-[#842cff] hover:text-[#6426d9]",
//                                                     ].join(" ")}
//                                                     onClick={() => setAgentPage(page)}
//                                                     aria-label={`Agent page ${page}`}
//                                                     aria-current={currentAgentPage === page ? "page" : undefined}
//                                                 >
//                                                     {page}
//                                                 </button>
//                                             </span>
//                                         );
//                                     })}
//                                     <button
//                                         type="button"
//                                         className="flex size-8 items-center justify-center rounded-lg border border-slate-300 bg-white text-slate-500 transition hover:border-[#842cff] hover:text-[#6426d9] disabled:cursor-not-allowed disabled:opacity-40"
//                                         onClick={() => setAgentPage((page) => Math.min(page + 1, totalAgentPages))}
//                                         disabled={currentAgentPage === totalAgentPages}
//                                         aria-label="Next agent page"
//                                     >
//                                         <FiChevronRight className="size-4" aria-hidden="true" />
//                                     </button>
//                                 </div>
//                             </div>
//                         )}
//                         <div className="dashboard-panel-accent dashboard-accent-indigo border-t border-slate-300 bg-slate-50/80 px-4 py-4">
//                             <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
//                                 <div>
//                                     <p className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">Monthly Data</p>
//                                     <h3 className="mt-1 text-base font-semibold text-slate-900">Agent activity for {monthlyRangeLabel}</h3>
//                                 </div>
//                                 <div className="flex flex-wrap items-center gap-2">
//                                     <span className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-semibold text-slate-600">
//                                         {formatNumber(monthlyTotals.touchedLeads)} touched · {formatNumber(monthlyTotals.calls)} calls · {formatNumber(monthlyTotals.comments)} comments
//                                     </span>
//                                     <button
//                                         type="button"
//                                         className="inline-flex h-10 items-center gap-2 rounded-lg border border-slate-300 bg-white px-3 text-sm font-semibold text-slate-800 shadow-sm transition hover:border-[#842cff] hover:text-[#6426d9] disabled:cursor-not-allowed disabled:opacity-55"
//                                         onClick={handleExportMonthlyData}
//                                         disabled={monthlyAgents.length === 0}
//                                     >
//                                         <FiDownload className="size-4" aria-hidden="true" />
//                                         Export
//                                     </button>
//                                     <div
//                                         className="relative"
//                                         onBlur={(event) => {
//                                             if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
//                                                 setIsMonthMenuOpen(false);
//                                             }
//                                         }}
//                                     >
//                                         <button
//                                             type="button"
//                                             className="flex h-10 min-w-[12rem] items-center justify-between gap-3 rounded-lg border border-slate-300 bg-white px-3 text-left text-sm font-semibold text-slate-800 shadow-sm transition hover:border-[#842cff] focus:outline-none focus:ring-2 focus:ring-[#842cff]/30"
//                                             onClick={() => setIsMonthMenuOpen((isOpen) => !isOpen)}
//                                             aria-haspopup="menu"
//                                             aria-expanded={isMonthMenuOpen}
//                                         >
//                                             <span className="flex min-w-0 items-center gap-2">
//                                                 <FiCalendar className="size-4 shrink-0 text-[#842cff]" aria-hidden="true" />
//                                                 <span className="truncate">{formatMonthLabel(selectedMonth)}</span>
//                                             </span>
//                                             <FiChevronDown className={["size-4 shrink-0 text-slate-500 transition", isMonthMenuOpen ? "rotate-180" : ""].join(" ")} aria-hidden="true" />
//                                         </button>
//                                         {isMonthMenuOpen && (
//                                             <div className="absolute right-0 z-20 mt-2 max-h-72 w-full overflow-y-auto rounded-lg border border-slate-300 bg-white p-1 text-sm shadow-xl shadow-slate-950/15" role="menu">
//                                                 {monthOptions.map((month) => {
//                                                     const isSelected = month === selectedMonth;

//                                                     return (
//                                                         <button
//                                                             key={month}
//                                                             type="button"
//                                                             className={[
//                                                                 "flex w-full items-center justify-between rounded-md px-3 py-2 text-left font-semibold transition",
//                                                                 isSelected ? "bg-[#842cff] text-white" : "text-slate-700 hover:bg-violet-50 hover:text-[#6426d9]",
//                                                             ].join(" ")}
//                                                             onClick={() => {
//                                                                 setSelectedMonth(month);
//                                                                 setMonthlyPage(1);
//                                                                 setIsMonthMenuOpen(false);
//                                                             }}
//                                                             role="menuitemradio"
//                                                             aria-checked={isSelected}
//                                                         >
//                                                             <span>{formatMonthLabel(month)}</span>
//                                                             {isSelected && <span className="text-xs text-white/80">Selected</span>}
//                                                         </button>
//                                                     );
//                                                 })}
//                                             </div>
//                                         )}
//                                     </div>
//                                 </div>
//                             </div>
//                             <div className="mt-4 overflow-x-auto rounded-lg border border-slate-300 bg-white">
//                                 <table className="w-full min-w-0 table-fixed border-separate border-spacing-0">
//                                     <colgroup>
//                                         <col className="w-[28%]" />
//                                         <col className="w-[9%]" />
//                                         <col className="w-[10%]" />
//                                         <col className="w-[8%]" />
//                                         <col className="w-[10%]" />
//                                         <col className="w-[12%]" />
//                                         <col className="w-[9%]" />
//                                         <col className="w-[8%]" />
//                                         <col className="w-[6%]" />
//                                     </colgroup>
//                                     <thead className="bg-white text-[0.62rem] uppercase tracking-[0.08em] text-slate-500">
//                                         <tr>
//                                             <th className="px-2 py-3 text-left font-semibold">Agent</th>
//                                             <th className="px-2 py-3 text-center font-semibold">Added</th>
//                                             <th className="px-2 py-3 text-center font-semibold">Follow Up</th>
//                                             <th className="px-2 py-3 text-center font-semibold">Calls</th>
//                                             <th className="px-2 py-3 text-center font-semibold">Qualified</th>
//                                             <th className="px-2 py-3 text-center font-semibold">Archive/Dead</th>
//                                             <th className="px-2 py-3 text-center font-semibold">Comments</th>
//                                             <th className="px-2 py-3 text-center font-semibold">Touched</th>
//                                             <th className="px-2 py-3 text-center font-semibold">Score</th>
//                                         </tr>
//                                     </thead>
//                                     <tbody className="divide-y divide-slate-200">
//                                         {isLoading && (
//                                             <tr>
//                                                 <td className="px-4 py-8 text-center text-sm text-slate-500" colSpan={9}>Loading monthly metrics...</td>
//                                             </tr>
//                                         )}
//                                         {!isLoading && monthlyAgents.length === 0 && (
//                                             <tr>
//                                                 <td className="px-4 py-8" colSpan={9}>
//                                                     <EmptyPanel title="No monthly data yet" message="Choose another month or wait for lead activity to appear here." />
//                                                 </td>
//                                             </tr>
//                                         )}
//                                         {visibleMonthlyAgents.map((row) => (
//                                             <MonthlyAgentRow key={row.employeeId} row={row} onQualifiedClick={setQualifiedLeadRow} />
//                                         ))}
//                                         {!isLoading && visibleMonthlyAgents.length > 0 && visibleMonthlyAgents.length < monthlyRowsPerPage && Array.from({ length: monthlyRowsPerPage - visibleMonthlyAgents.length }).map((_, index) => (
//                                             <tr key={`monthly-placeholder-${index}`} aria-hidden="true" className="pointer-events-none">
//                                                 <td className="h-[4.5rem] px-3 py-0" colSpan={9} />
//                                             </tr>
//                                         ))}
//                                     </tbody>
//                                 </table>
//                                 {!isLoading && monthlyAgents.length > 0 && (
//                                     <div className="flex flex-col gap-3 border-t border-slate-300 bg-white px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
//                                         <p className="text-xs font-semibold text-slate-500">
//                                             Showing {monthlyPageStart} to {monthlyPageEnd} of {formatNumber(monthlyAgents.length)} monthly rows
//                                         </p>
//                                         <div className="flex items-center gap-1">
//                                             <button
//                                                 type="button"
//                                                 className="flex size-8 items-center justify-center rounded-lg border border-slate-300 bg-white text-slate-500 transition hover:border-[#842cff] hover:text-[#6426d9] disabled:cursor-not-allowed disabled:opacity-40"
//                                                 onClick={() => setMonthlyPage((page) => Math.max(page - 1, 1))}
//                                                 disabled={currentMonthlyPage === 1}
//                                                 aria-label="Previous monthly data page"
//                                             >
//                                                 <FiChevronLeft className="size-4" aria-hidden="true" />
//                                             </button>
//                                             {monthlyPageNumbers.map((page, index) => {
//                                                 const previousPage = monthlyPageNumbers[index - 1];
//                                                 const hasGap = previousPage && page - previousPage > 1;

//                                                 return (
//                                                     <span key={page} className="flex items-center gap-1">
//                                                         {hasGap && <span className="px-1 text-xs font-semibold text-slate-400">...</span>}
//                                                         <button
//                                                             type="button"
//                                                             className={[
//                                                                 "flex size-8 items-center justify-center rounded-lg border text-sm font-semibold transition",
//                                                                 currentMonthlyPage === page
//                                                                     ? "border-[#842cff] bg-[#842cff] text-white"
//                                                                     : "border-slate-300 bg-white text-slate-600 hover:border-[#842cff] hover:text-[#6426d9]",
//                                                             ].join(" ")}
//                                                             onClick={() => setMonthlyPage(page)}
//                                                             aria-label={`Monthly data page ${page}`}
//                                                             aria-current={currentMonthlyPage === page ? "page" : undefined}
//                                                         >
//                                                             {page}
//                                                         </button>
//                                                     </span>
//                                                 );
//                                             })}
//                                             <button
//                                                 type="button"
//                                                 className="flex size-8 items-center justify-center rounded-lg border border-slate-300 bg-white text-slate-500 transition hover:border-[#842cff] hover:text-[#6426d9] disabled:cursor-not-allowed disabled:opacity-40"
//                                                 onClick={() => setMonthlyPage((page) => Math.min(page + 1, totalMonthlyPages))}
//                                                 disabled={currentMonthlyPage === totalMonthlyPages}
//                                                 aria-label="Next monthly data page"
//                                             >
//                                                 <FiChevronRight className="size-4" aria-hidden="true" />
//                                             </button>
//                                         </div>
//                                     </div>
//                                 )}
//                             </div>
//                         </div>
//                         {/* Call logger */}
//                         <div className="flex flex-wrap items-center justify-between gap-3 border-t-6 border-slate-300 bg-slate-50 px-4 py-4">
//                             <div>
//                                 <p className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">
//                                     Log Call Counts
//                                 </p>

//                                 <h3 className="mt-1 text-base font-semibold text-slate-900">
//                                     {leadCallStatsQuery.isLoading || leadCallStatsQuery.isFetching
//                                         ? "Loading call data"
//                                         : `${formatNumber(totalLoggedLeadCalls)} connected calls`}
//                                 </h3>

//                                 <p className="mt-1 text-xs font-semibold text-rose-600">
//                                     {formatNumber(totalNotConnectedCalls)} not connected
//                                 </p>
//                             </div>

//                             <div className="flex flex-wrap items-center gap-3">
//                                 <label className="flex flex-col gap-1">
//                                     <span className="text-[0.65rem] font-semibold uppercase tracking-[0.12em] text-slate-500">
//                                         From
//                                     </span>
//                                     <input
//                                         type="date"
//                                         className="h-9 rounded-lg border border-slate-300 bg-white px-3 text-sm font-semibold text-slate-800 outline-none transition focus:border-[#842cff] focus:ring-2 focus:ring-[#842cff]/20"
//                                         value={callFilterDateFrom}
//                                         onChange={(event) => setCallFilterDateFrom(event.target.value)}
//                                     />
//                                 </label>
//                                 <label className="flex flex-col gap-1">
//                                     <span className="text-[0.65rem] font-semibold uppercase tracking-[0.12em] text-slate-500">
//                                         To
//                                     </span>
//                                     <input
//                                         type="date"
//                                         className="h-9 rounded-lg border border-slate-300 bg-white px-3 text-sm font-semibold text-slate-800 outline-none transition focus:border-[#842cff] focus:ring-2 focus:ring-[#842cff]/20"
//                                         value={callFilterDateTo}
//                                         onChange={(event) => setCallFilterDateTo(event.target.value)}
//                                     />
//                                 </label>
//                                 <button
//                                     type="button"
//                                     className="mt-5 h-9 rounded-lg border border-slate-300 bg-white px-3 text-sm font-semibold text-slate-700 transition hover:border-[#842cff]/40 hover:text-[#6426d9]"
//                                     onClick={() => {
//                                         const today = formatDateInputValue(new Date());
//                                         setCallFilterDateFrom(today);
//                                         setCallFilterDateTo(today);
//                                     }}
//                                 >
//                                     Today
//                                 </button>
//                                 <button
//                                     type="button"
//                                     className="mt-5 h-9 rounded-lg border border-slate-300 bg-white px-3 text-sm font-semibold text-slate-700 transition hover:border-[#842cff]/40 hover:text-[#6426d9]"
//                                     onClick={() => {
//                                         const today = new Date();
//                                         const firstDay = new Date(today.getFullYear(), today.getMonth(), 1);

//                                         setCallFilterDateFrom(formatDateInputValue(firstDay));
//                                         setCallFilterDateTo(formatDateInputValue(today));
//                                     }}
//                                 >
//                                     This Month
//                                 </button>
//                                 <span className="mt-5 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm font-semibold text-emerald-700">
//                                     {formatNumber(filteredLeadCallStats.length)} lead
//                                     {filteredLeadCallStats.length === 1 ? "" : "s"}
//                                 </span>

//                                 <Link
//                                     className="mt-5 inline-flex h-9 items-center gap-2 rounded-lg bg-[#842cff] px-3 text-sm font-semibold text-white transition hover:brightness-110"
//                                     to="/admin/leads"
//                                 >
//                                     <FiTarget className="size-4" aria-hidden="true" />
//                                     Manage Leads
//                                 </Link>
//                             </div>
//                         </div>
//                         <div className="flex w-full flex-col p-4 pt-0">
//                             {leadCallStatsQuery.isLoading || leadCallStatsQuery.isFetching ? (
//                                 <div className="mt-4">
//                                     <EmptyPanel
//                                         title="Loading call counts"
//                                         message="Getting logged calls from the call stats table."
//                                     />
//                                 </div>
//                             ) : employeeCallRows.length === 0 ? (
//                                 <div className="mt-4">
//                                     <EmptyPanel
//                                         title="No logged calls yet"
//                                         message="Once an employee clicks Log Call, the lead call data will appear here."
//                                     />
//                                 </div>
//                             ) : (
//                                 <div className="mt-4 overflow-x-auto rounded-lg border border-slate-300 bg-white">
//                                     <table className="w-full min-w-[46rem] table-fixed border-separate border-spacing-0">
//                                         <colgroup>
//                                             <col className="w-[26%]" />
//                                             <col className="w-[13%]" />
//                                             <col className="w-[17%]" />
//                                             <col className="w-[13%]" />
//                                             <col className="w-[17%]" />
//                                         </colgroup>

//                                         <thead className="bg-white text-[0.68rem] uppercase tracking-[0.12em] text-slate-500">
//                                             <tr>
//                                                 <th className="px-3 py-3 text-left font-semibold">Employee</th>
//                                                 <th className="px-3 py-3 text-center font-semibold">Calls</th>
//                                                 <th className="px-3 py-3 text-center font-semibold">Not Connected</th>
//                                                 <th className="px-3 py-3 text-center font-semibold">Leads</th>
//                                                 <th className="px-3 py-3 text-left font-semibold">Last Call</th>
//                                             </tr>
//                                         </thead>
//                                         <tbody className="divide-y divide-slate-200">
//                                             {employeeCallRows.map((row) => (
//                                                 <tr
//                                                     key={row.employeeId}
//                                                     className="text-sm text-slate-700 transition hover:bg-emerald-50/60"
//                                                 >
//                                                     <td className="px-3 py-3">
//                                                         <p className="truncate font-semibold text-slate-800">
//                                                             {row.employeeName || "No employee"}
//                                                         </p>

//                                                         {(row.employeeRole || row.employeeTeam) && (
//                                                             <p className="mt-0.5 truncate text-xs text-slate-500">
//                                                                 {[row.employeeRole, row.employeeTeam]
//                                                                     .filter(Boolean)
//                                                                     .join(" · ")}
//                                                             </p>
//                                                         )}
//                                                     </td>
//                                                     <td className="px-3 py-3 text-center font-semibold text-slate-950">
//                                                         <button
//                                                             type="button"
//                                                             className="inline-flex h-8 items-center justify-center rounded-md border border-emerald-200 bg-emerald-50 px-3 text-xs font-semibold text-emerald-700 transition hover:border-emerald-400 hover:bg-emerald-100 focus:outline-none focus:ring-2 focus:ring-emerald-300"
//                                                             onClick={() => setSelectedCallEmployeeRow(row)}
//                                                         >
//                                                             {formatNumber(row.totalCalls)}
//                                                         </button>
//                                                     </td>
//                                                     <td className="px-3 py-3 text-center font-semibold text-rose-600">
//                                                         <button
//                                                             type="button"
//                                                             className="inline-flex h-8 items-center justify-center rounded-md border border-emerald-200 bg-emerald-50 px-3 text-xs font-semibold text-emerald-700 transition hover:border-emerald-400 hover:bg-emerald-100 focus:outline-none focus:ring-2 focus:ring-emerald-300"
//                                                             onClick={() => setSelectedCallEmployeeRow(row)}
//                                                         >
//                                                             {formatNumber(row.totalNotConnectedCalls)}
//                                                         </button>
//                                                     </td>
//                                                     <td className="px-3 py-3 text-center font-semibold text-slate-950">
//                                                         {formatNumber(row.leads.length)}
//                                                     </td>
//                                                     <td className="px-3 py-3 text-sm text-slate-600">
//                                                         {row.lastCallAt ? formatPhDateTime(row.lastCallAt) : "No date"}
//                                                     </td>
//                                                 </tr>
//                                             ))}
//                                         </tbody>
//                                     </table>
//                                 </div>
//                             )}
//                         </div>
//                         {/* Call logger */}

//                     </section>

//                     <div className="space-y-4">
//                         <section className="dashboard-panel-accent dashboard-accent-blue rounded-lg border border-slate-300 bg-white p-3 text-slate-950 shadow-lg shadow-slate-950/10">
//                             <div className="flex items-center justify-between gap-3">
//                                 <div>
//                                     <p className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">Lead Status</p>
//                                     <h3 className="mt-1 text-base font-semibold">Current total: {formatNumber(pipelineTotals.total)}</h3>
//                                 </div>
//                                 <FiBarChart2 className="size-5 text-[#842cff]" aria-hidden="true" />
//                             </div>
//                             <div className="mt-4 space-y-3">
//                                 {pipelineBars.map((item) => (
//                                     <div key={item.label}>
//                                         <div className="flex justify-between gap-3 text-sm">
//                                             <span className="font-semibold text-slate-700">{item.label}</span>
//                                             <span className="text-slate-500">{formatNumber(item.value)}</span>
//                                         </div>
//                                         <div className="mt-2 h-2 rounded-full bg-slate-200">
//                                             <div className={`h-full rounded-full ${item.color}`} style={{ width: `${Math.max((item.value / maxPipelineValue) * 100, item.value > 0 ? 5 : 0)}%` }} />
//                                         </div>
//                                     </div>
//                                 ))}
//                             </div>
//                         </section>

//                         <section className="dashboard-panel-accent dashboard-accent-teal rounded-lg border border-slate-300 bg-white p-3 text-slate-950 shadow-lg shadow-slate-950/10">
//                             <div className="flex items-center justify-between gap-3">
//                                 <div>
//                                     <p className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">Online Status</p>
//                                     <h3 className="mt-1 text-base font-semibold">{formatNumber(availableAgentCount)} available now</h3>
//                                 </div>
//                                 <FiActivity className="size-5 text-emerald-500" aria-hidden="true" />
//                             </div>
//                             <div className="content-scroll mt-4 max-h-[19rem] space-y-3 overflow-y-auto pr-1">
//                                 {onlineStatusAgents.length === 0 && <EmptyPanel title="No employees yet" message="Employee availability will show here once employees are added." />}
//                                 {onlineStatusAgents.map((agent) => (
//                                     <div key={agent.employeeId} className="rounded-lg border border-slate-300 bg-slate-50 p-3">
//                                         <div className="flex items-start justify-between gap-3">
//                                             <div className="flex min-w-0 items-start gap-2">
//                                                 <span className={`mt-1.5 size-2.5 shrink-0 rounded-full ${availabilityDotClass(agent.availabilityStatus)}`} />
//                                                 <div className="min-w-0">
//                                                     <p className="truncate text-sm font-semibold text-slate-950">{agent.employeeName}</p>
//                                                     <p className="mt-1 truncate text-xs text-slate-500">{agent.role} · {agent.team}</p>
//                                                     <p className="mt-1 text-xs text-slate-500">{formatNumber(agent.assignedLeads)} active leads</p>
//                                                 </div>
//                                             </div>
//                                             <span className={`shrink-0 rounded-md border px-2 py-1 text-xs font-semibold ${availabilityClass(agent.availabilityStatus)}`}>
//                                                 {normalizeEmployeeAvailabilityStatus(agent.availabilityStatus)}
//                                             </span>
//                                         </div>
//                                     </div>
//                                 ))}
//                             </div>
//                         </section>

//                         <section className="dashboard-panel-accent dashboard-accent-teal rounded-lg border border-slate-300 bg-white p-3 text-slate-950 shadow-lg shadow-slate-950/10">
//                             <div className="flex items-start justify-between gap-3">
//                                 <div className="min-w-0">
//                                     <p className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">Agent Calls</p>
//                                     <h3 className="mt-2 text-2xl font-semibold">{formatNumber(selectedCallCount)}</h3>
//                                     <p className="mt-1 text-sm leading-5 text-slate-600">{selectedCallHelper}</p>
//                                 </div>
//                                 <span className="dashboard-accent-icon flex size-10 shrink-0 items-center justify-center rounded-lg border border-emerald-200 bg-emerald-50 text-[#10ac84]">
//                                     <FiPhoneCall className="size-5" aria-hidden="true" />
//                                 </span>
//                             </div>
//                             <div className="mt-4 space-y-2">
//                                 <label className="block text-[0.65rem] font-semibold uppercase tracking-[0.14em] text-slate-500" htmlFor="agent-call-employee">
//                                     Employee
//                                 </label>
//                                 <div className="relative">
//                                     <select
//                                         id="agent-call-employee"
//                                         className="h-10 w-full appearance-none rounded-lg border border-slate-300 bg-white px-3 pr-9 text-sm font-semibold text-slate-800 shadow-sm outline-none transition focus:border-[#10ac84] focus:ring-2 focus:ring-emerald-100"
//                                         value={selectedCallEmployeeId}
//                                         onChange={(event) => setSelectedCallEmployeeId(event.target.value)}
//                                     >
//                                         <option value="all">All employees</option>
//                                         {callEmployeeOptions.map((employee) => (
//                                             <option key={employee.id} value={employee.id}>
//                                                 {employee.name}
//                                             </option>
//                                         ))}
//                                     </select>
//                                     <FiChevronDown className="pointer-events-none absolute right-3 top-1/2 size-4 -translate-y-1/2 text-slate-500" aria-hidden="true" />
//                                 </div>

//                                 <label className="block pt-1 text-[0.65rem] font-semibold uppercase tracking-[0.14em] text-slate-500" htmlFor="agent-call-range">
//                                     Period
//                                 </label>
//                                 <div className="relative">
//                                     <select
//                                         id="agent-call-range"
//                                         className="h-10 w-full appearance-none rounded-lg border border-slate-300 bg-white px-3 pr-9 text-sm font-semibold text-slate-800 shadow-sm outline-none transition focus:border-[#10ac84] focus:ring-2 focus:ring-emerald-100"
//                                         value={callCountRange}
//                                         onChange={(event) => setCallCountRange(event.target.value as CallCountRange)}
//                                     >
//                                         <option value="day">Day</option>
//                                         <option value="month">Month</option>
//                                     </select>
//                                     <FiChevronDown className="pointer-events-none absolute right-3 top-1/2 size-4 -translate-y-1/2 text-slate-500" aria-hidden="true" />
//                                 </div>

//                                 {callCountRange === "day" ? (
//                                     <>
//                                         <label className="block pt-1 text-[0.65rem] font-semibold uppercase tracking-[0.14em] text-slate-500" htmlFor="agent-call-date">
//                                             Date
//                                         </label>
//                                         <input
//                                             id="agent-call-date"
//                                             className="h-10 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm font-semibold text-slate-800 shadow-sm outline-none transition focus:border-[#10ac84] focus:ring-2 focus:ring-emerald-100"
//                                             type="date"
//                                             value={selectedCallDate}
//                                             onChange={(event) => setSelectedCallDate(event.target.value)}
//                                         />
//                                     </>
//                                 ) : (
//                                     <>
//                                         <label className="block pt-1 text-[0.65rem] font-semibold uppercase tracking-[0.14em] text-slate-500" htmlFor="agent-call-month">
//                                             Month
//                                         </label>
//                                         <input
//                                             id="agent-call-month"
//                                             className="h-10 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm font-semibold text-slate-800 shadow-sm outline-none transition focus:border-[#10ac84] focus:ring-2 focus:ring-emerald-100"
//                                             type="month"
//                                             value={selectedMonth}
//                                             onChange={(event) => {
//                                                 setSelectedMonth(event.target.value);
//                                                 setMonthlyPage(1);
//                                                 setIsMonthMenuOpen(false);
//                                             }}
//                                         />
//                                     </>
//                                 )}
//                             </div>
//                         </section>
//                     </div>
//                 </div>

//                 <div className="grid gap-5 xl:grid-cols-[minmax(0,0.75fr)_minmax(0,1.25fr)]">
//                     <section className="dashboard-panel-accent dashboard-accent-purple rounded-lg border border-slate-300 bg-white p-4 text-slate-950 shadow-lg shadow-slate-950/10">
//                         <div className="flex items-center justify-between gap-3">
//                             <div>
//                                 <p className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">Top Agents</p>
//                                 <h3 className="mt-1 text-base font-semibold">Today by productivity score</h3>
//                             </div>
//                             <FiUserCheck className="size-5 text-[#842cff]" aria-hidden="true" />
//                         </div>
//                         <div className="mt-4 space-y-3">
//                             {topAgents.length === 0 && <EmptyPanel title="No activity today" message="Lead touches and comments will rank agents here." />}
//                             {topAgents.map((agent, index) => {
//                                 const maxScore = Math.max(topAgents[0]?.productivityScore || 1, 1);
//                                 return (
//                                     <div key={agent.employeeId} className="grid grid-cols-[2rem_minmax(0,1fr)_3rem] items-center gap-3">
//                                         <span className="text-xs font-semibold text-slate-400">#{index + 1}</span>
//                                         <div className="min-w-0">
//                                             <div className="flex justify-between gap-3">
//                                                 <p className="truncate text-sm font-semibold text-slate-950">{agent.employeeName}</p>
//                                                 <p className="text-sm font-semibold text-slate-600">{formatNumber(agent.productivityScore)}</p>
//                                             </div>
//                                             <div className="mt-2 h-2 rounded-full bg-slate-200">
//                                                 <div className="h-full rounded-full bg-[#842cff]" style={{ width: `${Math.max((agent.productivityScore / maxScore) * 100, 5)}%` }} />
//                                             </div>
//                                         </div>
//                                         <span className="text-right text-xs text-slate-400">pts</span>
//                                     </div>
//                                 );
//                             })}
//                         </div>
//                     </section>

//                     <section className="dashboard-panel-accent dashboard-accent-indigo rounded-lg border border-slate-300 bg-white p-4 text-slate-950 shadow-lg shadow-slate-950/10">
//                         <div className="flex items-center justify-between gap-3">
//                             <div>
//                                 <p className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">Recent Lead Activity</p>
//                                 <h3 className="mt-1 text-base font-semibold">Latest employee actions</h3>
//                             </div>
//                             <div className="flex items-center gap-2 text-slate-500">
//                                 <FiMessageSquare className="size-5" aria-hidden="true" />
//                                 <FiActivity className="size-5" aria-hidden="true" />
//                                 <FiCheckCircle className="size-5" aria-hidden="true" />
//                             </div>
//                         </div>
//                         <div className="mt-4 grid gap-3 lg:grid-cols-2">
//                             {(data?.recentActivity || []).length === 0 && <EmptyPanel title="No recent lead actions" message="Employee comments, status updates, and scheduled follow-ups will appear here." />}
//                             {(data?.recentActivity || []).map((item) => <ActivityItem key={item.id} item={item} onOpen={setSelectedActivity} />)}
//                         </div>
//                     </section>
//                 </div>
//             </section>

//             {selectedActivity && (
//                 <LeadHistoryModal
//                     activity={selectedActivity}
//                     lead={leadHistoryQuery.data}
//                     history={leadHistory}
//                     isLoading={leadHistoryQuery.isLoading || leadHistoryQuery.isFetching}
//                     isError={leadHistoryQuery.isError}
//                     onClose={() => setSelectedActivity(null)}
//                 />
//             )}
//             {qualifiedLeadRow && (
//                 <QualifiedLeadsModal row={qualifiedLeadRow} onClose={() => setQualifiedLeadRow(null)} />
//             )}

//             {selectedCallEmployeeRow && (
//                 <EmployeeLeadCallsModal
//                     row={selectedCallEmployeeRow}
//                     onClose={() => setSelectedCallEmployeeRow(null)}
//                 />
//             )}
//         </AdminLayout>
//     );
// }


// import { useMemo, useState } from "react";
// import { createPortal } from "react-dom";
// import { Link, useNavigate } from "react-router";
// import { useQuery } from "@tanstack/react-query";
// import {
//     FiActivity,
//     FiBarChart2,
//     FiCalendar,
//     FiCheckCircle,
//     FiChevronDown,
//     FiChevronLeft,
//     FiChevronRight,
//     FiClock,
//     FiDownload,
//     FiMessageSquare,
//     FiPhoneCall,
//     FiRefreshCw,
//     FiSearch,
//     FiTarget,
//     FiTrendingUp,
//     FiUserCheck,
//     FiUsers,
//     FiX,
// } from "react-icons/fi";
// import AdminLayout from "../adminLayout";
// import { getEmployeeSummaries, normalizeEmployeeAvailabilityStatus, type Employee } from "../../../api/employees";
// import { getEmployeeAttendance, type AttendanceRecord } from "../../../api/attendance";
// import { getAgentLeadDashboard, getLead, getLeadCallStats, type AgentLeadActivity, type AgentLeadMonthlyRow, type AgentLeadProgress, type Lead, type LeadCallStat } from "../../../api/leads";
// import { formatPhDate, formatPhDateTime, formatPhTime } from "../../../lib/dateTime";

// const numberFormatter = new Intl.NumberFormat("en-US");
// const monthLabelFormatter = new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric" });
// const dateRangeLabelFormatter = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" });
// const agentRowsPerPage = 5;
// const monthlyRowsPerPage = 5;
// type CallCountRange = "day" | "month";

// function formatNumber(value?: number) {
//     return numberFormatter.format(value || 0);
// }

// function getMonthInputValue(date: Date) {
//     const year = date.getFullYear();
//     const month = String(date.getMonth() + 1).padStart(2, "0");

//     return `${year}-${month}`;
// }

// function formatMonthLabel(monthKey?: string) {
//     const [yearValue, monthValue] = String(monthKey || "").split("-").map(Number);

//     if (!yearValue || !monthValue) {
//         return "Selected month";
//     }

//     return monthLabelFormatter.format(new Date(yearValue, monthValue - 1, 1));
// }

// function formatDateInputValue(date: Date) {
//     const year = date.getFullYear();
//     const month = String(date.getMonth() + 1).padStart(2, "0");
//     const day = String(date.getDate()).padStart(2, "0");

//     return `${year}-${month}-${day}`;
// }

// function parseDateInputValue(value?: string) {
//     const [yearValue, monthValue, dayValue] = String(value || "").split("-").map(Number);

//     if (!yearValue || !monthValue || !dayValue) {
//         return null;
//     }

//     return new Date(yearValue, monthValue - 1, dayValue);
// }

// function getMonthlyDashboardDateRange(monthKey?: string) {
//     const [yearValue, monthValue] = String(monthKey || "").split("-").map(Number);

//     if (!yearValue || !monthValue) {
//         const today = new Date();
//         return {
//             dateFrom: formatDateInputValue(new Date(today.getFullYear(), today.getMonth(), 3)),
//             dateTo: formatDateInputValue(new Date(today.getFullYear(), today.getMonth() + 1, 2)),
//         };
//     }

//     return {
//         dateFrom: formatDateInputValue(new Date(yearValue, monthValue - 1, 3)),
//         dateTo: formatDateInputValue(new Date(yearValue, monthValue, 2)),
//     };
// }

// function formatDateRangeLabel(dateFrom: string, dateTo: string) {
//     const start = parseDateInputValue(dateFrom);
//     const end = parseDateInputValue(dateTo);

//     if (!start || !end) {
//         return "Selected range";
//     }

//     return `${dateRangeLabelFormatter.format(start)} - ${dateRangeLabelFormatter.format(end)}`;
// }

// function formatSingleDateLabel(value: string) {
//     const date = parseDateInputValue(value);

//     return date ? dateRangeLabelFormatter.format(date) : "Selected date";
// }

// function csvCell(value: string | number | null | undefined) {
//     return `"${String(value ?? "").replaceAll('"', '""')}"`;
// }

// function downloadCsv(filename: string, rows: Array<Array<string | number | null | undefined>>) {
//     const csv = rows.map((row) => row.map(csvCell).join(",")).join("\n");
//     const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
//     const url = URL.createObjectURL(blob);
//     const link = document.createElement("a");
//     link.href = url;
//     link.download = filename;
//     link.click();
//     URL.revokeObjectURL(url);
// }

// function getPaginationNumbers(currentPage: number, totalPages: number) {
//     const pages = new Set([1, totalPages, currentPage - 1, currentPage, currentPage + 1]);

//     return Array.from(pages)
//         .filter((page) => page >= 1 && page <= totalPages)
//         .sort((first, second) => first - second);
// }

// function activityLabelClass(action: string) {
//     const normalizedAction = action.toLowerCase();
//     if (normalizedAction.includes("comment")) return "bg-sky-50 text-sky-700 border-sky-200";
//     if (normalizedAction.includes("status") || normalizedAction.includes("qualified")) return "bg-emerald-50 text-emerald-700 border-emerald-200";
//     if (normalizedAction.includes("schedule") || normalizedAction.includes("reschedule")) return "bg-violet-50 text-violet-700 border-violet-200";
//     return "bg-slate-50 text-slate-600 border-slate-300";
// }

// function availabilityClass(value?: string) {
//     const status = normalizeEmployeeAvailabilityStatus(value);

//     if (status === "ONLINE") return "border-emerald-200 bg-emerald-50 text-emerald-700";
//     if (status === "BREAK" || status === "LUNCH") return "border-amber-200 bg-amber-50 text-amber-700";
//     if (status === "OFF THE PHONE") return "border-sky-200 bg-sky-50 text-sky-700";

//     return "border-slate-200 bg-slate-100 text-slate-600";
// }

// function availabilityDotClass(value?: string) {
//     const status = normalizeEmployeeAvailabilityStatus(value);

//     if (status === "ONLINE") return "bg-emerald-500";
//     if (status === "BREAK" || status === "LUNCH") return "bg-amber-500";
//     if (status === "OFF THE PHONE") return "bg-sky-500";

//     return "bg-slate-400";
// }

// function availabilitySortRank(value?: string) {
//     const status = normalizeEmployeeAvailabilityStatus(value);

//     if (status === "ONLINE") return 0;
//     if (status === "BREAK") return 1;
//     if (status === "LUNCH") return 2;
//     if (status === "OFF THE PHONE") return 3;

//     return 4;
// }

// function personNameTokens(value?: string | null) {
//     return String(value || "")
//         .trim()
//         .toLowerCase()
//         .replace(/[^a-z0-9\s]/g, " ")
//         .replace(/\s+/g, " ")
//         .split(" ")
//         .filter((token) => token.length > 1);
// }

// function isLikelySamePersonName(first?: string | null, second?: string | null) {
//     const firstTokens = personNameTokens(first);
//     const secondTokens = personNameTokens(second);

//     if (firstTokens.length < 2 || secondTokens.length < 2) return false;

//     const firstFirstName = firstTokens[0];
//     const secondFirstName = secondTokens[0];
//     const firstLastName = firstTokens.at(-1);
//     const secondLastName = secondTokens.at(-1);

//     if (!firstLastName || firstLastName !== secondLastName) return false;

//     return (
//         (firstFirstName.length >= 4 && secondFirstName.startsWith(firstFirstName)) ||
//         (secondFirstName.length >= 4 && firstFirstName.startsWith(secondFirstName))
//     );
// }

// function isGenericAgentDisplay(row: { role?: string; team?: string }) {
//     return String(row.role || "").trim().toLowerCase() === "agent" && String(row.team || "").trim().toLowerCase() === "unassigned";
// }

// function latestDateValue(first?: string | null, second?: string | null) {
//     const firstTime = first ? new Date(first).getTime() : 0;
//     const secondTime = second ? new Date(second).getTime() : 0;

//     if (Number.isNaN(firstTime) && Number.isNaN(secondTime)) return null;
//     if (Number.isNaN(firstTime)) return second || null;
//     if (Number.isNaN(secondTime)) return first || null;

//     return firstTime >= secondTime ? first || null : second || null;
// }

// function findMergeTarget<T extends { employeeId: string; employeeName: string; role?: string; team?: string }>(rows: T[], row: T) {
//     return rows.find((currentRow) => {
//         if (currentRow.employeeId === row.employeeId) return true;
//         if (!isLikelySamePersonName(currentRow.employeeName, row.employeeName)) return false;

//         return isGenericAgentDisplay(currentRow) !== isGenericAgentDisplay(row);
//     });
// }

// function preferEmployeeDisplay<T extends { employeeName: string; employeeId: string; role?: string; team?: string }>(first: T, second: T) {
//     if (isGenericAgentDisplay(first) && !isGenericAgentDisplay(second)) return second;
//     if (!isGenericAgentDisplay(first) && isGenericAgentDisplay(second)) return first;

//     return first;
// }

// type LeadHistoryItem = {
//     id: string;
//     label: string;
//     detail: string;
//     actorName: string;
//     actorType: string;
//     status?: string;
//     createdAt: string;
//     kind: "activity" | "comment";
// };

// type OnlineStatusEmployeeRow = Pick<
//     AgentLeadProgress,
//     "employeeId" | "employeeName" | "role" | "team" | "availabilityStatus" | "assignedLeads"
// >;

// function isArchivedEmployee(employee: Employee) {
//     return String(employee.status || "").trim().toLowerCase() === "archived";
// }

// function buildOnlineStatusRows(employees: Employee[], agents: AgentLeadProgress[]): OnlineStatusEmployeeRow[] {
//     const agentById = new Map(agents.map((agent) => [agent.employeeId, agent]));
//     const agentByName = new Map(agents.map((agent) => [agent.employeeName.trim().toLowerCase(), agent]));

//     return employees
//         .filter((employee) => !isArchivedEmployee(employee))
//         .map((employee) => {
//             const matchedAgent = agentById.get(employee._id) || agentByName.get((employee.name || "").trim().toLowerCase());

//             return {
//                 employeeId: employee._id,
//                 employeeName: employee.name || employee.employeeCode || "Employee",
//                 role: employee.role || "Employee",
//                 team: employee.team || "Unassigned",
//                 availabilityStatus: employee.availabilityStatus || matchedAgent?.availabilityStatus || "OFFLINE",
//                 assignedLeads: matchedAgent?.assignedLeads || 0,
//             };
//         })
//         .sort((first, second) => {
//             const rankDifference = availabilitySortRank(first.availabilityStatus) - availabilitySortRank(second.availabilityStatus);

//             if (rankDifference !== 0) return rankDifference;

//             return first.employeeName.localeCompare(second.employeeName);
//         });
// }

// function mergeAgentProgressRows(rows: AgentLeadProgress[]) {
//     return rows.reduce<AgentLeadProgress[]>((mergedRows, row) => {
//         const target = findMergeTarget(mergedRows, row);

//         if (!target) {
//             mergedRows.push({ ...row });
//             return mergedRows;
//         }

//         const displayRow = preferEmployeeDisplay(target, row);
//         const mergedRow: AgentLeadProgress = {
//             ...displayRow,
//             assignedLeads: target.assignedLeads + row.assignedLeads,
//             newLeads: target.newLeads + row.newLeads,
//             followUps: target.followUps + row.followUps,
//             ongoing: target.ongoing + row.ongoing,
//             qualified: target.qualified + row.qualified,
//             negotiation: target.negotiation + row.negotiation,
//             dead: target.dead + row.dead,
//             dueFollowUps: target.dueFollowUps + row.dueFollowUps,
//             scheduledToday: target.scheduledToday + row.scheduledToday,
//             commentsToday: target.commentsToday + row.commentsToday,
//             callsToday: (target.callsToday || 0) + (row.callsToday || 0),
//             activityToday: target.activityToday + row.activityToday,
//             touchedLeadsToday: target.touchedLeadsToday + row.touchedLeadsToday,
//             productivityScore: target.productivityScore + row.productivityScore,
//             lastActivityAt: latestDateValue(target.lastActivityAt, row.lastActivityAt),
//             progressPercent: 0,
//         };

//         mergedRow.progressPercent =
//             mergedRow.assignedLeads > 0 ? Math.round(((mergedRow.followUps + mergedRow.qualified) / mergedRow.assignedLeads) * 100) : 0;

//         mergedRows[mergedRows.indexOf(target)] = mergedRow;
//         return mergedRows;
//     }, []);
// }

// function mergeAgentMonthlyRows(rows: AgentLeadMonthlyRow[]) {
//     return rows.reduce<AgentLeadMonthlyRow[]>((mergedRows, row) => {
//         const target = findMergeTarget(mergedRows, row);

//         if (!target) {
//             mergedRows.push({ ...row, qualifiedLeads: [...(row.qualifiedLeads || [])] });
//             return mergedRows;
//         }

//         const displayRow = preferEmployeeDisplay(target, row);
//         const qualifiedLeadsById = new Map<string, AgentLeadMonthlyRow["qualifiedLeads"][number]>();

//         [...(target.qualifiedLeads || []), ...(row.qualifiedLeads || [])].forEach((lead) => {
//             qualifiedLeadsById.set(lead.leadId, lead);
//         });

//         mergedRows[mergedRows.indexOf(target)] = {
//             ...displayRow,
//             leadsAdded: target.leadsAdded + row.leadsAdded,
//             followUps: target.followUps + row.followUps,
//             qualified: target.qualified + row.qualified,
//             archiveDead: target.archiveDead + row.archiveDead,
//             comments: target.comments + row.comments,
//             calls: (target.calls || 0) + (row.calls || 0),
//             actions: target.actions + row.actions,
//             touchedLeads: target.touchedLeads + row.touchedLeads,
//             productivityScore: target.productivityScore + row.productivityScore,
//             qualifiedLeads: Array.from(qualifiedLeadsById.values()),
//             lastActivityAt: latestDateValue(target.lastActivityAt, row.lastActivityAt),
//         };

//         return mergedRows;
//     }, []);
// }

// function getLeadDisplayName(lead?: Lead | null, fallback?: AgentLeadActivity | null) {
//     return lead?.leadName || lead?.businessName || fallback?.leadName || fallback?.businessName || "Lead";
// }

// function getLeadHistory(lead?: Lead | null): LeadHistoryItem[] {
//     if (!lead) return [];

//     const activity = (lead.activity || []).map((item, index) => ({
//         id: item._id || `activity-${index}-${item.createdAt}`,
//         label: item.label || "Lead activity",
//         detail: item.detail || "No details provided.",
//         actorName: item.actorName || "System",
//         actorType: item.actorType || "system",
//         status: item.status,
//         createdAt: item.createdAt,
//         kind: "activity" as const,
//     }));
//     const comments = (lead.comments || []).map((item, index) => ({
//         id: item._id || `comment-${index}-${item.createdAt}`,
//         label: "Comment",
//         detail: item.body || "No comment text.",
//         actorName: item.authorName || "Unknown",
//         actorType: item.authorType || "employee",
//         status: undefined,
//         createdAt: item.createdAt,
//         kind: "comment" as const,
//     }));

//     return [...activity, ...comments].sort((left, right) => {
//         const rightTime = new Date(right.createdAt || 0).getTime() || 0;
//         const leftTime = new Date(left.createdAt || 0).getTime() || 0;
//         return rightTime - leftTime;
//     });
// }

// function KpiCard({
//     label,
//     value,
//     helper,
//     icon: Icon,
//     accent,
// }: {
//     label: string;
//     value: string;
//     helper: string;
//     icon: typeof FiUsers;
//     accent: "green" | "blue" | "orange" | "purple";
// }) {
//     return (
//         <article className={`dashboard-kpi-card dashboard-accent-${accent} rounded-lg border border-slate-300 bg-white p-4 text-slate-950 shadow-lg shadow-slate-950/10`}>
//             <div className="flex items-start justify-between gap-3">
//                 <div className="min-w-0">
//                     <p className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">{label}</p>
//                     <p className="mt-3 truncate text-2xl font-semibold">{value}</p>
//                 </div>
//                 <span className="dashboard-accent-icon flex size-10 shrink-0 items-center justify-center rounded-lg border border-violet-200 bg-violet-50 text-[#842cff]">
//                     <Icon className="size-5" aria-hidden="true" />
//                 </span>
//             </div>
//             <p className="mt-2 text-sm leading-5 text-slate-600">{helper}</p>
//         </article>
//     );
// }

// function EmptyPanel({ title, message }: { title: string; message: string }) {
//     return (
//         <div className="rounded-lg border border-dashed border-slate-300 bg-slate-50 p-6 text-center">
//             <p className="text-sm font-semibold text-slate-800">{title}</p>
//             <p className="mt-1 text-sm text-slate-500">{message}</p>
//         </div>
//     );
// }

// function AgentProgressRow({ agent }: { agent: AgentLeadProgress }) {
//     const currentTotal = agent.newLeads + agent.followUps + agent.qualified + agent.dead;

//     return (
//         <tr className="text-sm text-slate-700 transition hover:bg-slate-50">
//             <td className="min-w-[13rem] px-3 py-3">
//                 <div className="flex items-center gap-3">
//                     <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-[#842cff] text-sm font-semibold text-white">
//                         {agent.employeeName.slice(0, 1).toUpperCase()}
//                     </span>
//                     <div className="min-w-0">
//                         <p className="truncate font-semibold text-slate-950">{agent.employeeName}</p>
//                         <p className="mt-0.5 truncate text-xs text-slate-500">{agent.role} · {agent.team}</p>
//                     </div>
//                 </div>
//             </td>
//             <td className="px-3 py-3 text-center font-semibold text-slate-950">{formatNumber(currentTotal)}</td>
//             <td className="px-3 py-3 text-center">{formatNumber(agent.newLeads)}</td>
//             <td className="px-3 py-3 text-center">{formatNumber(agent.followUps)}</td>
//             <td className="px-3 py-3 text-center">{formatNumber(agent.callsToday)}</td>
//             <td className="px-3 py-3 text-center">{formatNumber(agent.qualified)}</td>
//             <td className="px-3 py-3 text-center">{formatNumber(agent.dead)}</td>
//         </tr>
//     );
// }

// type MonthlyQualifiedLead = AgentLeadMonthlyRow["qualifiedLeads"][number];

// function getQualifiedLeadSearchLabel(lead: MonthlyQualifiedLead) {
//     return lead.leadName || lead.businessName || lead.assignedAgentName || "";
// }

// function getQualifiedLeadPath(lead: MonthlyQualifiedLead) {
//     const params = new URLSearchParams({
//         scope: "all",
//         lead: lead.leadId,
//     });
//     const searchLabel = getQualifiedLeadSearchLabel(lead);

//     if (searchLabel) {
//         params.set("leadSearch", searchLabel);
//     }

//     return `/admin/leads?${params.toString()}`;
// }

// function MonthlyAgentRow({ row, onQualifiedClick }: { row: AgentLeadMonthlyRow; onQualifiedClick: (row: AgentLeadMonthlyRow) => void }) {
//     return (
//         <tr className="text-sm text-slate-700 transition hover:bg-violet-50/35">
//             <td className="min-w-0 px-2 py-3">
//                 <div className="flex min-w-0 items-center gap-2">
//                     <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-violet-100 text-xs font-semibold text-[#6426d9]">
//                         {row.employeeName.slice(0, 1).toUpperCase()}
//                     </span>
//                     <div className="min-w-0">
//                         <p className="truncate font-semibold text-slate-900">{row.employeeName}</p>
//                         <p className="mt-0.5 truncate text-xs text-slate-500">{row.role} · {row.team}</p>
//                     </div>
//                 </div>
//             </td>
//             <td className="px-2 py-3 text-center font-semibold text-slate-900">{formatNumber(row.leadsAdded)}</td>
//             <td className="px-2 py-3 text-center">{formatNumber(row.followUps)}</td>
//             <td className="px-2 py-3 text-center">{formatNumber(row.calls)}</td>
//             <td className="px-2 py-3 text-center">
//                 {row.qualified > 0 ? (
//                     <button
//                         type="button"
//                         className="inline-flex min-w-8 items-center justify-center rounded-md border border-emerald-200 bg-emerald-50 px-2 py-1 text-sm font-semibold text-emerald-700 transition hover:border-emerald-400 hover:bg-emerald-100 focus:outline-none focus:ring-2 focus:ring-emerald-300"
//                         onClick={() => onQualifiedClick(row)}
//                         aria-label={`View ${formatNumber(row.qualified)} qualified leads for ${row.employeeName}`}
//                     >
//                         {formatNumber(row.qualified)}
//                     </button>
//                 ) : (
//                     formatNumber(row.qualified)
//                 )}
//             </td>
//             <td className="px-2 py-3 text-center">{formatNumber(row.archiveDead)}</td>
//             <td className="px-2 py-3 text-center">{formatNumber(row.comments)}</td>
//             <td className="px-2 py-3 text-center">{formatNumber(row.touchedLeads)}</td>
//             <td className="px-2 py-3 text-center">
//                 <span className="inline-flex max-w-full justify-center rounded-md bg-violet-100 px-2 py-1 text-xs font-semibold text-[#6426d9]">
//                     {formatNumber(row.productivityScore)}
//                 </span>
//             </td>
//         </tr>
//     );
// }

// function QualifiedLeadsModal({ row, onClose }: { row: AgentLeadMonthlyRow; onClose: () => void }) {
//     const leads = row.qualifiedLeads || [];

//     return createPortal(
//         <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/65 px-4 py-6 backdrop-blur-sm">
//             <section className="flex max-h-[86vh] w-full max-w-4xl flex-col overflow-hidden rounded-lg border border-slate-300 bg-white text-slate-950 shadow-2xl shadow-slate-950/30">
//                 <div className="flex items-start justify-between gap-4 border-b border-slate-200 bg-slate-50 px-5 py-4">
//                     <div className="min-w-0">
//                         <p className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">Qualified Leads</p>
//                         <h3 className="mt-1 truncate text-lg font-semibold">{row.employeeName}</h3>
//                         <p className="mt-1 text-sm text-slate-600">
//                             Showing {formatNumber(leads.length)} records included in the dashboard qualified count.
//                         </p>
//                     </div>
//                     <button
//                         type="button"
//                         className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-slate-300 bg-white text-slate-700 transition hover:border-[#842cff] hover:text-[#6426d9]"
//                         onClick={onClose}
//                         aria-label="Close qualified leads"
//                     >
//                         <FiX className="size-4" aria-hidden="true" />
//                     </button>
//                 </div>
//                 <div className="content-scroll overflow-y-auto p-4">
//                     {leads.length === 0 ? (
//                         <EmptyPanel title="No qualified lead details" message="This row has no qualified lead records attached to the current dashboard response." />
//                     ) : (
//                         <div className="overflow-hidden rounded-lg border border-slate-300">
//                             <table className="w-full min-w-[46rem] table-fixed border-separate border-spacing-0">
//                                 <colgroup>
//                                     <col className="w-[28%]" />
//                                     <col className="w-[28%]" />
//                                     <col className="w-[14%]" />
//                                     <col className="w-[14%]" />
//                                     <col className="w-[16%]" />
//                                 </colgroup>
//                                 <thead className="bg-slate-50 text-[0.68rem] uppercase tracking-[0.12em] text-slate-500">
//                                     <tr>
//                                         <th className="px-3 py-3 text-left font-semibold">Lead</th>
//                                         <th className="px-3 py-3 text-left font-semibold">Business</th>
//                                         <th className="px-3 py-3 text-left font-semibold">Category</th>
//                                         <th className="px-3 py-3 text-left font-semibold">Source</th>
//                                         <th className="px-3 py-3 text-left font-semibold">Qualified At</th>
//                                     </tr>
//                                 </thead>
//                                 <tbody className="divide-y divide-slate-200">
//                                     {leads.map((lead: MonthlyQualifiedLead) => {
//                                         const leadPath = getQualifiedLeadPath(lead);

//                                         return (
//                                             <tr key={lead.leadId} className="text-sm text-slate-700 transition hover:bg-violet-50/70">
//                                                 <td className="p-0">
//                                                     <Link className="block px-3 py-3" to={leadPath}>
//                                                         <p className="truncate font-semibold text-slate-950">{lead.leadName || "No contact name"}</p>
//                                                         <p className="mt-0.5 truncate text-xs text-slate-500">{lead.status}</p>
//                                                     </Link>
//                                                 </td>
//                                                 <td className="p-0">
//                                                     <Link className="block px-3 py-3" to={leadPath}>
//                                                         <p className="truncate font-semibold text-slate-800">{lead.businessName || "No business"}</p>
//                                                         <p className="mt-0.5 truncate text-xs text-slate-500">{lead.assignedAgentName || row.employeeName}</p>
//                                                     </Link>
//                                                 </td>
//                                                 <td className="p-0">
//                                                     <Link className="block px-3 py-3" to={leadPath}>{lead.category || "Uncategorized"}</Link>
//                                                 </td>
//                                                 <td className="p-0">
//                                                     <Link className="block px-3 py-3" to={leadPath}>{lead.source || "Manual"}</Link>
//                                                 </td>
//                                                 <td className="p-0">
//                                                     <Link className="block px-3 py-3" to={leadPath}>{lead.statusAt ? formatPhDateTime(lead.statusAt) : "No date"}</Link>
//                                                 </td>
//                                             </tr>
//                                         );
//                                     })}
//                                 </tbody>
//                             </table>
//                         </div>
//                     )}
//                 </div>
//             </section>
//         </div>,
//         document.body
//     );
// }

// function EmployeeLeadCallsModal({
//     row,
//     onClose,
// }: {
//     row: EmployeeCallSummaryRow;
//     onClose: () => void;
// }) {

//     const navigate = useNavigate();

//     const openLead = (leadId: string) => {
//         onClose();
//         navigate(`/admin/leads?lead=${leadId}`);
//     };

//     return createPortal(
//         <div
//             className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/65 px-4 py-6 backdrop-blur-sm"
//             onMouseDown={(event) => {
//                 if (event.target === event.currentTarget) {
//                     onClose();
//                 }
//             }}
//         >
//             <section
//                 className="flex max-h-[86vh] w-full max-w-5xl flex-col overflow-hidden rounded-lg border border-slate-300 bg-white text-slate-950 shadow-2xl shadow-slate-950/30"
//                 role="dialog"
//                 aria-modal="true"
//                 aria-labelledby="employee-lead-calls-title"
//             >
//                 <div className="flex items-start justify-between gap-4 border-b border-slate-200 bg-slate-50 px-5 py-4">
//                     <div className="min-w-0">
//                         <p className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">
//                             Employee Lead Calls
//                         </p>

//                         <h3
//                             id="employee-lead-calls-title"
//                             className="mt-1 truncate text-lg font-semibold text-slate-950"
//                         >
//                             {row.employeeName}
//                         </h3>

//                         <p className="mt-1 text-sm text-slate-600">
//                             Showing {formatNumber(row.leads.length)} lead record
//                             {row.leads.length === 1 ? "" : "s"} and{" "}
//                             {formatNumber(row.totalCalls)} total call
//                             {row.totalCalls === 1 ? "" : "s"}.
//                         </p>
//                     </div>

//                     <button
//                         type="button"
//                         className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-slate-300 bg-white text-slate-700 transition hover:border-[#842cff] hover:text-[#6426d9]"
//                         onClick={onClose}
//                         aria-label="Close employee lead calls"
//                     >
//                         <FiX className="size-4" aria-hidden="true" />
//                     </button>
//                 </div>

//                 <div className="content-scroll overflow-y-auto p-4">
//                     {row.leads.length === 0 ? (
//                         <EmptyPanel
//                             title="No lead call records"
//                             message="This employee has no lead call records attached."
//                         />
//                     ) : (
//                         <div className="overflow-x-auto rounded-lg border border-slate-300 bg-white">
//                             <table className="w-full min-w-[52rem] table-fixed border-separate border-spacing-0">
//                                 <colgroup>
//                                     <col className="w-[30%]" />
//                                     <col className="w-[30%]" />
//                                     <col className="w-[12%]" />
//                                     <col className="w-[14%]" />
//                                     <col className="w-[14%]" />
//                                 </colgroup>
//                                 <thead className="bg-slate-50 text-[0.68rem] uppercase tracking-[0.12em] text-slate-500">
//                                     <tr>
//                                         <th className="px-3 py-3 text-left font-semibold">Lead</th>
//                                         <th className="px-3 py-3 text-left font-semibold">Business</th>
//                                         <th className="px-3 py-3 text-center font-semibold">Calls</th>
//                                         <th className="px-3 py-3 text-center font-semibold">Not Connected</th>
//                                         <th className="px-3 py-3 text-left font-semibold">Last Call</th>
//                                     </tr>
//                                 </thead>
//                                 <tbody className="divide-y divide-slate-200">
//                                     {row.leads.map((lead) => (
//                                         <tr
//                                             key={lead.leadId}
//                                             role="link"
//                                             tabIndex={0}
//                                             className="cursor-pointer text-sm text-slate-700 transition hover:bg-emerald-50/60 focus:bg-emerald-50/60 focus:outline-none focus:ring-2 focus:ring-inset focus:ring-emerald-300"
//                                             onClick={() => openLead(lead.leadId)}
//                                             onKeyDown={(event) => {
//                                                 if (event.key === "Enter" || event.key === " ") {
//                                                     event.preventDefault();
//                                                     openLead(lead.leadId);
//                                                 }
//                                             }}
//                                         >
//                                             <td className="px-3 py-3">
//                                                 <p className="truncate font-semibold text-slate-950">
//                                                     {lead.leadName || "No lead name"}
//                                                 </p>

//                                                 <p className="mt-0.5 truncate text-xs text-slate-500">
//                                                     {lead.leadId}
//                                                 </p>
//                                             </td>

//                                             <td className="px-3 py-3">
//                                                 <p className="truncate font-semibold text-slate-800">
//                                                     {lead.businessName || "No business name"}
//                                                 </p>
//                                             </td>

//                                             <td className="px-3 py-3 text-center font-semibold text-slate-950">
//                                                 {formatNumber(lead.callCount)}
//                                             </td>

//                                             <td className="px-3 py-3 text-center font-semibold text-rose-600">
//                                                 {formatNumber(lead.callNotConnectedCount)}
//                                             </td>

//                                             <td className="px-3 py-3 text-sm text-slate-600">
//                                                 {lead.lastCallAt ? formatPhDateTime(lead.lastCallAt) : "No date"}
//                                             </td>
//                                         </tr>
//                                     ))}
//                                 </tbody>
//                             </table>
//                         </div>
//                     )}
//                 </div>
//             </section>
//         </div>,
//         document.body
//     );
// }

// function ActivityItem({ item, onOpen }: { item: AgentLeadActivity; onOpen: (item: AgentLeadActivity) => void }) {
//     const leadName = item.leadName || item.businessName || "Lead";

//     return (
//         <button
//             type="button"
//             className="cursor-pointer rounded-lg border border-slate-300 bg-white p-3 text-left transition hover:border-[#842cff] hover:bg-violet-50/40 focus:outline-none focus:ring-2 focus:ring-[#842cff]/35"
//             onClick={() => onOpen(item)}
//             aria-label={`Open transaction history for ${leadName}`}
//         >
//             <div className="flex items-start justify-between gap-3">
//                 <div className="min-w-0">
//                     <p className="truncate text-sm font-semibold text-slate-950">{item.employeeName}</p>
//                     <p className="mt-1 truncate text-xs text-slate-500">{leadName}</p>
//                 </div>
//                 <span className={`shrink-0 rounded-md border px-2 py-1 text-xs font-semibold ${activityLabelClass(item.action)}`}>
//                     {item.action}
//                 </span>
//             </div>
//             <p className="mt-3 line-clamp-3 whitespace-pre-line text-sm leading-5 text-slate-700">{item.detail}</p>
//             <p className="mt-2 text-xs font-semibold uppercase tracking-[0.12em] text-slate-400">
//                 {item.createdAt ? formatPhDateTime(item.createdAt) : "No time"}
//             </p>
//             <span className="mt-3 inline-flex text-xs font-semibold text-[#842cff]">View history</span>
//         </button>
//     );
// }

// function LeadHistoryModal({
//     activity,
//     lead,
//     history,
//     isLoading,
//     isError,
//     onClose,
// }: {
//     activity: AgentLeadActivity;
//     lead?: Lead;
//     history: LeadHistoryItem[];
//     isLoading: boolean;
//     isError: boolean;
//     onClose: () => void;
// }) {
//     const leadName = getLeadDisplayName(lead, activity);
//     const assignedAgentName = lead?.assignedAgentName || lead?.assignedAgent?.name || activity.employeeName || "Unassigned";
//     const status = lead?.status || activity.status;
//     const latestTime = history[0]?.createdAt || activity.createdAt;

//     return createPortal(
//         <div
//             className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 p-4"
//             onMouseDown={(event) => {
//                 if (event.target === event.currentTarget) {
//                     onClose();
//                 }
//             }}
//         >
//             <section
//                 className="flex max-h-[88vh] w-full max-w-3xl flex-col overflow-hidden rounded-lg border border-slate-300 bg-white text-slate-950 shadow-2xl shadow-slate-950/30"
//                 role="dialog"
//                 aria-modal="true"
//                 aria-labelledby="lead-history-title"
//             >
//                 <header className="flex items-start justify-between gap-4 border-b border-slate-200 px-5 py-4">
//                     <div className="min-w-0">
//                         <p className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">Transaction History</p>
//                         <h3 id="lead-history-title" className="mt-1 truncate text-xl font-semibold text-slate-950">{leadName}</h3>
//                         <p className="mt-1 truncate text-sm text-slate-600">{lead?.businessName || activity.businessName || "No business name"}</p>
//                     </div>
//                     <button
//                         type="button"
//                         className="flex size-10 shrink-0 items-center justify-center rounded-lg border border-slate-300 bg-white text-slate-700 transition hover:bg-slate-100"
//                         onClick={onClose}
//                         aria-label="Close transaction history"
//                     >
//                         <FiX className="size-5" aria-hidden="true" />
//                     </button>
//                 </header>

//                 <div className="grid gap-3 border-b border-slate-200 bg-slate-50 px-5 py-4 sm:grid-cols-3">
//                     <div className="rounded-lg border border-slate-300 bg-white p-3">
//                         <p className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">Status</p>
//                         <span className={`mt-2 inline-flex rounded-md border px-2 py-1 text-xs font-semibold ${activityLabelClass(status || "")}`}>
//                             {status || "Unknown"}
//                         </span>
//                     </div>
//                     <div className="rounded-lg border border-slate-300 bg-white p-3">
//                         <p className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">Assigned Agent</p>
//                         <p className="mt-2 truncate text-sm font-semibold text-slate-950">{assignedAgentName}</p>
//                     </div>
//                     <div className="rounded-lg border border-slate-300 bg-white p-3">
//                         <p className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">Latest</p>
//                         <p className="mt-2 text-sm font-semibold text-slate-950">{latestTime ? formatPhDateTime(latestTime) : "No time"}</p>
//                     </div>
//                 </div>

//                 <div className="overflow-y-auto px-5 py-4">
//                     {isLoading && <EmptyPanel title="Loading transaction history" message="Getting the latest lead activity." />}
//                     {!activity.leadId && <EmptyPanel title="Lead history is unavailable" message="This activity record is missing its lead link." />}
//                     {isError && <EmptyPanel title="Transaction history could not load" message="Please refresh and try opening this lead again." />}
//                     {!isLoading && activity.leadId && !isError && history.length === 0 && (
//                         <EmptyPanel title="No transaction history yet" message="Comments, status changes, schedules, and follow-ups will show here." />
//                     )}
//                     {!isLoading && activity.leadId && !isError && history.length > 0 && (
//                         <div className="space-y-4">
//                             {history.map((item) => (
//                                 <article key={item.id} className="relative border-l border-slate-200 pl-4">
//                                     <span className={`absolute -left-[5px] top-1 size-2.5 rounded-full ${item.kind === "comment" ? "bg-sky-500" : "bg-[#842cff]"}`} />
//                                     <div className="flex flex-wrap items-start justify-between gap-2">
//                                         <div className="min-w-0">
//                                             <p className="text-sm font-semibold text-slate-950">{item.label}</p>
//                                             <p className="mt-1 text-xs text-slate-500">
//                                                 {item.actorName} · {item.actorType}
//                                             </p>
//                                         </div>
//                                         {item.status && (
//                                             <span className={`shrink-0 rounded-md border px-2 py-1 text-xs font-semibold ${activityLabelClass(item.status)}`}>
//                                                 {item.status}
//                                             </span>
//                                         )}
//                                     </div>
//                                     <p className="mt-2 whitespace-pre-line text-sm leading-5 text-slate-700">{item.detail}</p>
//                                     <p className="mt-2 text-xs font-semibold uppercase tracking-[0.12em] text-slate-400">
//                                         {item.createdAt ? formatPhDateTime(item.createdAt) : "No time"}
//                                     </p>
//                                 </article>
//                             ))}
//                         </div>
//                     )}
//                 </div>
//             </section>
//         </div>,
//         document.body
//     );
// }

// function latestAttendance(records: AttendanceRecord[]) {
//     return [...records].sort((first, second) => new Date(second.timeIn || second.createdAt).getTime() - new Date(first.timeIn || first.createdAt).getTime());
// }

// function statusBadgeClass(value?: string) {
//     const status = normalizeEmployeeAvailabilityStatus(value);

//     if (status === "ONLINE") return "border-emerald-200 bg-emerald-50 text-emerald-700";
//     if (status === "BREAK" || status === "LUNCH") return "border-amber-200 bg-amber-50 text-amber-700";
//     if (status === "OFF THE PHONE") return "border-sky-200 bg-sky-50 text-sky-700";
//     return "border-slate-200 bg-slate-50 text-slate-700";
// }

// function formatDateOrDash(value?: string | null) {
//     return value ? formatPhDate(value) : "-";
// }

// function formatActivityTime(value?: string | null) {
//     return value ? formatPhDateTime(value) : "No timestamp";
// }

// const ATTENDANCE_BREAK_LIMITS_MS: Partial<Record<AttendanceRecord["source"], number>> = {
//     "Break Out": 15 * 60 * 1000,
//     "Lunch Break Out": 60 * 60 * 1000,
// };

// const SHIFT_START_HOUR = 23;
// const SHIFT_END_HOUR = 8;
// const SHIFT_LENGTH_MS = 9 * 60 * 60 * 1000;
// const SHIFT_MORNING_CUTOFF_HOUR = 12;

// function getAttendanceTimestamp(record?: AttendanceRecord | null) {
//     const timestamp = record?.timeIn || record?.createdAt;
//     const value = timestamp ? new Date(timestamp).getTime() : 0;

//     return Number.isNaN(value) ? 0 : value;
// }

// function getDateValue(value?: string | null) {
//     const timestamp = value ? new Date(value).getTime() : 0;
//     return Number.isNaN(timestamp) ? 0 : timestamp;
// }

// function formatAttendanceDuration(milliseconds: number) {
//     const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000));
//     const days = Math.floor(totalSeconds / 86400);
//     const hours = Math.floor((totalSeconds % 86400) / 3600);
//     const minutes = Math.floor((totalSeconds % 3600) / 60);
//     const seconds = totalSeconds % 60;

//     if (days > 0) {
//         return `${days}d ${String(hours).padStart(2, "0")}h ${String(minutes).padStart(2, "0")}m ${String(seconds).padStart(2, "0")}s`;
//     }

//     if (hours > 0) {
//         return `${hours}h ${String(minutes).padStart(2, "0")}m ${String(seconds).padStart(2, "0")}s`;
//     }

//     if (minutes > 0) {
//         return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
//     }

//     return `${seconds}s`;
// }

// function getAttendanceStatusText(record: AttendanceRecord) {
//     return String(record.attendanceStatus || "").trim().toLowerCase();
// }

// function getBreakReturnSource(source?: AttendanceRecord["source"]) {
//     if (source === "Break Out") return "Break In";
//     if (source === "Lunch Break Out") return "Lunch Break In";
//     return "";
// }

// type AttendanceOverBreakRow = {
//     id: string;
//     label: string;
//     startedAt: string;
//     endedAt: string | null;
//     durationMs: number;
//     allowedMs: number;
//     overMs: number;
//     isOpen: boolean;
// };

// type AttendanceShiftRow = {
//     id: string;
//     shiftDateValue: string;
//     shiftStart: Date;
//     shiftEnd: Date;
//     records: AttendanceRecord[];
//     overBreakRows: AttendanceOverBreakRow[];
//     totalOverBreakMs: number;
//     lateRecords: AttendanceRecord[];
//     underTimeRecords: AttendanceRecord[];
//     firstTimeIn: AttendanceRecord | null;
//     lastTimeOut: AttendanceRecord | null;
// };

// function getShiftStartDateFromTimestamp(value?: string | null) {
//     const date = value ? new Date(value) : new Date();

//     if (Number.isNaN(date.getTime())) {
//         return new Date(0);
//     }

//     const shiftStart = new Date(date);

//     // Attendance day is an overnight work day. Any punch before noon belongs to
//     // the previous night's 11PM shift. Punches from noon onward belong to that
//     // date's 11PM shift. This prevents 8:01 AM time-outs from being moved to
//     // the next 11PM shift.
//     if (date.getHours() < SHIFT_MORNING_CUTOFF_HOUR) {
//         shiftStart.setDate(shiftStart.getDate() - 1);
//     }

//     shiftStart.setHours(SHIFT_START_HOUR, 0, 0, 0);
//     return shiftStart;
// }

// function getShiftEndDate(shiftStart: Date) {
//     return new Date(shiftStart.getTime() + SHIFT_LENGTH_MS);
// }

// function getShiftDateValueFromStart(shiftStart: Date) {
//     return formatDateInputValue(new Date(shiftStart.getFullYear(), shiftStart.getMonth(), shiftStart.getDate()));
// }

// function getCurrentShiftDateValue() {
//     return getShiftDateValueFromStart(getShiftStartDateFromTimestamp(new Date().toISOString()));
// }

// function getShiftLabel(row: AttendanceShiftRow) {
//     return `${formatPhDateTime(row.shiftStart.toISOString())} to ${formatPhDateTime(row.shiftEnd.toISOString())}`;
// }

// function isTimeInSource(source?: AttendanceRecord["source"]) {
//     return source === "Login" || source === "Time In";
// }

// function isTimeOutSource(source?: AttendanceRecord["source"]) {
//     return source === "Logout" || source === "Time Out";
// }

// function getChronologicalAttendance(records: AttendanceRecord[]) {
//     return [...records].sort((first, second) => getAttendanceTimestamp(first) - getAttendanceTimestamp(second));
// }

// function getLatestAttendanceInShift(records: AttendanceRecord[]) {
//     return [...records].sort((first, second) => getAttendanceTimestamp(second) - getAttendanceTimestamp(first));
// }

// function findBreakEndRecord(records: AttendanceRecord[], startIndex: number, returnSource: string) {
//     const startRecord = records[startIndex];
//     const startedAtMs = getAttendanceTimestamp(startRecord);

//     for (let index = startIndex + 1; index < records.length; index += 1) {
//         const candidate = records[index];
//         const candidateMs = getAttendanceTimestamp(candidate);

//         if (candidateMs <= startedAtMs) {
//             continue;
//         }

//         if (candidate.source === returnSource) {
//             return { record: candidate, isReturned: true };
//         }

//         // A time-out closes any open break/lunch. A new break/lunch without a
//         // matching return also closes the previous open segment at that punch so
//         // the calculation never runs until today's Date.now() by mistake.
//         if (
//             isTimeOutSource(candidate.source) ||
//             candidate.source === "Break Out" ||
//             candidate.source === "Lunch Break Out" ||
//             isTimeInSource(candidate.source)
//         ) {
//             return { record: candidate, isReturned: false };
//         }
//     }

//     return { record: null, isReturned: false };
// }

// function buildOverBreakRows(records: AttendanceRecord[], shiftEnd: Date, isCurrentOpenShift: boolean) {
//     const ascendingRecords = getChronologicalAttendance(records);
//     const rows: AttendanceOverBreakRow[] = [];

//     ascendingRecords.forEach((record, index) => {
//         const allowedMs = ATTENDANCE_BREAK_LIMITS_MS[record.source];
//         const returnSource = getBreakReturnSource(record.source);

//         if (!allowedMs || !returnSource) {
//             return;
//         }

//         const startedAtMs = getAttendanceTimestamp(record);
//         const breakEnd = findBreakEndRecord(ascendingRecords, index, returnSource);
//         const fallbackEndMs = isCurrentOpenShift ? Date.now() : shiftEnd.getTime();
//         const endedAtMs = breakEnd.record ? getAttendanceTimestamp(breakEnd.record) : fallbackEndMs;
//         const safeEndedAtMs = Math.max(startedAtMs, endedAtMs);
//         const durationMs = Math.max(0, safeEndedAtMs - startedAtMs);
//         const overMs = Math.max(0, durationMs - allowedMs);

//         if (overMs <= 0) {
//             return;
//         }

//         rows.push({
//             id: record._id,
//             label: record.source === "Lunch Break Out" ? "Lunch Break" : "Break",
//             startedAt: record.timeIn,
//             endedAt: breakEnd.record?.timeIn || new Date(safeEndedAtMs).toISOString(),
//             durationMs,
//             allowedMs,
//             overMs,
//             isOpen: !breakEnd.record && isCurrentOpenShift,
//         });
//     });

//     return rows.sort((first, second) => getDateValue(first.startedAt) - getDateValue(second.startedAt));
// }

// type AttendanceShiftDraft = {
//     shiftDateValue: string;
//     shiftStart: Date;
//     shiftEnd: Date;
//     records: AttendanceRecord[];
// };

// function createShiftDraftFromRecord(record: AttendanceRecord): AttendanceShiftDraft {
//     const shiftStart = getShiftStartDateFromTimestamp(record.timeIn || record.createdAt);

//     return {
//         shiftDateValue: getShiftDateValueFromStart(shiftStart),
//         shiftStart,
//         shiftEnd: getShiftEndDate(shiftStart),
//         records: [],
//     };
// }

// function buildAttendanceShiftRows(records: AttendanceRecord[]) {
//     const chronologicalRecords = getChronologicalAttendance(records);
//     const shiftDrafts: AttendanceShiftDraft[] = [];
//     const orphanRowsByDate = new Map<string, AttendanceShiftDraft>();
//     let activeShift: AttendanceShiftDraft | null = null;

//     chronologicalRecords.forEach((record) => {
//         if (isTimeInSource(record.source)) {
//             activeShift = createShiftDraftFromRecord(record);
//             activeShift.records.push(record);
//             shiftDrafts.push(activeShift);
//             return;
//         }

//         if (activeShift) {
//             activeShift.records.push(record);

//             if (isTimeOutSource(record.source)) {
//                 activeShift = null;
//             }

//             return;
//         }

//         // Fallback for imported/old data that has break or time-out records but
//         // no time-in record available in the returned API payload.
//         const fallbackShiftStart = getShiftStartDateFromTimestamp(record.timeIn || record.createdAt);
//         const fallbackShiftDateValue = getShiftDateValueFromStart(fallbackShiftStart);

//         if (!orphanRowsByDate.has(fallbackShiftDateValue)) {
//             orphanRowsByDate.set(fallbackShiftDateValue, {
//                 shiftDateValue: fallbackShiftDateValue,
//                 shiftStart: fallbackShiftStart,
//                 shiftEnd: getShiftEndDate(fallbackShiftStart),
//                 records: [],
//             });
//         }

//         orphanRowsByDate.get(fallbackShiftDateValue)!.records.push(record);
//     });

//     return [...shiftDrafts, ...Array.from(orphanRowsByDate.values())]
//         .filter((draft) => draft.records.length > 0)
//         .map((draft) => {
//             const sortedShiftRecords = getLatestAttendanceInShift(draft.records);
//             const ascendingShiftRecords = getChronologicalAttendance(draft.records);
//             const latestRecord = ascendingShiftRecords[ascendingShiftRecords.length - 1];
//             const isCurrentOpenShift = Boolean(
//                 latestRecord &&
//                 !ascendingShiftRecords.some((record) => isTimeOutSource(record.source)) &&
//                 draft.shiftDateValue === getCurrentShiftDateValue()
//             );
//             const overBreakRows = buildOverBreakRows(draft.records, draft.shiftEnd, isCurrentOpenShift);
//             const lateRecords = sortedShiftRecords.filter((record) => getAttendanceStatusText(record).includes("late"));
//             const underTimeRecords = sortedShiftRecords.filter((record) => {
//                 const statusText = getAttendanceStatusText(record);

//                 return statusText.includes("under") || statusText.includes("undertime");
//             });
//             const firstTimeIn = ascendingShiftRecords.find((record) => isTimeInSource(record.source)) || ascendingShiftRecords[0] || null;
//             const lastTimeOut = sortedShiftRecords.find((record) => isTimeOutSource(record.source)) || null;

//             return {
//                 id: draft.shiftDateValue,
//                 shiftDateValue: draft.shiftDateValue,
//                 shiftStart: draft.shiftStart,
//                 shiftEnd: draft.shiftEnd,
//                 records: sortedShiftRecords,
//                 overBreakRows,
//                 totalOverBreakMs: overBreakRows.reduce((total, row) => total + row.overMs, 0),
//                 lateRecords,
//                 underTimeRecords,
//                 firstTimeIn,
//                 lastTimeOut,
//             };
//         })
//         .sort((first, second) => first.shiftStart.getTime() - second.shiftStart.getTime());
// }

// function AttendancePanel({ employee, attendance, isPlaceholder = false }: { employee?: Employee | null; attendance: AttendanceRecord[]; isPlaceholder?: boolean }) {
//     const status = normalizeEmployeeAvailabilityStatus(employee?.availabilityStatus);
//     const todayDateValue = getCurrentShiftDateValue();
//     const [selectedAttendanceDate, setSelectedAttendanceDate] = useState("");
//     const [attendanceDateFrom, setAttendanceDateFrom] = useState("");
//     const [attendanceDateTo, setAttendanceDateTo] = useState("");
//     const [selectedShiftRow, setSelectedShiftRow] = useState<AttendanceShiftRow | null>(null);
//     const sortedAllAttendance = useMemo(() => latestAttendance(attendance), [attendance]);
//     const allShiftRows = useMemo(() => buildAttendanceShiftRows(sortedAllAttendance), [sortedAllAttendance]);
//     const filteredShiftRows = useMemo(() => {
//         const exactDateStart = selectedAttendanceDate ? getDateStart(selectedAttendanceDate) : null;
//         const exactDateEnd = selectedAttendanceDate ? getDateEnd(selectedAttendanceDate) : null;
//         const rangeStart = !selectedAttendanceDate && attendanceDateFrom ? getDateStart(attendanceDateFrom) : null;
//         const rangeEnd = !selectedAttendanceDate && attendanceDateTo ? getDateEnd(attendanceDateTo) : null;

//         return allShiftRows.filter((row) => {
//             const shiftDateTime = getDateStart(row.shiftDateValue)?.getTime() || row.shiftStart.getTime();

//             if (exactDateStart && shiftDateTime < exactDateStart.getTime()) return false;
//             if (exactDateEnd && shiftDateTime > exactDateEnd.getTime()) return false;
//             if (rangeStart && shiftDateTime < rangeStart.getTime()) return false;
//             if (rangeEnd && shiftDateTime > rangeEnd.getTime()) return false;

//             return true;
//         });
//     }, [allShiftRows, selectedAttendanceDate, attendanceDateFrom, attendanceDateTo]);
//     const totalFilteredRecords = filteredShiftRows.reduce((total, row) => total + row.records.length, 0);
//     const totalOverBreakMs = filteredShiftRows.reduce((total, row) => total + row.totalOverBreakMs, 0);
//     const totalOverBreakCount = filteredShiftRows.reduce((total, row) => total + row.overBreakRows.length, 0);
//     const totalLateCount = filteredShiftRows.reduce((total, row) => total + row.lateRecords.length, 0);
//     const totalUnderTimeCount = filteredShiftRows.reduce((total, row) => total + row.underTimeRecords.length, 0);
//     const hasAttendanceFilter = Boolean(selectedAttendanceDate || attendanceDateFrom || attendanceDateTo);
//     const filterSummary = selectedAttendanceDate
//         ? `Selected shift date: ${formatDateOrDash(selectedAttendanceDate)}`
//         : attendanceDateFrom || attendanceDateTo
//             ? `Shift date range: ${attendanceDateFrom ? formatDateOrDash(attendanceDateFrom) : "Start"} to ${attendanceDateTo ? formatDateOrDash(attendanceDateTo) : "End"}`
//             : "Showing all attendance shifts";
//     const clearAttendanceFilters = () => {
//         setSelectedAttendanceDate("");
//         setAttendanceDateFrom("");
//         setAttendanceDateTo("");
//     };
//     const applyTodayAttendanceFilter = () => {
//         setSelectedAttendanceDate(todayDateValue);
//         setAttendanceDateFrom("");
//         setAttendanceDateTo("");
//     };
//     const applyThisMonthAttendanceFilter = () => {
//         const today = new Date();
//         const monthStart = formatDateInputValue(new Date(today.getFullYear(), today.getMonth(), 1));

//         setSelectedAttendanceDate("");
//         setAttendanceDateFrom(monthStart);
//         setAttendanceDateTo(todayDateValue);
//     };
//     const metricCards = [
//         {
//             label: "Over break",
//             value: formatAttendanceDuration(totalOverBreakMs),
//             detail: `${formatNumber(totalOverBreakCount)} break/lunch violation${totalOverBreakCount === 1 ? "" : "s"}`,
//             className: "border-rose-200 bg-rose-50 text-rose-700",
//         },
//         {
//             label: "Under time",
//             value: formatNumber(totalUnderTimeCount),
//             detail: "Records marked undertime inside selected shift rows",
//             className: "border-amber-200 bg-amber-50 text-amber-700",
//         },
//         {
//             label: "Late times",
//             value: formatNumber(totalLateCount),
//             detail: "Records marked late inside selected shift rows",
//             className: "border-violet-200 bg-violet-50 text-violet-700",
//         },
//     ];
//     const skeletonMetricCards = ["Over break", "Under time", "Late times"];

//     return (
//         <section className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
//             <div className="flex items-start justify-between gap-3">
//                 <div>
//                     <p className="mt-1 text-xs text-slate-500">
//                         {isPlaceholder ? (
//                             "Select an employee to load 11:00 PM to 8:00 AM shift rows, late, undertime, and over-break details."
//                         ) : (
//                             <>One row equals one full shift: 11:00 PM shift date to 8:00 AM next day. Showing {formatNumber(filteredShiftRows.length)} of {formatNumber(allShiftRows.length)} shift row{allShiftRows.length === 1 ? "" : "s"}.</>
//                         )}
//                     </p>
//                 </div>
//                 <span className={`rounded-full border px-3 py-1 text-xs font-bold ${statusBadgeClass(status)}`}>{status}</span>
//             </div>

//             <div className="mt-5 grid gap-3 sm:grid-cols-3">
//                 {isPlaceholder
//                     ? skeletonMetricCards.map((label) => (
//                         <article key={label} className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-3">
//                             <p className="text-[0.65rem] font-bold uppercase tracking-[0.12em] text-slate-400">{label}</p>
//                             <div className="mt-3 h-6 w-20 animate-pulse rounded bg-slate-200" />
//                             <div className="mt-3 h-3 w-40 max-w-full animate-pulse rounded bg-slate-200" />
//                         </article>
//                     ))
//                     : metricCards.map((item) => (
//                         <article key={item.label} className={`rounded-lg border px-3 py-3 ${item.className}`}>
//                             <p className="text-[0.65rem] font-bold uppercase tracking-[0.12em] opacity-80">{item.label}</p>
//                             <p className="mt-2 text-xl font-semibold">{item.value}</p>
//                             <p className="mt-1 text-xs font-semibold opacity-80">{item.detail}</p>
//                         </article>
//                     ))}
//             </div>

//             <div className="mt-5 rounded-lg border border-slate-200 bg-slate-50 p-4">
//                 <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
//                     <div>
//                         <p className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">Shift Filter</p>
//                         <p className="mt-1 text-sm font-semibold text-slate-800">{isPlaceholder ? "No employee selected" : filterSummary}</p>
//                         <p className="mt-1 text-xs text-slate-500">Date means the shift start date. Example: 06/16/2026 means 11:00 PM 06/16/2026 to 8:00 AM 06/17/2026.</p>
//                     </div>

//                     <div className="grid w-full gap-3 sm:grid-cols-2 lg:w-auto lg:grid-cols-[10rem_10rem_10rem_auto]">
//                         <label className="text-xs font-semibold text-slate-600">
//                             Shift Date
//                             <input
//                                 type="date"
//                                 disabled={isPlaceholder}
//                                 value={selectedAttendanceDate}
//                                 onChange={(event) => {
//                                     setSelectedAttendanceDate(event.target.value);
//                                     if (event.target.value) {
//                                         setAttendanceDateFrom("");
//                                         setAttendanceDateTo("");
//                                     }
//                                 }}
//                                 className="mt-1 h-10 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm font-semibold text-slate-800 shadow-sm focus:border-violet-500 focus:outline-none focus:ring-2 focus:ring-violet-200"
//                             />
//                         </label>

//                         <label className="text-xs font-semibold text-slate-600">
//                             Shift From
//                             <input
//                                 type="date"
//                                 disabled={isPlaceholder}
//                                 value={attendanceDateFrom}
//                                 onChange={(event) => {
//                                     setAttendanceDateFrom(event.target.value);
//                                     if (event.target.value) {
//                                         setSelectedAttendanceDate("");
//                                     }
//                                 }}
//                                 className="mt-1 h-10 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm font-semibold text-slate-800 shadow-sm focus:border-violet-500 focus:outline-none focus:ring-2 focus:ring-violet-200"
//                             />
//                         </label>

//                         <label className="text-xs font-semibold text-slate-600">
//                             Shift To
//                             <input
//                                 type="date"
//                                 disabled={isPlaceholder}
//                                 value={attendanceDateTo}
//                                 onChange={(event) => {
//                                     setAttendanceDateTo(event.target.value);
//                                     if (event.target.value) {
//                                         setSelectedAttendanceDate("");
//                                     }
//                                 }}
//                                 className="mt-1 h-10 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm font-semibold text-slate-800 shadow-sm focus:border-violet-500 focus:outline-none focus:ring-2 focus:ring-violet-200"
//                             />
//                         </label>

//                         <div className="flex items-end gap-2">
//                             <button
//                                 type="button"
//                                 className="inline-flex h-10 items-center justify-center rounded-lg border border-violet-200 bg-white px-3 text-xs font-bold text-violet-700 transition hover:border-violet-500 hover:bg-violet-50"
//                                 onClick={applyTodayAttendanceFilter}
//                                 disabled={isPlaceholder}
//                             >
//                                 Today
//                             </button>
//                             <button
//                                 type="button"
//                                 className="inline-flex h-10 items-center justify-center rounded-lg border border-[#842cff]/30 bg-white px-3 text-xs font-bold text-[#6426d9] transition hover:border-[#842cff] hover:bg-violet-50"
//                                 onClick={applyThisMonthAttendanceFilter}
//                                 disabled={isPlaceholder}
//                             >
//                                 This Month
//                             </button>
//                             <button
//                                 type="button"
//                                 className="inline-flex h-10 items-center justify-center rounded-lg border border-slate-300 bg-white px-3 text-xs font-bold text-slate-600 transition hover:border-slate-500 hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-50"
//                                 onClick={clearAttendanceFilters}
//                                 disabled={isPlaceholder || !hasAttendanceFilter}
//                             >
//                                 Clear
//                             </button>
//                         </div>
//                     </div>
//                 </div>
//             </div>

//             <div className="mt-5 overflow-hidden rounded-lg border border-slate-300 bg-white">
//                 <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 bg-slate-50 px-4 py-3">
//                     <div>
//                         <p className="text-xs font-semibold uppercase tracking-[0.12em] text-slate-500">Shift Attendance Table</p>
//                         <p className="mt-1 text-xs text-slate-500">{isPlaceholder ? "Select an employee above to load shift rows here." : <>Click View to open every punch, issue, and break detail inside that shift. {filterSummary}</>}</p>
//                     </div>
//                     <span className="rounded-full bg-white px-2.5 py-1 text-[0.65rem] font-bold text-slate-500">Shift 11PM-8AM · Break 15m · Lunch 1h</span>
//                 </div>

//                 <div className="content-scroll max-h-[34rem] overflow-auto">
//                     <table className="w-full min-w-[70rem] table-fixed border-separate border-spacing-0 text-left text-sm">
//                         <colgroup>
//                             <col className="w-[12%]" />
//                             <col className="w-[25%]" />
//                             <col className="w-[12%]" />
//                             <col className="w-[12%]" />
//                             <col className="w-[8%]" />
//                             <col className="w-[8%]" />
//                             <col className="w-[8%]" />
//                             <col className="w-[15%]" />
//                         </colgroup>
//                         <thead className="sticky top-0 z-10 bg-white text-[0.68rem] uppercase tracking-[0.12em] text-slate-500 shadow-sm">
//                             <tr>
//                                 <th className="px-3 py-3 font-semibold">Shift Date</th>
//                                 <th className="px-3 py-3 font-semibold">Shift Window</th>
//                                 <th className="px-3 py-3 font-semibold">Time In</th>
//                                 <th className="px-3 py-3 font-semibold">Time Out</th>
//                                 <th className="px-3 py-3 text-center font-semibold">Late</th>
//                                 <th className="px-3 py-3 text-center font-semibold">Under</th>
//                                 <th className="px-3 py-3 font-semibold">Over Break</th>
//                                 <th className="px-3 py-3 text-center font-semibold">Details</th>
//                             </tr>
//                         </thead>
//                         <tbody className="divide-y divide-slate-200">
//                             {isPlaceholder && Array.from({ length: 4 }).map((_, index) => (
//                                 <tr key={`attendance-skeleton-${index}`} className="pointer-events-none">
//                                     <td className="px-3 py-4"><div className="h-4 w-24 animate-pulse rounded bg-slate-200" /></td>
//                                     <td className="px-3 py-4"><div className="h-4 w-64 max-w-full animate-pulse rounded bg-slate-200" /><div className="mt-2 h-3 w-40 animate-pulse rounded bg-slate-200" /></td>
//                                     <td className="px-3 py-4"><div className="h-4 w-20 animate-pulse rounded bg-slate-200" /></td>
//                                     <td className="px-3 py-4"><div className="h-4 w-20 animate-pulse rounded bg-slate-200" /></td>
//                                     <td className="px-3 py-4"><div className="mx-auto h-4 w-8 animate-pulse rounded bg-slate-200" /></td>
//                                     <td className="px-3 py-4"><div className="mx-auto h-4 w-8 animate-pulse rounded bg-slate-200" /></td>
//                                     <td className="px-3 py-4"><div className="mx-auto h-4 w-8 animate-pulse rounded bg-slate-200" /></td>
//                                     <td className="px-3 py-4"><div className="h-4 w-24 animate-pulse rounded bg-slate-200" /></td>
//                                     <td className="px-3 py-4"><div className="mx-auto h-8 w-14 animate-pulse rounded-lg bg-slate-200" /></td>
//                                 </tr>
//                             ))}
//                             {!isPlaceholder && filteredShiftRows.map((row) => (
//                                 <tr key={row.id} className="text-slate-700 transition hover:bg-violet-50/40">
//                                     <td className="px-3 py-3 font-semibold text-slate-900">{formatDateOrDash(row.shiftDateValue)}</td>
//                                     <td className="px-3 py-3">
//                                         <p className="font-semibold text-slate-950">{getShiftLabel(row)}</p>
//                                         <p className="mt-0.5 text-xs text-slate-500">11:00 PM to 8:00 AM next day</p>
//                                     </td>
//                                     <td className="px-3 py-3">{row.firstTimeIn ? formatPhTime(row.firstTimeIn.timeIn) : "-"}</td>
//                                     <td className="px-3 py-3">{row.lastTimeOut ? formatPhTime(row.lastTimeOut.timeIn) : "No time out"}</td>
//                                     <td className="px-3 py-3 text-center">
//                                         <span className={row.lateRecords.length ? "inline-flex rounded-full bg-violet-100 px-2 py-1 text-xs font-bold text-violet-700" : "text-xs font-semibold text-slate-400"}>
//                                             {row.lateRecords.length ? formatNumber(row.lateRecords.length) : "0"}
//                                         </span>
//                                     </td>
//                                     <td className="px-3 py-3 text-center">
//                                         <span className={row.underTimeRecords.length ? "inline-flex rounded-full bg-amber-100 px-2 py-1 text-xs font-bold text-amber-700" : "text-xs font-semibold text-slate-400"}>
//                                             {row.underTimeRecords.length ? formatNumber(row.underTimeRecords.length) : "0"}
//                                         </span>
//                                     </td>
//                                     <td className="px-3 py-3">
//                                         {row.totalOverBreakMs > 0 ? (
//                                             <div>
//                                                 <p className="font-semibold text-rose-700">{formatAttendanceDuration(row.totalOverBreakMs)}</p>
//                                                 <p className="mt-0.5 text-xs text-slate-500">{formatNumber(row.overBreakRows.length)} violation{row.overBreakRows.length === 1 ? "" : "s"}</p>
//                                             </div>
//                                         ) : (
//                                             <span className="text-xs font-semibold text-slate-400">-</span>
//                                         )}
//                                     </td>
//                                     <td className="px-3 py-3 text-center">
//                                         <button
//                                             type="button"
//                                             className="inline-flex h-8 items-center justify-center rounded-lg border border-slate-300 bg-white px-3 text-xs font-semibold text-slate-700 transition hover:border-violet-500 hover:text-violet-700 focus:outline-none focus:ring-2 focus:ring-violet-200"
//                                             onClick={() => setSelectedShiftRow(row)}
//                                         >
//                                             View
//                                         </button>
//                                     </td>
//                                 </tr>
//                             ))}
//                             {!isPlaceholder && filteredShiftRows.length === 0 && (
//                                 <tr>
//                                     <td className="px-4 py-8 text-center text-sm text-slate-500" colSpan={9}>
//                                         No attendance shifts found.
//                                     </td>
//                                 </tr>
//                             )}
//                         </tbody>
//                     </table>
//                 </div>
//             </div>

//             {selectedShiftRow && (
//                 <AttendanceShiftDetailsModal
//                     row={selectedShiftRow}
//                     onClose={() => setSelectedShiftRow(null)}
//                 />
//             )}
//         </section>
//     );
// }

// function AttendanceShiftDetailsModal({ row, onClose }: { row: AttendanceShiftRow; onClose: () => void }) {
//     const chronologicalShiftRecords = [...row.records].sort(
//         (first, second) => getAttendanceTimestamp(first) - getAttendanceTimestamp(second)
//     );
//     const chronologicalOverBreakRows = [...row.overBreakRows].sort(
//         (first, second) => getDateValue(first.startedAt) - getDateValue(second.startedAt)
//     );

//     return createPortal(
//         <div
//             className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/65 px-4 py-6 backdrop-blur-sm"
//             onMouseDown={(event) => {
//                 if (event.target === event.currentTarget) {
//                     onClose();
//                 }
//             }}
//         >
//             <section
//                 className="flex max-h-[88vh] w-full max-w-6xl flex-col overflow-hidden rounded-lg border border-slate-300 bg-white text-slate-950 shadow-2xl shadow-slate-950/30"
//                 role="dialog"
//                 aria-modal="true"
//                 aria-labelledby="attendance-shift-details-title"
//             >
//                 <div className="flex items-start justify-between gap-4 border-b border-slate-200 bg-slate-50 px-5 py-4">
//                     <div className="min-w-0">
//                         <p className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">Attendance Shift Details</p>
//                         <h3 id="attendance-shift-details-title" className="mt-1 truncate text-lg font-semibold text-slate-950">
//                             {formatDateOrDash(row.shiftDateValue)} Shift
//                         </h3>
//                         <p className="mt-1 text-sm text-slate-600">{getShiftLabel(row)}</p>
//                     </div>
//                     <button
//                         type="button"
//                         className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-slate-300 bg-white text-slate-700 transition hover:border-violet-500 hover:text-violet-700"
//                         onClick={onClose}
//                         aria-label="Close attendance shift details"
//                     >
//                         <FiX className="size-4" aria-hidden="true" />
//                     </button>
//                 </div>

//                 <div className="content-scroll overflow-y-auto p-5">
//                     <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
//                         <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
//                             <p className="text-[0.65rem] font-bold uppercase tracking-[0.12em] text-slate-500">Shift Window</p>
//                             <p className="mt-1 text-sm font-semibold text-slate-950">11PM to 8AM</p>
//                         </div>
//                         <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
//                             <p className="text-[0.65rem] font-bold uppercase tracking-[0.12em] text-slate-500">Records</p>
//                             <p className="mt-1 text-sm font-semibold text-slate-950">{formatNumber(row.records.length)}</p>
//                         </div>
//                         <div className="rounded-lg border border-violet-200 bg-violet-50 p-3 text-violet-700">
//                             <p className="text-[0.65rem] font-bold uppercase tracking-[0.12em] opacity-80">Late</p>
//                             <p className="mt-1 text-sm font-semibold">{formatNumber(row.lateRecords.length)}</p>
//                         </div>
//                         <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-amber-700">
//                             <p className="text-[0.65rem] font-bold uppercase tracking-[0.12em] opacity-80">Undertime</p>
//                             <p className="mt-1 text-sm font-semibold">{formatNumber(row.underTimeRecords.length)}</p>
//                         </div>
//                         <div className="rounded-lg border border-rose-200 bg-rose-50 p-3 text-rose-700">
//                             <p className="text-[0.65rem] font-bold uppercase tracking-[0.12em] opacity-80">Over Break</p>
//                             <p className="mt-1 text-sm font-semibold">{formatAttendanceDuration(row.totalOverBreakMs)}</p>
//                         </div>
//                     </div>

//                     <div className="mt-5 overflow-hidden rounded-lg border border-slate-300 bg-white">
//                         <div className="border-b border-slate-200 bg-slate-50 px-4 py-3">
//                             <p className="text-xs font-semibold uppercase tracking-[0.12em] text-slate-500">All Punches Inside This Shift</p>
//                         </div>
//                         <div className="overflow-x-auto">
//                             <table className="w-full min-w-[64rem] table-fixed border-separate border-spacing-0 text-left text-sm">
//                                 <colgroup>
//                                     <col className="w-[16%]" />
//                                     <col className="w-[12%]" />
//                                     <col className="w-[18%]" />
//                                     <col className="w-[18%]" />
//                                     <col className="w-[18%]" />
//                                     <col className="w-[18%]" />
//                                 </colgroup>
//                                 <thead className="bg-white text-[0.68rem] uppercase tracking-[0.12em] text-slate-500">
//                                     <tr>
//                                         <th className="px-3 py-3 font-semibold">Date</th>
//                                         <th className="px-3 py-3 font-semibold">Time</th>
//                                         <th className="px-3 py-3 font-semibold">Punch</th>
//                                         <th className="px-3 py-3 font-semibold">Attendance Status</th>
//                                         <th className="px-3 py-3 font-semibold">Issue</th>
//                                         <th className="px-3 py-3 font-semibold">Record ID</th>
//                                     </tr>
//                                 </thead>
//                                 <tbody className="divide-y divide-slate-200">
//                                     {chronologicalShiftRecords.map((record) => {
//                                         const statusText = getAttendanceStatusText(record);
//                                         const isLate = statusText.includes("late");
//                                         const isUnderTime = statusText.includes("under") || statusText.includes("undertime");
//                                         const overBreakRow = row.overBreakRows.find((item) => item.id === record._id);

//                                         return (
//                                             <tr key={record._id} className="text-slate-700">
//                                                 <td className="px-3 py-3 font-semibold text-slate-900">{formatDateOrDash(record.timeIn)}</td>
//                                                 <td className="px-3 py-3">{formatPhTime(record.timeIn)}</td>
//                                                 <td className="px-3 py-3 font-semibold text-slate-950">{record.source || "Attendance"}</td>
//                                                 <td className="px-3 py-3">{record.attendanceStatus || "No status"}</td>
//                                                 <td className="px-3 py-3">
//                                                     <div className="flex flex-wrap gap-1.5">
//                                                         {isLate && <span className="rounded-full bg-violet-100 px-2 py-1 text-[0.65rem] font-bold uppercase tracking-[0.08em] text-violet-700">Late</span>}
//                                                         {isUnderTime && <span className="rounded-full bg-amber-100 px-2 py-1 text-[0.65rem] font-bold uppercase tracking-[0.08em] text-amber-700">Undertime</span>}
//                                                         {overBreakRow && <span className="rounded-full bg-rose-100 px-2 py-1 text-[0.65rem] font-bold uppercase tracking-[0.08em] text-rose-700">Over Break</span>}
//                                                         {!isLate && !isUnderTime && !overBreakRow && <span className="text-xs font-semibold text-slate-400">None</span>}
//                                                     </div>
//                                                 </td>
//                                                 <td className="px-3 py-3 text-xs text-slate-500">{record._id}</td>
//                                             </tr>
//                                         );
//                                     })}
//                                 </tbody>
//                             </table>
//                         </div>
//                     </div>

//                     <div className="mt-5 rounded-lg border border-slate-300 bg-white p-4">
//                         <div className="flex flex-wrap items-center justify-between gap-3">
//                             <p className="text-xs font-semibold uppercase tracking-[0.12em] text-slate-500">Over Break Details</p>
//                             <span className="rounded-full bg-slate-100 px-2.5 py-1 text-[0.65rem] font-bold text-slate-500">Break 15m · Lunch 1h</span>
//                         </div>

//                         <div className="mt-3 space-y-2">
//                             {chronologicalOverBreakRows.map((item) => (
//                                 <article key={item.id} className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-3 text-sm text-rose-700">
//                                     <div className="flex flex-wrap items-start justify-between gap-3">
//                                         <div>
//                                             <p className="font-semibold text-rose-800">{item.label} over by {formatAttendanceDuration(item.overMs)}</p>
//                                             <p className="mt-1 text-xs">Used {formatAttendanceDuration(item.durationMs)} of {formatAttendanceDuration(item.allowedMs)}</p>
//                                             <p className="mt-1 text-xs text-slate-600">{formatPhDateTime(item.startedAt)} to {item.endedAt ? formatPhDateTime(item.endedAt) : "Open break"}</p>
//                                         </div>
//                                         <span className="rounded-full bg-white px-2 py-1 text-[0.65rem] font-bold uppercase tracking-[0.08em] text-rose-700">
//                                             {item.isOpen ? "Open" : "Closed"}
//                                         </span>
//                                     </div>
//                                 </article>
//                             ))}
//                             {row.overBreakRows.length === 0 && (
//                                 <p className="rounded-lg border border-dashed border-slate-300 bg-slate-50 p-4 text-sm text-slate-500">No over-break records for this shift.</p>
//                             )}
//                         </div>
//                     </div>
//                 </div>
//             </section>
//         </div>,
//         document.body
//     );
// }

// function AttendanceRecordDetailsModal({
//     record,
//     overBreakRow,
//     onClose,
// }: {
//     record: AttendanceRecord;
//     overBreakRow: AttendanceOverBreakRow | null;
//     onClose: () => void;
// }) {
//     const statusText = getAttendanceStatusText(record);
//     const isLate = statusText.includes("late");
//     const isUnderTime = statusText.includes("under") || statusText.includes("undertime");
//     const recordWithMeta = record as AttendanceRecord & {
//         createdAt?: string | null;
//         updatedAt?: string | null;
//         notes?: string | null;
//         remarks?: string | null;
//     };

//     return createPortal(
//         <div
//             className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/65 px-4 py-6 backdrop-blur-sm"
//             onMouseDown={(event) => {
//                 if (event.target === event.currentTarget) {
//                     onClose();
//                 }
//             }}
//         >
//             <section
//                 className="flex max-h-[86vh] w-full max-w-2xl flex-col overflow-hidden rounded-lg border border-slate-300 bg-white text-slate-950 shadow-2xl shadow-slate-950/30"
//                 role="dialog"
//                 aria-modal="true"
//                 aria-labelledby="attendance-record-details-title"
//             >
//                 <div className="flex items-start justify-between gap-4 border-b border-slate-200 bg-slate-50 px-5 py-4">
//                     <div className="min-w-0">
//                         <p className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">Attendance Record Details</p>
//                         <h3 id="attendance-record-details-title" className="mt-1 truncate text-lg font-semibold text-slate-950">
//                             {record.source || "Attendance"}
//                         </h3>
//                         <p className="mt-1 text-sm text-slate-600">{formatPhDateTime(record.timeIn)}</p>
//                     </div>
//                     <button
//                         type="button"
//                         className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-slate-300 bg-white text-slate-700 transition hover:border-violet-500 hover:text-violet-700"
//                         onClick={onClose}
//                         aria-label="Close attendance record details"
//                     >
//                         <FiX className="size-4" aria-hidden="true" />
//                     </button>
//                 </div>

//                 <div className="content-scroll overflow-y-auto p-5">
//                     <div className="grid gap-3 sm:grid-cols-2">
//                         <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
//                             <p className="text-[0.65rem] font-bold uppercase tracking-[0.12em] text-slate-500">Date</p>
//                             <p className="mt-1 text-sm font-semibold text-slate-950">{formatDateOrDash(record.timeIn)}</p>
//                         </div>
//                         <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
//                             <p className="text-[0.65rem] font-bold uppercase tracking-[0.12em] text-slate-500">Time</p>
//                             <p className="mt-1 text-sm font-semibold text-slate-950">{formatPhTime(record.timeIn)}</p>
//                         </div>
//                         <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
//                             <p className="text-[0.65rem] font-bold uppercase tracking-[0.12em] text-slate-500">Punch Type</p>
//                             <p className="mt-1 text-sm font-semibold text-slate-950">{record.source || "Attendance"}</p>
//                         </div>
//                         <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
//                             <p className="text-[0.65rem] font-bold uppercase tracking-[0.12em] text-slate-500">Attendance Status</p>
//                             <p className="mt-1 text-sm font-semibold text-slate-950">{record.attendanceStatus || "No status"}</p>
//                         </div>
//                     </div>

//                     <div className="mt-4 rounded-lg border border-slate-200 bg-white p-3">
//                         <p className="text-[0.65rem] font-bold uppercase tracking-[0.12em] text-slate-500">Flags</p>
//                         <div className="mt-2 flex flex-wrap gap-2">
//                             {isLate && <span className="rounded-full bg-violet-100 px-2.5 py-1 text-xs font-bold text-violet-700">Late</span>}
//                             {isUnderTime && <span className="rounded-full bg-amber-100 px-2.5 py-1 text-xs font-bold text-amber-700">Undertime</span>}
//                             {overBreakRow && <span className="rounded-full bg-rose-100 px-2.5 py-1 text-xs font-bold text-rose-700">Over Break</span>}
//                             {!isLate && !isUnderTime && !overBreakRow && <span className="text-sm font-semibold text-slate-500">No issues found for this record.</span>}
//                         </div>
//                     </div>

//                     {overBreakRow && (
//                         <div className="mt-4 rounded-lg border border-rose-200 bg-rose-50 p-3 text-rose-800">
//                             <p className="text-[0.65rem] font-bold uppercase tracking-[0.12em]">Over Break Details</p>
//                             <div className="mt-3 grid gap-3 sm:grid-cols-2">
//                                 <div>
//                                     <p className="text-xs font-semibold opacity-80">Break Type</p>
//                                     <p className="text-sm font-semibold">{overBreakRow.label}</p>
//                                 </div>
//                                 <div>
//                                     <p className="text-xs font-semibold opacity-80">Over By</p>
//                                     <p className="text-sm font-semibold">{formatAttendanceDuration(overBreakRow.overMs)}</p>
//                                 </div>
//                                 <div>
//                                     <p className="text-xs font-semibold opacity-80">Used Time</p>
//                                     <p className="text-sm font-semibold">{formatAttendanceDuration(overBreakRow.durationMs)}</p>
//                                 </div>
//                                 <div>
//                                     <p className="text-xs font-semibold opacity-80">Allowed Time</p>
//                                     <p className="text-sm font-semibold">{formatAttendanceDuration(overBreakRow.allowedMs)}</p>
//                                 </div>
//                                 <div>
//                                     <p className="text-xs font-semibold opacity-80">Started</p>
//                                     <p className="text-sm font-semibold">{formatPhDateTime(overBreakRow.startedAt)}</p>
//                                 </div>
//                                 <div>
//                                     <p className="text-xs font-semibold opacity-80">Ended</p>
//                                     <p className="text-sm font-semibold">{overBreakRow.endedAt ? formatPhDateTime(overBreakRow.endedAt) : "Still running"}</p>
//                                 </div>
//                             </div>
//                         </div>
//                     )}

//                     <div className="mt-4 rounded-lg border border-slate-200 bg-slate-50 p-3">
//                         <p className="text-[0.65rem] font-bold uppercase tracking-[0.12em] text-slate-500">Other Details</p>
//                         <dl className="mt-3 grid gap-3 text-sm sm:grid-cols-2">
//                             <div>
//                                 <dt className="text-xs font-semibold text-slate-500">Record ID</dt>
//                                 <dd className="mt-1 break-all font-semibold text-slate-800">{record._id}</dd>
//                             </div>
//                             <div>
//                                 <dt className="text-xs font-semibold text-slate-500">Created At</dt>
//                                 <dd className="mt-1 font-semibold text-slate-800">{recordWithMeta.createdAt ? formatPhDateTime(recordWithMeta.createdAt) : "No date"}</dd>
//                             </div>
//                             <div>
//                                 <dt className="text-xs font-semibold text-slate-500">Updated At</dt>
//                                 <dd className="mt-1 font-semibold text-slate-800">{recordWithMeta.updatedAt ? formatPhDateTime(recordWithMeta.updatedAt) : "No date"}</dd>
//                             </div>
//                             <div>
//                                 <dt className="text-xs font-semibold text-slate-500">Remarks</dt>
//                                 <dd className="mt-1 font-semibold text-slate-800">{recordWithMeta.remarks || recordWithMeta.notes || "No remarks"}</dd>
//                             </div>
//                         </dl>
//                     </div>
//                 </div>
//             </section>
//         </div>,
//         document.body
//     );
// }

// type EmployeeLeadCallRow = {
//     leadId: string;
//     leadName: string;
//     businessName: string;
//     callCount: number;
//     callNotConnectedCount: number;
//     totalAttempts: number;
//     lastCallAt: string | null;
//     callLogs: NonNullable<LeadCallStat["callLogs"]>;
// };

// type EmployeeCallSummaryRow = {
//     employeeId: string;
//     employeeName: string;
//     employeeRole: string;
//     employeeTeam: string;
//     totalCalls: number;
//     totalNotConnectedCalls: number;
//     totalAttempts: number;
//     lastCallAt: string | null;
//     leads: EmployeeLeadCallRow[];
// };

// function getDateTimeValue(value?: string | null) {
//     const timestamp = value ? new Date(value).getTime() : 0;
//     return Number.isNaN(timestamp) ? 0 : timestamp;
// }

// function getLatestDateValue(first?: string | null, second?: string | null) {
//     return getDateTimeValue(first) >= getDateTimeValue(second) ? first || null : second || null;
// }

// function getLeadCallStatLeadId(item: LeadCallStat) {
//     if (typeof item.lead === "string") {
//         return item.lead;
//     }

//     return item.lead?._id || item._id || `${item.leadName}-${item.businessName}`;
// }

// function getCallLogEmployeeId(log: LeadCallStat["callLogs"][number]) {
//     if (typeof log.employee === "string") {
//         return log.employee;
//     }

//     return log.employee?._id || "";
// }

// function buildEmployeeCallRows(leadCallStats: LeadCallStat[]): EmployeeCallSummaryRow[] {
//     const rowsByEmployee = new Map<string, EmployeeCallSummaryRow>();

//     leadCallStats.forEach((item) => {
//         const leadId = getLeadCallStatLeadId(item);
//         const leadName = item.leadName || "No lead name";
//         const businessName = item.businessName || "No business name";

//         (item.callLogs || []).forEach((log) => {
//             const employeeId =
//                 getCallLogEmployeeId(log) ||
//                 `employee-name:${String(log.employeeName || "Employee").trim().toLowerCase()}`;

//             if (!employeeId) {
//                 return;
//             }

//             const outcome = log.outcome === "not_connected" ? "not_connected" : "connected";
//             const calledAt = log.calledAt || item.lastCallAt || null;

//             if (!rowsByEmployee.has(employeeId)) {
//                 rowsByEmployee.set(employeeId, {
//                     employeeId,
//                     employeeName: log.employeeName || "Employee",
//                     employeeRole: log.employeeRole || "",
//                     employeeTeam: log.employeeTeam || "",
//                     totalCalls: 0,
//                     totalNotConnectedCalls: 0,
//                     totalAttempts: 0,
//                     lastCallAt: null,
//                     leads: [],
//                 });
//             }

//             const employeeRow = rowsByEmployee.get(employeeId)!;

//             employeeRow.employeeName = log.employeeName || employeeRow.employeeName;
//             employeeRow.employeeRole = log.employeeRole || employeeRow.employeeRole;
//             employeeRow.employeeTeam = log.employeeTeam || employeeRow.employeeTeam;
//             employeeRow.totalAttempts += 1;
//             employeeRow.lastCallAt = getLatestDateValue(employeeRow.lastCallAt, calledAt);

//             if (outcome === "not_connected") {
//                 employeeRow.totalNotConnectedCalls += 1;
//             } else {
//                 employeeRow.totalCalls += 1;
//             }

//             let leadRow = employeeRow.leads.find((lead) => lead.leadId === leadId);

//             if (!leadRow) {
//                 leadRow = {
//                     leadId,
//                     leadName,
//                     businessName,
//                     callCount: 0,
//                     callNotConnectedCount: 0,
//                     totalAttempts: 0,
//                     lastCallAt: null,
//                     callLogs: [],
//                 };

//                 employeeRow.leads.push(leadRow);
//             }

//             leadRow.totalAttempts += 1;
//             leadRow.lastCallAt = getLatestDateValue(leadRow.lastCallAt, calledAt);
//             leadRow.callLogs.push(log);

//             if (outcome === "not_connected") {
//                 leadRow.callNotConnectedCount += 1;
//             } else {
//                 leadRow.callCount += 1;
//             }
//         });
//     });

//     return Array.from(rowsByEmployee.values())
//         .map((employeeRow) => ({
//             ...employeeRow,
//             leads: employeeRow.leads.sort(
//                 (first, second) =>
//                     getDateTimeValue(second.lastCallAt) - getDateTimeValue(first.lastCallAt)
//             ),
//         }))
//         .sort(
//             (first, second) =>
//                 getDateTimeValue(second.lastCallAt) - getDateTimeValue(first.lastCallAt)
//         );
// }

// function getDateStart(value: string) {
//     const date = parseDateInputValue(value);

//     if (!date) {
//         return null;
//     }

//     date.setHours(0, 0, 0, 0);
//     return date;
// }

// function getDateEnd(value: string) {
//     const date = parseDateInputValue(value);

//     if (!date) {
//         return null;
//     }

//     date.setHours(23, 59, 59, 999);
//     return date;
// }

// function isCallLogWithinDateRange(
//     calledAt: string | undefined,
//     dateFrom: string,
//     dateTo: string
// ) {
//     if (!calledAt) {
//         return false;
//     }

//     const calledTime = new Date(calledAt).getTime();

//     if (Number.isNaN(calledTime)) {
//         return false;
//     }

//     const startDate = getDateStart(dateFrom);
//     const endDate = getDateEnd(dateTo);

//     if (startDate && calledTime < startDate.getTime()) {
//         return false;
//     }

//     if (endDate && calledTime > endDate.getTime()) {
//         return false;
//     }

//     return true;
// }

// function filterLeadCallStatsByDateRange(
//     leadCallStats: LeadCallStat[],
//     dateFrom: string,
//     dateTo: string
// ) {
//     return leadCallStats
//         .map((item) => {
//             const filteredCallLogs = (item.callLogs || []).filter((log) =>
//                 isCallLogWithinDateRange(log.calledAt, dateFrom, dateTo)
//             );

//             const connectedLogs = filteredCallLogs.filter(
//                 (log) => (log.outcome || "connected") === "connected"
//             );

//             const notConnectedLogs = filteredCallLogs.filter(
//                 (log) => log.outcome === "not_connected"
//             );

//             const latestLog = [...filteredCallLogs].sort((first, second) => {
//                 const firstTime = first.calledAt ? new Date(first.calledAt).getTime() : 0;
//                 const secondTime = second.calledAt ? new Date(second.calledAt).getTime() : 0;

//                 return secondTime - firstTime;
//             })[0];

//             return {
//                 ...item,
//                 callLogs: filteredCallLogs,
//                 callCount: connectedLogs.length,
//                 callNotConnectedCount: notConnectedLogs.length,
//                 lastCallAt: latestLog?.calledAt || null,
//             };
//         })
//         .filter((item) => item.callLogs.length > 0);
// }

// export default function AdminDashboard() {
//     const [selectedActivity, setSelectedActivity] = useState<AgentLeadActivity | null>(null);
//     const [qualifiedLeadRow, setQualifiedLeadRow] = useState<AgentLeadMonthlyRow | null>(null);
//     const [selectedMonth, setSelectedMonth] = useState(() => getMonthInputValue(new Date()));
//     const [isMonthMenuOpen, setIsMonthMenuOpen] = useState(false);
//     const [callCountRange, setCallCountRange] = useState<CallCountRange>("day");
//     const [selectedCallDate, setSelectedCallDate] = useState(() => formatDateInputValue(new Date()));
//     const [selectedCallEmployeeId, setSelectedCallEmployeeId] = useState("all");
//     const [selectedAttendanceEmployeeId, setSelectedAttendanceEmployeeId] = useState("");
//     const [attendanceEmployeeSearch, setAttendanceEmployeeSearch] = useState("");
//     const [isAttendanceEmployeeMenuOpen, setIsAttendanceEmployeeMenuOpen] = useState(false);
//     const [isAttendanceSelectionCleared, setIsAttendanceSelectionCleared] = useState(false);
//     const [agentPage, setAgentPage] = useState(1);
//     const [monthlyPage, setMonthlyPage] = useState(1);
//     const selectedMonthlyRange = useMemo(() => getMonthlyDashboardDateRange(selectedMonth), [selectedMonth]);
//     const monthlyRangeLabel = useMemo(() => formatDateRangeLabel(selectedMonthlyRange.dateFrom, selectedMonthlyRange.dateTo), [selectedMonthlyRange]);
//     const { data, isLoading, isError, refetch, isFetching } = useQuery({
//         queryKey: ["agent-lead-dashboard", selectedMonth, selectedMonthlyRange.dateFrom, selectedMonthlyRange.dateTo, selectedCallDate],
//         queryFn: () => getAgentLeadDashboard({ month: selectedMonth, dateFrom: selectedMonthlyRange.dateFrom, dateTo: selectedMonthlyRange.dateTo, callDate: selectedCallDate }),
//         refetchInterval: 60_000,
//     });
//     const employeesQuery = useQuery({
//         queryKey: ["employees", "summary", "dashboard-online-status"],
//         queryFn: getEmployeeSummaries,
//         refetchInterval: 60_000,
//     });
//     const attendanceEmployeeOptions = useMemo(() => {
//         return (employeesQuery.data || [])
//             .filter((employee) => !isArchivedEmployee(employee))
//             .sort((first, second) => (first.name || first.employeeCode || "").localeCompare(second.name || second.employeeCode || ""));
//     }, [employeesQuery.data]);
//     const effectiveAttendanceEmployeeId = isAttendanceSelectionCleared ? "" : selectedAttendanceEmployeeId || attendanceEmployeeOptions[0]?._id || "";
//     const selectedAttendanceEmployee = attendanceEmployeeOptions.find((employee) => employee._id === effectiveAttendanceEmployeeId) || null;
//     const selectedAttendanceEmployeeLabel = selectedAttendanceEmployee?.name || selectedAttendanceEmployee?.employeeCode || "Select employee";
//     const filteredAttendanceEmployeeOptions = useMemo(() => {
//         const searchValue = attendanceEmployeeSearch.trim().toLowerCase();

//         if (!searchValue) {
//             return attendanceEmployeeOptions;
//         }

//         return attendanceEmployeeOptions.filter((employee) => {
//             const searchableText = [
//                 employee.name,
//                 employee.employeeCode,
//                 employee.role,
//                 employee.team,
//                 ...(employee.aliases || []),
//             ]
//                 .filter(Boolean)
//                 .join(" ")
//                 .toLowerCase();

//             return searchableText.includes(searchValue);
//         });
//     }, [attendanceEmployeeOptions, attendanceEmployeeSearch]);
//     const attendanceRecordsQuery = useQuery({
//         queryKey: ["admin-dashboard-attendance-records", effectiveAttendanceEmployeeId],
//         queryFn: () => getEmployeeAttendance(effectiveAttendanceEmployeeId),
//         enabled: Boolean(effectiveAttendanceEmployeeId),
//         refetchInterval: 60_000,
//     });
//     const selectedLeadId = selectedActivity?.leadId || "";
//     const leadHistoryQuery = useQuery({
//         queryKey: ["dashboard-lead-history", selectedLeadId],
//         queryFn: () => getLead(selectedLeadId),
//         enabled: Boolean(selectedLeadId),
//     });
//     const agents = useMemo(() => mergeAgentProgressRows(data?.agents || []), [data?.agents]);
//     const monthlyAgents = useMemo(() => mergeAgentMonthlyRows(data?.monthlyAgents || []), [data?.monthlyAgents]);
//     const summary = data?.summary;
//     const totalAgentPages = Math.max(Math.ceil(agents.length / agentRowsPerPage), 1);
//     const currentAgentPage = Math.min(agentPage, totalAgentPages);
//     const visibleAgents = useMemo(() => {
//         const startIndex = (currentAgentPage - 1) * agentRowsPerPage;

//         return agents.slice(startIndex, startIndex + agentRowsPerPage);
//     }, [agents, currentAgentPage]);
//     const agentPageNumbers = getPaginationNumbers(currentAgentPage, totalAgentPages);
//     const agentPageStart = agents.length === 0 ? 0 : (currentAgentPage - 1) * agentRowsPerPage + 1;
//     const agentPageEnd = Math.min(currentAgentPage * agentRowsPerPage, agents.length);
//     const totalMonthlyPages = Math.max(Math.ceil(monthlyAgents.length / monthlyRowsPerPage), 1);
//     const currentMonthlyPage = Math.min(monthlyPage, totalMonthlyPages);
//     const visibleMonthlyAgents = useMemo(() => {
//         const startIndex = (currentMonthlyPage - 1) * monthlyRowsPerPage;

//         return monthlyAgents.slice(startIndex, startIndex + monthlyRowsPerPage);
//     }, [monthlyAgents, currentMonthlyPage]);
//     const monthlyPageNumbers = getPaginationNumbers(currentMonthlyPage, totalMonthlyPages);
//     const monthlyPageStart = monthlyAgents.length === 0 ? 0 : (currentMonthlyPage - 1) * monthlyRowsPerPage + 1;
//     const monthlyPageEnd = Math.min(currentMonthlyPage * monthlyRowsPerPage, monthlyAgents.length);
//     const topAgents = agents.slice(0, 5);
//     const onlineStatusAgents = useMemo(() => {
//         if (employeesQuery.data) {
//             return buildOnlineStatusRows(employeesQuery.data, agents);
//         }

//         return [...agents].sort((first, second) => {
//             const rankDifference = availabilitySortRank(first.availabilityStatus) - availabilitySortRank(second.availabilityStatus);

//             if (rankDifference !== 0) return rankDifference;

//             return first.employeeName.localeCompare(second.employeeName);
//         });
//     }, [agents, employeesQuery.data]);
//     const availableAgentCount = onlineStatusAgents.filter(
//         (agent) => normalizeEmployeeAvailabilityStatus(agent.availabilityStatus) !== "OFFLINE"
//     ).length;
//     const leadHistory = useMemo(() => getLeadHistory(leadHistoryQuery.data), [leadHistoryQuery.data]);
//     const pipelineTotals = useMemo(() => {
//         return agents.reduce(
//             (totals, agent) => ({
//                 total: totals.total + agent.newLeads + agent.followUps + agent.qualified + agent.dead,
//                 newLeads: totals.newLeads + agent.newLeads,
//                 followUps: totals.followUps + agent.followUps,
//                 qualified: totals.qualified + agent.qualified,
//                 dead: totals.dead + agent.dead,
//             }),
//             { total: 0, newLeads: 0, followUps: 0, qualified: 0, dead: 0 }
//         );
//     }, [agents]);
//     const pipelineBars = [
//         { label: "NEW", value: pipelineTotals.newLeads, color: "bg-slate-400" },
//         { label: "FOLLOW UP", value: pipelineTotals.followUps, color: "bg-violet-500" },
//         { label: "QUALIFIED", value: pipelineTotals.qualified, color: "bg-emerald-500" },
//         { label: "ARCHIVE/DEAD", value: pipelineTotals.dead, color: "bg-red-400" },
//     ];
//     const maxPipelineValue = Math.max(...pipelineBars.map((item) => item.value), 1);
//     const monthlyTotals = useMemo(() => {
//         return monthlyAgents.reduce(
//             (totals, row) => ({
//                 leadsAdded: totals.leadsAdded + row.leadsAdded,
//                 calls: totals.calls + (row.calls || 0),
//                 comments: totals.comments + row.comments,
//                 touchedLeads: totals.touchedLeads + row.touchedLeads,
//                 productivityScore: totals.productivityScore + row.productivityScore,
//             }),
//             { leadsAdded: 0, calls: 0, comments: 0, touchedLeads: 0, productivityScore: 0 }
//         );
//     }, [monthlyAgents]);
//     const dailyCallCount = summary?.callsToday ?? agents.reduce((total, agent) => total + (agent.callsToday || 0), 0);
//     const callEmployeeOptions = useMemo(() => {
//         const optionsById = new Map<string, { id: string; name: string }>();
//         const addOption = (id?: string, name?: string) => {
//             const normalizedId = String(id || "").trim();
//             const normalizedName = String(name || "").trim();

//             if (!normalizedId || !normalizedName || optionsById.has(normalizedId)) return;

//             optionsById.set(normalizedId, { id: normalizedId, name: normalizedName });
//         };

//         agents.forEach((agent) => addOption(agent.employeeId, agent.employeeName));
//         monthlyAgents.forEach((agent) => addOption(agent.employeeId, agent.employeeName));

//         return Array.from(optionsById.values()).sort((first, second) => first.name.localeCompare(second.name));
//     }, [agents, monthlyAgents]);
//     const selectedDailyCallCount = selectedCallEmployeeId === "all"
//         ? dailyCallCount
//         : agents.find((agent) => agent.employeeId === selectedCallEmployeeId)?.callsToday || 0;
//     const selectedMonthlyCallCount = selectedCallEmployeeId === "all"
//         ? monthlyTotals.calls
//         : monthlyAgents.find((agent) => agent.employeeId === selectedCallEmployeeId)?.calls || 0;
//     const selectedCallCount = callCountRange === "day" ? selectedDailyCallCount : selectedMonthlyCallCount;
//     const selectedCallEmployeeName = selectedCallEmployeeId === "all"
//         ? "All employees"
//         : callEmployeeOptions.find((employee) => employee.id === selectedCallEmployeeId)?.name || "Selected employee";
//     const selectedCallHelper = callCountRange === "day"
//         ? `${selectedCallEmployeeName} · calls logged ${formatSingleDateLabel(selectedCallDate)}`
//         : `${selectedCallEmployeeName} · calls logged ${monthlyRangeLabel}`;
//     const monthOptions = useMemo(() => {
//         return Array.from(new Set([selectedMonth, data?.selectedMonth || "", ...(data?.monthOptions || [])]))
//             .filter(Boolean)
//             .sort((first, second) => second.localeCompare(first));
//     }, [data?.monthOptions, data?.selectedMonth, selectedMonth]);
//     const handleExportMonthlyData = () => {
//         const rows = [
//             ["Date Range", "Agent", "Role", "Team", "Added", "Follow Up", "Calls", "Qualified", "Archive/Dead", "Comments", "Touched", "Score", "Last Activity"],
//             ...monthlyAgents.map((row) => [
//                 monthlyRangeLabel,
//                 row.employeeName,
//                 row.role,
//                 row.team,
//                 row.leadsAdded,
//                 row.followUps,
//                 row.calls || 0,
//                 row.qualified,
//                 row.archiveDead,
//                 row.comments,
//                 row.touchedLeads,
//                 row.productivityScore,
//                 row.lastActivityAt ? formatPhDateTime(row.lastActivityAt) : "",
//             ]),
//             [
//                 monthlyRangeLabel,
//                 "Total",
//                 "",
//                 "",
//                 monthlyTotals.leadsAdded,
//                 "",
//                 monthlyTotals.calls,
//                 "",
//                 "",
//                 monthlyTotals.comments,
//                 monthlyTotals.touchedLeads,
//                 monthlyTotals.productivityScore,
//                 "",
//             ],
//         ];

//         downloadCsv(`agent-monthly-data-${selectedMonthlyRange.dateFrom}-to-${selectedMonthlyRange.dateTo}.csv`, rows);
//     };

//     const leadCallStatsQuery = useQuery({
//         queryKey: ["lead-call-stats"],
//         queryFn: () => getLeadCallStats(100),
//         refetchInterval: 60_000,
//     });

//     const leadCallStats = leadCallStatsQuery.data || [];
//     const selectedAttendanceRecords = attendanceRecordsQuery.data || [];

//     const [selectedCallEmployeeRow, setSelectedCallEmployeeRow] = useState<EmployeeCallSummaryRow | null>(null);

//     const [callFilterDateFrom, setCallFilterDateFrom] = useState(() =>
//         formatDateInputValue(new Date())
//     );

//     const [callFilterDateTo, setCallFilterDateTo] = useState(() =>
//         formatDateInputValue(new Date())
//     );

//     const filteredLeadCallStats = useMemo(() => {
//         return filterLeadCallStatsByDateRange(
//             leadCallStats,
//             callFilterDateFrom,
//             callFilterDateTo
//         );
//     }, [leadCallStats, callFilterDateFrom, callFilterDateTo]);

//     const employeeCallRows = useMemo(() => {
//         return buildEmployeeCallRows(filteredLeadCallStats);
//     }, [filteredLeadCallStats]);

//     const totalLoggedLeadCalls = useMemo(() => {
//         return employeeCallRows.reduce((total, item) => total + item.totalCalls, 0);
//     }, [employeeCallRows]);

//     const totalNotConnectedCalls = useMemo(() => {
//         return employeeCallRows.reduce(
//             (total, item) => total + item.totalNotConnectedCalls,
//             0
//         );
//     }, [employeeCallRows]);

//     return (
//         <AdminLayout>
//             <section className="admin-dashboard-page min-h-full space-y-5">
//                 <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
//                     <div>
//                         <p className="text-xs font-semibold uppercase tracking-[0.16em] text-white/45">Admin Dashboard</p>
//                         <h2 className="mt-1 text-2xl font-semibold text-white">Agent Lead Progress</h2>
//                         <p className="mt-1 text-sm text-white/55">Live lead workload, movement, and productivity using PH time for today.</p>
//                     </div>
//                     <div className="flex flex-wrap items-center gap-2">
//                         <span className="rounded-lg border border-white/10 bg-white/[0.05] px-3 py-2 text-xs font-semibold text-white/55">
//                             Updated {data?.generatedAt ? formatPhDateTime(data.generatedAt) : "loading"}
//                         </span>
//                         <button
//                             className="inline-flex h-10 items-center gap-2 rounded-lg border border-white/10 bg-white px-3 text-sm font-semibold text-slate-950 transition hover:bg-slate-100 disabled:opacity-60"
//                             type="button"
//                             onClick={() => void refetch()}
//                             disabled={isFetching}
//                         >
//                             <FiRefreshCw className={["size-4", isFetching ? "animate-spin" : ""].join(" ")} aria-hidden="true" />
//                             Refresh
//                         </button>
//                     </div>
//                 </div>

//                 <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
//                     <KpiCard label="Active Agents" value={formatNumber(summary?.totalActiveAgents)} helper={`${formatNumber(summary?.onlineAgents)} online or available now`} icon={FiUsers} accent="green" />
//                     <KpiCard label="Open Leads" value={formatNumber(summary?.totalOpenLeads)} helper={`${formatNumber(summary?.unassignedLeads)} still unassigned`} icon={FiTarget} accent="blue" />
//                     <KpiCard label="Due Follow-ups" value={formatNumber(summary?.dueFollowUps)} helper={`${formatNumber(summary?.touchedLeadsToday)} leads touched today`} icon={FiClock} accent="orange" />
//                     <KpiCard label="Productivity Today" value={formatNumber(summary?.activityToday)} helper={`${formatNumber(summary?.commentsToday)} employee comments logged`} icon={FiTrendingUp} accent="purple" />
//                 </div>

//                 {isError && (
//                     <section className="rounded-lg border border-red-200 bg-red-50 p-4 text-red-700">
//                         <p className="font-semibold">Dashboard data could not load.</p>
//                         <p className="mt-1 text-sm">Please refresh after the backend is running.</p>
//                     </section>
//                 )}

//                 <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_18rem] 2xl:grid-cols-[minmax(0,1fr)_20rem]">
//                     <section className="dashboard-panel-accent dashboard-accent-green overflow-hidden rounded-lg border border-slate-300 bg-white text-slate-950 shadow-lg shadow-slate-950/10">
//                         <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-300 bg-slate-50 px-4 py-4">
//                             <div>
//                                 <p className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">Agent Productivity</p>
//                                 <h3 className="mt-1 text-base font-semibold">Lead progress by agent</h3>
//                             </div>
//                             <Link className="inline-flex h-9 items-center gap-2 rounded-lg bg-[#842cff] px-3 text-sm font-semibold text-white transition hover:brightness-110" to="/admin/leads">
//                                 <FiTarget className="size-4" aria-hidden="true" />
//                                 Manage Leads
//                             </Link>
//                         </div>
//                         <div className="overflow-x-auto">
//                             <table className="w-full min-w-[50rem] table-fixed border-separate border-spacing-0">
//                                 <colgroup>
//                                     <col className="w-[35%]" />
//                                     <col className="w-[9%]" />
//                                     <col className="w-[8%]" />
//                                     <col className="w-[13%]" />
//                                     <col className="w-[9%]" />
//                                     <col className="w-[12%]" />
//                                     <col className="w-[14%]" />
//                                 </colgroup>
//                                 <thead className="bg-white text-[0.68rem] uppercase tracking-[0.12em] text-slate-500">
//                                     <tr>
//                                         <th className="px-3 py-3 text-left font-semibold">Agent</th>
//                                         <th className="px-3 py-3 text-center font-semibold">Total</th>
//                                         <th className="px-3 py-3 text-center font-semibold">NEW</th>
//                                         <th className="px-3 py-3 text-center font-semibold">FOLLOW UP</th>
//                                         <th className="px-3 py-3 text-center font-semibold">CALLS</th>
//                                         <th className="px-3 py-3 text-center font-semibold">QUALIFIED</th>
//                                         <th className="px-3 py-3 text-center font-semibold">ARCHIVE/DEAD</th>
//                                     </tr>
//                                 </thead>
//                                 <tbody className="divide-y divide-slate-200">
//                                     {isLoading && (
//                                         <tr>
//                                             <td className="px-4 py-8 text-center text-sm text-slate-500" colSpan={7}>Loading agent metrics...</td>
//                                         </tr>
//                                     )}
//                                     {!isLoading && agents.length === 0 && (
//                                         <tr>
//                                             <td className="px-4 py-8" colSpan={7}>
//                                                 <EmptyPanel title="No agent lead data yet" message="Agents will appear here after they have lead assignments or lead activity." />
//                                             </td>
//                                         </tr>
//                                     )}
//                                     {visibleAgents.map((agent) => <AgentProgressRow key={agent.employeeId} agent={agent} />)}
//                                     {!isLoading && visibleAgents.length > 0 && visibleAgents.length < agentRowsPerPage && Array.from({ length: agentRowsPerPage - visibleAgents.length }).map((_, index) => (
//                                         <tr key={`agent-placeholder-${index}`} aria-hidden="true" className="pointer-events-none">
//                                             <td className="h-[4.5rem] px-3 py-0" colSpan={7} />
//                                         </tr>
//                                     ))}
//                                 </tbody>
//                             </table>
//                         </div>
//                         {!isLoading && agents.length > 0 && (
//                             <div className="flex flex-col gap-3 border-t border-slate-300 bg-white px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
//                                 <p className="text-xs font-semibold text-slate-500">
//                                     Showing {agentPageStart} to {agentPageEnd} of {formatNumber(agents.length)} agents
//                                 </p>
//                                 <div className="flex items-center gap-1">
//                                     <button
//                                         type="button"
//                                         className="flex size-8 items-center justify-center rounded-lg border border-slate-300 bg-white text-slate-500 transition hover:border-[#842cff] hover:text-[#6426d9] disabled:cursor-not-allowed disabled:opacity-40"
//                                         onClick={() => setAgentPage((page) => Math.max(page - 1, 1))}
//                                         disabled={currentAgentPage === 1}
//                                         aria-label="Previous agent page"
//                                     >
//                                         <FiChevronLeft className="size-4" aria-hidden="true" />
//                                     </button>
//                                     {agentPageNumbers.map((page, index) => {
//                                         const previousPage = agentPageNumbers[index - 1];
//                                         const hasGap = previousPage && page - previousPage > 1;

//                                         return (
//                                             <span key={page} className="flex items-center gap-1">
//                                                 {hasGap && <span className="px-1 text-xs font-semibold text-slate-400">...</span>}
//                                                 <button
//                                                     type="button"
//                                                     className={[
//                                                         "flex size-8 items-center justify-center rounded-lg border text-sm font-semibold transition",
//                                                         currentAgentPage === page
//                                                             ? "border-[#842cff] bg-[#842cff] text-white"
//                                                             : "border-slate-300 bg-white text-slate-600 hover:border-[#842cff] hover:text-[#6426d9]",
//                                                     ].join(" ")}
//                                                     onClick={() => setAgentPage(page)}
//                                                     aria-label={`Agent page ${page}`}
//                                                     aria-current={currentAgentPage === page ? "page" : undefined}
//                                                 >
//                                                     {page}
//                                                 </button>
//                                             </span>
//                                         );
//                                     })}
//                                     <button
//                                         type="button"
//                                         className="flex size-8 items-center justify-center rounded-lg border border-slate-300 bg-white text-slate-500 transition hover:border-[#842cff] hover:text-[#6426d9] disabled:cursor-not-allowed disabled:opacity-40"
//                                         onClick={() => setAgentPage((page) => Math.min(page + 1, totalAgentPages))}
//                                         disabled={currentAgentPage === totalAgentPages}
//                                         aria-label="Next agent page"
//                                     >
//                                         <FiChevronRight className="size-4" aria-hidden="true" />
//                                     </button>
//                                 </div>
//                             </div>
//                         )}
//                         <div className="dashboard-panel-accent dashboard-accent-indigo border-t border-slate-300 bg-slate-50/80 px-4 py-4">
//                             <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
//                                 <div>
//                                     <p className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">Monthly Data</p>
//                                     <h3 className="mt-1 text-base font-semibold text-slate-900">Agent activity for {monthlyRangeLabel}</h3>
//                                 </div>
//                                 <div className="flex flex-wrap items-center gap-2">
//                                     <span className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-semibold text-slate-600">
//                                         {formatNumber(monthlyTotals.touchedLeads)} touched · {formatNumber(monthlyTotals.calls)} calls · {formatNumber(monthlyTotals.comments)} comments
//                                     </span>
//                                     <button
//                                         type="button"
//                                         className="inline-flex h-10 items-center gap-2 rounded-lg border border-slate-300 bg-white px-3 text-sm font-semibold text-slate-800 shadow-sm transition hover:border-[#842cff] hover:text-[#6426d9] disabled:cursor-not-allowed disabled:opacity-55"
//                                         onClick={handleExportMonthlyData}
//                                         disabled={monthlyAgents.length === 0}
//                                     >
//                                         <FiDownload className="size-4" aria-hidden="true" />
//                                         Export
//                                     </button>
//                                     <div
//                                         className="relative"
//                                         onBlur={(event) => {
//                                             if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
//                                                 setIsMonthMenuOpen(false);
//                                             }
//                                         }}
//                                     >
//                                         <button
//                                             type="button"
//                                             className="flex h-10 min-w-[12rem] items-center justify-between gap-3 rounded-lg border border-slate-300 bg-white px-3 text-left text-sm font-semibold text-slate-800 shadow-sm transition hover:border-[#842cff] focus:outline-none focus:ring-2 focus:ring-[#842cff]/30"
//                                             onClick={() => setIsMonthMenuOpen((isOpen) => !isOpen)}
//                                             aria-haspopup="menu"
//                                             aria-expanded={isMonthMenuOpen}
//                                         >
//                                             <span className="flex min-w-0 items-center gap-2">
//                                                 <FiCalendar className="size-4 shrink-0 text-[#842cff]" aria-hidden="true" />
//                                                 <span className="truncate">{formatMonthLabel(selectedMonth)}</span>
//                                             </span>
//                                             <FiChevronDown className={["size-4 shrink-0 text-slate-500 transition", isMonthMenuOpen ? "rotate-180" : ""].join(" ")} aria-hidden="true" />
//                                         </button>
//                                         {isMonthMenuOpen && (
//                                             <div className="absolute right-0 z-20 mt-2 max-h-72 w-full overflow-y-auto rounded-lg border border-slate-300 bg-white p-1 text-sm shadow-xl shadow-slate-950/15" role="menu">
//                                                 {monthOptions.map((month) => {
//                                                     const isSelected = month === selectedMonth;

//                                                     return (
//                                                         <button
//                                                             key={month}
//                                                             type="button"
//                                                             className={[
//                                                                 "flex w-full items-center justify-between rounded-md px-3 py-2 text-left font-semibold transition",
//                                                                 isSelected ? "bg-[#842cff] text-white" : "text-slate-700 hover:bg-violet-50 hover:text-[#6426d9]",
//                                                             ].join(" ")}
//                                                             onClick={() => {
//                                                                 setSelectedMonth(month);
//                                                                 setMonthlyPage(1);
//                                                                 setIsMonthMenuOpen(false);
//                                                             }}
//                                                             role="menuitemradio"
//                                                             aria-checked={isSelected}
//                                                         >
//                                                             <span>{formatMonthLabel(month)}</span>
//                                                             {isSelected && <span className="text-xs text-white/80">Selected</span>}
//                                                         </button>
//                                                     );
//                                                 })}
//                                             </div>
//                                         )}
//                                     </div>
//                                 </div>
//                             </div>
//                             <div className="mt-4 overflow-x-auto rounded-lg border border-slate-300 bg-white">
//                                 <table className="w-full min-w-0 table-fixed border-separate border-spacing-0">
//                                     <colgroup>
//                                         <col className="w-[28%]" />
//                                         <col className="w-[9%]" />
//                                         <col className="w-[10%]" />
//                                         <col className="w-[8%]" />
//                                         <col className="w-[10%]" />
//                                         <col className="w-[12%]" />
//                                         <col className="w-[9%]" />
//                                         <col className="w-[8%]" />
//                                         <col className="w-[6%]" />
//                                     </colgroup>
//                                     <thead className="bg-white text-[0.62rem] uppercase tracking-[0.08em] text-slate-500">
//                                         <tr>
//                                             <th className="px-2 py-3 text-left font-semibold">Agent</th>
//                                             <th className="px-2 py-3 text-center font-semibold">Added</th>
//                                             <th className="px-2 py-3 text-center font-semibold">Follow Up</th>
//                                             <th className="px-2 py-3 text-center font-semibold">Calls</th>
//                                             <th className="px-2 py-3 text-center font-semibold">Qualified</th>
//                                             <th className="px-2 py-3 text-center font-semibold">Archive/Dead</th>
//                                             <th className="px-2 py-3 text-center font-semibold">Comments</th>
//                                             <th className="px-2 py-3 text-center font-semibold">Touched</th>
//                                             <th className="px-2 py-3 text-center font-semibold">Score</th>
//                                         </tr>
//                                     </thead>
//                                     <tbody className="divide-y divide-slate-200">
//                                         {isLoading && (
//                                             <tr>
//                                                 <td className="px-4 py-8 text-center text-sm text-slate-500" colSpan={9}>Loading monthly metrics...</td>
//                                             </tr>
//                                         )}
//                                         {!isLoading && monthlyAgents.length === 0 && (
//                                             <tr>
//                                                 <td className="px-4 py-8" colSpan={9}>
//                                                     <EmptyPanel title="No monthly data yet" message="Choose another month or wait for lead activity to appear here." />
//                                                 </td>
//                                             </tr>
//                                         )}
//                                         {visibleMonthlyAgents.map((row) => (
//                                             <MonthlyAgentRow key={row.employeeId} row={row} onQualifiedClick={setQualifiedLeadRow} />
//                                         ))}
//                                         {!isLoading && visibleMonthlyAgents.length > 0 && visibleMonthlyAgents.length < monthlyRowsPerPage && Array.from({ length: monthlyRowsPerPage - visibleMonthlyAgents.length }).map((_, index) => (
//                                             <tr key={`monthly-placeholder-${index}`} aria-hidden="true" className="pointer-events-none">
//                                                 <td className="h-[4.5rem] px-3 py-0" colSpan={9} />
//                                             </tr>
//                                         ))}
//                                     </tbody>
//                                 </table>
//                                 {!isLoading && monthlyAgents.length > 0 && (
//                                     <div className="flex flex-col gap-3 border-t border-slate-300 bg-white px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
//                                         <p className="text-xs font-semibold text-slate-500">
//                                             Showing {monthlyPageStart} to {monthlyPageEnd} of {formatNumber(monthlyAgents.length)} monthly rows
//                                         </p>
//                                         <div className="flex items-center gap-1">
//                                             <button
//                                                 type="button"
//                                                 className="flex size-8 items-center justify-center rounded-lg border border-slate-300 bg-white text-slate-500 transition hover:border-[#842cff] hover:text-[#6426d9] disabled:cursor-not-allowed disabled:opacity-40"
//                                                 onClick={() => setMonthlyPage((page) => Math.max(page - 1, 1))}
//                                                 disabled={currentMonthlyPage === 1}
//                                                 aria-label="Previous monthly data page"
//                                             >
//                                                 <FiChevronLeft className="size-4" aria-hidden="true" />
//                                             </button>
//                                             {monthlyPageNumbers.map((page, index) => {
//                                                 const previousPage = monthlyPageNumbers[index - 1];
//                                                 const hasGap = previousPage && page - previousPage > 1;

//                                                 return (
//                                                     <span key={page} className="flex items-center gap-1">
//                                                         {hasGap && <span className="px-1 text-xs font-semibold text-slate-400">...</span>}
//                                                         <button
//                                                             type="button"
//                                                             className={[
//                                                                 "flex size-8 items-center justify-center rounded-lg border text-sm font-semibold transition",
//                                                                 currentMonthlyPage === page
//                                                                     ? "border-[#842cff] bg-[#842cff] text-white"
//                                                                     : "border-slate-300 bg-white text-slate-600 hover:border-[#842cff] hover:text-[#6426d9]",
//                                                             ].join(" ")}
//                                                             onClick={() => setMonthlyPage(page)}
//                                                             aria-label={`Monthly data page ${page}`}
//                                                             aria-current={currentMonthlyPage === page ? "page" : undefined}
//                                                         >
//                                                             {page}
//                                                         </button>
//                                                     </span>
//                                                 );
//                                             })}
//                                             <button
//                                                 type="button"
//                                                 className="flex size-8 items-center justify-center rounded-lg border border-slate-300 bg-white text-slate-500 transition hover:border-[#842cff] hover:text-[#6426d9] disabled:cursor-not-allowed disabled:opacity-40"
//                                                 onClick={() => setMonthlyPage((page) => Math.min(page + 1, totalMonthlyPages))}
//                                                 disabled={currentMonthlyPage === totalMonthlyPages}
//                                                 aria-label="Next monthly data page"
//                                             >
//                                                 <FiChevronRight className="size-4" aria-hidden="true" />
//                                             </button>
//                                         </div>
//                                     </div>
//                                 )}
//                             </div>
//                         </div>
//                         {/* Call logger */}
//                         <div className="flex flex-wrap items-center justify-between gap-3 border-t-6 border-slate-300 bg-slate-50 px-4 py-4">
//                             <div>
//                                 <p className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">
//                                     Log Call Counts
//                                 </p>

//                                 <h3 className="mt-1 text-base font-semibold text-slate-900">
//                                     {leadCallStatsQuery.isLoading || leadCallStatsQuery.isFetching
//                                         ? "Loading call data"
//                                         : `${formatNumber(totalLoggedLeadCalls)} connected calls`}
//                                 </h3>

//                                 <p className="mt-1 text-xs font-semibold text-rose-600">
//                                     {formatNumber(totalNotConnectedCalls)} not connected
//                                 </p>
//                             </div>

//                             <div className="flex flex-wrap items-center gap-3">
//                                 <label className="flex flex-col gap-1">
//                                     <span className="text-[0.65rem] font-semibold uppercase tracking-[0.12em] text-slate-500">
//                                         From
//                                     </span>
//                                     <input
//                                         type="date"
//                                         className="h-9 rounded-lg border border-slate-300 bg-white px-3 text-sm font-semibold text-slate-800 outline-none transition focus:border-[#842cff] focus:ring-2 focus:ring-[#842cff]/20"
//                                         value={callFilterDateFrom}
//                                         onChange={(event) => setCallFilterDateFrom(event.target.value)}
//                                     />
//                                 </label>
//                                 <label className="flex flex-col gap-1">
//                                     <span className="text-[0.65rem] font-semibold uppercase tracking-[0.12em] text-slate-500">
//                                         To
//                                     </span>
//                                     <input
//                                         type="date"
//                                         className="h-9 rounded-lg border border-slate-300 bg-white px-3 text-sm font-semibold text-slate-800 outline-none transition focus:border-[#842cff] focus:ring-2 focus:ring-[#842cff]/20"
//                                         value={callFilterDateTo}
//                                         onChange={(event) => setCallFilterDateTo(event.target.value)}
//                                     />
//                                 </label>
//                                 <button
//                                     type="button"
//                                     className="mt-5 h-9 rounded-lg border border-slate-300 bg-white px-3 text-sm font-semibold text-slate-700 transition hover:border-[#842cff]/40 hover:text-[#6426d9]"
//                                     onClick={() => {
//                                         const today = formatDateInputValue(new Date());
//                                         setCallFilterDateFrom(today);
//                                         setCallFilterDateTo(today);
//                                     }}
//                                 >
//                                     Today
//                                 </button>
//                                 <button
//                                     type="button"
//                                     className="mt-5 h-9 rounded-lg border border-slate-300 bg-white px-3 text-sm font-semibold text-slate-700 transition hover:border-[#842cff]/40 hover:text-[#6426d9]"
//                                     onClick={() => {
//                                         const today = new Date();
//                                         const firstDay = new Date(today.getFullYear(), today.getMonth(), 1);

//                                         setCallFilterDateFrom(formatDateInputValue(firstDay));
//                                         setCallFilterDateTo(formatDateInputValue(today));
//                                     }}
//                                 >
//                                     This Month
//                                 </button>
//                                 <span className="mt-5 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm font-semibold text-emerald-700">
//                                     {formatNumber(filteredLeadCallStats.length)} lead
//                                     {filteredLeadCallStats.length === 1 ? "" : "s"}
//                                 </span>

//                                 <Link
//                                     className="mt-5 inline-flex h-9 items-center gap-2 rounded-lg bg-[#842cff] px-3 text-sm font-semibold text-white transition hover:brightness-110"
//                                     to="/admin/leads"
//                                 >
//                                     <FiTarget className="size-4" aria-hidden="true" />
//                                     Manage Leads
//                                 </Link>
//                             </div>
//                         </div>
//                         <div className="flex w-full flex-col p-4 pt-0">
//                             {leadCallStatsQuery.isLoading || leadCallStatsQuery.isFetching ? (
//                                 <div className="mt-4">
//                                     <EmptyPanel
//                                         title="Loading call counts"
//                                         message="Getting logged calls from the call stats table."
//                                     />
//                                 </div>
//                             ) : employeeCallRows.length === 0 ? (
//                                 <div className="mt-4">
//                                     <EmptyPanel
//                                         title="No logged calls yet"
//                                         message="Once an employee clicks Log Call, the lead call data will appear here."
//                                     />
//                                 </div>
//                             ) : (
//                                 <div className="mt-4 overflow-x-auto rounded-lg border border-slate-300 bg-white">
//                                     <table className="w-full min-w-[46rem] table-fixed border-separate border-spacing-0">
//                                         <colgroup>
//                                             <col className="w-[26%]" />
//                                             <col className="w-[13%]" />
//                                             <col className="w-[17%]" />
//                                             <col className="w-[13%]" />
//                                             <col className="w-[17%]" />
//                                         </colgroup>

//                                         <thead className="bg-white text-[0.68rem] uppercase tracking-[0.12em] text-slate-500">
//                                             <tr>
//                                                 <th className="px-3 py-3 text-left font-semibold">Employee</th>
//                                                 <th className="px-3 py-3 text-center font-semibold">Calls</th>
//                                                 <th className="px-3 py-3 text-center font-semibold">Not Connected</th>
//                                                 <th className="px-3 py-3 text-center font-semibold">Leads</th>
//                                                 <th className="px-3 py-3 text-left font-semibold">Last Call</th>
//                                             </tr>
//                                         </thead>
//                                         <tbody className="divide-y divide-slate-200">
//                                             {employeeCallRows.map((row) => (
//                                                 <tr
//                                                     key={row.employeeId}
//                                                     className="text-sm text-slate-700 transition hover:bg-emerald-50/60"
//                                                 >
//                                                     <td className="px-3 py-3">
//                                                         <p className="truncate font-semibold text-slate-800">
//                                                             {row.employeeName || "No employee"}
//                                                         </p>

//                                                         {(row.employeeRole || row.employeeTeam) && (
//                                                             <p className="mt-0.5 truncate text-xs text-slate-500">
//                                                                 {[row.employeeRole, row.employeeTeam]
//                                                                     .filter(Boolean)
//                                                                     .join(" · ")}
//                                                             </p>
//                                                         )}
//                                                     </td>
//                                                     <td className="px-3 py-3 text-center font-semibold text-slate-950">
//                                                         <button
//                                                             type="button"
//                                                             className="inline-flex h-8 items-center justify-center rounded-md border border-emerald-200 bg-emerald-50 px-3 text-xs font-semibold text-emerald-700 transition hover:border-emerald-400 hover:bg-emerald-100 focus:outline-none focus:ring-2 focus:ring-emerald-300"
//                                                             onClick={() => setSelectedCallEmployeeRow(row)}
//                                                         >
//                                                             {formatNumber(row.totalCalls)}
//                                                         </button>
//                                                     </td>
//                                                     <td className="px-3 py-3 text-center font-semibold text-rose-600">
//                                                         <button
//                                                             type="button"
//                                                             className="inline-flex h-8 items-center justify-center rounded-md border border-emerald-200 bg-emerald-50 px-3 text-xs font-semibold text-emerald-700 transition hover:border-emerald-400 hover:bg-emerald-100 focus:outline-none focus:ring-2 focus:ring-emerald-300"
//                                                             onClick={() => setSelectedCallEmployeeRow(row)}
//                                                         >
//                                                             {formatNumber(row.totalNotConnectedCalls)}
//                                                         </button>
//                                                     </td>
//                                                     <td className="px-3 py-3 text-center font-semibold text-slate-950">
//                                                         {formatNumber(row.leads.length)}
//                                                     </td>
//                                                     <td className="px-3 py-3 text-sm text-slate-600">
//                                                         {row.lastCallAt ? formatPhDateTime(row.lastCallAt) : "No date"}
//                                                     </td>
//                                                 </tr>
//                                             ))}
//                                         </tbody>
//                                     </table>
//                                 </div>
//                             )}
//                         </div>
//                         <div className="border-t-6 border-slate-300 bg-slate-50/80 p-4">
//                             <div className="mb-4 flex flex-col gap-3 rounded-lg border border-slate-300 bg-white p-4 sm:flex-row sm:items-end sm:justify-between">
//                                 <div>
//                                     <p className="text-xl font-semibold uppercase tracking-[0.14em] text-slate-800">Employee Attendance</p>
//                                     <p className="mt-1 text-xs text-slate-500">Choose an employee to view 11PM to 8AM shift rows, late, undertime, and over-break details.</p>
//                                 </div>

//                                 <div className="w-full sm:w-[28rem]">
//                                     <div
//                                         className="relative"
//                                         onBlur={(event) => {
//                                             if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
//                                                 setIsAttendanceEmployeeMenuOpen(false);
//                                             }
//                                         }}
//                                     >
//                                         <span className="text-[0.65rem] font-semibold uppercase tracking-[0.12em] text-slate-500">Employee</span>
//                                         <div className="mt-1 flex gap-2">
//                                             <button
//                                                 type="button"
//                                                 className="flex h-10 min-w-0 flex-1 items-center justify-between gap-3 rounded-lg border border-slate-300 bg-white px-3 text-left text-sm font-semibold text-slate-800 outline-none transition hover:border-[#842cff] focus:border-[#842cff] focus:ring-2 focus:ring-[#842cff]/20"
//                                                 onClick={() => setIsAttendanceEmployeeMenuOpen((isOpen) => !isOpen)}
//                                                 disabled={attendanceEmployeeOptions.length === 0}
//                                                 aria-haspopup="listbox"
//                                                 aria-expanded={isAttendanceEmployeeMenuOpen}
//                                             >
//                                                 <span className="truncate">{attendanceEmployeeOptions.length === 0 ? "No employees found" : selectedAttendanceEmployeeLabel}</span>
//                                                 <FiChevronDown className={["size-4 shrink-0 text-slate-500 transition", isAttendanceEmployeeMenuOpen ? "rotate-180" : ""].join(" ")} aria-hidden="true" />
//                                             </button>
//                                             <button
//                                                 type="button"
//                                                 className="inline-flex h-10 shrink-0 items-center justify-center rounded-lg border border-rose-200 bg-rose-50 px-3 text-sm font-semibold text-rose-700 transition hover:border-rose-300 hover:bg-rose-100 disabled:cursor-not-allowed disabled:opacity-50"
//                                                 onClick={() => {
//                                                     setSelectedAttendanceEmployeeId("");
//                                                     setIsAttendanceSelectionCleared(true);
//                                                     setAttendanceEmployeeSearch("");
//                                                     setIsAttendanceEmployeeMenuOpen(false);
//                                                 }}
//                                                 disabled={!effectiveAttendanceEmployeeId && !attendanceEmployeeSearch}
//                                             >
//                                                 Clear
//                                             </button>
//                                         </div>

//                                         {isAttendanceEmployeeMenuOpen && (
//                                             <div className="absolute right-0 z-30 mt-2 w-full overflow-hidden rounded-lg border border-slate-300 bg-white shadow-xl shadow-slate-950/15">
//                                                 <div className="border-b border-slate-200 bg-slate-50 p-2">
//                                                     <div className="flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-3 focus-within:border-[#842cff] focus-within:ring-2 focus-within:ring-[#842cff]/20">
//                                                         <FiSearch className="size-4 shrink-0 text-slate-400" aria-hidden="true" />
//                                                         <input
//                                                             type="search"
//                                                             className="h-10 min-w-0 flex-1 bg-transparent text-sm font-semibold text-slate-800 outline-none placeholder:text-slate-400"
//                                                             placeholder="Search employee name or code"
//                                                             value={attendanceEmployeeSearch}
//                                                             onChange={(event) => setAttendanceEmployeeSearch(event.target.value)}
//                                                             autoFocus
//                                                         />
//                                                     </div>
//                                                 </div>
//                                                 <div className="content-scroll max-h-72 overflow-y-auto p-1" role="listbox">
//                                                     {filteredAttendanceEmployeeOptions.length === 0 ? (
//                                                         <p className="px-3 py-4 text-center text-sm font-semibold text-slate-500">No matching employee found.</p>
//                                                     ) : (
//                                                         filteredAttendanceEmployeeOptions.map((employee) => {
//                                                             const isSelected = employee._id === effectiveAttendanceEmployeeId;

//                                                             return (
//                                                                 <button
//                                                                     key={employee._id}
//                                                                     type="button"
//                                                                     className={[
//                                                                         "flex w-full items-center justify-between gap-3 rounded-md px-3 py-2 text-left text-sm transition",
//                                                                         isSelected ? "bg-[#842cff] text-white" : "text-slate-700 hover:bg-violet-50 hover:text-[#6426d9]",
//                                                                     ].join(" ")}
//                                                                     onMouseDown={(event) => event.preventDefault()}
//                                                                     onClick={() => {
//                                                                         setSelectedAttendanceEmployeeId(employee._id);
//                                                                         setIsAttendanceSelectionCleared(false);
//                                                                         setAttendanceEmployeeSearch("");
//                                                                         setIsAttendanceEmployeeMenuOpen(false);
//                                                                     }}
//                                                                     role="option"
//                                                                     aria-selected={isSelected}
//                                                                 >
//                                                                     <span className="min-w-0">
//                                                                         <span className="block truncate font-semibold">{employee.name || employee.employeeCode || "Employee"}</span>
//                                                                         <span className={["mt-0.5 block truncate text-xs", isSelected ? "text-white/75" : "text-slate-500"].join(" ")}>{employee.role || "Employee"} · {employee.team || "Unassigned"}</span>
//                                                                     </span>
//                                                                     {isSelected && <FiCheckCircle className="size-4 shrink-0" aria-hidden="true" />}
//                                                                 </button>
//                                                             );
//                                                         })
//                                                     )}
//                                                 </div>
//                                             </div>
//                                         )}
//                                     </div>
//                                 </div>
//                             </div>

//                             {employeesQuery.isLoading || attendanceRecordsQuery.isLoading ? (
//                                 <EmptyPanel title="Loading attendance" message="Getting employee attendance records for the selected employee." />
//                             ) : selectedAttendanceEmployee ? (
//                                 <AttendancePanel employee={selectedAttendanceEmployee} attendance={selectedAttendanceRecords} />
//                             ) : (
//                                 <AttendancePanel employee={null} attendance={[]} isPlaceholder />
//                             )}
//                         </div>
//                         {/* Attendance panel */}

//                     </section>

//                     <div className="space-y-4">
//                         <section className="dashboard-panel-accent dashboard-accent-blue rounded-lg border border-slate-300 bg-white p-3 text-slate-950 shadow-lg shadow-slate-950/10">
//                             <div className="flex items-center justify-between gap-3">
//                                 <div>
//                                     <p className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">Lead Status</p>
//                                     <h3 className="mt-1 text-base font-semibold">Current total: {formatNumber(pipelineTotals.total)}</h3>
//                                 </div>
//                                 <FiBarChart2 className="size-5 text-[#842cff]" aria-hidden="true" />
//                             </div>
//                             <div className="mt-4 space-y-3">
//                                 {pipelineBars.map((item) => (
//                                     <div key={item.label}>
//                                         <div className="flex justify-between gap-3 text-sm">
//                                             <span className="font-semibold text-slate-700">{item.label}</span>
//                                             <span className="text-slate-500">{formatNumber(item.value)}</span>
//                                         </div>
//                                         <div className="mt-2 h-2 rounded-full bg-slate-200">
//                                             <div className={`h-full rounded-full ${item.color}`} style={{ width: `${Math.max((item.value / maxPipelineValue) * 100, item.value > 0 ? 5 : 0)}%` }} />
//                                         </div>
//                                     </div>
//                                 ))}
//                             </div>
//                         </section>

//                         <section className="dashboard-panel-accent dashboard-accent-teal rounded-lg border border-slate-300 bg-white p-3 text-slate-950 shadow-lg shadow-slate-950/10">
//                             <div className="flex items-center justify-between gap-3">
//                                 <div>
//                                     <p className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">Online Status</p>
//                                     <h3 className="mt-1 text-base font-semibold">{formatNumber(availableAgentCount)} available now</h3>
//                                 </div>
//                                 <FiActivity className="size-5 text-emerald-500" aria-hidden="true" />
//                             </div>
//                             <div className="content-scroll mt-4 max-h-[19rem] space-y-3 overflow-y-auto pr-1">
//                                 {onlineStatusAgents.length === 0 && <EmptyPanel title="No employees yet" message="Employee availability will show here once employees are added." />}
//                                 {onlineStatusAgents.map((agent) => (
//                                     <div key={agent.employeeId} className="rounded-lg border border-slate-300 bg-slate-50 p-3">
//                                         <div className="flex items-start justify-between gap-3">
//                                             <div className="flex min-w-0 items-start gap-2">
//                                                 <span className={`mt-1.5 size-2.5 shrink-0 rounded-full ${availabilityDotClass(agent.availabilityStatus)}`} />
//                                                 <div className="min-w-0">
//                                                     <p className="truncate text-sm font-semibold text-slate-950">{agent.employeeName}</p>
//                                                     <p className="mt-1 truncate text-xs text-slate-500">{agent.role} · {agent.team}</p>
//                                                     <p className="mt-1 text-xs text-slate-500">{formatNumber(agent.assignedLeads)} active leads</p>
//                                                 </div>
//                                             </div>
//                                             <span className={`shrink-0 rounded-md border px-2 py-1 text-xs font-semibold ${availabilityClass(agent.availabilityStatus)}`}>
//                                                 {normalizeEmployeeAvailabilityStatus(agent.availabilityStatus)}
//                                             </span>
//                                         </div>
//                                     </div>
//                                 ))}
//                             </div>
//                         </section>

//                         <section className="dashboard-panel-accent dashboard-accent-teal rounded-lg border border-slate-300 bg-white p-3 text-slate-950 shadow-lg shadow-slate-950/10">
//                             <div className="flex items-start justify-between gap-3">
//                                 <div className="min-w-0">
//                                     <p className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">Agent Calls</p>
//                                     <h3 className="mt-2 text-2xl font-semibold">{formatNumber(selectedCallCount)}</h3>
//                                     <p className="mt-1 text-sm leading-5 text-slate-600">{selectedCallHelper}</p>
//                                 </div>
//                                 <span className="dashboard-accent-icon flex size-10 shrink-0 items-center justify-center rounded-lg border border-emerald-200 bg-emerald-50 text-[#10ac84]">
//                                     <FiPhoneCall className="size-5" aria-hidden="true" />
//                                 </span>
//                             </div>
//                             <div className="mt-4 space-y-2">
//                                 <label className="block text-[0.65rem] font-semibold uppercase tracking-[0.14em] text-slate-500" htmlFor="agent-call-employee">
//                                     Employee
//                                 </label>
//                                 <div className="relative">
//                                     <select
//                                         id="agent-call-employee"
//                                         className="h-10 w-full appearance-none rounded-lg border border-slate-300 bg-white px-3 pr-9 text-sm font-semibold text-slate-800 shadow-sm outline-none transition focus:border-[#10ac84] focus:ring-2 focus:ring-emerald-100"
//                                         value={selectedCallEmployeeId}
//                                         onChange={(event) => setSelectedCallEmployeeId(event.target.value)}
//                                     >
//                                         <option value="all">All employees</option>
//                                         {callEmployeeOptions.map((employee) => (
//                                             <option key={employee.id} value={employee.id}>
//                                                 {employee.name}
//                                             </option>
//                                         ))}
//                                     </select>
//                                     <FiChevronDown className="pointer-events-none absolute right-3 top-1/2 size-4 -translate-y-1/2 text-slate-500" aria-hidden="true" />
//                                 </div>

//                                 <label className="block pt-1 text-[0.65rem] font-semibold uppercase tracking-[0.14em] text-slate-500" htmlFor="agent-call-range">
//                                     Period
//                                 </label>
//                                 <div className="relative">
//                                     <select
//                                         id="agent-call-range"
//                                         className="h-10 w-full appearance-none rounded-lg border border-slate-300 bg-white px-3 pr-9 text-sm font-semibold text-slate-800 shadow-sm outline-none transition focus:border-[#10ac84] focus:ring-2 focus:ring-emerald-100"
//                                         value={callCountRange}
//                                         onChange={(event) => setCallCountRange(event.target.value as CallCountRange)}
//                                     >
//                                         <option value="day">Day</option>
//                                         <option value="month">Month</option>
//                                     </select>
//                                     <FiChevronDown className="pointer-events-none absolute right-3 top-1/2 size-4 -translate-y-1/2 text-slate-500" aria-hidden="true" />
//                                 </div>

//                                 {callCountRange === "day" ? (
//                                     <>
//                                         <label className="block pt-1 text-[0.65rem] font-semibold uppercase tracking-[0.14em] text-slate-500" htmlFor="agent-call-date">
//                                             Date
//                                         </label>
//                                         <input
//                                             id="agent-call-date"
//                                             className="h-10 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm font-semibold text-slate-800 shadow-sm outline-none transition focus:border-[#10ac84] focus:ring-2 focus:ring-emerald-100"
//                                             type="date"
//                                             value={selectedCallDate}
//                                             onChange={(event) => setSelectedCallDate(event.target.value)}
//                                         />
//                                     </>
//                                 ) : (
//                                     <>
//                                         <label className="block pt-1 text-[0.65rem] font-semibold uppercase tracking-[0.14em] text-slate-500" htmlFor="agent-call-month">
//                                             Month
//                                         </label>
//                                         <input
//                                             id="agent-call-month"
//                                             className="h-10 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm font-semibold text-slate-800 shadow-sm outline-none transition focus:border-[#10ac84] focus:ring-2 focus:ring-emerald-100"
//                                             type="month"
//                                             value={selectedMonth}
//                                             onChange={(event) => {
//                                                 setSelectedMonth(event.target.value);
//                                                 setMonthlyPage(1);
//                                                 setIsMonthMenuOpen(false);
//                                             }}
//                                         />
//                                     </>
//                                 )}
//                             </div>
//                         </section>
//                     </div>
//                 </div>

//                 <div className="grid gap-5 xl:grid-cols-[minmax(0,0.75fr)_minmax(0,1.25fr)]">
//                     <section className="dashboard-panel-accent dashboard-accent-purple rounded-lg border border-slate-300 bg-white p-4 text-slate-950 shadow-lg shadow-slate-950/10">
//                         <div className="flex items-center justify-between gap-3">
//                             <div>
//                                 <p className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">Top Agents</p>
//                                 <h3 className="mt-1 text-base font-semibold">Today by productivity score</h3>
//                             </div>
//                             <FiUserCheck className="size-5 text-[#842cff]" aria-hidden="true" />
//                         </div>
//                         <div className="mt-4 space-y-3">
//                             {topAgents.length === 0 && <EmptyPanel title="No activity today" message="Lead touches and comments will rank agents here." />}
//                             {topAgents.map((agent, index) => {
//                                 const maxScore = Math.max(topAgents[0]?.productivityScore || 1, 1);
//                                 return (
//                                     <div key={agent.employeeId} className="grid grid-cols-[2rem_minmax(0,1fr)_3rem] items-center gap-3">
//                                         <span className="text-xs font-semibold text-slate-400">#{index + 1}</span>
//                                         <div className="min-w-0">
//                                             <div className="flex justify-between gap-3">
//                                                 <p className="truncate text-sm font-semibold text-slate-950">{agent.employeeName}</p>
//                                                 <p className="text-sm font-semibold text-slate-600">{formatNumber(agent.productivityScore)}</p>
//                                             </div>
//                                             <div className="mt-2 h-2 rounded-full bg-slate-200">
//                                                 <div className="h-full rounded-full bg-[#842cff]" style={{ width: `${Math.max((agent.productivityScore / maxScore) * 100, 5)}%` }} />
//                                             </div>
//                                         </div>
//                                         <span className="text-right text-xs text-slate-400">pts</span>
//                                     </div>
//                                 );
//                             })}
//                         </div>
//                     </section>

//                     <section className="dashboard-panel-accent dashboard-accent-indigo rounded-lg border border-slate-300 bg-white p-4 text-slate-950 shadow-lg shadow-slate-950/10">
//                         <div className="flex items-center justify-between gap-3">
//                             <div>
//                                 <p className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">Recent Lead Activity</p>
//                                 <h3 className="mt-1 text-base font-semibold">Latest employee actions</h3>
//                             </div>
//                             <div className="flex items-center gap-2 text-slate-500">
//                                 <FiMessageSquare className="size-5" aria-hidden="true" />
//                                 <FiActivity className="size-5" aria-hidden="true" />
//                                 <FiCheckCircle className="size-5" aria-hidden="true" />
//                             </div>
//                         </div>
//                         <div className="mt-4 grid gap-3 lg:grid-cols-2">
//                             {(data?.recentActivity || []).length === 0 && <EmptyPanel title="No recent lead actions" message="Employee comments, status updates, and scheduled follow-ups will appear here." />}
//                             {(data?.recentActivity || []).map((item) => <ActivityItem key={item.id} item={item} onOpen={setSelectedActivity} />)}
//                         </div>
//                     </section>
//                 </div>
//             </section>

//             {selectedActivity && (
//                 <LeadHistoryModal
//                     activity={selectedActivity}
//                     lead={leadHistoryQuery.data}
//                     history={leadHistory}
//                     isLoading={leadHistoryQuery.isLoading || leadHistoryQuery.isFetching}
//                     isError={leadHistoryQuery.isError}
//                     onClose={() => setSelectedActivity(null)}
//                 />
//             )}
//             {qualifiedLeadRow && (
//                 <QualifiedLeadsModal row={qualifiedLeadRow} onClose={() => setQualifiedLeadRow(null)} />
//             )}

//             {selectedCallEmployeeRow && (
//                 <EmployeeLeadCallsModal
//                     row={selectedCallEmployeeRow}
//                     onClose={() => setSelectedCallEmployeeRow(null)}
//                 />
//             )}
//         </AdminLayout>
//     );
// }

import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { Link, useNavigate } from "react-router";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import {
    FiActivity,
    FiBarChart2,
    FiCalendar,
    FiCheckCircle,
    FiChevronDown,
    FiChevronLeft,
    FiChevronRight,
    FiClock,
    FiDownload,
    FiMessageSquare,
    FiPhoneCall,
    FiRefreshCw,
    FiSearch,
    FiTarget,
    FiTrendingUp,
    FiUserCheck,
    FiUsers,
    FiX,
} from "react-icons/fi";
import AdminLayout from "../adminLayout";
import CallDashboardPanel from "../../../components/CallDashboardPanel";
import { getBusinesses } from "../../../api/businesses";
import { getActiveBusinessId } from "../../../api/businessStorage";
import { getEmployeeSummaries, normalizeEmployeeAvailabilityStatus, type Employee } from "../../../api/employees";
import { getEmployeeAttendance, getEmployeesAttendance, type AttendanceRecord } from "../../../api/attendance";
import { getAgentLeadDashboard, getLead, getLeadCallSummary, type AgentLeadActivity, type AgentLeadMonthlyRow, type AgentLeadProgress, type Lead, type LeadCallStat } from "../../../api/leads";
import { buildOffPhoneAttendanceSessions, type OffPhoneAttendanceSession } from "../../../lib/attendanceRecords";
import { isAttendanceTimeOutUndertime } from "../../../lib/attendanceSlots";
import { formatPhDate, formatPhDateTime, formatPhTime } from "../../../lib/dateTime";
import { socket } from "../../../lib/socket";

const numberFormatter = new Intl.NumberFormat("en-US");
const monthLabelFormatter = new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric" });
const dateRangeLabelFormatter = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" });
const agentRowsPerPage = 5;
const monthlyRowsPerPage = 5;
type CallCountRange = "day" | "month";

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

function formatTimeInputValue(date: Date) {
    const hours = String(date.getHours()).padStart(2, "0");
    const minutes = String(date.getMinutes()).padStart(2, "0");

    return `${hours}:${minutes}`;
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

function formatSingleDateLabel(value: string) {
    const date = parseDateInputValue(value);

    return date ? dateRangeLabelFormatter.format(date) : "Selected date";
}

function csvCell(value: string | number | null | undefined) {
    return `"${String(value ?? "").replaceAll('"', '""')}"`;
}

function downloadCsv(filename: string, rows: Array<Array<string | number | null | undefined>>) {
    const csv = rows.map((row) => row.map(csvCell).join(",")).join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    link.click();
    URL.revokeObjectURL(url);
}

function getPaginationNumbers(currentPage: number, totalPages: number) {
    const pages = new Set([1, totalPages, currentPage - 1, currentPage, currentPage + 1]);

    return Array.from(pages)
        .filter((page) => page >= 1 && page <= totalPages)
        .sort((first, second) => first - second);
}

function activityLabelClass(action: string) {
    const normalizedAction = action.toLowerCase();
    if (normalizedAction.includes("comment")) return "bg-sky-50 text-sky-700 border-sky-200";
    if (normalizedAction.includes("status") || normalizedAction.includes("qualified")) return "bg-emerald-50 text-emerald-700 border-emerald-200";
    if (normalizedAction.includes("schedule") || normalizedAction.includes("reschedule")) return "bg-violet-50 text-violet-700 border-violet-200";
    return "bg-slate-50 text-slate-600 border-slate-300";
}

function availabilityClass(value?: string) {
    const status = normalizeEmployeeAvailabilityStatus(value);

    if (status === "ONLINE") return "border-emerald-200 bg-emerald-50 text-emerald-700";
    if (status === "BREAK" || status === "LUNCH") return "border-amber-200 bg-amber-50 text-amber-700";
    if (status === "OFF THE PHONE") return "border-sky-200 bg-sky-50 text-sky-700";

    return "border-slate-200 bg-slate-100 text-slate-600";
}

function availabilityDotClass(value?: string) {
    const status = normalizeEmployeeAvailabilityStatus(value);

    if (status === "ONLINE") return "bg-emerald-500";
    if (status === "BREAK" || status === "LUNCH") return "bg-amber-500";
    if (status === "OFF THE PHONE") return "bg-sky-500";

    return "bg-slate-400";
}

function availabilitySortRank(value?: string) {
    const status = normalizeEmployeeAvailabilityStatus(value);

    if (status === "ONLINE") return 0;
    if (status === "BREAK") return 1;
    if (status === "LUNCH") return 2;
    if (status === "OFF THE PHONE") return 3;

    return 4;
}

function personNameTokens(value?: string | null) {
    return String(value || "")
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, " ")
        .replace(/\s+/g, " ")
        .split(" ")
        .filter((token) => token.length > 1);
}

function isLikelySamePersonName(first?: string | null, second?: string | null) {
    const firstTokens = personNameTokens(first);
    const secondTokens = personNameTokens(second);

    if (firstTokens.length < 2 || secondTokens.length < 2) return false;

    const firstFirstName = firstTokens[0];
    const secondFirstName = secondTokens[0];
    const firstLastName = firstTokens.at(-1);
    const secondLastName = secondTokens.at(-1);

    if (!firstLastName || firstLastName !== secondLastName) return false;

    return (
        (firstFirstName.length >= 4 && secondFirstName.startsWith(firstFirstName)) ||
        (secondFirstName.length >= 4 && firstFirstName.startsWith(secondFirstName))
    );
}

function isGenericAgentDisplay(row: { role?: string; team?: string }) {
    return String(row.role || "").trim().toLowerCase() === "agent" && String(row.team || "").trim().toLowerCase() === "unassigned";
}

function latestDateValue(first?: string | null, second?: string | null) {
    const firstTime = first ? new Date(first).getTime() : 0;
    const secondTime = second ? new Date(second).getTime() : 0;

    if (Number.isNaN(firstTime) && Number.isNaN(secondTime)) return null;
    if (Number.isNaN(firstTime)) return second || null;
    if (Number.isNaN(secondTime)) return first || null;

    return firstTime >= secondTime ? first || null : second || null;
}

function findMergeTarget<T extends { employeeId: string; employeeName: string; role?: string; team?: string }>(rows: T[], row: T) {
    return rows.find((currentRow) => {
        if (currentRow.employeeId === row.employeeId) return true;
        if (!isLikelySamePersonName(currentRow.employeeName, row.employeeName)) return false;

        return isGenericAgentDisplay(currentRow) !== isGenericAgentDisplay(row);
    });
}

function preferEmployeeDisplay<T extends { employeeName: string; employeeId: string; role?: string; team?: string }>(first: T, second: T) {
    if (isGenericAgentDisplay(first) && !isGenericAgentDisplay(second)) return second;
    if (!isGenericAgentDisplay(first) && isGenericAgentDisplay(second)) return first;

    return first;
}

type LeadHistoryItem = {
    id: string;
    label: string;
    detail: string;
    actorName: string;
    actorType: string;
    status?: string;
    createdAt: string;
    kind: "activity" | "comment";
};

type OnlineStatusEmployeeRow = Pick<
    AgentLeadProgress,
    "employeeId" | "employeeName" | "businessName" | "role" | "team" | "availabilityStatus" | "assignedLeads"
>;

function isArchivedEmployee(employee: Employee) {
    return String(employee.status || "").trim().toLowerCase() === "archived";
}

function buildOnlineStatusRows(employees: Employee[], agents: AgentLeadProgress[], businessName: string): OnlineStatusEmployeeRow[] {
    const agentById = new Map(agents.map((agent) => [agent.employeeId, agent]));
    const agentByName = new Map(agents.map((agent) => [agent.employeeName.trim().toLowerCase(), agent]));

    return employees
        .filter((employee) => !isArchivedEmployee(employee))
        .map((employee) => {
            const matchedAgent = agentById.get(employee._id) || agentByName.get((employee.name || "").trim().toLowerCase());

            return {
                employeeId: employee._id,
                employeeName: employee.name || employee.employeeCode || "Employee",
                businessName: matchedAgent?.businessName || businessName,
                role: employee.role || "Employee",
                team: employee.team || "Unassigned",
                availabilityStatus: employee.availabilityStatus || matchedAgent?.availabilityStatus || "OFFLINE",
                assignedLeads: matchedAgent?.assignedLeads || 0,
            };
        })
        .sort((first, second) => {
            const rankDifference = availabilitySortRank(first.availabilityStatus) - availabilitySortRank(second.availabilityStatus);

            if (rankDifference !== 0) return rankDifference;

            return first.employeeName.localeCompare(second.employeeName);
        });
}

function mergeAgentProgressRows(rows: AgentLeadProgress[]) {
    return rows.reduce<AgentLeadProgress[]>((mergedRows, row) => {
        const target = findMergeTarget(mergedRows, row);

        if (!target) {
            mergedRows.push({ ...row });
            return mergedRows;
        }

        const displayRow = preferEmployeeDisplay(target, row);
        const mergedRow: AgentLeadProgress = {
            ...displayRow,
            assignedLeads: target.assignedLeads + row.assignedLeads,
            newLeads: target.newLeads + row.newLeads,
            followUps: target.followUps + row.followUps,
            ongoing: target.ongoing + row.ongoing,
            qualified: target.qualified + row.qualified,
            negotiation: target.negotiation + row.negotiation,
            dead: target.dead + row.dead,
            dueFollowUps: target.dueFollowUps + row.dueFollowUps,
            scheduledToday: target.scheduledToday + row.scheduledToday,
            commentsToday: target.commentsToday + row.commentsToday,
            callsToday: (target.callsToday || 0) + (row.callsToday || 0),
            activityToday: target.activityToday + row.activityToday,
            touchedLeadsToday: target.touchedLeadsToday + row.touchedLeadsToday,
            productivityScore: target.productivityScore + row.productivityScore,
            lastActivityAt: latestDateValue(target.lastActivityAt, row.lastActivityAt),
            progressPercent: 0,
        };

        mergedRow.progressPercent =
            mergedRow.assignedLeads > 0 ? Math.round(((mergedRow.followUps + mergedRow.qualified) / mergedRow.assignedLeads) * 100) : 0;

        mergedRows[mergedRows.indexOf(target)] = mergedRow;
        return mergedRows;
    }, []);
}

function mergeAgentMonthlyRows(rows: AgentLeadMonthlyRow[]) {
    return rows.reduce<AgentLeadMonthlyRow[]>((mergedRows, row) => {
        const target = findMergeTarget(mergedRows, row);

        if (!target) {
            mergedRows.push({ ...row, qualifiedLeads: [...(row.qualifiedLeads || [])] });
            return mergedRows;
        }

        const displayRow = preferEmployeeDisplay(target, row);
        const qualifiedLeadsById = new Map<string, AgentLeadMonthlyRow["qualifiedLeads"][number]>();

        [...(target.qualifiedLeads || []), ...(row.qualifiedLeads || [])].forEach((lead) => {
            qualifiedLeadsById.set(lead.leadId, lead);
        });

        mergedRows[mergedRows.indexOf(target)] = {
            ...displayRow,
            leadsAdded: target.leadsAdded + row.leadsAdded,
            followUps: target.followUps + row.followUps,
            qualified: target.qualified + row.qualified,
            archiveDead: target.archiveDead + row.archiveDead,
            comments: target.comments + row.comments,
            calls: (target.calls || 0) + (row.calls || 0),
            actions: target.actions + row.actions,
            touchedLeads: target.touchedLeads + row.touchedLeads,
            productivityScore: target.productivityScore + row.productivityScore,
            qualifiedLeads: Array.from(qualifiedLeadsById.values()),
            lastActivityAt: latestDateValue(target.lastActivityAt, row.lastActivityAt),
        };

        return mergedRows;
    }, []);
}

function getLeadDisplayName(lead?: Lead | null, fallback?: AgentLeadActivity | null) {
    return lead?.leadName || lead?.businessName || fallback?.leadName || fallback?.businessName || "Lead";
}

function getLeadHistory(lead?: Lead | null): LeadHistoryItem[] {
    if (!lead) return [];

    const activity = (lead.activity || []).map((item, index) => ({
        id: item._id || `activity-${index}-${item.createdAt}`,
        label: item.label || "Lead activity",
        detail: item.detail || "No details provided.",
        actorName: item.actorName || "System",
        actorType: item.actorType || "system",
        status: item.status,
        createdAt: item.createdAt,
        kind: "activity" as const,
    }));
    const comments = (lead.comments || []).map((item, index) => ({
        id: item._id || `comment-${index}-${item.createdAt}`,
        label: "Comment",
        detail: item.body || "No comment text.",
        actorName: item.authorName || "Unknown",
        actorType: item.authorType || "employee",
        status: undefined,
        createdAt: item.createdAt,
        kind: "comment" as const,
    }));

    return [...activity, ...comments].sort((left, right) => {
        const rightTime = new Date(right.createdAt || 0).getTime() || 0;
        const leftTime = new Date(left.createdAt || 0).getTime() || 0;
        return rightTime - leftTime;
    });
}

function KpiCard({
    label,
    value,
    helper,
    icon: Icon,
    accent,
}: {
    label: string;
    value: string;
    helper: string;
    icon: typeof FiUsers;
    accent: "green" | "blue" | "orange" | "purple";
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
        </article>
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

function AgentProgressRow({ agent }: { agent: AgentLeadProgress }) {
    return (
        <tr className="text-sm text-slate-700 transition hover:bg-slate-50">
            <td className="min-w-[13rem] px-3 py-3">
                <div className="flex items-center gap-3">
                    <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-[#842cff] text-sm font-semibold text-white">
                        {agent.employeeName.slice(0, 1).toUpperCase()}
                    </span>
                    <div className="min-w-0">
                        <p className="truncate font-semibold text-slate-950">{agent.employeeName}</p>
                        <p className="mt-0.5 truncate text-xs text-slate-500">{[agent.role, agent.team, agent.businessName].filter(Boolean).join(" · ")}</p>
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

    return `/admin/leads?${params.toString()}`;
}

function MonthlyAgentRow({ row, onQualifiedClick }: { row: AgentLeadMonthlyRow; onQualifiedClick: (row: AgentLeadMonthlyRow) => void }) {
    return (
        <tr className="text-sm text-slate-700 transition hover:bg-violet-50/35">
            <td className="min-w-0 px-2 py-3">
                <div className="flex min-w-0 items-center gap-2">
                    <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-violet-100 text-xs font-semibold text-[#6426d9]">
                        {row.employeeName.slice(0, 1).toUpperCase()}
                    </span>
                    <div className="min-w-0">
                        <p className="truncate font-semibold text-slate-900">{row.employeeName}</p>
                        <p className="mt-0.5 truncate text-xs text-slate-500">{[row.role, row.team, row.businessName].filter(Boolean).join(" · ")}</p>
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

function ActivityItem({ item, onOpen }: { item: AgentLeadActivity; onOpen: (item: AgentLeadActivity) => void }) {
    const leadName = item.leadName || item.businessName || "Lead";

    return (
        <button
            type="button"
            className="cursor-pointer rounded-lg border border-slate-300 bg-white p-3 text-left transition hover:border-[#842cff] hover:bg-violet-50/40 focus:outline-none focus:ring-2 focus:ring-[#842cff]/35"
            onClick={() => onOpen(item)}
            aria-label={`Open transaction history for ${leadName}`}
        >
            <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                    <p className="truncate text-sm font-semibold text-slate-950">{item.employeeName}</p>
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
            <span className="mt-3 inline-flex text-xs font-semibold text-[#842cff]">View history</span>
        </button>
    );
}

function LeadHistoryModal({
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
                                                {item.actorName} · {item.actorType}
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
    employee?: Employee | null;
    shiftDateValue: string;
    shiftStart: Date;
    shiftEnd: Date;
    records: AttendanceRecord[];
    overBreakRows: AttendanceOverBreakRow[];
    totalOverBreakMs: number;
    offPhoneSessions: OffPhoneAttendanceSession[];
    totalOffPhoneMs: number;
    lateRecords: AttendanceRecord[];
    underTimeRecords: AttendanceRecord[];
    underTimeMs: number;
    firstTimeIn: AttendanceRecord | null;
    lastTimeOut: AttendanceRecord | null;
};

type AttendanceEmployeeGroup = {
    employee: Employee;
    attendance: AttendanceRecord[];
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

function getAttendanceQueryRange(selectedDate: string, dateFrom: string, dateTo: string) {
    const startDate = parseDateInputValue(selectedDate || dateFrom);
    const endDate = parseDateInputValue(selectedDate || dateTo);

    if (startDate) {
        startDate.setHours(SHIFT_START_HOUR, 0, 0, 0);
    }

    if (endDate) {
        endDate.setHours(SHIFT_START_HOUR, 0, 0, 0);
        endDate.setTime(endDate.getTime() + SHIFT_LENGTH_MS);
    }

    return {
        from: startDate?.toISOString(),
        to: endDate?.toISOString(),
    };
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

function buildAttendanceShiftRows(records: AttendanceRecord[], employee?: Employee | null) {
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
            const offPhoneSessions = buildOffPhoneAttendanceSessions(
                draft.records,
                isCurrentOpenShift ? Date.now() : draft.shiftEnd.getTime()
            );
            const lateRecords = sortedShiftRecords.filter((record) => getAttendanceStatusText(record).includes("late"));
            const statusUnderTimeRecords = sortedShiftRecords.filter((record) => {
                const statusText = getAttendanceStatusText(record);

                return statusText.includes("under") || statusText.includes("undertime");
            });
            const firstTimeIn = ascendingShiftRecords.find((record) => isTimeInSource(record.source)) || ascendingShiftRecords[0] || null;
            const lastTimeOut = sortedShiftRecords.find((record) => isTimeOutSource(record.source)) || null;
            const lastTimeOutMs = getAttendanceTimestamp(lastTimeOut);
            const underTimeMs = lastTimeOutMs ? Math.max(0, draft.shiftEnd.getTime() - lastTimeOutMs) : 0;
            const underTimeRecords = underTimeMs > 0 && lastTimeOut && !statusUnderTimeRecords.some((record) => record._id === lastTimeOut._id)
                ? [lastTimeOut, ...statusUnderTimeRecords]
                : statusUnderTimeRecords;

            return {
                id: [employee?._id || "employee", draft.shiftDateValue, ascendingShiftRecords[0]?._id || "shift"].join("-"),
                employee: employee || null,
                shiftDateValue: draft.shiftDateValue,
                shiftStart: draft.shiftStart,
                shiftEnd: draft.shiftEnd,
                records: sortedShiftRecords,
                overBreakRows,
                totalOverBreakMs: overBreakRows.reduce((total, row) => total + row.overMs, 0),
                offPhoneSessions,
                totalOffPhoneMs: offPhoneSessions.reduce((total, session) => total + session.durationMs, 0),
                lateRecords,
                underTimeRecords,
                underTimeMs,
                firstTimeIn,
                lastTimeOut,
            };
        })
        .sort((first, second) => first.shiftStart.getTime() - second.shiftStart.getTime());
}

function AttendancePanel({
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
                    <span className="rounded-full bg-white px-2.5 py-1 text-[0.65rem] font-bold text-slate-500">Shift 11PM-8AM · Break 15m · Lunch 1h</span>
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
                                            <p className="mt-0.5 truncate text-xs text-slate-500">{[row.employee?.role, row.employee?.team].filter(Boolean).join(" · ") || "No role"}</p>
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
                                            <p className="font-semibold">Off the Phone for {formatAttendanceDuration(session.durationMs)}</p>
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
    crmBusinessId: string;
    crmBusinessName: string;
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

function getCallLogEmployeeId(log: LeadCallStat["callLogs"][number]) {
    if (typeof log.employee === "string") {
        return log.employee;
    }

    return log.employee?._id || "";
}

// function buildEmployeeCallRows(leadCallStats: LeadCallStat[]): EmployeeCallSummaryRow[] {
//     const rowsByEmployee = new Map<string, EmployeeCallSummaryRow>();

//     leadCallStats.forEach((item) => {
//         const leadId = getLeadCallStatLeadId(item);
//         const leadName = item.leadName || "No lead name";
//         const businessName = item.businessName || "No business name";

//         (item.callLogs || []).forEach((log) => {
//             const employeeId =
//                 getCallLogEmployeeId(log) ||
//                 `employee-name:${String(log.employeeName || "Employee").trim().toLowerCase()}`;

//             if (!employeeId) {
//                 return;
//             }

//             const outcome = log.outcome === "not_connected" ? "not_connected" : "connected";
//             const calledAt = log.calledAt || item.lastCallAt || null;

//             if (!rowsByEmployee.has(employeeId)) {
//                 rowsByEmployee.set(employeeId, {
//                     employeeId,
//                     employeeName: log.employeeName || "Employee",
//                     employeeRole: log.employeeRole || "",
//                     employeeTeam: log.employeeTeam || "",
//                     totalCalls: 0,
//                     totalNotConnectedCalls: 0,
//                     totalAttempts: 0,
//                     lastCallAt: null,
//                     leads: [],
//                 });
//             }

//             const employeeRow = rowsByEmployee.get(employeeId)!;

//             employeeRow.employeeName = log.employeeName || employeeRow.employeeName;
//             employeeRow.employeeRole = log.employeeRole || employeeRow.employeeRole;
//             employeeRow.employeeTeam = log.employeeTeam || employeeRow.employeeTeam;
//             employeeRow.totalAttempts += 1;
//             employeeRow.lastCallAt = getLatestDateValue(employeeRow.lastCallAt, calledAt);

//             if (outcome === "not_connected") {
//                 employeeRow.totalNotConnectedCalls += 1;
//             } else {
//                 employeeRow.totalCalls += 1;
//             }

//             let leadRow = employeeRow.leads.find((lead) => lead.leadId === leadId);

//             if (!leadRow) {
//                 leadRow = {
//                     leadId,
//                     leadName,
//                     businessName,
//                     callCount: 0,
//                     callNotConnectedCount: 0,
//                     totalAttempts: 0,
//                     lastCallAt: null,
//                     callLogs: [],
//                 };

//                 employeeRow.leads.push(leadRow);
//             }

//             leadRow.totalAttempts += 1;
//             leadRow.lastCallAt = getLatestDateValue(leadRow.lastCallAt, calledAt);
//             leadRow.callLogs.push(log);

//             if (outcome === "not_connected") {
//                 leadRow.callNotConnectedCount += 1;
//             } else {
//                 leadRow.callCount += 1;
//             }
//         });
//     });

//     return Array.from(rowsByEmployee.values())
//         .map((employeeRow) => ({
//             ...employeeRow,
//             leads: employeeRow.leads.sort(
//                 (first, second) =>
//                     getDateTimeValue(second.lastCallAt) - getDateTimeValue(first.lastCallAt)
//             ),
//         }))
//         .sort(
//             (first, second) =>
//                 getDateTimeValue(second.lastCallAt) - getDateTimeValue(first.lastCallAt)
//         );
// }

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
                    crmBusinessId: "",
                    crmBusinessName: "Current business",
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


function getDateStart(value: string) {
    if (!value) {
        return null;
    }

    const date = parseDateInputValue(value);

    if (!date) {
        return null;
    }

    date.setHours(0, 0, 0, 0);
    return date;
}

function getDateEnd(value: string) {
    if (!value) {
        return null;
    }

    const date = parseDateInputValue(value);

    if (!date) {
        return null;
    }

    date.setHours(23, 59, 59, 999);
    return date;
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

    const startDate = getDateStart(dateFrom);
    const endDate = getDateEnd(dateTo);

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



function combineDateAndTime(dateValue: string, timeValue: string) {
    if (!dateValue) {
        return "";
    }

    const safeTime = timeValue || "00:00";

    return `${dateValue}T${safeTime}`;
}

function getCallSummaryFilterRange(
    dateFrom: string,
    timeFrom: string,
    dateTo: string,
    timeTo: string
) {
    const from = dateFrom
        ? new Date(combineDateAndTime(dateFrom, timeFrom || "00:00"))
        : null;
    const to = dateTo
        ? new Date(combineDateAndTime(dateTo, timeTo || "23:59"))
        : null;

    if (from && to && dateFrom === dateTo && to.getTime() <= from.getTime()) {
        to.setDate(to.getDate() + 1);
    }

    return {
        from: from?.toISOString(),
        to: to?.toISOString(),
    };
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

export default function AdminDashboard() {
    const navigate = useNavigate();
    const queryClient = useQueryClient();
    const [selectedActivity, setSelectedActivity] = useState<AgentLeadActivity | null>(null);
    const [qualifiedLeadRow, setQualifiedLeadRow] = useState<AgentLeadMonthlyRow | null>(null);
    const [selectedMonth, setSelectedMonth] = useState(() => getMonthInputValue(new Date()));
    const [isMonthMenuOpen, setIsMonthMenuOpen] = useState(false);
    const [callCountRange, setCallCountRange] = useState<CallCountRange>("day");
    const [selectedCallDate, setSelectedCallDate] = useState(() => formatDateInputValue(new Date()));
    const [selectedCallEmployeeId, setSelectedCallEmployeeId] = useState("all");
    const [selectedAttendanceEmployeeId, setSelectedAttendanceEmployeeId] = useState("");
    const [selectedAttendanceDepartment, setSelectedAttendanceDepartment] = useState("all");
    const [attendanceEmployeeSearch, setAttendanceEmployeeSearch] = useState("");
    const [isAttendanceEmployeeMenuOpen, setIsAttendanceEmployeeMenuOpen] = useState(false);
    const [, setIsAttendanceSelectionCleared] = useState(false);
    const [attendanceSelectedShiftDate, setAttendanceSelectedShiftDate] = useState(() => getCurrentShiftDateValue());
    const [attendanceDateFrom, setAttendanceDateFrom] = useState("");
    const [attendanceDateTo, setAttendanceDateTo] = useState("");
    const [agentPage, setAgentPage] = useState(1);
    const [monthlyPage, setMonthlyPage] = useState(1);
    const selectedMonthlyRange = useMemo(() => getMonthlyDashboardDateRange(selectedMonth), [selectedMonth]);
    const monthlyRangeLabel = useMemo(() => formatDateRangeLabel(selectedMonthlyRange.dateFrom, selectedMonthlyRange.dateTo), [selectedMonthlyRange]);
    const { data, isLoading, isError, refetch, isFetching } = useQuery({
        queryKey: ["agent-lead-dashboard", selectedMonth, selectedMonthlyRange.dateFrom, selectedMonthlyRange.dateTo, selectedCallDate],
        queryFn: () => getAgentLeadDashboard({ month: selectedMonth, dateFrom: selectedMonthlyRange.dateFrom, dateTo: selectedMonthlyRange.dateTo, callDate: selectedCallDate }),
        refetchInterval: 15_000,
        refetchOnWindowFocus: true,
    });
    const businessesQuery = useQuery({
        queryKey: ["businesses"],
        queryFn: getBusinesses,
        staleTime: 60_000,
    });
    const activeBusinessId = getActiveBusinessId() || data?.business?.id || "";
    const activeBusinessName = businessesQuery.data?.find((business) => business.id === activeBusinessId)?.name
        || data?.business?.name
        || "Current business";
    useEffect(() => {
        let refreshTimeoutId: number | undefined;

        const refreshLeadProgress = () => {
            window.clearTimeout(refreshTimeoutId);
            refreshTimeoutId = window.setTimeout(() => {
                void refetch();
                void queryClient.invalidateQueries({ queryKey: ["lead-call-summary", "admin"] });
            }, 750);
        };

        socket.on("lead:changed", refreshLeadProgress);
        socket.on("lead-call-stat:updated", refreshLeadProgress);

        return () => {
            window.clearTimeout(refreshTimeoutId);
            socket.off("lead:changed", refreshLeadProgress);
            socket.off("lead-call-stat:updated", refreshLeadProgress);
        };
    }, [queryClient, refetch]);
    const employeesQuery = useQuery({
        queryKey: ["employees", "summary", "dashboard-online-status"],
        queryFn: getEmployeeSummaries,
        refetchInterval: 15_000,
        refetchOnWindowFocus: true,
    });
    const attendanceEmployeeOptions = useMemo(() => {
        return (employeesQuery.data || [])
            .filter((employee) => !isArchivedEmployee(employee))
            .sort((first, second) => (first.name || first.employeeCode || "").localeCompare(second.name || second.employeeCode || ""));
    }, [employeesQuery.data]);
    const attendanceDepartmentOptions = useMemo(() => {
        return Array.from(
            new Set(attendanceEmployeeOptions.map((employee) => employee.team?.trim() || "Unassigned"))
        ).sort((first, second) => first.localeCompare(second));
    }, [attendanceEmployeeOptions]);
    const departmentFilteredAttendanceEmployeeOptions = useMemo(() => {
        if (selectedAttendanceDepartment === "all") {
            return attendanceEmployeeOptions;
        }

        return attendanceEmployeeOptions.filter((employee) => (employee.team?.trim() || "Unassigned") === selectedAttendanceDepartment);
    }, [attendanceEmployeeOptions, selectedAttendanceDepartment]);
    const selectedAttendanceEmployee = departmentFilteredAttendanceEmployeeOptions.find((employee) => employee._id === selectedAttendanceEmployeeId) || null;
    const effectiveAttendanceEmployeeId = selectedAttendanceEmployee?._id || "";
    const selectedAttendanceEmployeeLabel = selectedAttendanceEmployee?.name || selectedAttendanceEmployee?.employeeCode || "Select employee";
    const filteredAttendanceEmployeeOptions = useMemo(() => {
        const searchValue = attendanceEmployeeSearch.trim().toLowerCase();

        if (!searchValue) {
            return departmentFilteredAttendanceEmployeeOptions;
        }

        return departmentFilteredAttendanceEmployeeOptions.filter((employee) => {
            const searchableText = [
                employee.name,
                employee.employeeCode,
                employee.role,
                employee.team,
                ...(employee.aliases || []),
            ]
                .filter(Boolean)
                .join(" ")
                .toLowerCase();

            return searchableText.includes(searchValue);
        });
    }, [departmentFilteredAttendanceEmployeeOptions, attendanceEmployeeSearch]);
    const attendanceQueryRange = useMemo(
        () => getAttendanceQueryRange(attendanceSelectedShiftDate, attendanceDateFrom, attendanceDateTo),
        [attendanceSelectedShiftDate, attendanceDateFrom, attendanceDateTo]
    );
    const attendanceRecordsQuery = useQuery({
        queryKey: ["admin-dashboard-attendance-records", effectiveAttendanceEmployeeId, attendanceQueryRange.from, attendanceQueryRange.to],
        queryFn: () => getEmployeeAttendance(effectiveAttendanceEmployeeId, { limit: 300, ...attendanceQueryRange }),
        enabled: Boolean(effectiveAttendanceEmployeeId),
        refetchInterval: 15_000,
        refetchOnWindowFocus: true,
    });
    const allAttendanceEmployeeIds = useMemo(
        () => departmentFilteredAttendanceEmployeeOptions.map((employee) => employee._id),
        [departmentFilteredAttendanceEmployeeOptions]
    );
    const allAttendanceQuery = useQuery({
        queryKey: ["admin-dashboard-attendance-records", "all", allAttendanceEmployeeIds, attendanceQueryRange.from, attendanceQueryRange.to],
        queryFn: () => getEmployeesAttendance(allAttendanceEmployeeIds, attendanceQueryRange),
        enabled: !effectiveAttendanceEmployeeId && allAttendanceEmployeeIds.length > 0,
        refetchInterval: 30_000,
        refetchOnWindowFocus: true,
    });
    useEffect(() => {
        const refreshAttendance = () => {
            void queryClient.invalidateQueries({ queryKey: ["admin-dashboard-attendance-records"] });
            void queryClient.invalidateQueries({ queryKey: ["employees", "summary", "dashboard-online-status"] });
        };

        socket.on("employee:availability-updated", refreshAttendance);
        socket.on("call-dashboard:updated", refreshAttendance);

        return () => {
            socket.off("employee:availability-updated", refreshAttendance);
            socket.off("call-dashboard:updated", refreshAttendance);
        };
    }, [queryClient]);
    const selectedLeadId = selectedActivity?.leadId || "";
    const leadHistoryQuery = useQuery({
        queryKey: ["dashboard-lead-history", selectedLeadId],
        queryFn: () => getLead(selectedLeadId),
        enabled: Boolean(selectedLeadId),
    });
    const agents = useMemo(
        () => mergeAgentProgressRows(data?.agents || []).map((row) => ({ ...row, businessId: activeBusinessId, businessName: activeBusinessName })),
        [activeBusinessId, activeBusinessName, data?.agents]
    );
    const monthlyAgents = useMemo(
        () => mergeAgentMonthlyRows(data?.monthlyAgents || []).map((row) => ({ ...row, businessId: activeBusinessId, businessName: activeBusinessName })),
        [activeBusinessId, activeBusinessName, data?.monthlyAgents]
    );
    const summary = data?.summary;
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
    const topAgents = agents.slice(0, 5);
    const onlineStatusAgents = useMemo(() => {
        if (employeesQuery.data) {
            return buildOnlineStatusRows(employeesQuery.data, agents, activeBusinessName);
        }

        return [...agents].sort((first, second) => {
            const rankDifference = availabilitySortRank(first.availabilityStatus) - availabilitySortRank(second.availabilityStatus);

            if (rankDifference !== 0) return rankDifference;

            return first.employeeName.localeCompare(second.employeeName);
        });
    }, [activeBusinessName, agents, employeesQuery.data]);
    const availableAgentCount = onlineStatusAgents.filter(
        (agent) => normalizeEmployeeAvailabilityStatus(agent.availabilityStatus) !== "OFFLINE"
    ).length;
    const leadHistory = useMemo(() => getLeadHistory(leadHistoryQuery.data), [leadHistoryQuery.data]);
    const pipelineTotals = useMemo(() => {
        return agents.reduce(
            (totals, agent) => ({
                total: totals.total + agent.newLeads + agent.followUps + agent.qualified + agent.dead,
                newLeads: totals.newLeads + agent.newLeads,
                followUps: totals.followUps + agent.followUps,
                qualified: totals.qualified + agent.qualified,
                dead: totals.dead + agent.dead,
            }),
            { total: 0, newLeads: 0, followUps: 0, qualified: 0, dead: 0 }
        );
    }, [agents]);
    const pipelineBars = [
        { label: "NEW", value: pipelineTotals.newLeads, color: "bg-slate-400" },
        { label: "FOLLOW UP", value: pipelineTotals.followUps, color: "bg-violet-500" },
        { label: "QUALIFIED", value: pipelineTotals.qualified, color: "bg-emerald-500" },
        { label: "ARCHIVE/DEAD", value: pipelineTotals.dead, color: "bg-red-400" },
    ];
    const maxPipelineValue = Math.max(...pipelineBars.map((item) => item.value), 1);
    const monthlyTotals = useMemo(() => {
        return monthlyAgents.reduce(
            (totals, row) => ({
                leadsAdded: totals.leadsAdded + row.leadsAdded,
                calls: totals.calls + (row.calls || 0),
                comments: totals.comments + row.comments,
                touchedLeads: totals.touchedLeads + row.touchedLeads,
                productivityScore: totals.productivityScore + row.productivityScore,
            }),
            { leadsAdded: 0, calls: 0, comments: 0, touchedLeads: 0, productivityScore: 0 }
        );
    }, [monthlyAgents]);
    const dailyCallCount = summary?.callsToday ?? agents.reduce((total, agent) => total + (agent.callsToday || 0), 0);
    const callEmployeeOptions = useMemo(() => {
        const optionsById = new Map<string, { id: string; name: string }>();
        const addOption = (id?: string, name?: string) => {
            const normalizedId = String(id || "").trim();
            const normalizedName = String(name || "").trim();

            if (!normalizedId || !normalizedName || optionsById.has(normalizedId)) return;

            optionsById.set(normalizedId, { id: normalizedId, name: normalizedName });
        };

        agents.forEach((agent) => addOption(agent.employeeId, agent.employeeName));
        monthlyAgents.forEach((agent) => addOption(agent.employeeId, agent.employeeName));

        return Array.from(optionsById.values()).sort((first, second) => first.name.localeCompare(second.name));
    }, [agents, monthlyAgents]);
    const selectedDailyCallCount = selectedCallEmployeeId === "all"
        ? dailyCallCount
        : agents.find((agent) => agent.employeeId === selectedCallEmployeeId)?.callsToday || 0;
    const selectedMonthlyCallCount = selectedCallEmployeeId === "all"
        ? monthlyTotals.calls
        : monthlyAgents.find((agent) => agent.employeeId === selectedCallEmployeeId)?.calls || 0;
    const selectedCallCount = callCountRange === "day" ? selectedDailyCallCount : selectedMonthlyCallCount;
    const selectedCallEmployeeName = selectedCallEmployeeId === "all"
        ? "All employees"
        : callEmployeeOptions.find((employee) => employee.id === selectedCallEmployeeId)?.name || "Selected employee";
    const selectedCallHelper = callCountRange === "day"
        ? `${selectedCallEmployeeName} · calls logged ${formatSingleDateLabel(selectedCallDate)}`
        : `${selectedCallEmployeeName} · calls logged ${monthlyRangeLabel}`;
    const monthOptions = useMemo(() => {
        return Array.from(new Set([selectedMonth, data?.selectedMonth || "", ...(data?.monthOptions || [])]))
            .filter(Boolean)
            .sort((first, second) => second.localeCompare(first));
    }, [data?.monthOptions, data?.selectedMonth, selectedMonth]);
    const handleExportMonthlyData = () => {
        const rows = [
            ["Date Range", "Agent", "Role", "Team", "Added", "Follow Up", "Calls", "Qualified", "Archive/Dead", "Comments", "Touched", "Score", "Last Activity"],
            ...monthlyAgents.map((row) => [
                monthlyRangeLabel,
                row.employeeName,
                row.role,
                row.team,
                row.leadsAdded,
                row.followUps,
                row.calls || 0,
                row.qualified,
                row.archiveDead,
                row.comments,
                row.touchedLeads,
                row.productivityScore,
                row.lastActivityAt ? formatPhDateTime(row.lastActivityAt) : "",
            ]),
            [
                monthlyRangeLabel,
                "Total",
                "",
                "",
                monthlyTotals.leadsAdded,
                "",
                monthlyTotals.calls,
                "",
                "",
                monthlyTotals.comments,
                monthlyTotals.touchedLeads,
                monthlyTotals.productivityScore,
                "",
            ],
        ];

        downloadCsv(`agent-monthly-data-${selectedMonthlyRange.dateFrom}-to-${selectedMonthlyRange.dateTo}.csv`, rows);
    };


    const [selectedCallEmployeeRow, setSelectedCallEmployeeRow] =
        useState<EmployeeCallSummaryRow | null>(null);

    const [callFilterDateFrom, setCallFilterDateFrom] = useState("");
    const [callFilterTimeFrom, setCallFilterTimeFrom] = useState("23:00");
    const [callFilterDateTo, setCallFilterDateTo] = useState("");
    const [callFilterTimeTo, setCallFilterTimeTo] = useState("08:00");
    const callSummaryFilterRange = useMemo(
        () => getCallSummaryFilterRange(
            callFilterDateFrom,
            callFilterTimeFrom,
            callFilterDateTo,
            callFilterTimeTo
        ),
        [callFilterDateFrom, callFilterTimeFrom, callFilterDateTo, callFilterTimeTo]
    );

    const leadCallStatsQuery = useQuery({
        queryKey: ["lead-call-summary", "admin", callFilterDateFrom, callFilterTimeFrom, callFilterDateTo, callFilterTimeTo],
        queryFn: () => getLeadCallSummary(callSummaryFilterRange),
        placeholderData: keepPreviousData,
        refetchInterval: 15_000,
        refetchOnWindowFocus: true,
    });

    const selectedAttendanceRecords = attendanceRecordsQuery.data || [];
    const allAttendanceGroups = useMemo(
        () =>
            departmentFilteredAttendanceEmployeeOptions.map((employee) => ({
                employee,
                attendance: (allAttendanceQuery.data || []).filter((record) => String(record.employee) === employee._id),
            })),
        [allAttendanceQuery.data, departmentFilteredAttendanceEmployeeOptions]
    );
    const isAllAttendanceLoading = !effectiveAttendanceEmployeeId && allAttendanceQuery.isLoading;
    const openEmployeeAttendance = (employeeId: string) => {
        navigate(`/admin/employees/${encodeURIComponent(employeeId)}?tab=attendance`);
    };

    const employeeCallRows = useMemo(() => {
        return (leadCallStatsQuery.data || []).map((row) => ({
            ...row,
            crmBusinessId: activeBusinessId,
            crmBusinessName: activeBusinessName,
            leads: row.leads.map((lead) => ({ ...lead, callLogs: [] })),
        }));
    }, [activeBusinessId, activeBusinessName, leadCallStatsQuery.data]);

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

    const clearCallFilters = () => {
        setCallFilterDateFrom("");
        setCallFilterTimeFrom("");
        setCallFilterDateTo("");
        setCallFilterTimeTo("");
    };

    // const totalCallAttempts = useMemo(() => {
    //     return totalLoggedLeadCalls + totalNotConnectedCalls;
    // }, [totalLoggedLeadCalls, totalNotConnectedCalls]);

    // const clearCallFilters = () => {
    //     setCallFilterDateFrom("");
    //     setCallFilterDateTo("");
    // };

    // const applyTodayCallFilter = () => {
    //     const today = formatDateInputValue(new Date());

    //     setCallFilterDateFrom(today);
    //     setCallFilterDateTo(today);
    // };

    // const applyThisMonthCallFilter = () => {
    //     const today = new Date();
    //     const firstDay = new Date(today.getFullYear(), today.getMonth(), 1);

    //     setCallFilterDateFrom(formatDateInputValue(firstDay));
    //     setCallFilterDateTo(formatDateInputValue(today));
    // };

    return (
        <AdminLayout>
            <section className="admin-dashboard-page min-h-full space-y-5">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
                    <div>
                        <p className="text-xs font-semibold uppercase tracking-[0.16em] text-white/45">Admin Dashboard</p>
                        <h2 className="mt-1 text-2xl font-semibold text-white">Agent Lead Progress</h2>
                        <p className="mt-1 text-sm text-white/55">Live lead workload, movement, and productivity using PH time for today.</p>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                        <span className="rounded-lg border border-white/10 bg-white/[0.05] px-3 py-2 text-xs font-semibold text-white/55">
                            Updated {data?.generatedAt ? formatPhDateTime(data.generatedAt) : "loading"}
                        </span>
                        <button
                            className="inline-flex h-10 items-center gap-2 rounded-lg border border-white/10 bg-white px-3 text-sm font-semibold text-slate-950 transition hover:bg-slate-100 disabled:opacity-60"
                            type="button"
                            onClick={() => void refetch()}
                            disabled={isFetching}
                        >
                            <FiRefreshCw className={["size-4", isFetching ? "animate-spin" : ""].join(" ")} aria-hidden="true" />
                            Refresh
                        </button>
                    </div>
                </div>

                <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
                    <KpiCard label="Active Agents" value={formatNumber(summary?.totalActiveAgents)} helper={`${formatNumber(summary?.onlineAgents)} online or available now`} icon={FiUsers} accent="green" />
                    <KpiCard label="Open Leads" value={formatNumber(summary?.totalOpenLeads)} helper={`${formatNumber(summary?.unassignedLeads)} still unassigned`} icon={FiTarget} accent="blue" />
                    <KpiCard label="Due Follow-ups" value={formatNumber(summary?.dueFollowUps)} helper={`${formatNumber(summary?.touchedLeadsToday)} leads touched today`} icon={FiClock} accent="orange" />
                    <KpiCard label="Productivity Today" value={formatNumber(summary?.activityToday)} helper={`${formatNumber(summary?.commentsToday)} employee comments logged`} icon={FiTrendingUp} accent="purple" />
                </div>

                <CallDashboardPanel businessName={activeBusinessName} />

                {isError && (
                    <section className="rounded-lg border border-red-200 bg-red-50 p-4 text-red-700">
                        <p className="font-semibold">Dashboard data could not load.</p>
                        <p className="mt-1 text-sm">Please refresh after the backend is running.</p>
                    </section>
                )}

                <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_18rem] 2xl:grid-cols-[minmax(0,1fr)_20rem]">
                    <section className="dashboard-panel-accent dashboard-accent-green overflow-hidden rounded-lg border border-slate-300 bg-white text-slate-950 shadow-lg shadow-slate-950/10">
                        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-300 bg-slate-50 px-4 py-4">
                            <div>
                                <p className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">Agent Productivity</p>
                                <h3 className="mt-1 text-base font-semibold">Lead progress by agent</h3>
                            </div>
                            <Link className="inline-flex h-9 items-center gap-2 rounded-lg bg-[#842cff] px-3 text-sm font-semibold text-white transition hover:brightness-110" to="/admin/leads">
                                <FiTarget className="size-4" aria-hidden="true" />
                                Manage Leads
                            </Link>
                        </div>
                        <div className="overflow-x-auto">
                            <table className="w-full min-w-[50rem] table-fixed border-separate border-spacing-0">
                                <colgroup>
                                    <col className="w-[35%]" />
                                    <col className="w-[9%]" />
                                    <col className="w-[8%]" />
                                    <col className="w-[13%]" />
                                    <col className="w-[9%]" />
                                    <col className="w-[12%]" />
                                    <col className="w-[14%]" />
                                </colgroup>
                                <thead className="bg-white text-[0.68rem] uppercase tracking-[0.12em] text-slate-500">
                                    <tr>
                                        <th className="px-3 py-3 text-left font-semibold">Agent</th>
                                        <th className="px-3 py-3 text-center font-semibold">Total</th>
                                        <th className="px-3 py-3 text-center font-semibold">NEW</th>
                                        <th className="px-3 py-3 text-center font-semibold">FOLLOW UP</th>
                                        <th className="px-3 py-3 text-center font-semibold">CALLS</th>
                                        <th className="px-3 py-3 text-center font-semibold">QUALIFIED</th>
                                        <th className="px-3 py-3 text-center font-semibold">ARCHIVE/DEAD</th>
                                    </tr>
                                </thead>
                                <tbody className="divide-y divide-slate-200">
                                    {isLoading && (
                                        <tr>
                                            <td className="px-4 py-8 text-center text-sm text-slate-500" colSpan={7}>Loading agent metrics...</td>
                                        </tr>
                                    )}
                                    {!isLoading && agents.length === 0 && (
                                        <tr>
                                            <td className="px-4 py-8" colSpan={7}>
                                                <EmptyPanel title="No agent lead data yet" message="Agents will appear here after they have lead assignments or lead activity." />
                                            </td>
                                        </tr>
                                    )}
                                    {visibleAgents.map((agent) => <AgentProgressRow key={agent.employeeId} agent={agent} />)}
                                    {!isLoading && visibleAgents.length > 0 && visibleAgents.length < agentRowsPerPage && Array.from({ length: agentRowsPerPage - visibleAgents.length }).map((_, index) => (
                                        <tr key={`agent-placeholder-${index}`} aria-hidden="true" className="pointer-events-none">
                                            <td className="h-[4.5rem] px-3 py-0" colSpan={7} />
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                        {!isLoading && agents.length > 0 && (
                            <div className="flex flex-col gap-3 border-t border-slate-300 bg-white px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
                                <p className="text-xs font-semibold text-slate-500">
                                    Showing {agentPageStart} to {agentPageEnd} of {formatNumber(agents.length)} agents
                                </p>
                                <div className="flex items-center gap-1">
                                    <button
                                        type="button"
                                        className="flex size-8 items-center justify-center rounded-lg border border-slate-300 bg-white text-slate-500 transition hover:border-[#842cff] hover:text-[#6426d9] disabled:cursor-not-allowed disabled:opacity-40"
                                        onClick={() => setAgentPage((page) => Math.max(page - 1, 1))}
                                        disabled={currentAgentPage === 1}
                                        aria-label="Previous agent page"
                                    >
                                        <FiChevronLeft className="size-4" aria-hidden="true" />
                                    </button>
                                    {agentPageNumbers.map((page, index) => {
                                        const previousPage = agentPageNumbers[index - 1];
                                        const hasGap = previousPage && page - previousPage > 1;

                                        return (
                                            <span key={page} className="flex items-center gap-1">
                                                {hasGap && <span className="px-1 text-xs font-semibold text-slate-400">...</span>}
                                                <button
                                                    type="button"
                                                    className={[
                                                        "flex size-8 items-center justify-center rounded-lg border text-sm font-semibold transition",
                                                        currentAgentPage === page
                                                            ? "border-[#842cff] bg-[#842cff] text-white"
                                                            : "border-slate-300 bg-white text-slate-600 hover:border-[#842cff] hover:text-[#6426d9]",
                                                    ].join(" ")}
                                                    onClick={() => setAgentPage(page)}
                                                    aria-label={`Agent page ${page}`}
                                                    aria-current={currentAgentPage === page ? "page" : undefined}
                                                >
                                                    {page}
                                                </button>
                                            </span>
                                        );
                                    })}
                                    <button
                                        type="button"
                                        className="flex size-8 items-center justify-center rounded-lg border border-slate-300 bg-white text-slate-500 transition hover:border-[#842cff] hover:text-[#6426d9] disabled:cursor-not-allowed disabled:opacity-40"
                                        onClick={() => setAgentPage((page) => Math.min(page + 1, totalAgentPages))}
                                        disabled={currentAgentPage === totalAgentPages}
                                        aria-label="Next agent page"
                                    >
                                        <FiChevronRight className="size-4" aria-hidden="true" />
                                    </button>
                                </div>
                            </div>
                        )}
                        <div className="dashboard-panel-accent dashboard-accent-indigo border-t border-slate-300 bg-slate-50/80 px-4 py-4">
                            <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                                <div>
                                    <p className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">Monthly Data</p>
                                    <h3 className="mt-1 text-base font-semibold text-slate-900">Agent activity for {monthlyRangeLabel}</h3>
                                </div>
                                <div className="flex flex-wrap items-center gap-2">
                                    <span className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-semibold text-slate-600">
                                        {formatNumber(monthlyTotals.touchedLeads)} touched · {formatNumber(monthlyTotals.calls)} calls · {formatNumber(monthlyTotals.comments)} comments
                                    </span>
                                    <button
                                        type="button"
                                        className="inline-flex h-10 items-center gap-2 rounded-lg border border-slate-300 bg-white px-3 text-sm font-semibold text-slate-800 shadow-sm transition hover:border-[#842cff] hover:text-[#6426d9] disabled:cursor-not-allowed disabled:opacity-55"
                                        onClick={handleExportMonthlyData}
                                        disabled={monthlyAgents.length === 0}
                                    >
                                        <FiDownload className="size-4" aria-hidden="true" />
                                        Export
                                    </button>
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
                                            className="flex h-10 min-w-[12rem] items-center justify-between gap-3 rounded-lg border border-slate-300 bg-white px-3 text-left text-sm font-semibold text-slate-800 shadow-sm transition hover:border-[#842cff] focus:outline-none focus:ring-2 focus:ring-[#842cff]/30"
                                            onClick={() => setIsMonthMenuOpen((isOpen) => !isOpen)}
                                            aria-haspopup="menu"
                                            aria-expanded={isMonthMenuOpen}
                                        >
                                            <span className="flex min-w-0 items-center gap-2">
                                                <FiCalendar className="size-4 shrink-0 text-[#842cff]" aria-hidden="true" />
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
                                                                isSelected ? "bg-[#842cff] text-white" : "text-slate-700 hover:bg-violet-50 hover:text-[#6426d9]",
                                                            ].join(" ")}
                                                            onClick={() => {
                                                                setSelectedMonth(month);
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
                                        <col className="w-[28%]" />
                                        <col className="w-[9%]" />
                                        <col className="w-[10%]" />
                                        <col className="w-[8%]" />
                                        <col className="w-[10%]" />
                                        <col className="w-[12%]" />
                                        <col className="w-[9%]" />
                                        <col className="w-[8%]" />
                                        <col className="w-[6%]" />
                                    </colgroup>
                                    <thead className="bg-white text-[0.62rem] uppercase tracking-[0.08em] text-slate-500">
                                        <tr>
                                            <th className="px-2 py-3 text-left font-semibold">Agent</th>
                                            <th className="px-2 py-3 text-center font-semibold">Added</th>
                                            <th className="px-2 py-3 text-center font-semibold">Follow Up</th>
                                            <th className="px-2 py-3 text-center font-semibold">Calls</th>
                                            <th className="px-2 py-3 text-center font-semibold">Qualified</th>
                                            <th className="px-2 py-3 text-center font-semibold">Archive/Dead</th>
                                            <th className="px-2 py-3 text-center font-semibold">Comments</th>
                                            <th className="px-2 py-3 text-center font-semibold">Touched</th>
                                            <th className="px-2 py-3 text-center font-semibold">Score</th>
                                        </tr>
                                    </thead>
                                    <tbody className="divide-y divide-slate-200">
                                        {isLoading && (
                                            <tr>
                                                <td className="px-4 py-8 text-center text-sm text-slate-500" colSpan={9}>Loading monthly metrics...</td>
                                            </tr>
                                        )}
                                        {!isLoading && monthlyAgents.length === 0 && (
                                            <tr>
                                                <td className="px-4 py-8" colSpan={9}>
                                                    <EmptyPanel title="No monthly data yet" message="Choose another month or wait for lead activity to appear here." />
                                                </td>
                                            </tr>
                                        )}
                                        {visibleMonthlyAgents.map((row) => (
                                            <MonthlyAgentRow key={row.employeeId} row={row} onQualifiedClick={setQualifiedLeadRow} />
                                        ))}
                                        {!isLoading && visibleMonthlyAgents.length > 0 && visibleMonthlyAgents.length < monthlyRowsPerPage && Array.from({ length: monthlyRowsPerPage - visibleMonthlyAgents.length }).map((_, index) => (
                                            <tr key={`monthly-placeholder-${index}`} aria-hidden="true" className="pointer-events-none">
                                                <td className="h-[4.5rem] px-3 py-0" colSpan={9} />
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                                {!isLoading && monthlyAgents.length > 0 && (
                                    <div className="flex flex-col gap-3 border-t border-slate-300 bg-white px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
                                        <p className="text-xs font-semibold text-slate-500">
                                            Showing {monthlyPageStart} to {monthlyPageEnd} of {formatNumber(monthlyAgents.length)} monthly rows
                                        </p>
                                        <div className="flex items-center gap-1">
                                            <button
                                                type="button"
                                                className="flex size-8 items-center justify-center rounded-lg border border-slate-300 bg-white text-slate-500 transition hover:border-[#842cff] hover:text-[#6426d9] disabled:cursor-not-allowed disabled:opacity-40"
                                                onClick={() => setMonthlyPage((page) => Math.max(page - 1, 1))}
                                                disabled={currentMonthlyPage === 1}
                                                aria-label="Previous monthly data page"
                                            >
                                                <FiChevronLeft className="size-4" aria-hidden="true" />
                                            </button>
                                            {monthlyPageNumbers.map((page, index) => {
                                                const previousPage = monthlyPageNumbers[index - 1];
                                                const hasGap = previousPage && page - previousPage > 1;

                                                return (
                                                    <span key={page} className="flex items-center gap-1">
                                                        {hasGap && <span className="px-1 text-xs font-semibold text-slate-400">...</span>}
                                                        <button
                                                            type="button"
                                                            className={[
                                                                "flex size-8 items-center justify-center rounded-lg border text-sm font-semibold transition",
                                                                currentMonthlyPage === page
                                                                    ? "border-[#842cff] bg-[#842cff] text-white"
                                                                    : "border-slate-300 bg-white text-slate-600 hover:border-[#842cff] hover:text-[#6426d9]",
                                                            ].join(" ")}
                                                            onClick={() => setMonthlyPage(page)}
                                                            aria-label={`Monthly data page ${page}`}
                                                            aria-current={currentMonthlyPage === page ? "page" : undefined}
                                                        >
                                                            {page}
                                                        </button>
                                                    </span>
                                                );
                                            })}
                                            <button
                                                type="button"
                                                className="flex size-8 items-center justify-center rounded-lg border border-slate-300 bg-white text-slate-500 transition hover:border-[#842cff] hover:text-[#6426d9] disabled:cursor-not-allowed disabled:opacity-40"
                                                onClick={() => setMonthlyPage((page) => Math.min(page + 1, totalMonthlyPages))}
                                                disabled={currentMonthlyPage === totalMonthlyPages}
                                                aria-label="Next monthly data page"
                                            >
                                                <FiChevronRight className="size-4" aria-hidden="true" />
                                            </button>
                                        </div>
                                    </div>
                                )}
                            </div>
                        </div>
                        {/* Call logger */}
                        <div className="flex flex-wrap items-center justify-between gap-3 border-t-6 border-slate-300 bg-slate-50 px-4 py-4">
                            <div>
                                <p className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">
                                    Log Call Counts
                                </p>

                                <h3 className="mt-1 text-base font-semibold text-slate-900">
                                    {leadCallStatsQuery.isLoading && !leadCallStatsQuery.data
                                        ? "Loading call data"
                                        : `${formatNumber(totalLoggedLeadCalls)} connected calls`}
                                </h3>

                                <p className="mt-1 text-xs font-semibold text-rose-600">
                                    {formatNumber(totalNotConnectedCalls)} not connected
                                </p>

                                <p className="mt-1 text-xs font-semibold text-blue-600">
                                    {formatNumber(totalVoicemails)} voicemails
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
                                            className="h-9 w-28 rounded-lg border border-slate-300 bg-white px-3 text-sm font-semibold text-slate-800 outline-none transition focus:border-[#842cff] focus:ring-2 focus:ring-[#842cff]/20"
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
                                            className="h-9 w-28 rounded-lg border border-slate-300 bg-white px-3 text-sm font-semibold text-slate-800 outline-none transition focus:border-[#842cff] focus:ring-2 focus:ring-[#842cff]/20"
                                            value={callFilterTimeTo}
                                            onChange={(event) => setCallFilterTimeTo(event.target.value)}
                                        />
                                    </div>
                                </label>
                                <button
                                    type="button"
                                    className="mt-5 h-9 rounded-lg border border-slate-300 bg-white px-3 text-sm font-semibold text-slate-700 transition hover:border-[#842cff]/40 hover:text-[#6426d9]"
                                    onClick={() => {
                                        const shiftStart = getShiftStartDateFromTimestamp(new Date().toISOString());
                                        const shiftEnd = getShiftEndDate(shiftStart);

                                        setCallFilterDateFrom(formatDateInputValue(shiftStart));
                                        setCallFilterTimeFrom(formatTimeInputValue(shiftStart));
                                        setCallFilterDateTo(formatDateInputValue(shiftEnd));
                                        setCallFilterTimeTo(formatTimeInputValue(shiftEnd));
                                    }}
                                >
                                    Today
                                </button>
                                <button
                                    type="button"
                                    className="mt-5 h-9 rounded-lg border border-slate-300 bg-white px-3 text-sm font-semibold text-slate-700 transition hover:border-[#842cff]/40 hover:text-[#6426d9]"
                                    onClick={() => {
                                        const today = new Date();
                                        const firstDay = new Date(today.getFullYear(), today.getMonth(), 1);

                                        setCallFilterDateFrom(formatDateInputValue(firstDay));
                                        setCallFilterTimeFrom("00:00");
                                        setCallFilterDateTo(formatDateInputValue(today));
                                        setCallFilterTimeTo(formatTimeInputValue(today));
                                    }}
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
                                    to="/admin/leads"
                                >
                                    <FiTarget className="size-4" aria-hidden="true" />
                                    Manage Leads
                                </Link>
                            </div>
                        </div>
                        <div className="flex w-full flex-col p-4 pt-0">
                            {leadCallStatsQuery.isLoading && !leadCallStatsQuery.data ? (
                                <div className="mt-4">
                                    <EmptyPanel
                                        title="Loading call counts"
                                        message="Getting logged calls from the call stats table."
                                    />
                                </div>
                            ) : employeeCallRows.length === 0 ? (
                                <div className="mt-4">
                                    <EmptyPanel
                                        title="No logged calls yet"
                                        message="Once an employee logs a call outcome, the lead call data will appear here."
                                    />
                                </div>
                            ) : (
                                <div className="mt-4 overflow-x-auto rounded-lg border border-slate-300 bg-white">
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
                                                <th className="px-3 py-3 text-left font-semibold">Employee</th>
                                                <th className="px-3 py-3 text-center font-semibold">Connected</th>
                                                <th className="px-3 py-3 text-center font-semibold">Not Connected</th>
                                                <th className="px-3 py-3 text-center font-semibold">Voicemails</th>
                                                <th className="px-3 py-3 text-center font-semibold">Leads</th>
                                                <th className="px-3 py-3 text-left font-semibold">Last Call</th>
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

                                                        {(row.employeeRole || row.employeeTeam || row.crmBusinessName) && (
                                                            <p className="mt-0.5 truncate text-xs text-slate-500">
                                                                {[row.employeeRole, row.employeeTeam, row.crmBusinessName]
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
                                                            className="inline-flex h-8 items-center justify-center rounded-md border border-emerald-200 bg-emerald-50 px-3 text-xs font-semibold text-emerald-700 transition hover:border-emerald-400 hover:bg-emerald-100 focus:outline-none focus:ring-2 focus:ring-emerald-300"
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
                        <div className="hidden" aria-hidden="true">
                            <div className="mb-4 flex flex-col gap-3 rounded-lg border border-slate-300 bg-white p-4 sm:flex-row sm:items-end sm:justify-between">
                                <div>
                                    <p className="text-xl font-semibold uppercase tracking-[0.14em] text-slate-800">Employee Attendance</p>
                                    <p className="mt-1 text-xs text-slate-500">Choose an employee to view 11PM to 8AM shift rows, late, undertime, and over-break details.</p>
                                </div>

                                <div className="grid w-full gap-3 sm:w-[42rem] sm:grid-cols-[13rem_minmax(0,1fr)]">
                                    <label className="min-w-0">
                                        <span className="text-[0.65rem] font-semibold uppercase tracking-[0.12em] text-slate-500">Department</span>
                                        <select
                                            className="mt-1 h-10 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm font-semibold text-slate-800 outline-none transition hover:border-[#842cff] focus:border-[#842cff] focus:ring-2 focus:ring-[#842cff]/20 disabled:cursor-not-allowed disabled:opacity-60"
                                            value={selectedAttendanceDepartment}
                                            onChange={(event) => {
                                                setSelectedAttendanceDepartment(event.target.value);
                                                setSelectedAttendanceEmployeeId("");
                                                setIsAttendanceSelectionCleared(true);
                                                setAttendanceEmployeeSearch("");
                                                setIsAttendanceEmployeeMenuOpen(false);
                                            }}
                                            disabled={attendanceEmployeeOptions.length === 0}
                                        >
                                            <option value="all">All departments</option>
                                            {attendanceDepartmentOptions.map((department) => (
                                                <option key={department} value={department}>
                                                    {department}
                                                </option>
                                            ))}
                                        </select>
                                    </label>

                                    <div className="min-w-0">
                                    <div
                                        className="relative"
                                        onBlur={(event) => {
                                            if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
                                                setIsAttendanceEmployeeMenuOpen(false);
                                            }
                                        }}
                                    >
                                        <span className="text-[0.65rem] font-semibold uppercase tracking-[0.12em] text-slate-500">Employee</span>
                                        <div className="mt-1 flex gap-2">
                                            <button
                                                type="button"
                                                className="flex h-10 min-w-0 flex-1 items-center justify-between gap-3 rounded-lg border border-slate-300 bg-white px-3 text-left text-sm font-semibold text-slate-800 outline-none transition hover:border-[#842cff] focus:border-[#842cff] focus:ring-2 focus:ring-[#842cff]/20"
                                                onClick={() => setIsAttendanceEmployeeMenuOpen((isOpen) => !isOpen)}
                                                disabled={departmentFilteredAttendanceEmployeeOptions.length === 0}
                                                aria-haspopup="listbox"
                                                aria-expanded={isAttendanceEmployeeMenuOpen}
                                            >
                                                <span className="truncate">{departmentFilteredAttendanceEmployeeOptions.length === 0 ? "No employees found" : selectedAttendanceEmployeeLabel}</span>
                                                <FiChevronDown className={["size-4 shrink-0 text-slate-500 transition", isAttendanceEmployeeMenuOpen ? "rotate-180" : ""].join(" ")} aria-hidden="true" />
                                            </button>
                                            <button
                                                type="button"
                                                className="inline-flex h-10 shrink-0 items-center justify-center rounded-lg border border-rose-200 bg-rose-50 px-3 text-sm font-semibold text-rose-700 transition hover:border-rose-300 hover:bg-rose-100 disabled:cursor-not-allowed disabled:opacity-50"
                                                onClick={() => {
                                                    setSelectedAttendanceEmployeeId("");
                                                    setIsAttendanceSelectionCleared(true);
                                                    setAttendanceEmployeeSearch("");
                                                    setIsAttendanceEmployeeMenuOpen(false);
                                                }}
                                                disabled={!effectiveAttendanceEmployeeId && !attendanceEmployeeSearch}
                                            >
                                                Clear
                                            </button>
                                        </div>

                                        {isAttendanceEmployeeMenuOpen && (
                                            <div className="absolute right-0 z-30 mt-2 w-full overflow-hidden rounded-lg border border-slate-300 bg-white shadow-xl shadow-slate-950/15">
                                                <div className="border-b border-slate-200 bg-slate-50 p-2">
                                                    <div className="flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-3 focus-within:border-[#842cff] focus-within:ring-2 focus-within:ring-[#842cff]/20">
                                                        <FiSearch className="size-4 shrink-0 text-slate-400" aria-hidden="true" />
                                                        <input
                                                            type="search"
                                                            className="h-10 min-w-0 flex-1 bg-transparent text-sm font-semibold text-slate-800 outline-none placeholder:text-slate-400"
                                                            placeholder="Search employee name or code"
                                                            value={attendanceEmployeeSearch}
                                                            onChange={(event) => setAttendanceEmployeeSearch(event.target.value)}
                                                            autoFocus
                                                        />
                                                    </div>
                                                </div>
                                                <div className="content-scroll max-h-72 overflow-y-auto p-1" role="listbox">
                                                    {filteredAttendanceEmployeeOptions.length === 0 ? (
                                                        <p className="px-3 py-4 text-center text-sm font-semibold text-slate-500">No matching employee found.</p>
                                                    ) : (
                                                        filteredAttendanceEmployeeOptions.map((employee) => {
                                                            const isSelected = employee._id === effectiveAttendanceEmployeeId;

                                                            return (
                                                                <button
                                                                    key={employee._id}
                                                                    type="button"
                                                                    className={[
                                                                        "flex w-full items-center justify-between gap-3 rounded-md px-3 py-2 text-left text-sm transition",
                                                                        isSelected ? "bg-[#842cff] text-white" : "text-slate-700 hover:bg-violet-50 hover:text-[#6426d9]",
                                                                    ].join(" ")}
                                                                    onMouseDown={(event) => event.preventDefault()}
                                                                    onClick={() => {
                                                                        setSelectedAttendanceEmployeeId(employee._id);
                                                                        setIsAttendanceSelectionCleared(false);
                                                                        setAttendanceEmployeeSearch("");
                                                                        setIsAttendanceEmployeeMenuOpen(false);
                                                                    }}
                                                                    role="option"
                                                                    aria-selected={isSelected}
                                                                >
                                                                    <span className="min-w-0">
                                                                        <span className="block truncate font-semibold">{employee.name || employee.employeeCode || "Employee"}</span>
                                                                        <span className={["mt-0.5 block truncate text-xs", isSelected ? "text-white/75" : "text-slate-500"].join(" ")}>{employee.role || "Employee"} · {employee.team || "Unassigned"}</span>
                                                                    </span>
                                                                    {isSelected && <FiCheckCircle className="size-4 shrink-0" aria-hidden="true" />}
                                                                </button>
                                                            );
                                                        })
                                                    )}
                                                </div>
                                            </div>
                                        )}
                                    </div>
                                    </div>
                                </div>
                            </div>

                            {employeesQuery.isLoading || attendanceRecordsQuery.isLoading || isAllAttendanceLoading ? (
                                <EmptyPanel title="Loading attendance" message="Getting employee attendance records for the selected employee." />
                            ) : selectedAttendanceEmployee ? (
                                <AttendancePanel employee={selectedAttendanceEmployee} attendance={selectedAttendanceRecords} selectedAttendanceDate={attendanceSelectedShiftDate} attendanceDateFrom={attendanceDateFrom} attendanceDateTo={attendanceDateTo} onSelectedAttendanceDateChange={setAttendanceSelectedShiftDate} onAttendanceDateFromChange={setAttendanceDateFrom} onAttendanceDateToChange={setAttendanceDateTo} />
                            ) : (
                                <AttendancePanel employee={null} attendance={[]} attendanceGroups={allAttendanceGroups} selectedAttendanceDate={attendanceSelectedShiftDate} attendanceDateFrom={attendanceDateFrom} attendanceDateTo={attendanceDateTo} onSelectedAttendanceDateChange={setAttendanceSelectedShiftDate} onAttendanceDateFromChange={setAttendanceDateFrom} onAttendanceDateToChange={setAttendanceDateTo} />
                            )}
                        </div>
                        {/* Attendance panel */}

                    </section>

                    <div className="space-y-4">
                        <section className="dashboard-panel-accent dashboard-accent-blue rounded-lg border border-slate-300 bg-white p-3 text-slate-950 shadow-lg shadow-slate-950/10">
                            <div className="flex items-center justify-between gap-3">
                                <div>
                                    <p className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">Lead Status</p>
                                    <h3 className="mt-1 text-base font-semibold">Current total: {formatNumber(pipelineTotals.total)}</h3>
                                </div>
                                <FiBarChart2 className="size-5 text-[#842cff]" aria-hidden="true" />
                            </div>
                            <div className="mt-4 space-y-3">
                                {pipelineBars.map((item) => (
                                    <div key={item.label}>
                                        <div className="flex justify-between gap-3 text-sm">
                                            <span className="font-semibold text-slate-700">{item.label}</span>
                                            <span className="text-slate-500">{formatNumber(item.value)}</span>
                                        </div>
                                        <div className="mt-2 h-2 rounded-full bg-slate-200">
                                            <div className={`h-full rounded-full ${item.color}`} style={{ width: `${Math.max((item.value / maxPipelineValue) * 100, item.value > 0 ? 5 : 0)}%` }} />
                                        </div>
                                    </div>
                                ))}
                            </div>
                        </section>

                        <section className="dashboard-panel-accent dashboard-accent-teal rounded-lg border border-slate-300 bg-white p-3 text-slate-950 shadow-lg shadow-slate-950/10">
                            <div className="flex items-center justify-between gap-3">
                                <div>
                                    <p className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">Online Status</p>
                                    <h3 className="mt-1 text-base font-semibold">{formatNumber(availableAgentCount)} available now</h3>
                                </div>
                                <FiActivity className="size-5 text-emerald-500" aria-hidden="true" />
                            </div>
                            <div className="content-scroll mt-4 max-h-[19rem] space-y-3 overflow-y-auto pr-1">
                                {onlineStatusAgents.length === 0 && <EmptyPanel title="No employees yet" message="Employee availability will show here once employees are added." />}
                                {onlineStatusAgents.map((agent) => (
                                    <div key={agent.employeeId} className="rounded-lg border border-slate-300 bg-slate-50 p-3">
                                        <div className="flex items-start justify-between gap-3">
                                            <div className="flex min-w-0 items-start gap-2">
                                                <span className={`mt-1.5 size-2.5 shrink-0 rounded-full ${availabilityDotClass(agent.availabilityStatus)}`} />
                                                <div className="min-w-0">
                                                    <p className="truncate text-sm font-semibold text-slate-950">{agent.employeeName}</p>
                                                    <p className="mt-1 truncate text-xs text-slate-500">{[agent.role, agent.team, agent.businessName].filter(Boolean).join(" · ")}</p>
                                                    <p className="mt-1 text-xs text-slate-500">{formatNumber(agent.assignedLeads)} active leads</p>
                                                </div>
                                            </div>
                                            <button
                                                type="button"
                                                className={`shrink-0 rounded-md border px-2 py-1 text-xs font-semibold transition hover:brightness-95 focus:outline-none focus:ring-2 focus:ring-[#842cff]/30 ${availabilityClass(agent.availabilityStatus)}`}
                                                onClick={() => openEmployeeAttendance(agent.employeeId)}
                                                aria-label={`View ${agent.employeeName}'s attendance`}
                                                title="View employee attendance"
                                            >
                                                {normalizeEmployeeAvailabilityStatus(agent.availabilityStatus)}
                                            </button>
                                        </div>
                                    </div>
                                ))}
                            </div>
                        </section>

                        <section className="dashboard-panel-accent dashboard-accent-teal rounded-lg border border-slate-300 bg-white p-3 text-slate-950 shadow-lg shadow-slate-950/10">
                            <div className="flex items-start justify-between gap-3">
                                <div className="min-w-0">
                                    <p className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">Agent Calls</p>
                                    <h3 className="mt-2 text-2xl font-semibold">{formatNumber(selectedCallCount)}</h3>
                                    <p className="mt-1 text-sm leading-5 text-slate-600">{selectedCallHelper}</p>
                                </div>
                                <span className="dashboard-accent-icon flex size-10 shrink-0 items-center justify-center rounded-lg border border-emerald-200 bg-emerald-50 text-[#10ac84]">
                                    <FiPhoneCall className="size-5" aria-hidden="true" />
                                </span>
                            </div>
                            <div className="mt-4 space-y-2">
                                <label className="block text-[0.65rem] font-semibold uppercase tracking-[0.14em] text-slate-500" htmlFor="agent-call-employee">
                                    Employee
                                </label>
                                <div className="relative">
                                    <select
                                        id="agent-call-employee"
                                        className="h-10 w-full appearance-none rounded-lg border border-slate-300 bg-white px-3 pr-9 text-sm font-semibold text-slate-800 shadow-sm outline-none transition focus:border-[#10ac84] focus:ring-2 focus:ring-emerald-100"
                                        value={selectedCallEmployeeId}
                                        onChange={(event) => setSelectedCallEmployeeId(event.target.value)}
                                    >
                                        <option value="all">All employees</option>
                                        {callEmployeeOptions.map((employee) => (
                                            <option key={employee.id} value={employee.id}>
                                                {employee.name}
                                            </option>
                                        ))}
                                    </select>
                                    <FiChevronDown className="pointer-events-none absolute right-3 top-1/2 size-4 -translate-y-1/2 text-slate-500" aria-hidden="true" />
                                </div>

                                <label className="block pt-1 text-[0.65rem] font-semibold uppercase tracking-[0.14em] text-slate-500" htmlFor="agent-call-range">
                                    Period
                                </label>
                                <div className="relative">
                                    <select
                                        id="agent-call-range"
                                        className="h-10 w-full appearance-none rounded-lg border border-slate-300 bg-white px-3 pr-9 text-sm font-semibold text-slate-800 shadow-sm outline-none transition focus:border-[#10ac84] focus:ring-2 focus:ring-emerald-100"
                                        value={callCountRange}
                                        onChange={(event) => setCallCountRange(event.target.value as CallCountRange)}
                                    >
                                        <option value="day">Day</option>
                                        <option value="month">Month</option>
                                    </select>
                                    <FiChevronDown className="pointer-events-none absolute right-3 top-1/2 size-4 -translate-y-1/2 text-slate-500" aria-hidden="true" />
                                </div>

                                {callCountRange === "day" ? (
                                    <>
                                        <label className="block pt-1 text-[0.65rem] font-semibold uppercase tracking-[0.14em] text-slate-500" htmlFor="agent-call-date">
                                            Date
                                        </label>
                                        <input
                                            id="agent-call-date"
                                            className="h-10 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm font-semibold text-slate-800 shadow-sm outline-none transition focus:border-[#10ac84] focus:ring-2 focus:ring-emerald-100"
                                            type="date"
                                            value={selectedCallDate}
                                            onChange={(event) => setSelectedCallDate(event.target.value)}
                                        />
                                    </>
                                ) : (
                                    <>
                                        <label className="block pt-1 text-[0.65rem] font-semibold uppercase tracking-[0.14em] text-slate-500" htmlFor="agent-call-month">
                                            Month
                                        </label>
                                        <input
                                            id="agent-call-month"
                                            className="h-10 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm font-semibold text-slate-800 shadow-sm outline-none transition focus:border-[#10ac84] focus:ring-2 focus:ring-emerald-100"
                                            type="month"
                                            value={selectedMonth}
                                            onChange={(event) => {
                                                setSelectedMonth(event.target.value);
                                                setMonthlyPage(1);
                                                setIsMonthMenuOpen(false);
                                            }}
                                        />
                                    </>
                                )}
                            </div>
                        </section>
                    </div>
                </div>

                <div className="grid gap-5 xl:grid-cols-[minmax(0,0.75fr)_minmax(0,1.25fr)]">
                    <section className="dashboard-panel-accent dashboard-accent-purple rounded-lg border border-slate-300 bg-white p-4 text-slate-950 shadow-lg shadow-slate-950/10">
                        <div className="flex items-center justify-between gap-3">
                            <div>
                                <p className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">Top Agents</p>
                                <h3 className="mt-1 text-base font-semibold">Today by productivity score</h3>
                            </div>
                            <FiUserCheck className="size-5 text-[#842cff]" aria-hidden="true" />
                        </div>
                        <div className="mt-4 space-y-3">
                            {topAgents.length === 0 && <EmptyPanel title="No activity today" message="Lead touches and comments will rank agents here." />}
                            {topAgents.map((agent, index) => {
                                const maxScore = Math.max(topAgents[0]?.productivityScore || 1, 1);
                                return (
                                    <div key={agent.employeeId} className="grid grid-cols-[2rem_minmax(0,1fr)_3rem] items-center gap-3">
                                        <span className="text-xs font-semibold text-slate-400">#{index + 1}</span>
                                        <div className="min-w-0">
                                            <div className="flex justify-between gap-3">
                                                <p className="truncate text-sm font-semibold text-slate-950">{agent.employeeName}</p>
                                                <p className="text-sm font-semibold text-slate-600">{formatNumber(agent.productivityScore)}</p>
                                            </div>
                                            <div className="mt-2 h-2 rounded-full bg-slate-200">
                                                <div className="h-full rounded-full bg-[#842cff]" style={{ width: `${Math.max((agent.productivityScore / maxScore) * 100, 5)}%` }} />
                                            </div>
                                        </div>
                                        <span className="text-right text-xs text-slate-400">pts</span>
                                    </div>
                                );
                            })}
                        </div>
                    </section>

                    <section className="dashboard-panel-accent dashboard-accent-indigo rounded-lg border border-slate-300 bg-white p-4 text-slate-950 shadow-lg shadow-slate-950/10">
                        <div className="flex items-center justify-between gap-3">
                            <div>
                                <p className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">Recent Lead Activity</p>
                                <h3 className="mt-1 text-base font-semibold">Latest employee actions</h3>
                            </div>
                            <div className="flex items-center gap-2 text-slate-500">
                                <FiMessageSquare className="size-5" aria-hidden="true" />
                                <FiActivity className="size-5" aria-hidden="true" />
                                <FiCheckCircle className="size-5" aria-hidden="true" />
                            </div>
                        </div>
                        <div className="mt-4 grid gap-3 lg:grid-cols-2">
                            {(data?.recentActivity || []).length === 0 && <EmptyPanel title="No recent lead actions" message="Employee comments, status updates, and scheduled follow-ups will appear here." />}
                            {(data?.recentActivity || []).map((item) => <ActivityItem key={item.id} item={item} onOpen={setSelectedActivity} />)}
                        </div>
                    </section>
                </div>
            </section>

            {selectedActivity && (
                <LeadHistoryModal
                    activity={selectedActivity}
                    lead={leadHistoryQuery.data}
                    history={leadHistory}
                    isLoading={leadHistoryQuery.isLoading || leadHistoryQuery.isFetching}
                    isError={leadHistoryQuery.isError}
                    onClose={() => setSelectedActivity(null)}
                />
            )}
            {qualifiedLeadRow && (
                <QualifiedLeadsModal row={qualifiedLeadRow} onClose={() => setQualifiedLeadRow(null)} />
            )}

            {selectedCallEmployeeRow && (
                <EmployeeLeadCallsModal
                    row={selectedCallEmployeeRow}
                    onClose={() => setSelectedCallEmployeeRow(null)}
                />
            )}
        </AdminLayout>
    );
}
