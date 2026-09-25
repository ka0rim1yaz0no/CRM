import type { Request, Response } from "express";
import { Types } from "mongoose";
import { Attendance, type AttendanceSource } from "../models/Attendance";
import { Employee, employeeAvailabilityStatuses, normalizeEmployeeAvailabilityStatus, type EmployeeAvailabilityStatus } from "../models/Employee";
import { EmployeeTransaction } from "../models/EmployeeTransaction";
import { Lead, type LeadStatus } from "../models/Lead";

type AvailabilityStatus = EmployeeAvailabilityStatus;

type EmployeeReportRecord = {
  _id: Types.ObjectId;
  name?: string;
  employeeCode?: string;
  aliases?: string[];
  role?: string;
  team?: string;
  status?: string;
  availabilityStatus?: AvailabilityStatus;
};

type AttendanceReportRecord = {
  _id: Types.ObjectId;
  employee: Types.ObjectId | string;
  timeIn: Date;
  source: AttendanceSource;
};

type TransactionReportRecord = {
  _id: Types.ObjectId;
  employee: Types.ObjectId | string;
  title: string;
  description?: string;
  occurredAt: Date;
  metadata?: Record<string, unknown>;
};

type AgentReportLog = {
  id: string;
  employeeId: string;
  employeeName: string;
  action: string;
  detail: string;
  note: string;
  leadId: string;
  leadName: string;
  businessName: string;
  source: string;
  category: string;
  status: LeadStatus | "";
  followUpAt: Date | string | null;
  createdAt: Date | string | null;
};

type AgentReportRow = {
  employeeId: string;
  employeeName: string;
  employeeCode: string;
  role: string;
  team: string;
  employeeStatus: string;
  availabilityStatus: AvailabilityStatus;
  leadActions: number;
  comments: number;
  followUpsScheduled: number;
  statusUpdates: number;
  assignments: number;
  uniqueLeads: number;
  activeMinutes: number;
  idleMinutes: number;
  breakMinutes: number;
  lunchMinutes: number;
  offlineMinutes: number;
  idleSessions: number;
  lastLeadActivityAt: Date | string | null;
  lastStatusAt: Date | string | null;
  leadIds: Set<string>;
};

type StatusEvent = {
  id: string;
  employeeId: string;
  employeeName: string;
  status: AvailabilityStatus;
  detail: string;
  source: "Attendance" | "Activity";
  occurredAt: Date;
};

const availabilityStatuses: AvailabilityStatus[] = employeeAvailabilityStatuses;
const idleThresholdMs = 10 * 60 * 1000;

function normalize(value: string) {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function personNameTokens(value?: string | null) {
  return normalize(String(value || ""))
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 1);
}

function isLikelySamePersonName(first?: string | null, second?: string | null) {
  const firstTokens = personNameTokens(first);
  const secondTokens = personNameTokens(second);

  if (firstTokens.length < 2 || secondTokens.length < 2) {
    return false;
  }

  const firstFirstName = firstTokens[0];
  const secondFirstName = secondTokens[0];
  const firstLastName = firstTokens.at(-1) || "";
  const secondLastName = secondTokens.at(-1) || "";

  if (firstLastName !== secondLastName) {
    return false;
  }

  return (
    (firstFirstName.length >= 4 && secondFirstName.startsWith(firstFirstName)) ||
    (secondFirstName.length >= 4 && firstFirstName.startsWith(secondFirstName))
  );
}

function parseDate(value: unknown, fallback: Date) {
  const date = new Date(String(value || ""));

  return Number.isNaN(date.getTime()) ? fallback : date;
}

function dateValue(value: Date | string | null | undefined) {
  if (!value) {
    return 0;
  }

  const date = new Date(value);

  return Number.isNaN(date.getTime()) ? 0 : date.getTime();
}

function isLikelyLeadAgent(employee: EmployeeReportRecord) {
  const text = [employee.role, employee.team, employee.name, employee.employeeCode].filter(Boolean).join(" ");

  return /\b(agent|sales|lead|closer|setter|appointment)\b/i.test(text);
}

