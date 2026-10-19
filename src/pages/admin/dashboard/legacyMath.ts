import { normalizeEmployeeAvailabilityStatus, type Employee } from "../../../api/employees";
import { type AttendanceRecord } from "../../../api/attendance";
import { type AgentLeadActivity, type AgentLeadMonthlyRow, type AgentLeadProgress, type Lead, type LeadCallStat } from "../../../api/leads";
import { buildOffPhoneAttendanceSessions, type OffPhoneAttendanceSession } from "../../../lib/attendanceRecords";
import { isAttendanceTimeOutUndertime } from "../../../lib/attendanceSlots";
import { formatPhDate, formatPhDateTime } from "../../../lib/dateTime";

const numberFormatter = new Intl.NumberFormat("en-US");

const monthLabelFormatter = new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric" });

const dateRangeLabelFormatter = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" });

export const agentRowsPerPage = 5;

export const monthlyRowsPerPage = 5;

export type CallCountRange = "day" | "month";

export function formatNumber(value?: number) {
    return numberFormatter.format(value || 0);
}

export function getMonthInputValue(date: Date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");

    return `${year}-${month}`;
}

export function formatMonthLabel(monthKey?: string) {
    const [yearValue, monthValue] = String(monthKey || "").split("-").map(Number);

    if (!yearValue || !monthValue) {
        return "Selected month";
    }

    return monthLabelFormatter.format(new Date(yearValue, monthValue - 1, 1));
}

export function formatDateInputValue(date: Date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");

    return `${year}-${month}-${day}`;
}

export function formatTimeInputValue(date: Date) {
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

export function getMonthlyDashboardDateRange(monthKey?: string) {
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

export function formatDateRangeLabel(dateFrom: string, dateTo: string) {
    const start = parseDateInputValue(dateFrom);
    const end = parseDateInputValue(dateTo);

    if (!start || !end) {
        return "Selected range";
    }

    return `${dateRangeLabelFormatter.format(start)} - ${dateRangeLabelFormatter.format(end)}`;
}

export function formatSingleDateLabel(value: string) {
    const date = parseDateInputValue(value);

    return date ? dateRangeLabelFormatter.format(date) : "Selected date";
}

function csvCell(value: string | number | null | undefined) {
    return `"${String(value ?? "").replaceAll('"', '""')}"`;
}

export function downloadCsv(filename: string, rows: Array<Array<string | number | null | undefined>>) {
    const csv = rows.map((row) => row.map(csvCell).join(",")).join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    link.click();
    URL.revokeObjectURL(url);
}

export function getPaginationNumbers(currentPage: number, totalPages: number) {
    const pages = new Set([1, totalPages, currentPage - 1, currentPage, currentPage + 1]);

    return Array.from(pages)
        .filter((page) => page >= 1 && page <= totalPages)
        .sort((first, second) => first - second);
}

export function activityLabelClass(action: string) {
    const normalizedAction = action.toLowerCase();
    if (normalizedAction.includes("comment")) return "bg-sky-50 text-sky-700 border-sky-200";
    if (normalizedAction.includes("status") || normalizedAction.includes("qualified")) return "bg-emerald-50 text-emerald-700 border-emerald-200";
    if (normalizedAction.includes("schedule") || normalizedAction.includes("reschedule")) return "bg-violet-50 text-violet-700 border-violet-200";
    return "bg-slate-50 text-slate-600 border-slate-300";
}

export function availabilityClass(value?: string) {
    const status = normalizeEmployeeAvailabilityStatus(value);

    if (status === "ONLINE") return "border-emerald-200 bg-emerald-50 text-emerald-700";
    if (status === "BREAK" || status === "LUNCH") return "border-amber-200 bg-amber-50 text-amber-700";
    if (status === "OFF THE PHONE") return "border-sky-200 bg-sky-50 text-sky-700";

    return "border-slate-200 bg-slate-100 text-slate-600";
}

export function availabilityDotClass(value?: string) {
    const status = normalizeEmployeeAvailabilityStatus(value);

    if (status === "ONLINE") return "bg-emerald-500";
    if (status === "BREAK" || status === "LUNCH") return "bg-amber-500";
    if (status === "OFF THE PHONE") return "bg-sky-500";

    return "bg-slate-400";
}

export function availabilitySortRank(value?: string) {
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

export type LeadHistoryItem = {
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

export function isArchivedEmployee(employee: Employee) {
    return String(employee.status || "").trim().toLowerCase() === "archived";
}

export function buildOnlineStatusRows(employees: Employee[], agents: AgentLeadProgress[], businessName: string): OnlineStatusEmployeeRow[] {
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

export function mergeAgentProgressRows(rows: AgentLeadProgress[]) {
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

export function mergeAgentMonthlyRows(rows: AgentLeadMonthlyRow[]) {
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

export function getLeadDisplayName(lead?: Lead | null, fallback?: AgentLeadActivity | null) {
    return lead?.leadName || lead?.businessName || fallback?.leadName || fallback?.businessName || "Lead";
}

export function getLeadHistory(lead?: Lead | null): LeadHistoryItem[] {
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

export type MonthlyQualifiedLead = AgentLeadMonthlyRow["qualifiedLeads"][number];

function getQualifiedLeadSearchLabel(lead: MonthlyQualifiedLead) {
    return lead.leadName || lead.businessName || lead.assignedAgentName || "";
}

export function getQualifiedLeadPath(lead: MonthlyQualifiedLead) {
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

export function latestAttendance(records: AttendanceRecord[]) {
    return [...records].sort((first, second) => new Date(second.timeIn || second.createdAt).getTime() - new Date(first.timeIn || first.createdAt).getTime());
}

export function statusBadgeClass(value?: string) {
    const status = normalizeEmployeeAvailabilityStatus(value);

    if (status === "ONLINE") return "border-emerald-200 bg-emerald-50 text-emerald-700";
    if (status === "BREAK" || status === "LUNCH") return "border-amber-200 bg-amber-50 text-amber-700";
    if (status === "OFF THE PHONE") return "border-sky-200 bg-sky-50 text-sky-700";
    return "border-slate-200 bg-slate-50 text-slate-700";
}

export function formatDateOrDash(value?: string | null) {
    return value ? formatPhDate(value) : "-";
}

const ATTENDANCE_BREAK_LIMITS_MS: Partial<Record<AttendanceRecord["source"], number>> = {
    "Break Out": 15 * 60 * 1000,
    "Lunch Break Out": 60 * 60 * 1000,
};

const SHIFT_START_HOUR = 23;

const SHIFT_LENGTH_MS = 9 * 60 * 60 * 1000;

const SHIFT_MORNING_CUTOFF_HOUR = 12;

export function getAttendanceTimestamp(record?: AttendanceRecord | null) {
    const timestamp = record?.timeIn || record?.createdAt;
    const value = timestamp ? new Date(timestamp).getTime() : 0;

    return Number.isNaN(value) ? 0 : value;
}

export function getDateValue(value?: string | null) {
    const timestamp = value ? new Date(value).getTime() : 0;
    return Number.isNaN(timestamp) ? 0 : timestamp;
}

export function formatAttendanceDuration(milliseconds: number) {
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

export function getAttendanceStatusText(record: AttendanceRecord) {
    return String(record.attendanceStatus || (isAttendanceTimeOutUndertime(record) ? "Undertime" : "")).trim().toLowerCase();
}

export function getAttendanceStatusLabel(record: AttendanceRecord) {
    return record.attendanceStatus || (isAttendanceTimeOutUndertime(record) ? "Undertime" : "No status");
}

function getBreakReturnSource(source?: AttendanceRecord["source"]) {
    if (source === "Break Out") return "Break In";
    if (source === "Lunch Break Out") return "Lunch Break In";
    return "";
}

export type AttendanceOverBreakRow = {
    id: string;
    label: string;
    startedAt: string;
    endedAt: string | null;
    durationMs: number;
    allowedMs: number;
    overMs: number;
    isOpen: boolean;
};

export type AttendanceShiftRow = {
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

export type AttendanceEmployeeGroup = {
    employee: Employee;
    attendance: AttendanceRecord[];
};

export function getShiftStartDateFromTimestamp(value?: string | null) {
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

export function getShiftEndDate(shiftStart: Date) {
    return new Date(shiftStart.getTime() + SHIFT_LENGTH_MS);
}

function getShiftDateValueFromStart(shiftStart: Date) {
    return formatDateInputValue(new Date(shiftStart.getFullYear(), shiftStart.getMonth(), shiftStart.getDate()));
}

export function getCurrentShiftDateValue() {
    return getShiftDateValueFromStart(getShiftStartDateFromTimestamp(new Date().toISOString()));
}

export function getAttendanceQueryRange(selectedDate: string, dateFrom: string, dateTo: string) {
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

export function getShiftLabel(row: AttendanceShiftRow) {
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

export function buildAttendanceShiftRows(records: AttendanceRecord[], employee?: Employee | null) {
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

export type EmployeeCallSummaryRow = {
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

export function getDateStart(value: string) {
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

export function getDateEnd(value: string) {
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

export function getCallSummaryFilterRange(
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