function createAgentRow(employee: EmployeeReportRecord): AgentReportRow {
  return {
    employeeId: String(employee._id),
    employeeName: String(employee.name || "Employee"),
    employeeCode: String(employee.employeeCode || ""),
    role: String(employee.role || "Agent"),
    team: String(employee.team || "Unassigned"),
    employeeStatus: String(employee.status || "Active"),
    availabilityStatus: normalizeEmployeeAvailabilityStatus(employee.availabilityStatus),
    leadActions: 0,
    comments: 0,
    followUpsScheduled: 0,
    statusUpdates: 0,
    assignments: 0,
    uniqueLeads: 0,
    activeMinutes: 0,
    idleMinutes: 0,
    breakMinutes: 0,
    lunchMinutes: 0,
    offlineMinutes: 0,
    idleSessions: 0,
    lastLeadActivityAt: null,
    lastStatusAt: null,
    leadIds: new Set<string>(),
  };
}

function getLeadAssignedAgentId(lead: unknown) {
  const assignedAgent = (lead as { assignedAgent?: unknown })?.assignedAgent;

  if (!assignedAgent) {
    return null;
  }

  if (typeof assignedAgent === "object" && "_id" in assignedAgent) {
    return String((assignedAgent as { _id?: unknown })._id || "");
  }

  return String(assignedAgent);
}

function statusFromAttendanceSource(source: AttendanceSource): AvailabilityStatus | null {
  if (source === "Time In" || source === "Login" || source === "Break In" || source === "Lunch Break In") {
    return "ONLINE";
  }

  if (source === "Time Out" || source === "Logout") {
    return "OFFLINE";
  }

  if (source === "Break Out") {
    return "BREAK";
  }

  if (source === "Lunch Break Out") {
    return "LUNCH";
  }

  return null;
}

function statusFromTransactionTitle(title: string): AvailabilityStatus | null {
  if (title === "Idle" || title === "Off the phone") {
    return "OFF THE PHONE";
  }

  if (title === "Active" || title === "Online") {
    return "ONLINE";
  }

  return null;
}

function transactionStatusTime(transaction: TransactionReportRecord, status: AvailabilityStatus) {
  if (status !== "OFF THE PHONE") {
    return transaction.occurredAt;
  }

  const metadataStartedAt = new Date(String(transaction.metadata?.idleStartedAt || ""));

  if (!Number.isNaN(metadataStartedAt.getTime()) && metadataStartedAt.getTime() <= transaction.occurredAt.getTime()) {
    return metadataStartedAt;
  }

  return new Date(transaction.occurredAt.getTime() - idleThresholdMs);
}

function minutesBetween(start: number, end: number) {
  return Math.max(0, Math.round(((end - start) / 60000) * 10) / 10);
}

function addStatusMinutes(row: AgentReportRow, status: AvailabilityStatus, minutes: number) {
  if (minutes <= 0) {
    return;
  }

  if (status === "ONLINE") row.activeMinutes += minutes;
  if (status === "OFF THE PHONE") row.idleMinutes += minutes;
  if (status === "BREAK") row.breakMinutes += minutes;
  if (status === "LUNCH") row.lunchMinutes += minutes;
  if (status === "OFFLINE") row.offlineMinutes += minutes;
}

function matchesKeyword(log: AgentReportLog, keyword: string) {
  if (!keyword) {
    return true;
  }

  return [
    log.employeeName,
    log.action,
    log.detail,
    log.note,
    log.leadName,
    log.businessName,
    log.source,
    log.category,
    log.status,
  ]
    .join(" ")
    .toLowerCase()
    .includes(keyword);
}

export async function readAgentProductivityReport(request: Request, response: Response) {
  const now = new Date();
  const defaultStart = new Date(now.getTime() - 29 * 24 * 60 * 60 * 1000);
  const start = parseDate(request.query.start, defaultStart);
  const end = parseDate(request.query.end, now);
  const effectiveEnd = new Date(Math.min(end.getTime(), now.getTime()));
  const agentFilter = String(request.query.agent || "ALL").trim();
  const rawStatusFilter = String(request.query.status || "ALL").trim();
  const statusFilter = rawStatusFilter === "ALL" ? "ALL" : normalizeEmployeeAvailabilityStatus(rawStatusFilter);
  const actionFilter = normalize(String(request.query.action || "ALL"));
  const keyword = normalize(String(request.query.search || ""));
  const limit = Math.min(Math.max(Number(request.query.limit || 1000) || 1000, 1), 5000);
  const employees = (await Employee.find({ status: { $ne: "Archived" } })
    .select("name employeeCode aliases role team status availabilityStatus")
    .sort({ name: 1 })
    .lean()) as unknown as EmployeeReportRecord[];
  const employeeById = new Map<string, EmployeeReportRecord>();
  const employeeByName = new Map<string, EmployeeReportRecord>();
  const rows = new Map<string, AgentReportRow>();

  const registerName = (employee: EmployeeReportRecord, value?: string | null) => {
    const key = normalize(String(value || ""));

    if (key) {
      employeeByName.set(key, employee);
    }
  };

  const findLikelyEmployeeByName = (employeeName: string) => {
    const matches = employees.filter((employee) => isLikelySamePersonName(employee.name, employeeName));

    return matches.length === 1 ? matches[0] : null;
  };

  const isSelectedEmployee = (employee: EmployeeReportRecord) => {
    const employeeId = String(employee._id);
    const availabilityStatus = normalizeEmployeeAvailabilityStatus(employee.availabilityStatus);
    const statusMatches = statusFilter === "ALL" || availabilityStatus === statusFilter;
    const agentMatches = agentFilter === "ALL" || employeeId === agentFilter;

    return statusMatches && agentMatches;
  };

  const ensureEmployeeRow = (employee: EmployeeReportRecord) => {
    const employeeId = String(employee._id);
    const existingRow = rows.get(employeeId);

    if (existingRow) {
      return existingRow;
    }

    const row = createAgentRow(employee);
    rows.set(employeeId, row);

    return row;
  };

  const ensureActorRow = (actorName: string) => {
    const key = normalize(actorName);

    if (!key) {
      return null;
    }

    const employee = employeeByName.get(key) || findLikelyEmployeeByName(actorName);

    if (employee) {
      return isSelectedEmployee(employee) ? ensureEmployeeRow(employee) : null;
    }

    return null;
  };

  employees.forEach((employee) => {
    const employeeId = String(employee._id);
    employeeById.set(employeeId, employee);
    registerName(employee, employee.name);
    registerName(employee, employee.employeeCode);
    (employee.aliases || []).forEach((alias) => registerName(employee, alias));

    if (isSelectedEmployee(employee) && (isLikelyLeadAgent(employee) || agentFilter === employeeId)) {
      ensureEmployeeRow(employee);
    }
  });

  const selectedEmployeeIds = employees.filter(isSelectedEmployee).map((employee) => employee._id);
  const leads = await Lead.find({
    $or: [
      { activity: { $elemMatch: { actorType: "employee", createdAt: { $gte: start, $lte: end } } } },
      { comments: { $elemMatch: { authorType: "employee", createdAt: { $gte: start, $lte: end } } } },
    ],
  })
    .select("leadName businessName source category status assignedAgent assignedAgentName comments activity followUpAt updatedAt")
    .lean();
  const logs: AgentReportLog[] = [];

  leads.forEach((lead) => {
    const leadObject = lead as unknown as {
      _id: Types.ObjectId;
      leadName?: string;
      businessName?: string;
      source?: string;
      category?: string;
      status?: LeadStatus;
      followUpAt?: Date | string | null;
      comments?: { authorName?: string; authorType?: string; body?: string; createdAt?: Date | string | null }[];
      activity?: { label?: string; detail?: string; actorName?: string; actorType?: string; createdAt?: Date | string | null }[];
    };
    const leadId = String(leadObject._id);
    const leadLabel = leadObject.leadName || leadObject.businessName || "lead";

    (leadObject.activity || []).forEach((item) => {
      if (item.actorType !== "employee" || dateValue(item.createdAt) < start.getTime() || dateValue(item.createdAt) > end.getTime()) {
        return;
      }

      const row = ensureActorRow(String(item.actorName || ""));

      if (!row) {
        return;
      }

      const displayAction = normalize(String(item.label || "")) === "follow up scheduled" ? "Rescheduled" : String(item.label || "Activity");
      const log: AgentReportLog = {
        id: `activity-${leadId}-${String(item.createdAt)}-${displayAction}`,
        employeeId: row.employeeId,
        employeeName: row.employeeName,
        action: displayAction,
        detail: String(item.detail || `${row.employeeName} updated ${leadLabel}.`),
        note: "",
        leadId,
        leadName: String(leadObject.leadName || ""),
        businessName: String(leadObject.businessName || ""),
        source: String(leadObject.source || ""),
        category: String(leadObject.category || ""),
        status: leadObject.status || "",
        followUpAt: leadObject.followUpAt || null,
        createdAt: item.createdAt || null,
      };

      if ((actionFilter === "all" || normalize(log.action).includes(actionFilter)) && matchesKeyword(log, keyword)) {
        logs.push(log);
        row.leadActions += 1;
        row.leadIds.add(leadId);
        if (normalize(log.action).includes("rescheduled") || normalize(log.action).includes("follow up")) row.followUpsScheduled += 1;
        if (normalize(log.action).includes("status")) row.statusUpdates += 1;
        if (normalize(log.action).includes("assigned")) row.assignments += 1;
        if (dateValue(log.createdAt) > dateValue(row.lastLeadActivityAt)) row.lastLeadActivityAt = log.createdAt;
      }
    });

    (leadObject.comments || []).forEach((comment) => {
      if (comment.authorType !== "employee" || dateValue(comment.createdAt) < start.getTime() || dateValue(comment.createdAt) > end.getTime()) {
        return;
      }

      const row = ensureActorRow(String(comment.authorName || ""));

      if (!row) {
        return;
      }

      const log: AgentReportLog = {
        id: `comment-${leadId}-${String(comment.createdAt)}-${row.employeeName}`,
        employeeId: row.employeeId,
        employeeName: row.employeeName,
        action: "Commented",
        detail: `${row.employeeName} contacted ${leadLabel}.`,
        note: String(comment.body || ""),
        leadId,
        leadName: String(leadObject.leadName || ""),
        businessName: String(leadObject.businessName || ""),
        source: String(leadObject.source || ""),
        category: String(leadObject.category || ""),
        status: leadObject.status || "",
        followUpAt: leadObject.followUpAt || null,
        createdAt: comment.createdAt || null,
      };

      if ((actionFilter === "all" || normalize(log.action).includes(actionFilter)) && matchesKeyword(log, keyword)) {
        logs.push(log);
        row.leadActions += 1;
        row.comments += 1;
        row.leadIds.add(leadId);
        if (dateValue(log.createdAt) > dateValue(row.lastLeadActivityAt)) row.lastLeadActivityAt = log.createdAt;
      }
    });
  });

  const attendanceRecords = (await Attendance.find({
    employee: { $in: selectedEmployeeIds },
    isArchived: false,
    timeIn: { $lte: effectiveEnd },
  })
    .select("employee timeIn source")
    .sort({ timeIn: 1 })
    .lean()) as unknown as AttendanceReportRecord[];
  const activityTransactions = (await EmployeeTransaction.find({
    employee: { $in: selectedEmployeeIds },
    category: "Attendance",
    title: { $in: ["Idle", "Active", "Off the phone", "Online"] },
    occurredAt: { $lte: effectiveEnd },
  })
    .select("employee title description occurredAt metadata")
    .sort({ occurredAt: 1 })
    .lean()) as unknown as TransactionReportRecord[];
  const eventsByEmployee = new Map<string, StatusEvent[]>();
  const pushStatusEvent = (event: StatusEvent) => {
    const list = eventsByEmployee.get(event.employeeId) || [];
    list.push(event);
    eventsByEmployee.set(event.employeeId, list);

    if (event.occurredAt.getTime() >= start.getTime() && event.occurredAt.getTime() <= effectiveEnd.getTime()) {
      const row = rows.get(event.employeeId);

      if (row) {
        row.lastStatusAt = event.occurredAt;
        if (event.status === "OFF THE PHONE") {
          row.idleSessions += 1;
        }
      }
    }
  };

  attendanceRecords.forEach((record) => {
    const employeeId = String(record.employee);
    const employee = employeeById.get(employeeId);
    const status = statusFromAttendanceSource(record.source);

    if (!employee || !status || !rows.has(employeeId)) {
      return;
    }

    pushStatusEvent({
      id: `attendance-${String(record._id)}`,
      employeeId,
      employeeName: String(employee.name || "Employee"),
      status,
      detail: record.source,
      source: "Attendance",
      occurredAt: record.timeIn,
    });
  });

  activityTransactions.forEach((transaction) => {
    const employeeId = String(transaction.employee);
    const employee = employeeById.get(employeeId);
    const status = statusFromTransactionTitle(transaction.title);

    if (!employee || !status || !rows.has(employeeId)) {
      return;
    }

    pushStatusEvent({
      id: `activity-${String(transaction._id)}`,
      employeeId,
      employeeName: String(employee.name || "Employee"),
      status,
      detail: transaction.description || transaction.title,
      source: "Activity",
      occurredAt: transactionStatusTime(transaction, status),
    });
  });

  rows.forEach((row) => {
    const events = (eventsByEmployee.get(row.employeeId) || []).sort((first, second) => first.occurredAt.getTime() - second.occurredAt.getTime());
    const inRangeEvents = events.filter((event) => event.occurredAt.getTime() >= start.getTime() && event.occurredAt.getTime() <= effectiveEnd.getTime());
    let cursor = start.getTime();
    let currentStatus: AvailabilityStatus | null = null;

    row.lastStatusAt = inRangeEvents.at(-1)?.occurredAt || null;
    row.idleSessions = inRangeEvents.filter((event) => event.status === "OFF THE PHONE").length;

    events.forEach((event) => {
      const eventTime = event.occurredAt.getTime();

      if (eventTime < start.getTime()) {
        currentStatus = event.status;
        return;
      }

      if (eventTime > effectiveEnd.getTime()) {
        return;
      }

      if (currentStatus) {
        addStatusMinutes(row, currentStatus, minutesBetween(cursor, eventTime));
      }

      currentStatus = event.status;
      cursor = Math.max(eventTime, start.getTime());
    });

    if (currentStatus) {
      addStatusMinutes(row, currentStatus, minutesBetween(cursor, effectiveEnd.getTime()));
    }

    row.uniqueLeads = row.leadIds.size;
  });

  const publicAgents = Array.from(rows.values())
    .map(({ leadIds, ...row }) => ({
      ...row,
      activeMinutes: Math.round(row.activeMinutes),
      idleMinutes: Math.round(row.idleMinutes),
      breakMinutes: Math.round(row.breakMinutes),
      lunchMinutes: Math.round(row.lunchMinutes),
      offlineMinutes: Math.round(row.offlineMinutes),
    }))
    .filter((row) => {
      const rowLooksLikeAgent = /\b(agent|sales|lead|closer|setter|appointment)\b/i.test([row.role, row.team, row.employeeName, row.employeeCode].join(" "));
      return agentFilter !== "ALL" || row.leadActions > 0 || row.activeMinutes > 0 || row.idleMinutes > 0 || row.breakMinutes > 0 || rowLooksLikeAgent;
    })
    .sort((first, second) => {
      if (second.leadActions !== first.leadActions) return second.leadActions - first.leadActions;
      if (second.idleMinutes !== first.idleMinutes) return second.idleMinutes - first.idleMinutes;
      return first.employeeName.localeCompare(second.employeeName);
    });
  const sortedLogs = logs.sort((first, second) => dateValue(second.createdAt) - dateValue(first.createdAt));
  const statusEvents = Array.from(eventsByEmployee.values())
    .flat()
    .filter((event) => event.occurredAt.getTime() >= start.getTime() && event.occurredAt.getTime() <= effectiveEnd.getTime())
    .sort((first, second) => second.occurredAt.getTime() - first.occurredAt.getTime())
    .slice(0, 200);

  response.json({
    generatedAt: new Date(),
    range: { start, end, effectiveEnd },
    summary: {
      totalActions: logs.length,
      uniqueLeads: new Set(logs.map((log) => log.leadId)).size,
      activeAgents: publicAgents.filter((agent) => agent.leadActions > 0 || agent.activeMinutes > 0).length,
      currentlyOnline: publicAgents.filter((agent) => agent.availabilityStatus === "ONLINE").length,
      currentlyIdle: publicAgents.filter((agent) => agent.availabilityStatus === "OFF THE PHONE").length,
      totalIdleMinutes: publicAgents.reduce((total, agent) => total + agent.idleMinutes, 0),
      totalActiveMinutes: publicAgents.reduce((total, agent) => total + agent.activeMinutes, 0),
      totalBreakMinutes: publicAgents.reduce((total, agent) => total + agent.breakMinutes + agent.lunchMinutes, 0),
    },
    agents: publicAgents,
    logs: sortedLogs.slice(0, limit),
    statusEvents,
    availableStatuses: availabilityStatuses,
  });
}
