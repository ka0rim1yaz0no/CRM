import type { Request, Response } from "express";
import { Types } from "mongoose";
import { Employee, normalizeEmployeeAvailabilityStatus } from "../models/Employee";
import { Lead } from "../models/Lead";
import { LeadCallStat } from "../models/leadCallStat";
import { scoreLeadsByPotential } from "../services/leadScoringService";
import { geocodeLocation, reverseGeocodeLocality, searchAllGooglePlaces, searchGooglePlaces, searchGooglePlacesPages, type GooglePlaceLead, type GooglePlacesLocationBias } from "../services/googlePlacesService";
import { getTomTomUsage, searchTomTomPlaceQueries, type TomTomPlaceLead } from "../services/tomTomSearchService";
import { isSpecificTomTomSearchQuery } from "../services/tomTomRelevance";
import { getPlaceSearchAuditModel } from "../models/PlaceSearchUsage";
import { isLeadAutoAssignmentEnabled } from "./systemSettingsController";
import { formatPhDate } from "../utils/dateTime";
import { emitLeadChanged } from "../socket";
import { getCurrentBusinessId, runForEachBusiness } from "../config/tenancy";
import { AUTO_CALL_COMMENT_COOLDOWN_MS, isLeadEligibleForAutoCall } from "../services/leadAutoCallEligibility";
import { getCallProvider } from "../config/callProvider";
import { getCallBridgeAttemptModel } from "../models/CallBridge";
import { getRingCentralMonitorStatus } from "../services/ringCentralCallMonitor";
import { isRingCentralOutcomeShadowEnabled } from "../services/ringCentralCallClassification";

const populateLead = [
  { path: "assignedAgent", select: "name employeeCode aliases role team status" },
  { path: "assignedTeam", select: "name" },
];
const AUTO_ASSIGNMENT_BATCH_SIZE = 100;
const AUTO_ASSIGNMENT_INTERVAL_MS = 24 * 60 * 60 * 1000;
const GOOGLE_AUTO_SEARCH_PAGE_LIMIT = 20;
const TOMTOM_AUTO_SEARCH_REQUEST_LIMIT = 400;
const TOMTOM_CALLABLE_LEADS_PER_REQUEST_ESTIMATE = 4;
const TOMTOM_DUPLICATE_BUFFER_MULTIPLIER = 1.25;
const PH_TIME_OFFSET_HOURS = 8;
let leadAutoAssignmentTimer: NodeJS.Timeout | null = null;

type PopulatedLead = Awaited<ReturnType<typeof Lead.find>>[number];
type AssignmentCandidate = {
  _id: Types.ObjectId;
  assignedCount: number;
};

type ImportablePlaceLead = GooglePlaceLead & Partial<Pick<TomTomPlaceLead, "provider" | "providerPlaceId" | "providerCategory">>;

const leadStatuses = ["NEW", "Follow up", "Ongoing comms", "Qualified", "Ongoing Negotiation", "Completed", "Dead", "Archived"] as const;
const salesAssignmentTextRegex = /sales/i;

type ImportedLead = {
  leadName: string;
  position: string;
  businessName: string;
  businessAddress: string;
  email: string;
  phone: string;
  website: string;
  source: string;
  category: string;
  status: (typeof leadStatuses)[number];
  assignedAgent: null;
  assignedAgentName: string;
  autoAssignedAt: null;
  assignedTeam: null;
  googlePlaceId: string;
  notes: string;
  followUpAt: null;
  followUpNote: string;
  followUpPriority: number;
  aiScore: number;
  aiScoreReason: string;
  aiScoreSource: string;
  aiScoredAt: null;
  assignedToName: string;
  createdAt?: Date;
  updatedAt?: Date;
};

function isSalesAssignableEmployee(employee: { role?: unknown; team?: unknown }) {
  return salesAssignmentTextRegex.test(String(employee.role || "")) || salesAssignmentTextRegex.test(String(employee.team || ""));
}

function normalizeLeadValue(value: string) {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function normalizeLeadStatus(value: unknown): (typeof leadStatuses)[number] {
  const normalizedValue = normalizeLeadValue(String(value || ""));
  const statusMap: Record<string, (typeof leadStatuses)[number]> = {
    new: "NEW",
    followup: "Follow up",
    "follow up": "Follow up",
    follow_up: "Follow up",
    ongoing: "Ongoing comms",
    "ongoing comms": "Ongoing comms",
    contacted: "Ongoing comms",
    qualified: "Qualified",
    negotiation: "Ongoing Negotiation",
    "ongoing negotiation": "Ongoing Negotiation",
    completed: "Completed",
    complete: "Completed",
    done: "Completed",
    dead: "Dead",
    lost: "Dead",
    archived: "Archived",
  };

  return statusMap[normalizedValue] || "NEW";
}

function parseOptionalDate(value: unknown) {
  const rawValue = String(value || "").trim();

  if (!rawValue) {
    return null;
  }

  const parsedDate = new Date(rawValue);

  return Number.isNaN(parsedDate.getTime()) ? null : parsedDate;
}

function parseDateRangeBoundary(value: unknown, boundary: "start" | "end") {
  const rawValue = String(value || "").trim();

  if (!/^\d{4}-\d{2}-\d{2}$/.test(rawValue)) {
    return null;
  }

  const [year, month, day] = rawValue.split("-").map(Number);
  const safeDate = new Date(`${rawValue}T00:00:00.000Z`);

  if (
    Number.isNaN(safeDate.getTime()) ||
    safeDate.getUTCFullYear() !== year ||
    safeDate.getUTCMonth() !== month - 1 ||
    safeDate.getUTCDate() !== day
  ) {
    return null;
  }

  const parsedDate =
    boundary === "start"
      ? new Date(Date.UTC(year, month - 1, day, -PH_TIME_OFFSET_HOURS, 0, 0, 0))
      : new Date(Date.UTC(year, month - 1, day, 23 - PH_TIME_OFFSET_HOURS, 59, 59, 999));

  return Number.isNaN(parsedDate.getTime()) ? null : parsedDate;
}

function createDateRangeFilter(request: Request) {
  const dateFrom = parseDateRangeBoundary(request.query.dateFrom, "start");
  const dateTo = parseDateRangeBoundary(request.query.dateTo, "end");

  if (!dateFrom && !dateTo) {
    return null;
  }

  const dateRange: { $gte?: Date; $lte?: Date } = {};

  if (dateFrom) {
    dateRange.$gte = dateFrom;
  }

  if (dateTo) {
    dateRange.$lte = dateTo;
  }

  return dateRange;
}

function createQualifiedDateRangeFilter(request: Request) {
  const dateRange = createDateRangeFilter(request);

  if (!dateRange) {
    return null;
  }

  const qualifiedRegex = /\bQualified\b/i;

  return {
    $or: [
      { createdAt: dateRange },
      {
        activity: {
          $elemMatch: {
            createdAt: dateRange,
            $or: [
              { status: qualifiedRegex },
              { detail: qualifiedRegex },
            ],
          },
        },
      },
    ],
  };
}

function escapeRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function flexibleExactRegex(value: string) {
  const normalizedValue = normalizeLeadValue(value);
  const pattern = normalizedValue.split(" ").map(escapeRegex).join("\\s+");

  return new RegExp(`^\\s*${pattern}\\s*$`, "i");
}

function normalizePhoneDigits(value: string) {
  return value.replace(/\D/g, "");
}

function phoneDigitCandidates(value: string) {
  const digits = normalizePhoneDigits(value);

  if (digits.length < 7) {
    return [];
  }

  const candidates = new Set([digits]);

  if (digits.length === 11 && digits.startsWith("1")) {
    candidates.add(digits.slice(1));
  }

  if (digits.length > 10) {
    candidates.add(digits.slice(-10));
  }

  if (digits.length > 8) {
    candidates.add(digits.slice(-8));
  }

  return Array.from(candidates).filter((candidate) => candidate.length >= 7);
}

function hasUsablePhone(value?: string) {
  return phoneDigitCandidates(String(value || "")).length > 0;
}

function phoneDedupKeys(value?: string) {
  return phoneDigitCandidates(String(value || "")).map((phone) => `phone:${phone}`);
}

function flexiblePhoneDigitsRegex(digits: string) {
  return new RegExp(`^\\D*${digits.split("").map(escapeRegex).join("\\D*")}\\D*$`);
}

function flexiblePhoneRegex(value: string) {
  const [digits] = phoneDigitCandidates(value);

  return digits ? flexiblePhoneDigitsRegex(digits) : null;
}

function flexiblePhoneRegexes(value: string) {
  return phoneDigitCandidates(value).map(flexiblePhoneDigitsRegex);
}

function phoneSearchRegex(value: string) {
  const digits = normalizePhoneDigits(value);

  if (digits.length < 3) {
    return null;
  }

  return new RegExp(digits.split("").map(escapeRegex).join("\\D*"));
}

function normalizeWebsite(value: string) {
  return normalizeLeadValue(value)
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/\/+$/, "");
}

function flexibleWebsiteRegex(value: string) {
  const normalizedWebsite = normalizeWebsite(value);

  if (!normalizedWebsite) {
    return null;
  }

  return new RegExp(`^\\s*(?:https?:\\/\\/)?(?:www\\.)?${escapeRegex(normalizedWebsite)}\\/*\\s*$`, "i");
}

type LeadActivityActor = { actorName: string; actorType: "admin" | "employee" | "system" };
type PlacesAdminActor = { actorCode: string; actorName: string; actorType: "admin" | "poc" };

async function requirePlacesAdmin(request: Request, response: Response): Promise<PlacesAdminActor | null> {
  const actorCode = String(request.header("x-crm-user-code") || "").trim();
  const requestedName = String(request.header("x-crm-user-name") || "").trim();
  const requestedType = String(request.header("x-crm-user-type") || "").trim().toLowerCase();

  if (requestedType === "admin" && (actorCode || requestedName)) {
    return {
      actorCode: actorCode || "admin",
      actorName: requestedName || "Administrator",
      actorType: "admin",
    };
  }

  if (actorCode) {
    const employee = await Employee.findOne({ employeeCode: actorCode, status: { $ne: "Archived" } })
      .select("name employeeCode role")
      .lean();
    const normalizedRole = String(employee?.role || "").trim().toLowerCase();

    if (employee && (normalizedRole === "poc" || normalizedRole === "admin" || normalizedRole === "administrator")) {
      return {
        actorCode: String(employee.employeeCode || actorCode),
        actorName: String(employee.name || requestedName || "Administrator"),
        actorType: normalizedRole === "poc" ? "poc" : "admin",
      };
    }
  }

  response.status(403).json({ message: "Only an authorized admin or POC can search external business providers." });
  return null;
}

function requestIpAddress(request: Request) {
  const forwardedAddress = String(request.header("x-forwarded-for") || "").split(",")[0]?.trim();
  return forwardedAddress || request.socket.remoteAddress || request.ip || "";
}

async function recordTomTomSearchAudit(input: {
  request: Request;
  actor: PlacesAdminActor;
  mode: "manual" | "auto";
  query: string;
  location: string;
  radiusMiles: number;
  requestCount: number;
  returnedCount: number;
  importedCount: number;
  duplicateCount: number;
  skippedNoPhoneCount: number;
  status: "completed" | "partial" | "failed";
  errorMessage?: string;
}) {
  await getPlaceSearchAuditModel().create({
    provider: "tomtom",
    businessId: getCurrentBusinessId(),
    actorCode: input.actor.actorCode,
    actorName: input.actor.actorName,
    actorType: input.actor.actorType,
    ipAddress: requestIpAddress(input.request),
    mode: input.mode,
    query: input.query,
    location: input.location,
    radiusMiles: input.radiusMiles,
    requestCount: input.requestCount,
    returnedCount: input.returnedCount,
    importedCount: input.importedCount,
    duplicateCount: input.duplicateCount,
    skippedNoPhoneCount: input.skippedNoPhoneCount,
    status: input.status,
    errorMessage: input.errorMessage || "",
  });
}

function getActivityActor(request?: Request): LeadActivityActor {
  const actorType = request?.body?.activityActorType === "employee" ? "employee" : request?.body?.activityActorType === "system" ? "system" : "admin";
  const actorName = String(request?.body?.activityActorName || (actorType === "admin" ? "Admin" : actorType === "system" ? "System" : "Employee")).trim();

  return { actorName, actorType };
}

function leadActivity(label: string, detail: string, actor: LeadActivityActor, status = "Done") {
  return {
    label,
    detail,
    status,
    actorName: actor.actorName,
    actorType: actor.actorType,
    createdAt: new Date(),
  };
}

function activityPush(label: string, detail: string, actor: LeadActivityActor, status = "Done") {
  return {
    activity: {
      $each: [leadActivity(label, detail, actor, status)],
      $position: 0,
    },
  };
}

function formatScheduledTime(value: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).formatToParts(value);
  const valueFor = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value || "";
  return `${valueFor("hour")}:${valueFor("minute")} ${valueFor("dayPeriod")} ${valueFor("month")} ${valueFor("day")}, ${valueFor("year")}`;
}

function formatScheduledEasternTime(value: Date) {
  const timeZoneName = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    timeZoneName: "short",
  }).formatToParts(value).find((part) => part.type === "timeZoneName")?.value || "ET";

  return `${formatScheduledTime(value, "America/New_York")} ${timeZoneName}`;
}

function formatScheduledPhTime(value: Date) {
  return formatScheduledTime(value, "Asia/Manila");
}

function leadScheduleName(lead: { leadName?: string; businessName?: string } | null) {
  return String(lead?.leadName || lead?.businessName || "").trim();
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

type AgentDashboardEmployee = {
  _id: Types.ObjectId;
  name?: string;
  employeeCode?: string;
  aliases?: string[];
  role?: string;
  team?: string;
  status?: string;
  availabilityStatus?: string;
};

type AgentDashboardLead = {
  _id: Types.ObjectId;
  leadName?: string;
  businessName?: string;
  businessAddress?: string;
  email?: string;
  phone?: string;
  website?: string;
  googlePlaceId?: string;
  providerPlaceId?: string;
  placeProvider?: string;
  source?: string;
  category?: string;
  status?: (typeof leadStatuses)[number];
  assignedAgent?: Types.ObjectId | { _id?: Types.ObjectId | string } | string | null;
  assignedAgentName?: string;
  comments?: {
    authorName?: string;
    authorType?: "admin" | "employee";
    body?: string;
    createdAt?: Date | string | null;
  }[];
  activity?: {
    label?: string;
    detail?: string;
    status?: string;
    actorName?: string;
    actorType?: "admin" | "employee" | "system";
    createdAt?: Date | string | null;
  }[];
  followUpAt?: Date | string | null;
  updatedAt?: Date | string | null;
  createdAt?: Date | string | null;
};

type AgentDashboardRow = {
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
  lastActivityAt: Date | string | null;
  touchedLeadIdsToday: Set<string>;
};

type AgentDashboardMonthlyRow = {
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
  addedLeadIds: Set<string>;
  followUpLeadIds: Set<string>;
  qualifiedLeadIds: Set<string>;
  archiveDeadLeadIds: Set<string>;
  qualifiedLeadDetails: Map<string, AgentDashboardLeadListItem>;
  touchedLeadIds: Set<string>;
  lastActivityAt: Date | string | null;
};

type AgentDashboardLeadListItem = {
  leadId: string;
  leadName: string;
  businessName: string;
  source: string;
  category: string;
  status: string;
  assignedAgentName: string;
  statusAt: Date | string | null;
  createdAt: Date | string | null;
};

const phMonthKeyFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: "Asia/Manila",
  year: "numeric",
  month: "2-digit",
});
const phDateInputFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Manila",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

function getDashboardNameKey(value?: string | null) {
  return normalizeLeadValue(String(value || ""));
}

function getDashboardPersonNameTokens(value?: string | null) {
  return getDashboardNameKey(value)
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 1);
}

function isLikelySameDashboardPersonName(first?: string | null, second?: string | null) {
  const firstTokens = getDashboardPersonNameTokens(first);
  const secondTokens = getDashboardPersonNameTokens(second);

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

function isDashboardAgentRole(role?: string | null) {
  const normalizedRole = String(role || "").trim().toLowerCase().replace(/\./g, "");
  const compactRole = normalizedRole.replace(/[^a-z]/g, "");

  return (
    normalizedRole === "agent" ||
    normalizedRole.includes("sales") ||
    normalizedRole.includes("agent") ||
    compactRole === "salesagent" ||
    compactRole === "salesrepresentative"
  );
}

function hasOutsideSalesText(value?: unknown) {
  const normalizedRole = normalizeLeadValue(String(value || ""));

  return normalizedRole.includes("outside") && normalizedRole.includes("sales");
}

function hasInsideSalesText(value?: unknown) {
  const normalizedRole = normalizeLeadValue(String(value || ""));

  return normalizedRole.includes("inside") && normalizedRole.includes("sales");
}

function isOutsideSalesEmployeeRecord(employee: { role?: unknown; team?: unknown }) {
  return hasOutsideSalesText(employee.role) || hasOutsideSalesText(employee.team);
}

function isInsideSalesEmployeeRecord(employee: { role?: unknown; team?: unknown }) {
  return hasInsideSalesText(employee.role) || hasInsideSalesText(employee.team);
}

async function canEmployeeViewAllLeadQueues(employeeId: string) {
  if (!Types.ObjectId.isValid(employeeId)) {
    return false;
  }

  const employee = await Employee.findById(employeeId).select("role team status").lean();
  const employeeRecord = employee as { role?: unknown; team?: unknown; status?: unknown } | null;

  return Boolean(
    employeeRecord &&
    String(employeeRecord.status || "").trim().toLowerCase() !== "archived" &&
    isOutsideSalesEmployeeRecord(employeeRecord)
  );
}

async function canEmployeeViewCompletedLeadQueue(employeeId: string) {
  if (!Types.ObjectId.isValid(employeeId)) {
    return false;
  }

  const employee = await Employee.findById(employeeId).select("role team status").lean();
  const employeeRecord = employee as { role?: unknown; team?: unknown; status?: unknown } | null;

  return Boolean(
    employeeRecord &&
    String(employeeRecord.status || "").trim().toLowerCase() !== "archived" &&
    (isOutsideSalesEmployeeRecord(employeeRecord) || isInsideSalesEmployeeRecord(employeeRecord))
  );
}

function isLikelyLeadAgent(employee: AgentDashboardEmployee) {
  return isDashboardAgentRole(employee.role);
}

function getLeadDisplayName(lead: AgentDashboardLead) {
  return String(lead.leadName || lead.businessName || "Lead").trim();
}

function makeDashboardLeadListItem(lead: AgentDashboardLead, statusAt?: Date | string | null): AgentDashboardLeadListItem {
  return {
    leadId: String(lead._id),
    leadName: String(lead.leadName || ""),
    businessName: String(lead.businessName || ""),
    source: String(lead.source || ""),
    category: String(lead.category || ""),
    status: String(lead.status || "NEW"),
    assignedAgentName: String(lead.assignedAgentName || ""),
    statusAt: statusAt || null,
    createdAt: lead.createdAt || null,
  };
}

function isSamePhDay(value: Date | string | null | undefined, phDateKey: string) {
  return Boolean(value && formatPhDate(value) === phDateKey);
}

function dateTimeValue(value: Date | string | null | undefined) {
  if (!value) {
    return 0;
  }

  const date = new Date(value);

  return Number.isNaN(date.getTime()) ? 0 : date.getTime();
}

function getPhMonthKey(value: Date | string | null | undefined) {
  if (!value) {
    return "";
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return "";
  }

  const parts = phMonthKeyFormatter.formatToParts(date);
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;

  return year && month ? `${year}-${month}` : "";
}

function getDashboardLeadCreatedActivity(lead: AgentDashboardLead) {
  return (lead.activity || [])
    .filter((item) => normalizeLeadValue(item.label || "") === "lead created" && dateTimeValue(item.createdAt) > 0)
    .sort((first, second) => dateTimeValue(first.createdAt) - dateTimeValue(second.createdAt))[0] || null;
}

function getDashboardLeadAddedAt(lead: AgentDashboardLead) {
  return getDashboardLeadCreatedActivity(lead)?.createdAt || lead.createdAt;
}

function getDashboardCurrentStatusAt(lead: AgentDashboardLead) {
  const status = lead.status || "NEW";
  const statusBucket = getDashboardLeadStatusBucket(status);
  const matchingStatusActivities = (lead.activity || [])
    .filter((item) => {
      const activityStatus = getDashboardActivityResultStatus(item);

      return activityStatus && getDashboardLeadStatusBucket(activityStatus) === statusBucket && dateTimeValue(item.createdAt) > 0;
    })
    .sort((first, second) => dateTimeValue(second.createdAt) - dateTimeValue(first.createdAt));

  return matchingStatusActivities[0]?.createdAt || lead.createdAt;
}

function normalizeDashboardMonth(value: unknown) {
  const candidate = String(value || "").trim();
  const fallback = getPhMonthKey(new Date());

  if (!/^\d{4}-\d{2}$/.test(candidate)) {
    return fallback;
  }

  const month = Number(candidate.slice(5, 7));

  return month >= 1 && month <= 12 ? candidate : fallback;
}

function normalizeDashboardDate(value: unknown) {
  const candidate = String(value || "").trim();

  return parseDateRangeBoundary(candidate, "start") ? candidate : phDateInputFormatter.format(new Date());
}

function createDashboardMonthDateRange(monthKey: string) {
  const [yearValue, monthValue] = monthKey.split("-").map(Number);
  const startDateKey = `${yearValue}-${String(monthValue).padStart(2, "0")}-03`;
  const nextMonthDate = new Date(Date.UTC(yearValue, monthValue, 2));
  const endDateKey = `${nextMonthDate.getUTCFullYear()}-${String(nextMonthDate.getUTCMonth() + 1).padStart(2, "0")}-02`;
  const start = parseDateRangeBoundary(startDateKey, "start") || new Date(0);
  const end = parseDateRangeBoundary(endDateKey, "end") || new Date();

  return { start, end, dateFrom: startDateKey, dateTo: endDateKey };
}

function createDashboardSelectedDateRange(request: Request, selectedMonth: string) {
  const monthRange = createDashboardMonthDateRange(selectedMonth);
  const requestedStart = parseDateRangeBoundary(request.query.dateFrom, "start");
  const requestedEnd = parseDateRangeBoundary(request.query.dateTo, "end");

  return {
    start: requestedStart || monthRange.start,
    end: requestedEnd || monthRange.end,
    dateFrom: requestedStart ? String(request.query.dateFrom || "") : monthRange.dateFrom,
    dateTo: requestedEnd ? String(request.query.dateTo || "") : monthRange.dateTo,
  };
}

function isWithinDashboardDateRange(value: Date | string | null | undefined, range: { start: Date; end: Date }) {
  const time = dateTimeValue(value);

  return time > 0 && time >= range.start.getTime() && time <= range.end.getTime();
}

function makeAgentDashboardRow(
  employee: AgentDashboardEmployee,
  business: { id?: string; name?: string } | undefined
): AgentDashboardRow {
  return {
    employeeId: String(employee._id),
    employeeName: String(employee.name || "Employee"),
    employeeCode: String(employee.employeeCode || ""),
    businessId: String(business?.id || ""),
    businessName: String(business?.name || "Current business"),
    role: String(employee.role || "Agent"),
    team: String(employee.team || "Unassigned"),
    status: String(employee.status || "Active"),
    availabilityStatus: normalizeEmployeeAvailabilityStatus(employee.availabilityStatus),
    assignedLeads: 0,
    newLeads: 0,
    followUps: 0,
    ongoing: 0,
    qualified: 0,
    negotiation: 0,
    dead: 0,
    dueFollowUps: 0,
    scheduledToday: 0,
    commentsToday: 0,
    callsToday: 0,
    activityToday: 0,
    touchedLeadsToday: 0,
    progressPercent: 0,
    productivityScore: 0,
    lastActivityAt: null,
    touchedLeadIdsToday: new Set<string>(),
  };
}

function makeAgentDashboardMonthlyRow(row: AgentDashboardRow): AgentDashboardMonthlyRow {
  return {
    employeeId: row.employeeId,
    employeeName: row.employeeName,
    businessId: row.businessId,
    businessName: row.businessName,
    role: row.role,
    team: row.team,
    leadsAdded: 0,
    followUps: 0,
    qualified: 0,
    archiveDead: 0,
    comments: 0,
    calls: 0,
    actions: 0,
    addedLeadIds: new Set<string>(),
    followUpLeadIds: new Set<string>(),
    qualifiedLeadIds: new Set<string>(),
    archiveDeadLeadIds: new Set<string>(),
    qualifiedLeadDetails: new Map<string, AgentDashboardLeadListItem>(),
    touchedLeadIds: new Set<string>(),
    lastActivityAt: null,
  };
}

function getDashboardLeadStatusBucket(status: string) {
  if (status === "NEW") {
    return "new";
  }

  if (status === "Follow up" || status === "Ongoing comms") {
    return "followUp";
  }

  if (status === "Qualified" || status === "Ongoing Negotiation" || status === "Completed") {
    return "qualified";
  }

  if (status === "Dead" || status === "Archived") {
    return "archiveDead";
  }

  return "new";
}

function trackMonthlyStatusBucket(row: AgentDashboardMonthlyRow, lead: AgentDashboardLead, status: string, statusAt?: Date | string | null) {
  const leadId = String(lead._id);
  const bucket = getDashboardLeadStatusBucket(status);

  if (bucket === "followUp") row.followUpLeadIds.add(leadId);
  if (bucket === "qualified") {
    row.qualifiedLeadIds.add(leadId);
    row.qualifiedLeadDetails.set(leadId, makeDashboardLeadListItem(lead, statusAt));
  }
  if (bucket === "archiveDead") row.archiveDeadLeadIds.add(leadId);
}

function getDashboardLeadStatus(value?: string | null) {
  const normalizedValue = normalizeLeadValue(String(value || ""));

  return leadStatuses.find((status) => normalizeLeadValue(status) === normalizedValue) || "";
}

function getDashboardActivityResultStatus(item: { label?: string; detail?: string; status?: string }) {
  const directStatus = getDashboardLeadStatus(item.status);

  if (directStatus) {
    return directStatus;
  }

  const label = normalizeLeadValue(String(item.label || ""));

  if (label === "follow up scheduled") {
    return "Follow up";
  }

  if (label === "archived") {
    return "Archived";
  }

  const detail = String(item.detail || "");
  const match = detail.match(/\b(?:status to|to)\s+(NEW|Follow up|Ongoing comms|Qualified|Ongoing Negotiation|Dead|Archived)\b/i);

  return getDashboardLeadStatus(match?.[1]);
}

function emitLeadMutation(action: string, lead: unknown) {
  emitLeadChanged({
    action,
    lead,
    assignedAgentId: getLeadAssignedAgentId(lead),
  });
}

function summarizeLeadChanges(previousLead: Record<string, unknown>, nextLead: Record<string, unknown>) {
  const labels: Record<string, string> = {
    leadName: "lead name",
    position: "position",
    businessName: "business",
    businessAddress: "address",
    email: "email",
    phone: "phone",
    website: "website",
    source: "source",
    category: "category",
    status: "status",
    assignedAgentName: "assigned agent",
    notes: "notes",
  };

  return Object.entries(labels)
    .filter(([field]) => String(previousLead[field] || "") !== String(nextLead[field] || ""))
    .map(([, label]) => label);
}

function parseQueryList(value: unknown) {
  const rawValues = Array.isArray(value) ? value : String(value || "").split(",");

  return Array.from(
    new Set(
      rawValues
        .map((rawValue) => String(rawValue || "").trim())
        .filter(Boolean)
    )
  );
}

function getLeadDuplicateFilters(lead: {
  googlePlaceId?: string;
  businessName?: string;
  businessAddress?: string;
  source?: string;
  category?: string;
  phone?: string;
  website?: string;
}) {
  const filters: Record<string, unknown>[] = [];
  const googlePlaceId = String(lead.googlePlaceId || "").trim();
  const businessName = String(lead.businessName || "").trim();
  const businessAddress = String(lead.businessAddress || "").trim();
  const phone = String(lead.phone || "").trim();
  const website = String(lead.website || "").trim();
  const phoneRegexes = flexiblePhoneRegexes(phone);
  const websiteRegex = flexibleWebsiteRegex(website);

  if (googlePlaceId) {
    filters.push({ googlePlaceId });
  }

  if (businessName && businessAddress) {
    filters.push({
      businessName: flexibleExactRegex(businessName),
      businessAddress: flexibleExactRegex(businessAddress),
    });
  }

  if (phoneRegexes.length > 0) {
    filters.push(...phoneRegexes.map((phoneRegex) => ({ phone: phoneRegex })));
  }

  if (websiteRegex) {
    filters.push({ website: websiteRegex });
  }

  return filters;
}

async function findDuplicateLead(
  lead: {
    googlePlaceId?: string;
    businessName?: string;
    businessAddress?: string;
    source?: string;
    phone?: string;
    website?: string;
  },
  excludeId = ""
) {
  const filters = getLeadDuplicateFilters(lead);

  if (filters.length === 0) {
    return null;
  }

  const query: Record<string, unknown> = {
    $or: filters,
    status: { $ne: "Archived" },
  };

  if (excludeId) {
    query._id = { $ne: excludeId };
  }

  return Lead.findOne(query).populate(populateLead).sort({ createdAt: -1 });
}

function hasDuplicateSensitiveLeadChanges(
  existingLead: Record<string, unknown> | null,
  nextLead: {
    googlePlaceId?: string;
    businessName?: string;
    businessAddress?: string;
    phone?: string;
    website?: string;
  }
) {
  if (!existingLead) {
    return true;
  }

  return ["googlePlaceId", "businessName", "businessAddress", "phone", "website"].some(
    (field) => String(existingLead[field] || "").trim() !== String(nextLead[field as keyof typeof nextLead] || "").trim()
  );
}

function getDuplicateLeadConflict(
  lead: {
    googlePlaceId?: string;
    businessName?: string;
    businessAddress?: string;
    phone?: string;
    website?: string;
  },
  duplicateLead: Record<string, unknown>
) {
  const fields: string[] = [];
  const googlePlaceId = String(lead.googlePlaceId || "").trim();
  const businessName = String(lead.businessName || "").trim();
  const businessAddress = String(lead.businessAddress || "").trim();
  const phone = String(lead.phone || "").trim();
  const website = String(lead.website || "").trim();
  const duplicateGooglePlaceId = String(duplicateLead.googlePlaceId || "").trim();
  const duplicateBusinessName = String(duplicateLead.businessName || "").trim();
  const duplicateBusinessAddress = String(duplicateLead.businessAddress || "").trim();
  const duplicatePhone = String(duplicateLead.phone || "").trim();
  const duplicateWebsite = String(duplicateLead.website || "").trim();

  if (googlePlaceId && duplicateGooglePlaceId && googlePlaceId === duplicateGooglePlaceId) {
    fields.push(`Google Place ID ${googlePlaceId}`);
  }

  const phoneMatches = phoneDigitCandidates(phone).filter((candidate) => phoneDigitCandidates(duplicatePhone).includes(candidate));
  if (phoneMatches.length > 0) {
    fields.push(`phone ${duplicatePhone || phone}`);
  }

  if (website && duplicateWebsite && normalizeWebsite(website) === normalizeWebsite(duplicateWebsite)) {
    fields.push(`website ${duplicateWebsite}`);
  }

  if (
    businessName &&
    businessAddress &&
    normalizeLeadValue(businessName) === normalizeLeadValue(duplicateBusinessName) &&
    normalizeLeadValue(businessAddress) === normalizeLeadValue(duplicateBusinessAddress)
  ) {
    fields.push(`business/address ${duplicateBusinessName}`);
  }

  return fields;
}

function getDuplicateLeadMessage(
  lead: {
    googlePlaceId?: string;
    businessName?: string;
    businessAddress?: string;
    phone?: string;
    website?: string;
  },
  duplicateLead: Record<string, unknown>
) {
  const fields = getDuplicateLeadConflict(lead, duplicateLead);
  const existingName = String(duplicateLead.businessName || duplicateLead.leadName || "existing lead").trim();
  const existingPhone = String(duplicateLead.phone || "").trim();
  const fieldText = fields.length ? fields.join(", ") : "matching lead details";
  const phoneText = existingPhone ? ` (${existingPhone})` : "";

  return `Duplicate lead already exists: ${fieldText}. Existing lead: ${existingName}${phoneText}`;
}

async function findDuplicateLeadByPhone(lead: { phone?: string }) {
  const phoneRegexes = flexiblePhoneRegexes(String(lead.phone || ""));

  if (phoneRegexes.length === 0) {
    return null;
  }

  return Lead.findOne({
    $or: phoneRegexes.map((phoneRegex) => ({ phone: phoneRegex })),
    status: { $ne: "Archived" },
  })
    .populate(populateLead)
    .sort({ createdAt: -1 });
}

function getImportPhoneDedupKey(lead: { phone?: string }, fallbackKey: string) {
  const phone = normalizePhoneDigits(lead.phone || "");

  return phone.length >= 7 ? `phone:${phone}` : `row:${fallbackKey}`;
}

function getLeadDedupKey(lead: {
  googlePlaceId?: string;
  providerPlaceId?: string;
  placeProvider?: string;
  businessName?: string;
  businessAddress?: string;
  source?: string;
  phone?: string;
  website?: string;
}) {
  if (lead.googlePlaceId) {
    return `place:${lead.googlePlaceId}`;
  }

  if (lead.providerPlaceId) {
    return `place:${lead.placeProvider || "provider"}:${lead.providerPlaceId}`;
  }

  const phone = normalizePhoneDigits(lead.phone || "");

  if (phone.length >= 7) {
    return `phone:${phone}`;
  }

  const website = normalizeWebsite(lead.website || "");

  if (website) {
    return `website:${website}`;
  }

  const businessName = normalizeLeadValue(lead.businessName || "");
  const businessAddress = normalizeLeadValue(lead.businessAddress || "");

  return `business:${businessName}|${businessAddress}`;
}

function dedupeLeads<T extends PopulatedLead>(leads: T[]) {
  const leadsByKey = new Map<string, T>();

  leads.forEach((lead) => {
    const key = getLeadDedupKey(lead);

    if (!leadsByKey.has(key)) {
      leadsByKey.set(key, lead);
    }
  });

  return Array.from(leadsByKey.values());
}

async function resolveActiveLeadDuplicateGroups(leadIds: string[]) {
  const selectedLeads = await Lead.find({
    _id: { $in: leadIds },
    status: { $ne: "Archived" },
  })
    .select("googlePlaceId providerPlaceId placeProvider businessName businessAddress phone website")
    .lean();
  const selectedKeys = new Set(selectedLeads.map((lead) => getLeadDedupKey(lead)));

  if (selectedKeys.size === 0) {
    return { leadIds: [] as Types.ObjectId[], logicalLeadCount: 0 };
  }

  const activeLeads = await Lead.find({ status: { $ne: "Archived" } })
    .select("_id googlePlaceId providerPlaceId placeProvider businessName businessAddress phone website")
    .lean();
  const expandedLeadIds = activeLeads
    .filter((lead) => selectedKeys.has(getLeadDedupKey(lead)))
    .map((lead) => lead._id);

  return {
    leadIds: expandedLeadIds,
    logicalLeadCount: selectedKeys.size,
  };
}

function dedupePlaces(places: ImportablePlaceLead[]) {
  const placesByKey = new Map<string, ImportablePlaceLead>();

  places.forEach((place) => {
    const key = getGooglePlaceDedupKey(place);

    if (!placesByKey.has(key)) {
      placesByKey.set(key, place);
    }
  });

  return Array.from(placesByKey.values());
}

function onlyPlacesWithPhone(places: ImportablePlaceLead[]) {
  return places.filter((place) => String(place.businessName || "").trim() && hasUsablePhone(place.phone));
}

function getGooglePlaceDedupKey(place: ImportablePlaceLead) {
  const phoneKeys = phoneDedupKeys(place.phone);

  if (phoneKeys.length > 0) {
    return phoneKeys[0];
  }

  const googlePlaceId = place.googlePlaceId || "";
  const providerPlaceId = place.providerPlaceId || "";
  const businessName = normalizeLeadValue(place.businessName || "");
  const businessAddress = normalizeLeadValue(place.businessAddress || "");

  if (providerPlaceId) {
    return `place:${place.provider || "provider"}:${providerPlaceId}`;
  }

  return googlePlaceId ? `place:${googlePlaceId}` : `business:${businessName}|${businessAddress}|google places`;
}

function getAutoSearchTargets(product: string) {
  return [
    { query: product, fit: "exact product or business match" },
    { query: `${product} stores`, fit: "retailers explicitly matching the product" },
    { query: `${product} suppliers`, fit: "suppliers explicitly matching the product" },
    { query: `${product} dealers`, fit: "dealers explicitly matching the product" },
    { query: `${product} distributors`, fit: "distributors explicitly matching the product" },
  ];
}

function getTomTomSearchRequestEstimate(targetLeads: number) {
  const bufferedTarget = Math.ceil(targetLeads * TOMTOM_DUPLICATE_BUFFER_MULTIPLIER);
  const searchRequests = Math.ceil(bufferedTarget / TOMTOM_CALLABLE_LEADS_PER_REQUEST_ESTIMATE);
  return Math.min(searchRequests, TOMTOM_AUTO_SEARCH_REQUEST_LIMIT);
}

async function rejectTomTomSearchWithInsufficientBudget(input: {
  request: Request;
  response: Response;
  actor: PlacesAdminActor;
  mode: "manual" | "auto";
  query: string;
  location: string;
  radiusMiles: number;
  requiredRequests: number;
  remainingRequests: number;
  quotaName?: string;
}) {
  if (input.remainingRequests >= input.requiredRequests) return false;

  const quotaName = input.quotaName || "Places Discover";
  const message = `This search can use up to ${input.requiredRequests} TomTom ${quotaName} requests, but only ${input.remainingRequests} remain this month. Choose a smaller lead target or wait for the UTC monthly reset.`;

  await recordTomTomSearchAudit({
    request: input.request,
    actor: input.actor,
    mode: input.mode,
    query: input.query,
    location: input.location,
    radiusMiles: input.radiusMiles,
    requestCount: 0,
    returnedCount: 0,
    importedCount: 0,
    duplicateCount: 0,
    skippedNoPhoneCount: 0,
    status: "failed",
    errorMessage: message,
  }).catch((error) => console.error("Unable to record blocked TomTom search", error));

  input.response.status(429).json({
    message,
    code: "TOMTOM_MONTHLY_BUDGET_INSUFFICIENT",
    requiredRequests: input.requiredRequests,
    remainingRequests: input.remainingRequests,
    resetTimeZone: "UTC",
  });
  return true;
}

function getAutoSearchQueryVariants(targetQuery: string, location: string) {
  const normalizedQuery = targetQuery.trim();
  const normalizedLocation = location.trim();
  const locationSuffix = normalizedLocation ? ` in ${normalizedLocation}` : "";
  const nearSuffix = normalizedLocation ? ` near ${normalizedLocation}` : "";
  const variants = [
    `${normalizedQuery}${locationSuffix}`,
    `${normalizedQuery}${nearSuffix}`,
    `best ${normalizedQuery}${locationSuffix}`,
    `top rated ${normalizedQuery}${locationSuffix}`,
    `${normalizedQuery} companies${locationSuffix}`,
    `${normalizedQuery} services${locationSuffix}`,
  ];

  return Array.from(new Set(variants.map((variant) => variant.trim()).filter(Boolean)));
}

function getDirectSearchQueryVariants(targetQuery: string, location: string) {
  const normalizedQuery = targetQuery.trim();
  const normalizedLocation = location.trim();
  const locationSuffix = normalizedLocation ? ` in ${normalizedLocation}` : "";

  return Array.from(new Set([`${normalizedQuery}${locationSuffix}`].map((variant) => variant.trim()).filter(Boolean)));
}

const usStateAliases: Record<string, string> = {
  alabama: "AL",
  alaska: "AK",
  arizona: "AZ",
  arkansas: "AR",
  california: "CA",
  colorado: "CO",
  connecticut: "CT",
  delaware: "DE",
  florida: "FL",
  georgia: "GA",
  hawaii: "HI",
  idaho: "ID",
  illinois: "IL",
  indiana: "IN",
  iowa: "IA",
  kansas: "KS",
  kentucky: "KY",
  louisiana: "LA",
  maine: "ME",
  maryland: "MD",
  massachusetts: "MA",
  michigan: "MI",
  minnesota: "MN",
  mississippi: "MS",
  missouri: "MO",
  montana: "MT",
  nebraska: "NE",
  nevada: "NV",
  "new hampshire": "NH",
  "new jersey": "NJ",
  "new mexico": "NM",
  "new york": "NY",
  "north carolina": "NC",
  "north dakota": "ND",
  ohio: "OH",
  oklahoma: "OK",
  oregon: "OR",
  pennsylvania: "PA",
  "rhode island": "RI",
  "south carolina": "SC",
  "south dakota": "SD",
  tennessee: "TN",
  texas: "TX",
  utah: "UT",
  vermont: "VT",
  virginia: "VA",
  washington: "WA",
  "west virginia": "WV",
  wisconsin: "WI",
  wyoming: "WY",
};

const usStateCodes = new Set(Object.values(usStateAliases));
const usStateNamesByCode = new Map(
  Object.entries(usStateAliases).map(([name, code]) => [
    code,
    name.replace(/\b\w/g, (letter) => letter.toUpperCase()),
  ])
);
const GOOGLE_PLACES_MAX_RADIUS_METERS = 49999;
const GOOGLE_PLACES_METERS_PER_MILE = 1609.344;
const GOOGLE_PLACES_MAX_USER_RADIUS_MILES = 50;

function normalizeLeadState(value: unknown) {
  const rawValue = String(value || "").trim();
  const normalizedValue = normalizeLeadValue(rawValue);

  if (usStateCodes.has(rawValue.toUpperCase())) {
    return rawValue.toUpperCase();
  }

  return usStateAliases[normalizedValue] || "";
}

function extractLeadStateFromAddress(address: unknown) {
  const addressText = String(address || "").trim();

  if (!addressText) {
    return "";
  }

  const addressParts = addressText
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .reverse();

  for (const part of addressParts) {
    const partWithoutZip = part.replace(/\b\d{5}(?:-\d{4})?\b/g, "").trim();
    const fullPartState = normalizeLeadState(partWithoutZip);

    if (fullPartState) {
      return fullPartState;
    }

    const stateCodeTokens = partWithoutZip.match(/\b[A-Z]{2}\b/g) || [];
    const stateCode = stateCodeTokens.find((token) => usStateCodes.has(token));

    if (stateCode) {
      return stateCode;
    }
  }

  const normalizedAddress = normalizeLeadValue(addressText);

  for (const [stateName, stateCode] of Object.entries(usStateAliases)) {
    const stateNamePattern = new RegExp(`\\b${escapeRegex(stateName)}\\b`, "i");

    if (stateNamePattern.test(normalizedAddress)) {
      return stateCode;
    }
  }

  return "";
}

function createLeadStateAddressFilter(stateValue: unknown) {
  const stateCode = normalizeLeadState(stateValue);

  if (!stateCode) {
    return null;
  }

  const matchingStateNames = Object.entries(usStateAliases)
    .filter(([, code]) => code === stateCode)
    .map(([name]) => name);
  const stateCodePattern = new RegExp(`(?:^|[,\\s])${escapeRegex(stateCode)}(?:\\s+\\d{5}(?:-\\d{4})?|\\s|,|$)`, "i");
  const stateNamePatterns = matchingStateNames.map((stateName) => new RegExp(`\\b${escapeRegex(stateName)}\\b`, "i"));

  return {
    $or: [
      { businessAddress: stateCodePattern },
      ...stateNamePatterns.map((stateNamePattern) => ({ businessAddress: stateNamePattern })),
    ],
  };
}

async function getLeadStateOptions(filter: Record<string, unknown>) {
  const leads = await Lead.find(filter)
    .select("businessAddress")
    .lean()
    .limit(20000);
  const countsByState = new Map<string, number>();

  leads.forEach((lead) => {
    const state = extractLeadStateFromAddress(lead.businessAddress);

    if (state) {
      countsByState.set(state, (countsByState.get(state) || 0) + 1);
    }
  });

  return Array.from(countsByState.entries())
    .map(([code, count]) => ({
      code,
      name: usStateNamesByCode.get(code) || code,
      count,
    }))
    .sort((first, second) => first.name.localeCompare(second.name));
}

function parseGooglePlacesLocation(location: string) {
  const parts = location
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  const lastPartWords = (parts.at(-1) || "").split(/\s+/).filter(Boolean);
  const rawState = lastPartWords.at(-1) || "";
  const normalizedState = normalizeLeadValue(rawState);
  const state = usStateCodes.has(rawState.toUpperCase())
    ? rawState.toUpperCase()
    : usStateAliases[normalizedState] || "";
  const city = parts.length > 1 ? parts[0] : state ? location.replace(new RegExp(`\\b${escapeRegex(rawState)}\\b`, "i"), "").replace(/,+/g, " ").trim() : parts[0] || "";

  return {
    city: city ? normalizeLeadValue(city) : "",
    state,
  };
}

function addressMatchesGooglePlacesLocation(address: string, location: string, options: { matchCity?: boolean } = {}) {
  const { city, state } = parseGooglePlacesLocation(location);
  const normalizedAddress = normalizeLeadValue(address);
  const shouldMatchCity = options.matchCity !== false;

  if (!city && !state) {
    return true;
  }

  if (shouldMatchCity && city && !normalizedAddress.includes(city)) {
    return false;
  }

  if (!state) {
    return true;
  }

  const stateName = Object.entries(usStateAliases).find(([, code]) => code === state)?.[0] || "";
  const statePattern = new RegExp(`(?:,|\\s)${escapeRegex(state)}(?:\\s|,|\\d|$)`, "i");

  return statePattern.test(address) || Boolean(stateName && normalizedAddress.includes(stateName));
}

function filterPlacesByLocation(places: GooglePlaceLead[], location: string, options: { matchCity?: boolean } = {}) {
  const normalizedLocation = location.trim();

  if (!normalizedLocation) {
    return places;
  }

  return places.filter((place) => addressMatchesGooglePlacesLocation(place.businessAddress || "", normalizedLocation, options));
}

function getDistanceMiles(first: { latitude: number; longitude: number }, second: { latitude: number; longitude: number }) {
  const toRadians = (value: number) => (value * Math.PI) / 180;
  const earthRadiusMiles = 3958.7613;
  const latitudeDelta = toRadians(second.latitude - first.latitude);
  const longitudeDelta = toRadians(second.longitude - first.longitude);
  const firstLatitude = toRadians(first.latitude);
  const secondLatitude = toRadians(second.latitude);
  const haversine =
    Math.sin(latitudeDelta / 2) ** 2 +
    Math.cos(firstLatitude) * Math.cos(secondLatitude) * Math.sin(longitudeDelta / 2) ** 2;

  return 2 * earthRadiusMiles * Math.atan2(Math.sqrt(haversine), Math.sqrt(1 - haversine));
}

function filterPlacesByRadius(places: GooglePlaceLead[], center: { latitude: number; longitude: number } | null, radiusMiles: number) {
  if (!center || radiusMiles <= 0) {
    return places;
  }

  return places.filter((place) => {
    if (typeof place.latitude !== "number" || typeof place.longitude !== "number") {
      return true;
    }

    return getDistanceMiles(center, { latitude: place.latitude, longitude: place.longitude }) <= radiusMiles;
  });
}

function getRadiusMiles(value: unknown) {
  const radius = Number(value);
  if (!Number.isFinite(radius) || radius <= 0) {
    return 0;
  }

  return Math.min(Math.max(radius, 1), GOOGLE_PLACES_MAX_USER_RADIUS_MILES);
}

function createLocationBias(center: { latitude: number; longitude: number }, radiusMeters: number): GooglePlacesLocationBias {
  return {
    circle: {
      center,
      radius: Math.min(radiusMeters, GOOGLE_PLACES_MAX_RADIUS_METERS),
    },
  };
}

function offsetCoordinates(center: { latitude: number; longitude: number }, northMiles: number, eastMiles: number) {
  const latitude = center.latitude + northMiles / 69;
  const longitude = center.longitude + eastMiles / (69 * Math.cos((center.latitude * Math.PI) / 180));

  return { latitude, longitude };
}

async function getGooglePlacesLocationContext(location: string, radiusMiles: number): Promise<{ center: { latitude: number; longitude: number } | null; biases: GooglePlacesLocationBias[] }> {
  if (!location || radiusMiles <= 0) {
    return { center: null, biases: [] };
  }

  const coordinates = await geocodeLocation(location);

  if (!coordinates) {
    return { center: null, biases: [] };
  }

  const requestedRadiusMeters = radiusMiles * GOOGLE_PLACES_METERS_PER_MILE;
  const searchRadiusMeters = Math.min(requestedRadiusMeters, GOOGLE_PLACES_MAX_RADIUS_METERS);
  const biases = [createLocationBias(coordinates, searchRadiusMeters)];

  if (requestedRadiusMeters > GOOGLE_PLACES_MAX_RADIUS_METERS) {
    const offsetMiles = Math.max(0, radiusMiles - GOOGLE_PLACES_MAX_RADIUS_METERS / GOOGLE_PLACES_METERS_PER_MILE);
    [
      offsetCoordinates(coordinates, offsetMiles, 0),
      offsetCoordinates(coordinates, -offsetMiles, 0),
      offsetCoordinates(coordinates, 0, offsetMiles),
      offsetCoordinates(coordinates, 0, -offsetMiles),
    ].forEach((center) => biases.push(createLocationBias(center, GOOGLE_PLACES_MAX_RADIUS_METERS)));
  }

  return { center: coordinates, biases };
}

function formatLocationName(name: string, state: string) {
  const cleanName = name.replace(/\s+/g, " ").trim();
  return [cleanName, state].filter(Boolean).join(", ");
}

function getNearbyLocationSamplePoints(center: { latitude: number; longitude: number }, radiusMiles: number) {
  const distances = Array.from(new Set([Math.min(12, radiusMiles), Math.min(25, radiusMiles), radiusMiles].filter((distance) => distance >= 6)));
  const directions = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
    [0.7, 0.7],
    [0.7, -0.7],
    [-0.7, 0.7],
    [-0.7, -0.7],
  ];

  return distances.flatMap((distance) =>
    directions.map(([north, east]) => offsetCoordinates(center, distance * north, distance * east))
  );
}

async function getNearbyOpenStreetMapLocations(center: { latitude: number; longitude: number }, radiusMiles: number, state: string) {
  const radiusMeters = Math.min(Math.max(radiusMiles * GOOGLE_PLACES_METERS_PER_MILE, 1000), 100000);
  const query = `
    [out:json][timeout:12];
    (
      node(around:${Math.round(radiusMeters)},${center.latitude},${center.longitude})["place"~"^(city|town|village|hamlet)$"];
      way(around:${Math.round(radiusMeters)},${center.latitude},${center.longitude})["place"~"^(city|town|village|hamlet)$"];
      relation(around:${Math.round(radiusMeters)},${center.latitude},${center.longitude})["place"~"^(city|town|village|hamlet)$"];
    );
    out center tags;
  `;

  try {
    const overpassUrl = new URL("https://overpass-api.de/api/interpreter");
    overpassUrl.searchParams.set("data", query);
    const response = await fetch(overpassUrl, {
      headers: { "User-Agent": "crm-local-lead-search/1.0" },
    });

    if (!response.ok) {
      return [];
    }

    const data = (await response.json()) as {
      elements?: Array<{
        lat?: number;
        lon?: number;
        center?: { lat?: number; lon?: number };
        tags?: { name?: string };
      }>;
    };

    const locationsByName = new Map<string, { location: string; distance: number }>();

    (data.elements || [])
      .map((element) => {
        const latitude = element.lat ?? element.center?.lat;
        const longitude = element.lon ?? element.center?.lon;
        const name = String(element.tags?.name || "").trim();

        if (!name || typeof latitude !== "number" || typeof longitude !== "number") {
          return null;
        }

        return {
          name,
          distance: getDistanceMiles(center, { latitude, longitude }),
        };
      })
      .filter((item): item is { name: string; distance: number } => item !== null && item.distance <= radiusMiles)
      .forEach((item) => {
        const key = normalizeLeadValue(item.name);
        const existing = locationsByName.get(key);

        if (!existing || item.distance < existing.distance) {
          locationsByName.set(key, {
            location: formatLocationName(item.name, state),
            distance: item.distance,
          });
        }
      });

    return Array.from(locationsByName.values())
      .sort((first, second) => first.distance - second.distance)
      .map((item) => item.location);
  } catch {
    return [];
  }
}

async function getNearbyGooglePlacesLocations(location: string, radiusMiles: number, locationContext: { center: { latitude: number; longitude: number } | null; biases: GooglePlacesLocationBias[] }) {
  const normalizedLocation = location.trim();
  const parsedLocation = parseGooglePlacesLocation(location);
  const originalCity = parsedLocation.city;

  if (!normalizedLocation || radiusMiles <= 0 || !locationContext.center) {
    return [normalizedLocation].filter(Boolean);
  }

  const openStreetMapLocations = await getNearbyOpenStreetMapLocations(locationContext.center, radiusMiles, parsedLocation.state);
  const sampledLocations = await Promise.all(
    getNearbyLocationSamplePoints(locationContext.center, radiusMiles).map((point) => reverseGeocodeLocality(point).catch(() => null))
  );
  const reverseGeocodedLocations = sampledLocations
    .filter((sample): sample is { city: string; state: string } => Boolean(sample?.city))
    .filter((sample) => !parsedLocation.state || sample.state === parsedLocation.state)
    .map((sample) => formatLocationName(sample.city, sample.state || parsedLocation.state));
  const nearbyLocations = [...openStreetMapLocations, ...reverseGeocodedLocations]
    .filter((nearbyLocation) => {
      const nearbyCity = parseGooglePlacesLocation(nearbyLocation).city;
      return nearbyCity && nearbyCity !== originalCity && !nearbyCity.includes(originalCity) && !originalCity.includes(nearbyCity);
    });

  return Array.from(new Set([normalizedLocation, ...nearbyLocations])).slice(0, 60);
}

type GooglePlacesExpandedSearchResult = {
  places: GooglePlaceLead[];
  searchedQueries: string[];
  searchedPages: number;
  searchedLocations: string[];
};

async function searchGooglePlacesWithPageBudget(baseQuery: string, location: string, maxPages: number, radiusMiles = 0) {
  const placesByKey = new Map<string, GooglePlaceLead>();
  const searchedQueries: string[] = [];
  let searchedPages = 0;
  const locationContext = await getGooglePlacesLocationContext(location, radiusMiles);
  const locationFilterOptions = { matchCity: radiusMiles <= 0 };
  const searchLocations = await getNearbyGooglePlacesLocations(location, radiusMiles, locationContext);
  const mainLocationQueries = getAutoSearchQueryVariants(baseQuery, location);
  const nearbyQueries = searchLocations.slice(1).flatMap((searchLocation) => getDirectSearchQueryVariants(baseQuery, searchLocation));
  const queryVariants = Array.from(new Set([...mainLocationQueries, ...nearbyQueries]));

  for (const textQuery of queryVariants) {
    if (searchedPages >= maxPages) {
      break;
    }

    searchedQueries.push(textQuery);
    const pagesForQuery = searchedQueries.length <= mainLocationQueries.length ? Math.min(20, maxPages - searchedPages) : 1;
    const result = await searchGooglePlacesPages(textQuery, pagesForQuery, { locationBias: locationContext.biases[0] });
    searchedPages += result.pageCount;
    onlyPlacesWithPhone(filterPlacesByRadius(filterPlacesByLocation(result.places, location, locationFilterOptions), locationContext.center, radiusMiles)).forEach((place) =>
      placesByKey.set(getGooglePlaceDedupKey(place), place)
    );
  }

  return {
    places: Array.from(placesByKey.values()),
    searchedQueries,
    searchedPages,
    searchedLocations: searchLocations,
  } satisfies GooglePlacesExpandedSearchResult;
}

function getProductFitScore(lead: { businessName: string; category: string; phone: string; website: string }, product: string) {
  const text = `${lead.businessName} ${lead.category}`.toLowerCase();
  let score = 48;
  const reasons: string[] = [];

  if (product.toLowerCase().includes("popcorn")) {
    const highFitKeywords = ["movie", "cinema", "theater", "arcade", "bowling", "entertainment", "trampoline", "skating"];
    const mediumFitKeywords = ["mall", "event", "student", "college", "laundromat", "family"];

    if (highFitKeywords.some((keyword) => text.includes(keyword))) {
      score += 28;
      reasons.push("strong popcorn vending venue fit");
    } else if (mediumFitKeywords.some((keyword) => text.includes(keyword))) {
      score += 18;
      reasons.push("good foot-traffic placement fit");
    }
  }

  if (lead.phone) {
    score += 10;
    reasons.push("phone available");
  }

  if (lead.website) {
    score += 8;
    reasons.push("website available");
  }

  return {
    score: Math.max(0, Math.min(100, Math.round(score))),
    reason: reasons.slice(0, 3).join(", ") || "auto-matched by product lead search",
  };
}

function getFollowUpBucket(lead: { followUpAt?: Date | string | null }) {
  if (!lead.followUpAt) {
    return 0;
  }

  const followUpTime = new Date(lead.followUpAt).getTime();

  if (Number.isNaN(followUpTime)) {
    return 0;
  }

  const now = Date.now();

  if (followUpTime <= now) {
    return 3;
  }

  if (followUpTime <= now + AUTO_ASSIGNMENT_INTERVAL_MS) {
    return 2;
  }

  return 1;
}

function sortLeadsByFollowUpPriority<T extends { followUpAt?: Date | string | null; followUpPriority?: number; createdAt?: Date }>(leads: T[]) {
  return [...leads].sort((first, second) => {
    const bucketDelta = getFollowUpBucket(second) - getFollowUpBucket(first);

    if (bucketDelta !== 0) {
      return bucketDelta;
    }

    if (first.followUpAt && second.followUpAt) {
      const followUpTimeDelta = new Date(first.followUpAt).getTime() - new Date(second.followUpAt).getTime();

      if (followUpTimeDelta !== 0) {
        return followUpTimeDelta;
      }
    }

    const priorityDelta = (second.followUpPriority || 0) - (first.followUpPriority || 0);

    if (priorityDelta !== 0) {
      return priorityDelta;
    }

    return new Date(second.createdAt || 0).getTime() - new Date(first.createdAt || 0).getTime();
  });
}

function parseLeadQueueTime(value?: Date | string | null) {
  if (!value) {
    return null;
  }

  const time = new Date(value).getTime();
  return Number.isNaN(time) ? null : time;
}

function hasScheduledFollowUp(lead: { status?: string; followUpAt?: Date | string | null }) {
  if (lead.status === "Qualified") {
    return false;
  }

  return parseLeadQueueTime(lead.followUpAt) !== null;
}

function isScheduledForToday(lead: { status?: string; followUpAt?: Date | string | null }) {
  if (lead.status === "Qualified") {
    return false;
  }

  return Boolean(lead.followUpAt && formatPhDate(lead.followUpAt) === formatPhDate(new Date()));
}

function isScheduledDueNow(lead: { status?: string; followUpAt?: Date | string | null }, now = new Date()) {
  if (lead.status === "Qualified") {
    return false;
  }

  const followUpTime = parseLeadQueueTime(lead.followUpAt);
  return followUpTime !== null && followUpTime <= now.getTime();
}

function getManualCommentTime(lead: {
  comments?: { authorName?: string; createdAt?: Date | string | null }[];
}) {
  const times = (lead.comments || [])
    .filter((comment) => comment.authorName !== "CSV Import")
    .map((comment) => parseLeadQueueTime(comment.createdAt))
    .filter((time): time is number => time !== null);

  return times.length > 0 ? Math.max(...times) : null;
}

function getCommentActivityTime(lead: {
  activity?: { label?: string; createdAt?: Date | string | null }[];
}) {
  const times = (lead.activity || [])
    .filter((item) => String(item.label || "").toLowerCase() === "comment added")
    .map((item) => parseLeadQueueTime(item.createdAt))
    .filter((time): time is number => time !== null);

  return times.length > 0 ? Math.max(...times) : null;
}

function getAssignmentMoveTime(lead: {
  activity?: { label?: string; detail?: string; createdAt?: Date | string | null }[];
}) {
  const times = (lead.activity || [])
    .filter((item) => {
      const label = String(item.label || "").toLowerCase();
      const detail = String(item.detail || "").toLowerCase();

      return label === "assigned" || detail.includes(" passed this lead") || detail.includes(" assigned this lead");
    })
    .map((item) => parseLeadQueueTime(item.createdAt))
    .filter((time): time is number => time !== null);

  return times.length > 0 ? Math.max(...times) : null;
}

function getUpdateActivityTime(lead: {
  activity?: { label?: string; createdAt?: Date | string | null }[];
}) {
  const times = (lead.activity || [])
    .filter((item) => {
      const label = String(item.label || "").toLowerCase();
      return label === "lead updated" || label === "status updated" || label === "status changed" || label === "follow up scheduled";
    })
    .map((item) => parseLeadQueueTime(item.createdAt))
    .filter((time): time is number => time !== null);

  return times.length > 0 ? Math.max(...times) : null;
}

function getLeadDeprioritizedTime(lead: {
  comments?: { authorName?: string; createdAt?: Date | string | null }[];
  activity?: { label?: string; detail?: string; createdAt?: Date | string | null }[];
}) {
  const times = [getManualCommentTime(lead), getCommentActivityTime(lead), getAssignmentMoveTime(lead), getUpdateActivityTime(lead)].filter(
    (time): time is number => time !== null
  );

  return times.length > 0 ? Math.max(...times) : null;
}

function getCurrentPhDayRange() {
  const phOffsetMs = 8 * 60 * 60 * 1000;
  const shiftedNow = new Date(Date.now() + phOffsetMs);
  const startTime = Date.UTC(shiftedNow.getUTCFullYear(), shiftedNow.getUTCMonth(), shiftedNow.getUTCDate()) - phOffsetMs;

  return {
    start: new Date(startTime),
    end: new Date(startTime + 24 * 60 * 60 * 1000),
  };
}

function createScheduledTodayFilter() {
  const { start, end } = getCurrentPhDayRange();

  return { followUpAt: { $gte: start, $lt: end } };
}

function createContactedTodayFilter() {
  const { start, end } = getCurrentPhDayRange();
  const createdToday = { $gte: start, $lt: end };

  return {
    $or: [
      { comments: { $elemMatch: { authorName: { $ne: "CSV Import" }, createdAt: createdToday } } },
      {
        activity: {
          $elemMatch: {
            label: { $in: ["Comment added", "Lead updated", "Status updated", "Status changed", "Follow up scheduled"] },
            createdAt: createdToday,
          },
        },
      },
    ],
  };
}

function createAutoCallEligibleFilter(now = new Date(), employeeNames: string[] = []) {
  const normalizedEmployeeNames = Array.from(
    new Set(employeeNames.map((name) => normalizeLeadValue(name)).filter(Boolean))
  );
  const identityConditions: Record<string, unknown>[] = [{ $eq: ["$$comment.authorType", "employee"] }];

  if (normalizedEmployeeNames.length > 0) {
    identityConditions.push({
      $in: [
        { $toLower: { $trim: { input: { $ifNull: ["$$comment.authorName", ""] } } } },
        normalizedEmployeeNames,
      ],
    });
  }

  const matchingCommentCount = (dateCondition: Record<string, unknown>) => ({
    $size: {
      $filter: {
        input: { $ifNull: ["$comments", []] },
        as: "comment",
        cond: { $and: [...identityConditions, dateCondition] },
      },
    },
  });
  const recentCommentCount = matchingCommentCount({
    $gt: ["$$comment.createdAt", new Date(now.getTime() - AUTO_CALL_COMMENT_COOLDOWN_MS)],
  });
  const commentSinceFollowUpCount = matchingCommentCount({
    $gte: ["$$comment.createdAt", "$followUpAt"],
  });
  return {
    $expr: {
      $and: [
        {
          $or: [
            { $eq: [{ $ifNull: ["$followUpAt", null] }, null] },
            { $lte: ["$followUpAt", now] },
          ],
        },
        {
          $or: [
            { $eq: [recentCommentCount, 0] },
            {
              $and: [
                { $eq: ["$status", "Follow up"] },
                { $ne: [{ $ifNull: ["$followUpAt", null] }, null] },
                { $lte: ["$followUpAt", now] },
                { $eq: [commentSinceFollowUpCount, 0] },
              ],
            },
          ],
        },
      ],
    },
  };
}

function createHiddenFromEmployeeQueueTodayFilter() {
  return {
    $and: [
      createContactedTodayFilter(),
      {
        $or: [
          { followUpAt: null },
          { followUpAt: { $exists: false } },
          { followUpAt: { $gt: new Date() } },
        ],
      },
    ],
  };
}

function sortLeadsForAgentWorkQueue<
  T extends {
    status?: string;
    followUpAt?: Date | string | null;
    comments?: { authorName?: string; createdAt?: Date | string | null }[];
    activity?: { label?: string; detail?: string; createdAt?: Date | string | null }[];
    createdAt?: Date;
  }
>(leads: T[], employeeNames: string[] = [], now = new Date()) {
  return [...leads].sort((first, second) => {
    const getQueueRank = (lead: T) => {
      const isAutoCallEligible = isLeadEligibleForAutoCall(lead, now, employeeNames);
      const hasRecentEmployeeComment = !isAutoCallEligible && lead.status === "NEW";
      const scheduledDueNow = isScheduledDueNow(lead, now);

      if (scheduledDueNow && isAutoCallEligible) return 0;
      const scheduledToday = isScheduledForToday(lead);
      if (lead.status === "NEW" && !hasRecentEmployeeComment && !scheduledToday) return 1;
      if (lead.status === "NEW" && !scheduledToday) return 2;
      if (lead.status === "Follow up" && !scheduledToday) return 3;
      if (scheduledToday) return 5;
      return 4;
    };
    const firstRank = getQueueRank(first);
    const secondRank = getQueueRank(second);

    if (firstRank !== secondRank) {
      return firstRank - secondRank;
    }

    if (firstRank === 0 || firstRank === 5) {
      return (parseLeadQueueTime(first.followUpAt) || 0) - (parseLeadQueueTime(second.followUpAt) || 0);
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

    const createdAtDelta = new Date(second.createdAt || 0).getTime() - new Date(first.createdAt || 0).getTime();

    if (createdAtDelta !== 0) {
      return createdAtDelta;
    }

    return String((first as { _id?: unknown })._id || "").localeCompare(String((second as { _id?: unknown })._id || ""));
  });
}

async function createAssignmentCandidates(excludedAgentIds: string[] = []): Promise<AssignmentCandidate[]> {
  const excludedIds = excludedAgentIds.filter(Boolean);
  const employees = await Employee.find({
    status: "Active",
    $or: [{ role: salesAssignmentTextRegex }, { team: salesAssignmentTextRegex }],
    ...(excludedIds.length > 0 ? { _id: { $nin: excludedIds } } : {}),
  }).sort({ createdAt: 1 });

  if (employees.length === 0) {
    return [];
  }

  const assignmentCounts = await Lead.aggregate<{ _id: unknown; count: number }>([
    { $match: { status: { $ne: "Archived" }, assignedAgent: { $ne: null } } },
    { $group: { _id: "$assignedAgent", count: { $sum: 1 } } },
  ]);
  const countsByEmployeeId = new Map(assignmentCounts.map((item) => [String(item._id), item.count]));

  return employees.map((employee) => ({
    _id: employee._id,
    assignedCount: countsByEmployeeId.get(String(employee._id)) || 0,
  }));
}

async function getEmployeeName(employeeId: unknown) {
  if (!employeeId) {
    return "";
  }

  const employee = await Employee.findById(employeeId).select("name");
  return employee?.name || "";
}

function pickAssignmentCandidate(candidates: AssignmentCandidate[]): Types.ObjectId | null {
  if (candidates.length === 0) {
    return null;
  }

  candidates.sort((first, second) => first.assignedCount - second.assignedCount || String(first._id).localeCompare(String(second._id)));
  const candidate = candidates[0];
  candidate.assignedCount += 1;

  return candidate._id;
}

export async function runLeadAutoAssignmentBatch(limit = AUTO_ASSIGNMENT_BATCH_SIZE) {
  if (!(await isLeadAutoAssignmentEnabled())) {
    return { assignedCount: 0, availableAgents: 0, skipped: true };
  }

  const assignmentCandidates = await createAssignmentCandidates();

  if (assignmentCandidates.length === 0) {
    return { assignedCount: 0, availableAgents: 0 };
  }

  const candidateLeads = await Lead.find({
    status: { $nin: ["Archived", "Dead"] },
    $or: [{ assignedAgent: null }, { assignedAgent: { $exists: false } }],
  })
    .sort({ createdAt: 1 })
    .limit(limit * 5);
  const leads = sortLeadsByFollowUpPriority(candidateLeads).slice(0, limit);

  if (leads.length === 0) {
    return { assignedCount: 0, availableAgents: assignmentCandidates.length };
  }

  const assignedAt = new Date();
  const operations = leads
    .map((lead) => {
      const assignedAgent = pickAssignmentCandidate(assignmentCandidates);

      if (!assignedAgent) {
        return null;
      }

      return {
        updateOne: {
          filter: { _id: lead._id },
          update: {
            $set: {
              assignedAgent,
              autoAssignedAt: assignedAt,
            },
            $push: activityPush("Assigned", "System auto assigned this lead.", { actorName: "System", actorType: "system" }),
          },
        },
      };
    })
    .filter((operation): operation is NonNullable<typeof operation> => Boolean(operation));

  if (operations.length === 0) {
    return { assignedCount: 0, availableAgents: assignmentCandidates.length };
  }

  const result = await Lead.bulkWrite(operations, { ordered: false });

  return {
    assignedCount: result.modifiedCount,
    availableAgents: assignmentCandidates.length,
  };
}

async function runLeadAutoAssignmentForAllBusinesses() {
  await runForEachBusiness(async (business) => {
    try {
      await runLeadAutoAssignmentBatch();
    } catch (error) {
      console.error(`Lead auto-assignment failed for ${business.id}`, error);
    }
  });
}

export async function reassignLeadsFromAgent(agentId: string) {
  const normalizedAgentId = String(agentId || "").trim();

  if (!normalizedAgentId) {
    return { reassignedCount: 0, unassignedCount: 0, availableAgents: 0 };
  }

  const leads = await Lead.find({
    assignedAgent: normalizedAgentId,
    status: { $nin: ["Archived", "Dead"] },
  }).sort({ createdAt: 1 });

  if (leads.length === 0) {
    return { reassignedCount: 0, unassignedCount: 0, availableAgents: 0 };
  }

  if (!(await isLeadAutoAssignmentEnabled())) {
    const result = await Lead.updateMany(
      { _id: { $in: leads.map((lead) => lead._id) } },
      {
        $set: { assignedAgent: null, autoAssignedAt: null },
        $push: activityPush("Unassigned", "Lead unassigned because lead auto assignment is turned off.", {
          actorName: "System",
          actorType: "system",
        }),
      }
    );

    return { reassignedCount: 0, unassignedCount: result.modifiedCount, availableAgents: 0 };
  }

  const assignmentCandidates = await createAssignmentCandidates([normalizedAgentId]);
  const assignedAt = new Date();
  const operations = sortLeadsByFollowUpPriority(leads).map((lead) => {
    const assignedAgent = pickAssignmentCandidate(assignmentCandidates);

    return {
      updateOne: {
        filter: { _id: lead._id },
        update: {
          $set: {
            assignedAgent,
            autoAssignedAt: assignedAgent ? assignedAt : null,
          },
          $push: activityPush(
            assignedAgent ? "Reassigned" : "Unassigned",
            assignedAgent ? "Lead reassigned after employee archive/delete." : "Lead unassigned because no active sales agent was available.",
            { actorName: "System", actorType: "system" }
          ),
        },
      },
    };
  });

  const result = await Lead.bulkWrite(operations, { ordered: false });

  return {
    reassignedCount: assignmentCandidates.length > 0 ? result.modifiedCount : 0,
    unassignedCount: assignmentCandidates.length > 0 ? 0 : result.modifiedCount,
    availableAgents: assignmentCandidates.length,
  };
}

export async function reassignNewLeadsBatch(_request: Request, response: Response) {
  if (!(await isLeadAutoAssignmentEnabled())) {
    response.status(400).json({ message: "Lead auto assignment is turned off in Settings." });
    return;
  }

  const leads = await Lead.find({
    status: "NEW",
  }).sort({ createdAt: 1 });

  if (leads.length === 0) {
    response.json({ reassignedCount: 0, leads: [] });
    return;
  }

  const assignmentCandidates = (await isLeadAutoAssignmentEnabled()) ? await createAssignmentCandidates() : [];

  if (assignmentCandidates.length === 0) {
    response.status(400).json({ message: "No active sales agents available" });
    return;
  }

  const assignedAt = new Date();
  const operations = sortLeadsByFollowUpPriority(leads).map((lead) => {
    const assignedAgent = pickAssignmentCandidate(assignmentCandidates);

    return {
      updateOne: {
        filter: { _id: lead._id },
        update: {
          $set: {
            assignedAgent,
            autoAssignedAt: assignedAt,
          },
          $push: activityPush("Reassigned", "Admin reassigned this new lead.", { actorName: "Admin", actorType: "admin" }),
        },
      },
    };
  });

  const result = await Lead.bulkWrite(operations, { ordered: false });
  const updatedLeads = await Lead.find({ _id: { $in: leads.map((lead) => lead._id) } }).populate(populateLead);

  response.json({
    reassignedCount: result.modifiedCount,
    leads: sortLeadsByFollowUpPriority(updatedLeads),
  });
}

export function startLeadAutoAssignmentScheduler() {
  if (leadAutoAssignmentTimer) {
    return;
  }

  void runLeadAutoAssignmentForAllBusinesses().catch((error) => {
    console.error("Lead auto-assignment failed", error);
  });

  leadAutoAssignmentTimer = setInterval(() => {
    void runLeadAutoAssignmentForAllBusinesses().catch((error) => {
      console.error("Lead auto-assignment failed", error);
    });
  }, AUTO_ASSIGNMENT_INTERVAL_MS);
}

async function upsertPlacesAsLeads(
  places: ImportablePlaceLead[],
  category = "",
  options: { provider?: "google" | "tomtom"; actor?: PlacesAdminActor } = {}
) {
  const placesWithBusiness = places.filter((place) => String(place.businessName || "").trim());
  const placesWithPhone = placesWithBusiness.filter((place) => hasUsablePhone(place.phone));
  const validPlaces = dedupePlaces(placesWithPhone);
  const placeCategory = String(category || "").trim();
  const placeProvider = options.provider || (validPlaces[0]?.provider === "tomtom" ? "tomtom" : "google");
  const sourceName = placeProvider === "tomtom" ? "TomTom Search" : "Google Places";

  if (validPlaces.length === 0) {
    return {
      leads: [],
      places: [],
      skippedNoPhoneCount: placesWithBusiness.length,
      duplicateCount: 0,
    };
  }

  const existingPhoneFilters = validPlaces.flatMap((place) => flexiblePhoneRegexes(place.phone).map((phoneRegex) => ({ phone: phoneRegex })));
  const existingLeads = existingPhoneFilters.length > 0
    ? await Lead.find({ $or: existingPhoneFilters, status: { $ne: "Archived" } }).select("phone").lean()
    : [];
  const existingPhoneKeys = new Set(existingLeads.flatMap((lead) => phoneDedupKeys(String(lead.phone || ""))));
  const newPlaces = validPlaces.filter((place) => !phoneDedupKeys(place.phone).some((phoneKey) => existingPhoneKeys.has(phoneKey)));

  const autoAssignmentEnabled = await isLeadAutoAssignmentEnabled();
  const assignmentCandidates = autoAssignmentEnabled ? await createAssignmentCandidates() : [];

  if (newPlaces.length > 0) {
    await Lead.bulkWrite(
      newPlaces.map((place) => {
        const googlePlaceId = place.googlePlaceId || "";
        const providerPlaceId = place.providerPlaceId || googlePlaceId;
        const businessName = String(place.businessName).trim();
        const businessAddress = place.businessAddress || "";
        const phoneFilters = flexiblePhoneRegexes(place.phone).map((phoneRegex) => ({ phone: phoneRegex }));
        const duplicateFilters = [
          ...phoneFilters,
          ...(googlePlaceId ? [{ googlePlaceId }] : []),
          ...(providerPlaceId ? [{ placeProvider, providerPlaceId }] : []),
        ];
        const assignedAgent = autoAssignmentEnabled ? pickAssignmentCandidate(assignmentCandidates) : null;
        const autoAssignedAt = autoAssignmentEnabled && assignedAgent ? new Date() : null;

        return {
          updateOne: {
            filter: duplicateFilters.length > 0 ? { $or: duplicateFilters } : { businessName, businessAddress, source: sourceName },
            update: {
              $set: {
                businessName,
                businessAddress,
                phone: place.phone || "",
                website: place.website || "",
                googlePlaceId,
                placeProvider,
                providerPlaceId,
                source: sourceName,
                category: placeCategory || place.providerCategory || "",
              },
              $setOnInsert: {
                status: "NEW",
                createdByName: sourceName,
                createdByType: "system",
                assignedAgent,
                autoAssignedAt,
                activity: [leadActivity("Lead created", `${sourceName} lead added${placeCategory ? ` under ${placeCategory}` : ""}${options.actor ? ` by ${options.actor.actorName}` : ""}.`, { actorName: options.actor?.actorName || "System", actorType: options.actor ? "admin" : "system" })],
              },
            },
            upsert: true,
          },
        };
      }),
      { ordered: false }
    );
  }

  const googlePlaceIds = newPlaces
    .map((place) => place.googlePlaceId)
    .filter((googlePlaceId): googlePlaceId is string => typeof googlePlaceId === "string" && Boolean(googlePlaceId));
  const providerPlaceIds = newPlaces
    .map((place) => place.providerPlaceId || place.googlePlaceId)
    .filter((providerPlaceId): providerPlaceId is string => typeof providerPlaceId === "string" && Boolean(providerPlaceId));
  const importedPhoneFilters = newPlaces.flatMap((place) => flexiblePhoneRegexes(place.phone).map((phoneRegex) => ({ phone: phoneRegex })));

  const leads = newPlaces.length > 0
    ? await Lead.find({
      $or: [
        ...(googlePlaceIds.length > 0 ? [{ googlePlaceId: { $in: googlePlaceIds } }] : []),
        ...(providerPlaceIds.length > 0 ? [{ placeProvider, providerPlaceId: { $in: providerPlaceIds } }] : []),
        ...importedPhoneFilters,
      ],
    })
      .populate(populateLead)
      .sort({ createdAt: -1 })
    : [];

  return {
    leads: dedupeLeads(leads),
    places: newPlaces,
    skippedNoPhoneCount: placesWithBusiness.length - placesWithPhone.length,
    duplicateCount: validPlaces.length - newPlaces.length,
  };
}

export async function listLeads(request: Request, response: Response) {
  const assignedAgent = String(request.query.assignedAgent || "").trim();
  const assignedAgentNames = parseQueryList(request.query.assignedAgentNames || request.query.assignedAgentName);
  const search = String(request.query.search || "").trim();
  const status = String(request.query.status || "").trim();
  const statuses = parseQueryList(request.query.statuses).filter((statusValue): statusValue is (typeof leadStatuses)[number] =>
    leadStatuses.includes(statusValue as (typeof leadStatuses)[number])
  );
  const unassigned = String(request.query.unassigned || "").toLowerCase() === "true";
  const loadAll = String(request.query.all || "").toLowerCase() === "true";
  const limit = Math.min(Math.max(Number(request.query.limit || 20) || 20, 1), 100);
  const allLimit = Math.min(Math.max(Number(request.query.limit || 500) || 500, 1), 500);
  const page = Math.max(Number(request.query.page || 1) || 1, 1);
  const includeArchived = String(request.query.includeArchived || "").toLowerCase() === "true";
  const filter: Record<string, unknown> = includeArchived ? {} : { status: { $ne: "Archived" } };
  const assignmentFilters: Record<string, unknown>[] = [];
  const andFilters: Record<string, unknown>[] = [];

  if (assignedAgent && Types.ObjectId.isValid(assignedAgent)) {
    assignmentFilters.push({ assignedAgent: new Types.ObjectId(assignedAgent) });
  }

  assignedAgentNames.forEach((assignedAgentName) => {
    assignmentFilters.push({ assignedAgentName: flexibleExactRegex(assignedAgentName) });
  });

  if (assignmentFilters.length === 1) {
    Object.assign(filter, assignmentFilters[0]);
  }

  if (assignmentFilters.length > 1) {
    andFilters.push({ $or: assignmentFilters });
  }

  if (statuses.length > 0) {
    filter.status = { $in: statuses };
  } else if (leadStatuses.includes(status as (typeof leadStatuses)[number])) {
    filter.status = status;
  }

  if (unassigned) {
    andFilters.push({
      $and: [
        { $or: [{ assignedAgent: null }, { assignedAgent: { $exists: false } }] },
        { $or: [{ assignedAgentName: "" }, { assignedAgentName: { $exists: false } }] },
      ],
    });
  }

  if (search) {
    const searchRegex = new RegExp(escapeRegex(search), "i");
    andFilters.push({
      $or: [
        { leadName: searchRegex },
        { businessName: searchRegex },
        { businessAddress: searchRegex },
        { email: searchRegex },
        { phone: searchRegex },
        { website: searchRegex },
        { source: searchRegex },
        { category: searchRegex },
        { status: searchRegex },
        { assignedAgentName: searchRegex },
        { notes: searchRegex },
      ],
    });
  }

  if (andFilters.length > 0) {
    filter.$and = andFilters;
  }

  const leadQuery = Lead.find(filter)
    .populate(populateLead)
    .sort({ createdAt: -1 });

  const effectiveLimit = assignmentFilters.length > 0 ? Math.min(limit, 50) : limit;

  if (loadAll && assignmentFilters.length === 0) {
    leadQuery.limit(allLimit);
  } else {
    leadQuery.skip((page - 1) * effectiveLimit).limit(effectiveLimit);
  }

  const leads = await leadQuery;
  const dedupedLeads = dedupeLeads(leads);
  const isWorkQueueStatus =
    !status ||
    status === "NEW" ||
    status === "Follow up" ||
    (statuses.length > 0 && statuses.every((statusValue) => statusValue === "NEW" || statusValue === "Follow up"));
  const isAssignedAgentQueue = assignmentFilters.length > 0 && isWorkQueueStatus;

  response.json(isAssignedAgentQueue ? sortLeadsForAgentWorkQueue(dedupedLeads) : sortLeadsByFollowUpPriority(dedupedLeads));
}

export async function readLead(request: Request, response: Response) {
  const leadId = String(request.params.id || "").trim();

  if (!Types.ObjectId.isValid(leadId)) {
    response.status(400).json({ message: "Invalid lead id" });
    return;
  }

  const lead = await Lead.findById(leadId).populate(populateLead);

  if (!lead) {
    response.status(404).json({ message: "Lead not found" });
    return;
  }

  response.json(lead);
}

export async function listMyLeads(request: Request, response: Response) {
  const employeeId = String(request.query.employeeId || "").trim();
  const employeeNames = parseQueryList(request.query.employeeNames || request.query.employeeName);
  const limit = Math.min(Math.max(Number(request.query.limit || 50) || 50, 1), 50);
  const page = Math.max(Number(request.query.page || 1) || 1, 1);
  const tab = normalizeEmployeeLeadTab(request.params.tab || request.query.tab);
  const queueFilter = String(request.query.queue || request.query.leadQueueFilter || "ALL").trim();
  const searchFilter = createLeadSearchFilter(String(request.query.search || ""));
  const searchAll = String(request.query.searchAll || "").toLowerCase() === "true" && Object.keys(searchFilter).length > 0;
  const includeArchived = searchAll || String(request.query.includeArchived || "").toLowerCase() === "true";
  const autoCallEligible = String(request.query.autoCallEligible || "").toLowerCase() === "true";
  const assignmentFilters = createEmployeeLeadAssignmentFilters(employeeId, employeeNames);
  const canViewAllLeadQueues = await canEmployeeViewAllLeadQueues(employeeId);
  const canViewCompletedQueue = await canEmployeeViewCompletedLeadQueue(employeeId);
  const canBypassAssignmentFilter = canViewAllLeadQueues || (tab === "completed" && canViewCompletedQueue);

  if (!canBypassAssignmentFilter && assignmentFilters.length === 0) {
    response.status(400).json({ message: "employeeId or employeeName is required" });
    return;
  }

  const statusFilter = searchAll && includeArchived
    ? [...leadStatuses]
    : searchAll
      ? getEmployeeLeadTabStatuses("all")
      : getEmployeeLeadTabStatuses(tab, queueFilter);
  const andFilters: Record<string, unknown>[] = [
    { status: { $in: statusFilter } },
  ];

  if (!canBypassAssignmentFilter) {
    andFilters.unshift({ $or: assignmentFilters });
  }

  if (Object.keys(searchFilter).length > 0) {
    andFilters.push(searchFilter);
  }

  const stateOptionFilter: Record<string, unknown> = { $and: [...andFilters] };
  const selectedStateFilter = createLeadStateAddressFilter(request.query.state || request.query.stateFilter);

  if (selectedStateFilter) {
    andFilters.push(selectedStateFilter);
  }

  if (autoCallEligible) {
    andFilters.push(createAutoCallEligibleFilter(new Date(), employeeNames));
  }

  const filter: Record<string, unknown> = { $and: andFilters };
  const [total, stateOptions] = await Promise.all([
    Lead.countDocuments(filter),
    getLeadStateOptions(stateOptionFilter),
  ]);
  const leadFields = [
    "leadName",
    "position",
    "businessName",
    "businessAddress",
    "email",
    "phone",
    "website",
    "source",
    "category",
    "createdByName",
    "createdByType",
    "status",
    "assignedAgent",
    "assignedAgentName",
    "autoAssignedAt",
    "assignedTeam",
    "favoriteByEmployees",
    "googlePlaceId",
    "notes",
    "comments",
    "activity",
    "followUpAt",
    "followUpNote",
    "followUpPriority",
    "aiScore",
    "aiScoreReason",
    "aiScoreSource",
    "aiScoredAt",
    "createdAt",
    "updatedAt",
  ].join(" ");

  const shouldClientPageQueue = tab === "my" && !searchAll && Object.keys(searchFilter).length === 0;
  if (shouldClientPageQueue) {
    // Queue ordering needs every candidate, but hydrating every matching lead
    // (including populated relations and history) on each auto-call check is
    // prohibitively expensive. Sort lightweight candidates and hydrate only the
    // requested page.
    const candidates = await Lead.find(filter)
      .select("leadName businessName businessAddress email phone website status assignedAgent assignedAgentName followUpAt followUpPriority comments activity createdAt updatedAt")
      .slice("comments", -10)
      .slice("activity", 20)
      .sort({ createdAt: -1, _id: 1 })
      .lean();
    const sortedCandidates = sortLeadsForAgentWorkQueue(
      dedupeLeads(candidates as unknown as PopulatedLead[]),
      employeeNames,
    );
    const effectiveTotal = sortedCandidates.length;
    const pageCandidates = sortedCandidates.slice((page - 1) * limit, page * limit);
    const pageIds = pageCandidates.map((lead) => lead._id);
    const pageDocuments = pageIds.length > 0
      ? await Lead.find({ _id: { $in: pageIds } })
        .select(leadFields)
        .slice("comments", -10)
        .slice("activity", 20)
        .populate("assignedAgent", "name employeeCode aliases")
        .populate("assignedTeam", "name")
      : [];
    const documentsById = new Map(pageDocuments.map((lead) => [String(lead._id), lead]));
    const pagedLeads = pageIds
      .map((leadId) => documentsById.get(String(leadId)))
      .filter(Boolean);

    response.json({
      leads: pagedLeads,
      tab,
      page,
      limit,
      total: effectiveTotal,
      stateOptions,
      hasMore: page * limit < effectiveTotal,
      nextPage: page * limit < effectiveTotal ? page + 1 : null,
    });
    return;
  }

  const leads = await Lead.find(filter)
    .select(leadFields)
    .slice("comments", -10)
    .slice("activity", 20)
    .populate("assignedAgent", "name employeeCode aliases")
    .populate("assignedTeam", "name")
    .sort({ updatedAt: -1, createdAt: -1 })
    .skip((page - 1) * limit)
    .limit(limit);
  const pagedLeads = searchAll
    ? dedupeLeads(leads)
    : sortLeadsForAgentWorkQueue(dedupeLeads(leads), employeeNames);

  response.json({
    leads: pagedLeads,
    tab,
    page,
    limit,
    total,
    stateOptions,
    hasMore: page * limit < total,
    nextPage: page * limit < total ? page + 1 : null,
  });
}

export async function listAdminLeads(request: Request, response: Response) {
  const isExportMode = String(request.query.export || request.query.exportFile || "").toLowerCase() === "true";
  const maxLimit = isExportMode ? 10000 : 20;
  const defaultLimit = isExportMode ? 10000 : 20;
  const limit = Math.min(Math.max(Number(request.query.limit || defaultLimit) || defaultLimit, 1), maxLimit);
  const page = Math.max(Number(request.query.page || 1) || 1, 1);
  const filter = createAdminLeadTabFilter(request);
  const stateOptionFilter = createAdminLeadTabFilter(request, { includeStateFilter: false });
  const [total, stateOptions] = await Promise.all([
    Lead.countDocuments(filter),
    getLeadStateOptions(stateOptionFilter),
  ]);
  const tab = normalizeAdminLeadTab(request.params.tab || request.query.tab);
  const isQueueTab = tab === "leads" || tab === "unassigned";
  const detailFields = [
    "leadName",
    "position",
    "businessName",
    "businessAddress",
    "email",
    "phone",
    "website",
    "source",
    "category",
    "createdByName",
    "createdByType",
    "status",
    "assignedAgent",
    "assignedAgentName",
    "autoAssignedAt",
    "assignedTeam",
    "favoriteByEmployees",
    "googlePlaceId",
    "notes",
    "comments",
    "activity",
    "followUpAt",
    "followUpNote",
    "followUpPriority",
    "aiScore",
    "aiScoreReason",
    "aiScoreSource",
    "aiScoredAt",
    "createdAt",
    "updatedAt",
  ].join(" ");

  if (!isExportMode) {
    // Deduplication must happen before pagination on every tab. Queue ordering
    // additionally depends on schedule and activity data from the complete
    // result set. Load lightweight candidates first, then populate only the
    // visible page so counts and page boundaries stay exact.
    const candidates = await Lead.find(filter)
      .select("leadName businessName businessAddress email phone website status followUpAt comments activity createdAt updatedAt")
      .slice("comments", -10)
      .slice("activity", 30)
      .sort(isQueueTab ? { createdAt: -1, _id: 1 } : { updatedAt: -1, createdAt: -1 })
      .lean();
    const dedupedCandidates = dedupeLeads(candidates as unknown as PopulatedLead[]);
    const sortedCandidates = isQueueTab
      ? sortLeadsForAgentWorkQueue(dedupedCandidates)
      : dedupedCandidates;
    const effectiveTotal = sortedCandidates.length;
    const pageCandidates = sortedCandidates.slice((page - 1) * limit, page * limit);
    const pageIds = pageCandidates.map((lead) => lead._id);
    const pageDocuments = pageIds.length > 0
      ? await Lead.find({ _id: { $in: pageIds } })
        .select(detailFields)
        .slice("comments", -10)
        .slice("activity", 30)
        .populate(populateLead)
      : [];
    const documentsById = new Map(pageDocuments.map((lead) => [String(lead._id), lead]));
    const pagedLeads = pageIds
      .map((leadId) => documentsById.get(String(leadId)))
      .filter(Boolean);

    response.json({
      leads: pagedLeads,
      tab,
      page,
      limit,
      total: effectiveTotal,
      stateOptions,
      hasMore: page * limit < effectiveTotal,
      nextPage: page * limit < effectiveTotal ? page + 1 : null,
    });
    return;
  }

  const leads = await Lead.find(filter)
    .select(
      detailFields
    )
    .slice("comments", -10)
    .slice("activity", 30)
    .populate(populateLead)
    .sort(isQueueTab ? { createdAt: -1, _id: 1 } : { updatedAt: -1, createdAt: -1 })
    .limit(limit)
    .skip(isQueueTab ? 0 : (page - 1) * limit);
  const exportLeads = isExportMode ? leads : dedupeLeads(leads);
  const sortedLeads = isQueueTab ? sortLeadsForAgentWorkQueue(exportLeads) : exportLeads;
  const pagedLeads = isQueueTab ? sortedLeads.slice((page - 1) * limit, page * limit) : sortedLeads;
  const effectiveTotal = isQueueTab ? sortedLeads.length : total;

  response.json({
    leads: pagedLeads,
    tab,
    page,
    limit,
    total: effectiveTotal,
    stateOptions,
    hasMore: page * limit < effectiveTotal,
    nextPage: page * limit < effectiveTotal ? page + 1 : null,
  });
}

export async function listEmployeeLeadLogs(request: Request, response: Response) {
  const limit = Math.min(Math.max(Number(request.query.limit || 100) || 100, 1), 2000);
  const employee = String(request.query.employee || "").trim().toLowerCase();
  const action = String(request.query.action || "").trim().toLowerCase();
  const search = String(request.query.search || "").trim().toLowerCase();
  const start = request.query.start ? new Date(String(request.query.start)) : null;
  const end = request.query.end ? new Date(String(request.query.end)) : null;
  const leads = await Lead.find({
    $or: [{ "activity.actorType": "employee" }, { "comments.authorType": "employee" }],
  })
    .select("leadName businessName source category status comments activity followUpAt updatedAt")
    .sort({ updatedAt: -1 })
    .limit(750);
  const logs = leads.flatMap((lead) => {
    const leadObject = lead.toObject();
    const leadLabel = leadObject.leadName || leadObject.businessName || "lead";
    const activityLogs = (leadObject.activity || [])
      .filter((item) => item.actorType === "employee")
      .map((item) => {
        const normalizedLabel = String(item.label || "").toLowerCase();
        const displayAction = normalizedLabel === "follow up scheduled" ? "Rescheduled" : item.label || "Activity";

        return {
          id: `activity-${String(leadObject._id)}-${String(item.createdAt)}-${item.label}`,
          employeeName: item.actorName || "Employee",
          action: displayAction,
          detail: item.detail || `${item.actorName || "Employee"} updated ${leadLabel}.`,
          note: "",
          leadId: String(leadObject._id),
          leadName: leadObject.leadName || "",
          businessName: leadObject.businessName || "",
          source: leadObject.source || "",
          category: leadObject.category || "",
          status: leadObject.status || "",
          followUpAt: leadObject.followUpAt || null,
          createdAt: item.createdAt,
        };
      });
    const commentLogs = (leadObject.comments || [])
      .filter((comment) => comment.authorType === "employee")
      .map((comment) => ({
        id: `comment-${String(leadObject._id)}-${String(comment.createdAt)}-${comment.authorName}`,
        employeeName: comment.authorName || "Employee",
        action: "Commented",
        detail: `${comment.authorName || "Employee"} contacted ${leadLabel}.`,
        note: comment.body || "",
        leadId: String(leadObject._id),
        leadName: leadObject.leadName || "",
        businessName: leadObject.businessName || "",
        source: leadObject.source || "",
        category: leadObject.category || "",
        status: leadObject.status || "",
        followUpAt: leadObject.followUpAt || null,
        createdAt: comment.createdAt,
      }));

    return [...activityLogs, ...commentLogs];
  });
  const filteredLogs = logs
    .filter((log) => {
      const createdAt = new Date(log.createdAt || 0).getTime();
      if (Number.isNaN(createdAt)) return false;
      if (start && !Number.isNaN(start.getTime()) && createdAt < start.getTime()) return false;
      if (end && !Number.isNaN(end.getTime()) && createdAt > end.getTime()) return false;
      return true;
    })
    .filter((log) => !employee || log.employeeName.toLowerCase().includes(employee))
    .filter((log) => !action || log.action.toLowerCase().includes(action))
    .filter((log) => {
      if (!search) {
        return true;
      }

      return [log.employeeName, log.action, log.detail, log.note || "", log.leadName, log.businessName, log.source, log.category, log.status]
        .join(" ")
        .toLowerCase()
        .includes(search);
    })
    .sort((first, second) => new Date(second.createdAt || 0).getTime() - new Date(first.createdAt || 0).getTime())
    .slice(0, limit);

  response.json(filteredLogs);
}

export async function readAgentLeadDashboard(request: Request, response: Response) {
  const phToday = formatPhDate(new Date());
  const selectedMonth = normalizeDashboardMonth(request.query.month);
  const selectedCallDate = normalizeDashboardDate(request.query.callDate);
  const callDateStart = parseDateRangeBoundary(selectedCallDate, "start") || new Date(0);
  const callDateEnd = parseDateRangeBoundary(selectedCallDate, "end") || new Date();
  const phCallDate = formatPhDate(callDateStart);
  const selectedDateRange = createDashboardSelectedDateRange(request, selectedMonth);
  const callLogStart = new Date(Math.min(callDateStart.getTime(), selectedDateRange.start.getTime()));
  const callLogEnd = new Date(Math.max(callDateEnd.getTime(), selectedDateRange.end.getTime()));
  const now = Date.now();
  const [employees, leads, callLogs] = await Promise.all([
    Employee.find({ status: { $ne: "Archived" } })
      .select("name employeeCode aliases role team status availabilityStatus")
      .lean() as unknown as Promise<AgentDashboardEmployee[]>,
    Lead.find({})
      .select("leadName businessName businessAddress email phone website googlePlaceId providerPlaceId placeProvider source category status assignedAgent assignedAgentName comments activity followUpAt updatedAt createdAt")
      .sort({ updatedAt: -1, createdAt: -1 })
      .lean() as unknown as Promise<AgentDashboardLead[]>,
    LeadCallStat.aggregate<{ employeeId: string; employeeName: string; calledAt: Date }>([
      { $match: { "callLogs.calledAt": { $gte: callLogStart, $lte: callLogEnd } } },
      { $unwind: "$callLogs" },
      { $match: { "callLogs.calledAt": { $gte: callLogStart, $lte: callLogEnd } } },
      {
        $project: {
          _id: 0,
          employeeId: { $toString: "$callLogs.employee" },
          employeeName: "$callLogs.employeeName",
          calledAt: "$callLogs.calledAt",
        },
      },
    ]),
  ]);
  const rows = new Map<string, AgentDashboardRow>();
  const canonicalLeads = dedupeLeads(leads as unknown as PopulatedLead[]) as unknown as AgentDashboardLead[];
  const employeeById = new Map<string, AgentDashboardEmployee>();
  const employeeByName = new Map<string, AgentDashboardEmployee>();
  const likelyAgentIds = new Set<string>();
  const globalTouchedLeadIdsToday = new Set<string>();
  const monthlyRows = new Map<string, AgentDashboardMonthlyRow>();
  const monthlyOptions = new Set<string>([selectedMonth]);
  const recentActivity: {
    id: string;
    employeeId: string;
    employeeName: string;
    action: string;
    detail: string;
    leadId: string;
    leadName: string;
    businessName: string;
    status: string;
    createdAt: Date | string | null;
  }[] = [];

  const registerEmployeeName = (employee: AgentDashboardEmployee, value?: string | null) => {
    const key = getDashboardNameKey(value);

    if (key) {
      employeeByName.set(key, employee);
    }
  };

  const findLikelyEmployeeByName = (employeeName: string) => {
    const matches = employees.filter((employee) => isLikelySameDashboardPersonName(employee.name, employeeName));

    return matches.length === 1 ? matches[0] : null;
  };

  const ensureEmployeeRow = (employee: AgentDashboardEmployee) => {
    const employeeId = String(employee._id);
    const existingRow = rows.get(employeeId);

    if (existingRow) {
      return existingRow;
    }

    const row = makeAgentDashboardRow(employee, request.business);
    rows.set(employeeId, row);

    return row;
  };

  const ensureNamedRow = (employeeName: string) => {
    const key = getDashboardNameKey(employeeName);

    if (!key) {
      return null;
    }

    const employee = employeeByName.get(key) || findLikelyEmployeeByName(employeeName);

    if (employee) {
      return ensureEmployeeRow(employee);
    }

    return null;
  };

  const ensureMonthlyRow = (row: AgentDashboardRow) => {
    const existingRow = monthlyRows.get(row.employeeId);

    if (existingRow) {
      return existingRow;
    }

    const monthlyRow = makeAgentDashboardMonthlyRow(row);
    monthlyRows.set(row.employeeId, monthlyRow);

    return monthlyRow;
  };

  const trackMonthlyTouch = (row: AgentDashboardMonthlyRow, lead: AgentDashboardLead, createdAt?: Date | string | null) => {
    row.touchedLeadIds.add(String(lead._id));

    if (dateTimeValue(createdAt) > dateTimeValue(row.lastActivityAt)) {
      row.lastActivityAt = createdAt || null;
    }
  };

  const resolveAssignedRow = (lead: AgentDashboardLead) => {
    const assignedAgentId = getLeadAssignedAgentId(lead);

    if (assignedAgentId) {
      const employee = employeeById.get(assignedAgentId);

      if (employee) {
        return ensureEmployeeRow(employee);
      }
    }

    return ensureNamedRow(String(lead.assignedAgentName || ""));
  };

  const trackEmployeeEvent = (
    row: AgentDashboardRow | null,
    lead: AgentDashboardLead,
    event: { label: string; detail: string; createdAt?: Date | string | null },
    options: { isComment?: boolean } = {}
  ) => {
    if (!row) {
      return;
    }

    const createdAtTime = dateTimeValue(event.createdAt);

    if (createdAtTime > dateTimeValue(row.lastActivityAt)) {
      row.lastActivityAt = event.createdAt || null;
    }

    if (isSamePhDay(event.createdAt, phToday)) {
      row.activityToday += 1;
      row.touchedLeadIdsToday.add(String(lead._id));
      globalTouchedLeadIdsToday.add(String(lead._id));

      if (options.isComment) {
        row.commentsToday += 1;
      }

    }

    if (createdAtTime > 0) {
      recentActivity.push({
        id: `${row.employeeId}-${String(lead._id)}-${event.label}-${createdAtTime}`,
        employeeId: row.employeeId,
        employeeName: row.employeeName,
        action: event.label,
        detail: event.detail,
        leadId: String(lead._id),
        leadName: String(lead.leadName || ""),
        businessName: String(lead.businessName || ""),
        status: String(lead.status || "NEW"),
        createdAt: event.createdAt || null,
      });
    }
  };

  employees.forEach((employee) => {
    const employeeId = String(employee._id);
    employeeById.set(employeeId, employee);
    registerEmployeeName(employee, employee.name);
    registerEmployeeName(employee, employee.employeeCode);
    (employee.aliases || []).forEach((alias) => registerEmployeeName(employee, alias));

    if (isLikelyLeadAgent(employee)) {
      likelyAgentIds.add(employeeId);
      ensureEmployeeRow(employee);
    }
  });

  callLogs.forEach((callLog) => {
    const employee = employeeById.get(String(callLog.employeeId || ""));
    const row = employee
      ? ensureEmployeeRow(employee)
      : ensureNamedRow(String(callLog.employeeName || ""));

    if (!row) {
      return;
    }

    const calledAt = callLog.calledAt;
    const callMonth = getPhMonthKey(calledAt);

    if (callMonth) {
      monthlyOptions.add(callMonth);
    }

    if (isSamePhDay(calledAt, phCallDate)) {
      row.callsToday += 1;
    }

    if (isWithinDashboardDateRange(calledAt, selectedDateRange)) {
      ensureMonthlyRow(row).calls += 1;
    }

    if (dateTimeValue(calledAt) > dateTimeValue(row.lastActivityAt)) {
      row.lastActivityAt = calledAt;
    }
  });

  let totalOpenLeads = 0;
  let unassignedLeads = 0;
  let qualifiedLeads = 0;
  let negotiationLeads = 0;

  canonicalLeads.forEach((lead) => {
    const status = lead.status || "NEW";
    const isActiveLead = status !== "Dead" && status !== "Archived";
    const leadStatusBucket = getDashboardLeadStatusBucket(status);
    const assignedRow = resolveAssignedRow(lead);
    const leadAddedAt = getDashboardLeadAddedAt(lead);
    const leadCreatedMonth = getPhMonthKey(leadAddedAt);

    if (leadCreatedMonth) {
      monthlyOptions.add(leadCreatedMonth);
    }

    if (isActiveLead) {
      totalOpenLeads += 1;
    }

    if (!assignedRow && isActiveLead) {
      unassignedLeads += 1;
    }

    if (status === "Qualified") {
      qualifiedLeads += 1;
    }

    if (status === "Ongoing Negotiation") {
      negotiationLeads += 1;
    }

    if (assignedRow) {
      assignedRow.assignedLeads += 1;

      if (leadStatusBucket === "new") assignedRow.newLeads += 1;
      if (leadStatusBucket === "followUp") assignedRow.followUps += 1;
      if (leadStatusBucket === "qualified") assignedRow.qualified += 1;
      if (leadStatusBucket === "archiveDead") assignedRow.dead += 1;

      if (lead.followUpAt && dateTimeValue(lead.followUpAt) <= now && status === "Follow up") {
        assignedRow.dueFollowUps += 1;
      }

      if (isSamePhDay(lead.followUpAt, phToday)) {
        assignedRow.scheduledToday += 1;
      }
    }

    if (assignedRow && isWithinDashboardDateRange(leadAddedAt, selectedDateRange)) {
      const monthlyRow = ensureMonthlyRow(assignedRow);
      monthlyRow.addedLeadIds.add(String(lead._id));
      trackMonthlyTouch(monthlyRow, lead, leadAddedAt);
    }

    if (assignedRow && leadStatusBucket !== "new") {
      const currentStatusAt = getDashboardCurrentStatusAt(lead);
      const currentStatusMonth = getPhMonthKey(currentStatusAt);

      if (currentStatusMonth) {
        monthlyOptions.add(currentStatusMonth);
      }

      if (isWithinDashboardDateRange(currentStatusAt, selectedDateRange)) {
        const monthlyRow = ensureMonthlyRow(assignedRow);
        trackMonthlyStatusBucket(monthlyRow, lead, status, currentStatusAt);
        trackMonthlyTouch(monthlyRow, lead, currentStatusAt);
      }
    }

    (lead.comments || []).forEach((comment) => {
      const commentMonth = getPhMonthKey(comment.createdAt);

      if (commentMonth) {
        monthlyOptions.add(commentMonth);
      }

      if (comment.authorType !== "employee") {
        return;
      }

      const row = ensureNamedRow(String(comment.authorName || ""));
      if (row && isWithinDashboardDateRange(comment.createdAt, selectedDateRange)) {
        const monthlyRow = ensureMonthlyRow(row);
        monthlyRow.comments += 1;
        trackMonthlyTouch(monthlyRow, lead, comment.createdAt);
      }

      trackEmployeeEvent(
        row,
        lead,
        {
          label: "Commented",
          detail: `${row?.employeeName || comment.authorName || "Employee"} contacted ${getLeadDisplayName(lead)}.`,
          createdAt: comment.createdAt,
        },
        { isComment: true }
      );
    });

    (lead.activity || []).forEach((item) => {
      const activityMonth = getPhMonthKey(item.createdAt);

      if (activityMonth) {
        monthlyOptions.add(activityMonth);
      }

      const label = item.label || "Activity";
      const normalizedLabel = normalizeLeadValue(label);
      const activityStatus = getDashboardActivityResultStatus(item);
      const actorRow = item.actorType === "employee" ? ensureNamedRow(String(item.actorName || "")) : null;
      const statusOwnerRow = actorRow || (activityStatus ? assignedRow : null);

      if (statusOwnerRow && isWithinDashboardDateRange(item.createdAt, selectedDateRange)) {
        const monthlyRow = ensureMonthlyRow(statusOwnerRow);

        if (actorRow && normalizedLabel !== "comment added") monthlyRow.actions += 1;
        trackMonthlyTouch(monthlyRow, lead, item.createdAt);
      }

      if (!actorRow) {
        return;
      }

      trackEmployeeEvent(actorRow, lead, {
        label: normalizedLabel === "follow up scheduled" ? "Rescheduled" : label,
        detail: item.detail || `${actorRow.employeeName || item.actorName || "Employee"} updated ${getLeadDisplayName(lead)}.`,
        createdAt: item.createdAt,
      });
    });
  });

  const agents = Array.from(rows.values())
    .filter((row) => isDashboardAgentRole(row.role) && (likelyAgentIds.has(row.employeeId) || row.assignedLeads > 0 || row.dead > 0 || row.callsToday > 0 || row.activityToday > 0 || Boolean(row.lastActivityAt)))
    .map((row) => {
      const { touchedLeadIdsToday, ...publicRow } = row;
      const touchedLeadsToday = touchedLeadIdsToday.size;
      const progressPercent = row.assignedLeads > 0 ? Math.round(((row.followUps + row.qualified) / row.assignedLeads) * 100) : 0;
      const productivityScore =
        touchedLeadsToday * 4 +
        row.commentsToday * 3 +
        row.activityToday +
        row.scheduledToday * 2 +
        row.qualified * 2;

      return {
        ...publicRow,
        touchedLeadsToday,
        progressPercent,
        productivityScore,
      };
    })
    .sort((first, second) => {
      if (second.productivityScore !== first.productivityScore) {
        return second.productivityScore - first.productivityScore;
      }

      if (second.assignedLeads !== first.assignedLeads) {
        return second.assignedLeads - first.assignedLeads;
      }

      return first.employeeName.localeCompare(second.employeeName);
    });

  response.json({
    generatedAt: new Date(),
    business: {
      id: String(request.business?.id || ""),
      name: String(request.business?.name || "Current business"),
    },
    summary: {
      totalActiveAgents: agents.length,
      onlineAgents: agents.filter((agent) => agent.availabilityStatus !== "OFFLINE").length,
      totalOpenLeads,
      unassignedLeads,
      dueFollowUps: agents.reduce((total, agent) => total + agent.dueFollowUps, 0),
      touchedLeadsToday: globalTouchedLeadIdsToday.size,
      commentsToday: agents.reduce((total, agent) => total + agent.commentsToday, 0),
      callsToday: agents.reduce((total, agent) => total + agent.callsToday, 0),
      activityToday: agents.reduce((total, agent) => total + agent.activityToday, 0),
      qualifiedLeads,
      negotiationLeads,
    },
    agents,
    selectedMonth,
    selectedCallDate,
    selectedDateFrom: selectedDateRange.dateFrom,
    selectedDateTo: selectedDateRange.dateTo,
    monthOptions: Array.from(monthlyOptions).sort((first, second) => second.localeCompare(first)),
    monthlyAgents: Array.from(monthlyRows.values())
      .filter((row) => isDashboardAgentRole(row.role))
      .map((row) => {
        const leadsAdded = row.addedLeadIds.size;
        const followUps = row.followUpLeadIds.size;
        const qualified = row.qualifiedLeadIds.size;
        const archiveDead = row.archiveDeadLeadIds.size;
        const touchedLeads = row.touchedLeadIds.size;
        const productivityScore = touchedLeads * 4 + row.comments * 3 + row.actions + qualified * 2;
        const qualifiedLeads = Array.from(row.qualifiedLeadDetails.values())
          .sort((first, second) => dateTimeValue(second.statusAt) - dateTimeValue(first.statusAt));
        const { addedLeadIds, followUpLeadIds, qualifiedLeadIds, archiveDeadLeadIds, qualifiedLeadDetails, touchedLeadIds, ...publicRow } = row;

        return {
          ...publicRow,
          leadsAdded,
          followUps,
          qualified,
          qualifiedLeads,
          archiveDead,
          touchedLeads,
          productivityScore,
        };
      })
      .sort((first, second) => {
        if (second.productivityScore !== first.productivityScore) {
          return second.productivityScore - first.productivityScore;
        }

        if (second.leadsAdded !== first.leadsAdded) {
          return second.leadsAdded - first.leadsAdded;
        }

        return first.employeeName.localeCompare(second.employeeName);
      }),
    recentActivity: recentActivity
      .filter((item) => {
        const row = rows.get(item.employeeId);
        return isDashboardAgentRole(row?.role);
      })
      .sort((first, second) => dateTimeValue(second.createdAt) - dateTimeValue(first.createdAt))
      .slice(0, 12),
  });
}

export async function countAdminLeads(request: Request, response: Response) {
  const baseFilter = createAdminBaseFilter(request);
  const leads = await Lead.find(baseFilter)
    .select("status assignedAgent assignedAgentName email phone website businessName businessAddress createdAt")
    .sort({ createdAt: -1, _id: 1 })
    .lean();
  const counts: Record<string, number> = Object.fromEntries(leadStatuses.map((statusName) => [statusName, 0]));

  leadStatuses.forEach((statusName) => {
    counts[statusName] = dedupeLeads(
      leads.filter((lead) => (lead.status || "NEW") === statusName) as unknown as PopulatedLead[]
    ).length;
  });

  counts.ALL = dedupeLeads(
    leads.filter((lead) => lead.status !== "Archived") as unknown as PopulatedLead[]
  ).length;
  counts.Unassigned = dedupeLeads(
    leads.filter((lead) =>
      ["NEW", "Follow up", "Ongoing comms", "Qualified", "Ongoing Negotiation"].includes(lead.status || "NEW") &&
      !lead.assignedAgent &&
      !String(lead.assignedAgentName || "").trim()
    ) as unknown as PopulatedLead[]
  ).length;

  response.json(counts);
}

export async function countMyLeads(request: Request, response: Response) {
  const employeeId = String(request.query.employeeId || "").trim();
  const employeeNames = parseQueryList(request.query.employeeNames || request.query.employeeName);
  const assignmentFilters = createEmployeeLeadAssignmentFilters(employeeId, employeeNames);
  const canViewAllLeadQueues = await canEmployeeViewAllLeadQueues(employeeId);
  const canViewCompletedQueue = await canEmployeeViewCompletedLeadQueue(employeeId);

  if (!canViewAllLeadQueues && assignmentFilters.length === 0) {
    response.status(400).json({ message: "employeeId or employeeName is required" });
    return;
  }

  const stateFilter = createLeadStateAddressFilter(request.query.state || request.query.stateFilter);
  const baseAndFilters: Record<string, unknown>[] = [];

  if (!canViewAllLeadQueues) {
    baseAndFilters.push({ $or: assignmentFilters });
  }

  if (stateFilter) {
    baseAndFilters.push(stateFilter);
  }

  const baseFilter = baseAndFilters.length > 0 ? { $and: baseAndFilters } : {};
  const statusCounts = await Lead.aggregate<{ _id: string; count: number }>([
    { $match: baseFilter },
    { $group: { _id: "$status", count: { $sum: 1 } } },
  ]);
  const counts: Record<string, number> = Object.fromEntries(leadStatuses.map((statusName) => [statusName, 0]));

  statusCounts.forEach((item) => {
    counts[item._id || "NEW"] = item.count;
  });

  if (!canViewAllLeadQueues && canViewCompletedQueue) {
    counts.Completed = await Lead.countDocuments({ status: "Completed" });
  }

  counts.ALL = await Lead.countDocuments({
    ...baseFilter,
    status: { $in: getEmployeeLeadTabStatuses("all") },
  });
  counts.ContactedToday = await Lead.countDocuments({
    ...baseFilter,
    status: { $in: getEmployeeLeadTabStatuses("my") },
    ...createHiddenFromEmployeeQueueTodayFilter(),
  });

  response.json(counts);
}

type EmployeeLeadTab = "my" | "qualified" | "negotiation" | "completed" | "dead" | "archived" | "all";
type AdminLeadTab = "leads" | "qualified" | "negotiation" | "completed" | "dead" | "archived" | "unassigned" | "all";

function normalizeAdminLeadTab(value: unknown): AdminLeadTab {
  const normalizedValue = normalizeLeadValue(String(value || "leads"));
  const tabMap: Record<string, AdminLeadTab> = {
    leads: "leads",
    new: "leads",
    "my leads": "leads",
    qualified: "qualified",
    negotiation: "negotiation",
    "ongoing negotiation": "negotiation",
    "ongoing-negotiation": "negotiation",
    completed: "completed",
    complete: "completed",
    done: "completed",
    dead: "dead",
    archived: "archived",
    unassigned: "unassigned",
    all: "all",
  };

  return tabMap[normalizedValue] || "leads";
}

function getAdminLeadTabStatuses(tab: AdminLeadTab, queueFilter: string): (typeof leadStatuses)[number][] {
  if (tab === "leads" || tab === "unassigned") {
    if (queueFilter === "NEW" || queueFilter === "Follow up") {
      return [queueFilter];
    }

    if (tab === "leads") {
      return ["NEW", "Follow up"];
    }
  }

  const statusesByTab: Partial<Record<AdminLeadTab, (typeof leadStatuses)[number][]>> = {
    qualified: ["Qualified"],
    negotiation: ["Ongoing Negotiation"],
    completed: ["Completed"],
    dead: ["Dead"],
    archived: ["Archived"],
    unassigned: ["NEW", "Follow up", "Ongoing comms", "Qualified", "Ongoing Negotiation"],
    all: ["NEW", "Follow up", "Ongoing comms", "Qualified", "Ongoing Negotiation", "Completed", "Dead"],
  };

  return statusesByTab[tab] || ["NEW", "Follow up"];
}

function createAdminAssignmentFilters(request: Request) {
  const assignedAgent = String(request.query.assignedAgent || "").trim();
  const assignedAgentNames = parseQueryList(request.query.assignedAgentNames || request.query.assignedAgentName);
  const assignmentFilters: Record<string, unknown>[] = [];

  if (assignedAgent && Types.ObjectId.isValid(assignedAgent)) {
    assignmentFilters.push({ assignedAgent: new Types.ObjectId(assignedAgent) });
  }

  assignedAgentNames.forEach((assignedAgentName) => {
    assignmentFilters.push({ assignedAgentName: flexibleExactRegex(assignedAgentName) });
  });

  return assignmentFilters;
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function createAdminBaseFilter(request: Request, options: { includeStateFilter?: boolean } = {}) {
  const includeStateFilter = options.includeStateFilter !== false;

  const searchFilter = createLeadSearchFilter(String(request.query.search || ""));
  const assignmentFilters = createAdminAssignmentFilters(request);
  const andFilters: Record<string, unknown>[] = [];

  if (assignmentFilters.length === 1) {
    andFilters.push(assignmentFilters[0]);
  }

  if (assignmentFilters.length > 1) {
    andFilters.push({ $or: assignmentFilters });
  }

  if (Object.keys(searchFilter).length > 0) {
    andFilters.push(searchFilter);
  }

  if (includeStateFilter) {
    const stateFilter = createLeadStateAddressFilter(request.query.state || request.query.stateFilter);

    if (stateFilter) {
      andFilters.push(stateFilter);
    }
  }

  if (String(request.query.unassigned || "").toLowerCase() === "true") {
    andFilters.push(
      { $or: [{ assignedAgent: null }, { assignedAgent: { $exists: false } }] },
      { $or: [{ assignedAgentName: "" }, { assignedAgentName: { $exists: false } }] },
    );
  }

  return andFilters.length > 0 ? { $and: andFilters } : {};
}

function createAdminLeadTabFilter(request: Request, options: { includeStateFilter?: boolean } = {}) {
  const tab = normalizeAdminLeadTab(request.params.tab || request.query.tab);
  const queueFilter = String(request.query.queue || request.query.leadQueueFilter || "ALL").trim();
  const rawStatusFilter = String(request.query.statusFilter || request.query.status || "").trim();
  const statusFilter = rawStatusFilter && normalizeLeadValue(rawStatusFilter) !== "all" ? normalizeLeadStatus(rawStatusFilter) : null;
  const filter: Record<string, unknown> = {
    ...createAdminBaseFilter(request, options),
    status: { $in: getAdminLeadTabStatuses(tab, queueFilter) },
  };

  if (tab === "all" && statusFilter && statusFilter !== "Archived" && leadStatuses.includes(statusFilter)) {
    filter.status = statusFilter;
  }

  if (tab === "qualified") {
    const qualifiedDateRangeFilter = createQualifiedDateRangeFilter(request);

    if (qualifiedDateRangeFilter) {
      const existingAndFilters = Array.isArray(filter.$and) ? filter.$and : [];
      filter.$and = [...existingAndFilters, qualifiedDateRangeFilter];
    }
  }

  if (tab === "unassigned" || String(request.query.unassigned || "").toLowerCase() === "true") {
    const existingAndFilters = Array.isArray(filter.$and) ? filter.$and : [];
    filter.$and = [
      ...existingAndFilters,
      { $or: [{ assignedAgent: null }, { assignedAgent: { $exists: false } }] },
      { $or: [{ assignedAgentName: "" }, { assignedAgentName: { $exists: false } }] },
    ];
  }

  return filter;
}

function normalizeEmployeeLeadTab(value: unknown): EmployeeLeadTab {
  const normalizedValue = normalizeLeadValue(String(value || "my"));
  const tabMap: Record<string, EmployeeLeadTab> = {
    my: "my",
    "my leads": "my",
    new: "my",
    "follow up": "my",
    followup: "my",
    qualified: "qualified",
    negotiation: "negotiation",
    "ongoing negotiation": "negotiation",
    "ongoing-negotiation": "negotiation",
    completed: "completed",
    complete: "completed",
    done: "completed",
    dead: "dead",
    archived: "archived",
    all: "all",
  };

  return tabMap[normalizedValue] || "my";
}

function getEmployeeLeadTabStatuses(tab: EmployeeLeadTab, queueFilter = "ALL"): (typeof leadStatuses)[number][] {
  if (tab === "my" && (queueFilter === "NEW" || queueFilter === "Follow up")) {
    return [queueFilter];
  }

  const statusesByTab: Record<EmployeeLeadTab, (typeof leadStatuses)[number][]> = {
    my: ["NEW", "Follow up"],
    qualified: ["Qualified"],
    negotiation: ["Ongoing Negotiation"],
    completed: ["Completed"],
    dead: ["Dead"],
    archived: ["Archived"],
    all: ["NEW", "Follow up", "Ongoing comms", "Qualified", "Ongoing Negotiation", "Completed", "Dead"],
  };

  return statusesByTab[tab];
}

function createEmployeeLeadAssignmentFilters(employeeId: string, employeeNames: string[]) {
  const assignmentFilters: Record<string, unknown>[] = [];

  if (employeeId && Types.ObjectId.isValid(employeeId)) {
    assignmentFilters.push({ assignedAgent: new Types.ObjectId(employeeId) });
  }

  employeeNames.forEach((employeeName) => {
    assignmentFilters.push({ assignedAgentName: flexibleExactRegex(employeeName) });
  });

  return assignmentFilters;
}

function createLeadSearchFilter(search: string) {
  const trimmedSearch = search.trim();

  if (!trimmedSearch) {
    return {};
  }

  const searchRegex = new RegExp(escapeRegex(trimmedSearch), "i");
  const phoneRegexes = flexiblePhoneRegexes(trimmedSearch);
  const partialPhoneRegex = phoneSearchRegex(trimmedSearch);
  const searchFields: Record<string, unknown>[] = [
    { leadName: searchRegex },
    { position: searchRegex },
    { businessName: searchRegex },
    { businessAddress: searchRegex },
    { email: searchRegex },
    { phone: searchRegex },
    { website: searchRegex },
    { source: searchRegex },
    { category: searchRegex },
    { status: searchRegex },
    { assignedAgentName: searchRegex },
    { notes: searchRegex },
    { "comments.body": searchRegex },
    { "comments.authorName": searchRegex },
    { followUpNote: searchRegex },
    { "activity.detail": searchRegex },
    { googlePlaceId: searchRegex },
  ];

  phoneRegexes.forEach((phoneRegex) => {
    searchFields.push({ phone: phoneRegex });
  });

  if (partialPhoneRegex) {
    searchFields.push({ phone: partialPhoneRegex });
  }

  return {
    $or: searchFields,
  };
}

export async function countLeads(request: Request, response: Response) {
  const searchFilter = createLeadSearchFilter(String(request.query.search || ""));
  const assignedAgent = String(request.query.assignedAgent || "").trim();
  const assignedAgentNames = parseQueryList(request.query.assignedAgentNames || request.query.assignedAgentName);
  const assignmentFilters: Record<string, unknown>[] = [];
  const andFilters: Record<string, unknown>[] = [];

  if (assignedAgent) {
    assignmentFilters.push({ assignedAgent });
  }

  assignedAgentNames.forEach((assignedAgentName) => {
    assignmentFilters.push({ assignedAgentName: flexibleExactRegex(assignedAgentName) });
  });

  if (assignmentFilters.length === 1) {
    andFilters.push(assignmentFilters[0]);
  }

  if (assignmentFilters.length > 1) {
    andFilters.push({ $or: assignmentFilters });
  }

  if (Object.keys(searchFilter).length > 0) {
    andFilters.push(searchFilter);
  }

  const baseFilter = andFilters.length > 0 ? { $and: andFilters } : {};
  const statusCounts = await Lead.aggregate<{ _id: string; count: number }>([
    { $match: baseFilter },
    { $group: { _id: "$status", count: { $sum: 1 } } },
  ]);
  const counts: Record<string, number> = Object.fromEntries(leadStatuses.map((statusName) => [statusName, 0]));

  statusCounts.forEach((item) => {
    counts[item._id || "NEW"] = item.count;
  });

  counts.ALL = await Lead.countDocuments({ ...baseFilter, status: { $ne: "Archived" } });
  counts.Unassigned = await Lead.countDocuments({
    ...baseFilter,
    status: { $nin: ["Archived", "Dead"] },
    $and: [
      { $or: [{ assignedAgent: null }, { assignedAgent: { $exists: false } }] },
      { $or: [{ assignedAgentName: "" }, { assignedAgentName: { $exists: false } }] },
    ],
  });

  response.json(counts);
}

export async function scoreLeadsByHighestPotential(request: Request, response: Response) {
  const leadIds = Array.isArray(request.body.leadIds)
    ? request.body.leadIds.filter((leadId: unknown): leadId is string => typeof leadId === "string" && Boolean(leadId))
    : [];
  const query: Record<string, unknown> = { status: { $ne: "Archived" } };

  if (leadIds.length > 0) {
    query._id = { $in: leadIds };
  }

  const leads = await Lead.find(query).sort({ createdAt: -1 });
  const scores = await scoreLeadsByPotential(leads);
  const scoredAt = new Date();

  if (scores.length > 0) {
    await Lead.bulkWrite(
      scores.map((score) => ({
        updateOne: {
          filter: { _id: score.leadId },
          update: {
            $set: {
              aiScore: score.score,
              aiScoreReason: score.reason,
              aiScoreSource: score.source,
              aiScoredAt: scoredAt,
            },
          },
        },
      })),
      { ordered: false }
    );
  }

  const sortedLeadIds = scores.map((score) => score.leadId);
  const sortedLeads = await Lead.find({ _id: { $in: sortedLeadIds } }).populate(populateLead);
  const leadsById = new Map(sortedLeads.map((lead) => [String(lead._id), lead]));

  response.json({
    usedAi: scores.some((score) => score.source === "openai"),
    leads: sortedLeadIds.map((leadId) => leadsById.get(leadId)).filter(Boolean),
  });
}

export async function createLead(request: Request, response: Response) {
  const autoAssignmentEnabled = await isLeadAutoAssignmentEnabled();
  const assignmentCandidates = autoAssignmentEnabled ? await createAssignmentCandidates() : [];
  const assignedAgent = request.body.assignedAgent || pickAssignmentCandidate(assignmentCandidates);
  const creator = getActivityActor(request);
  const leadInput = {
    leadName: request.body.leadName || "",
    position: request.body.position || "",
    businessName: request.body.businessName,
    businessAddress: request.body.businessAddress || "",
    email: request.body.email || "",
    phone: request.body.phone || "",
    website: request.body.website || "",
    source: request.body.source || "Manual",
    category: request.body.category || "",
    createdByName: creator.actorName,
    createdByType: creator.actorType,
    status: request.body.status || "NEW",
    assignedAgent,
    assignedAgentName: request.body.assignedAgentName || "",
    autoAssignedAt: autoAssignmentEnabled && assignedAgent && !request.body.assignedAgent ? new Date() : null,
    assignedTeam: request.body.assignedTeam || null,
    googlePlaceId: request.body.googlePlaceId || "",
    notes: request.body.notes || "",
    followUpAt: request.body.followUpAt || null,
    followUpNote: request.body.followUpNote || "",
    followUpPriority: request.body.followUpPriority || 0,
    aiScore: request.body.aiScore || 0,
    aiScoreReason: request.body.aiScoreReason || "",
    aiScoreSource: request.body.aiScoreSource || "",
    aiScoredAt: request.body.aiScoredAt || null,
    activity: [
      leadActivity("Lead created", `${creator.actorName} created this lead${request.body.category ? ` under ${request.body.category}` : ""}.`, creator),
    ],
  };

  const duplicateLead = await findDuplicateLead(leadInput);

  if (duplicateLead) {
    response.status(200).json(duplicateLead);
    return;
  }

  const lead = await Lead.create(leadInput);

  const populatedLead = await Lead.findById(lead.id).populate(populateLead);
  emitLeadMutation("created", populatedLead);
  response.status(201).json(populatedLead);
}

export async function importLeads(request: Request, response: Response) {
  const rawLeads: Array<Record<string, unknown>> = Array.isArray(request.body.leads) ? request.body.leads : [];
  const validLeads = rawLeads
    .map((lead): ImportedLead | null => {
      const businessName = String(lead.businessName || lead["Business Name"] || lead["Company Name"] || lead.Company || lead.Name || "").trim();
      const phone = String(
        lead.phone ||
        lead.Phone ||
        lead["Phone Number"] ||
        lead["Phone No"] ||
        lead["Phone No."] ||
        lead.Telephone ||
        lead.Mobile ||
        lead["Mobile Number"] ||
        lead["Contact Number"] ||
        ""
      ).trim();

      if (!businessName) {
        return null;
      }

      const createdAt = parseOptionalDate(lead.createdAt || lead["Created At"]);

      return {
        leadName: String(lead.leadName || lead["Lead Name"] || lead["Contact Name"] || lead.Name || "").trim(),
        position: String(lead.position || lead.Position || lead.Title || "").trim(),
        businessName,
        businessAddress: String(lead.businessAddress || lead["Business Address"] || lead.Address || "").trim(),
        email: String(lead.email || lead.Email || lead["Email Address"] || lead["E-mail"] || lead["E-mail Address"] || "").trim(),
        phone,
        website: String(lead.website || lead.Website || "").trim(),
        source: String(lead.source || lead.Source || "CSV Import").trim() || "CSV Import",
        category: String(lead.category || lead.Category || lead["Biz Type"] || lead["Business Type"] || "").trim(),
        status: normalizeLeadStatus(lead.status || lead.Status),
        assignedAgent: null,
        assignedAgentName: String(lead.assignedAgentName || lead.assignedToName || lead["Assigned To"] || lead["Assigned Agent"] || lead.Agent || "").trim(),
        autoAssignedAt: null,
        assignedToName: String(lead.assignedToName || lead["Assigned To"] || lead["Assigned Agent"] || lead.Agent || "").trim(),
        assignedTeam: null,
        googlePlaceId: String(lead.googlePlaceId || lead["Google Place ID"] || lead["Google Place Id"] || "").trim(),
        notes: String(lead.notes || lead.Notes || "").trim(),
        followUpAt: null,
        followUpNote: "",
        followUpPriority: 0,
        aiScore: 0,
        aiScoreReason: "",
        aiScoreSource: "",
        aiScoredAt: null,
        ...(createdAt ? { createdAt } : {}),
      };
    })
    .filter((lead): lead is ImportedLead => Boolean(lead));

  if (validLeads.length === 0) {
    response.status(400).json({ message: "No valid leads found in import" });
    return;
  }

  const leadsToImport = validLeads;
  const assignedToNames = Array.from(new Set(leadsToImport.map((lead) => lead.assignedToName).filter(Boolean)));
  const assignedEmployees = assignedToNames.length > 0
    ? await Employee.find({
      status: { $ne: "Archived" },
      $or: assignedToNames.flatMap((name) => [
        { name: flexibleExactRegex(name) },
        { employeeCode: flexibleExactRegex(name) },
        { aliases: flexibleExactRegex(name) },
      ]),
    }).select("_id name employeeCode aliases")
    : [];
  const employeesByAssignedTo = new Map(
    assignedEmployees.flatMap((employee) => {
      const aliases = Array.isArray(employee.aliases) ? employee.aliases : [];
      return [
        [normalizeLeadValue(employee.name), employee._id],
        [normalizeLeadValue(employee.employeeCode), employee._id],
        ...aliases.map((alias) => [normalizeLeadValue(alias), employee._id] as const),
      ];
    })
  );

  const newLeads = leadsToImport;

  if (newLeads.length > 0) {
    await Lead.bulkWrite(
      newLeads.map((lead) => {
        const importedAssignedAgent = employeesByAssignedTo.get(normalizeLeadValue(lead.assignedToName)) || null;
        const { createdAt, assignedToName, ...leadFields } = lead;
        const setFields: Record<string, unknown> = {
          leadName: leadFields.leadName,
          position: leadFields.position,
          businessName: leadFields.businessName,
          businessAddress: leadFields.businessAddress,
          email: leadFields.email,
          phone: leadFields.phone,
          website: leadFields.website,
          source: leadFields.source,
          category: leadFields.category,
          createdByName: "CSV Import",
          createdByType: "system",
          notes: leadFields.notes,
          googlePlaceId: leadFields.googlePlaceId,
          assignedAgent: importedAssignedAgent,
          assignedAgentName: assignedToName,
          autoAssignedAt: null,
        };
        const noteComment = leadFields.notes
          ? {
            authorName: "CSV Import",
            authorType: "admin" as const,
            body: leadFields.notes,
            createdAt: createdAt || new Date(),
          }
          : null;

        return {
          insertOne: {
            document: {
              ...setFields,
              status: leadFields.status,
              assignedTeam: leadFields.assignedTeam,
              followUpAt: leadFields.followUpAt,
              followUpNote: leadFields.followUpNote,
              followUpPriority: leadFields.followUpPriority,
              aiScore: leadFields.aiScore,
              aiScoreReason: leadFields.aiScoreReason,
              aiScoreSource: leadFields.aiScoreSource,
              aiScoredAt: leadFields.aiScoredAt,
              comments: noteComment ? [noteComment] : [],
              activity: [
                leadActivity("Lead created", `${leadFields.source || "CSV Import"} lead added${leadFields.category ? ` under ${leadFields.category}` : ""}.`, {
                  actorName: "CSV Import",
                  actorType: "system",
                }),
              ],
              ...(createdAt ? { createdAt } : {}),
            },
          },
        };
      }),
      { ordered: false }
    );
  }

  response.status(201).json({
    importedCount: newLeads.length,
    skippedCount: rawLeads.length - newLeads.length,
    duplicateCount: 0,
    leads: [],
  });
}

export async function updateLead(request: Request, response: Response) {
  const leadId = String(request.params.id);
  const existingLead = await Lead.findById(leadId);
  const leadInput = {
    leadName: request.body.leadName || "",
    position: request.body.position || "",
    businessName: request.body.businessName,
    businessAddress: request.body.businessAddress || "",
    email: request.body.email || "",
    phone: request.body.phone || "",
    website: request.body.website || "",
    source: request.body.source || "Manual",
    category: request.body.category || "",
    status: request.body.status || "NEW",
    assignedAgent: request.body.assignedAgent || null,
    assignedAgentName: request.body.assignedAgentName || "",
    assignedTeam: request.body.assignedTeam || null,
    googlePlaceId: request.body.googlePlaceId || "",
    notes: request.body.notes || "",
    followUpAt: request.body.followUpAt || null,
    followUpNote: request.body.followUpNote || "",
    followUpPriority: request.body.followUpPriority || 0,
    aiScore: request.body.aiScore || 0,
    aiScoreReason: request.body.aiScoreReason || "",
    aiScoreSource: request.body.aiScoreSource || "",
    aiScoredAt: request.body.aiScoredAt || null,
  };

  if (leadInput.status === "Qualified") {
    leadInput.followUpAt = null;
    leadInput.followUpNote = "";
    leadInput.followUpPriority = 0;
  }

  const shouldCheckDuplicates = hasDuplicateSensitiveLeadChanges(existingLead?.toObject() || null, leadInput);
  const duplicateLead = shouldCheckDuplicates ? await findDuplicateLead(leadInput, leadId) : null;

  if (duplicateLead) {
    const duplicateLeadRecord = duplicateLead.toObject() as Record<string, unknown>;
    response.status(409).json({
      message: getDuplicateLeadMessage(leadInput, duplicateLeadRecord),
      duplicate: {
        fields: getDuplicateLeadConflict(leadInput, duplicateLeadRecord),
        leadId: String(duplicateLead._id),
        leadName: duplicateLead.leadName,
        businessName: duplicateLead.businessName,
        phone: duplicateLead.phone,
        website: duplicateLead.website,
        assignedAgentName: duplicateLead.assignedAgentName,
        status: duplicateLead.status,
      },
      lead: duplicateLead,
    });
    return;
  }

  if (leadInput.assignedAgent) {
    if (!Types.ObjectId.isValid(String(leadInput.assignedAgent))) {
      response.status(400).json({ message: "Select a valid Sales employee" });
      return;
    }

    const assignedEmployee = await Employee.findById(leadInput.assignedAgent).select("name status role team");

    if (!assignedEmployee || assignedEmployee.status === "Archived" || !isSalesAssignableEmployee(assignedEmployee)) {
      response.status(400).json({ message: "Lead can only be assigned to a non-archived employee in Sales" });
      return;
    }

    leadInput.assignedAgentName = assignedEmployee.name;
  }

  const changedFields = existingLead ? summarizeLeadChanges(existingLead.toObject(), leadInput) : [];
  const assignmentChanged = existingLead && String(existingLead.assignedAgent || "") !== String(leadInput.assignedAgent || "");
  const actor = getActivityActor(request);
  const nextAssignedName = leadInput.assignedAgent ? await getEmployeeName(leadInput.assignedAgent) : leadInput.assignedAgentName;
  const updatePayload: Record<string, unknown> = { $set: leadInput };

  if (assignmentChanged) {
    updatePayload.$push = activityPush(
      "Assigned",
      actor.actorType === "employee"
        ? `${actor.actorName} passed this lead${nextAssignedName ? ` to ${nextAssignedName}` : ""}.`
        : `${actor.actorName} assigned this lead${nextAssignedName ? ` to ${nextAssignedName}` : ""}.`,
      actor
    );
  } else if (changedFields.length > 0) {
    updatePayload.$push = activityPush("Lead updated", `${actor.actorName} updated ${changedFields.slice(0, 5).join(", ")}.`, actor);
  }

  const lead = await Lead.findByIdAndUpdate(
    leadId,
    updatePayload,
    { returnDocument: "after", runValidators: true }
  ).populate(populateLead);

  if (!lead) {
    response.status(404).json({ message: "Lead not found" });
    return;
  }

  emitLeadMutation("updated", lead);
  response.json(lead);
}

export async function assignLead(request: Request, response: Response) {
  const leadId = String(request.params.id);
  const assignedAgent = String(request.body.assignedAgent || "").trim();

  if (!Types.ObjectId.isValid(leadId)) {
    response.status(400).json({ message: "Invalid lead id" });
    return;
  }

  if (!Types.ObjectId.isValid(assignedAgent)) {
    response.status(400).json({ message: "Select a valid Sales employee" });
    return;
  }

  const employee = await Employee.findById(assignedAgent).select("name status role team");

  if (!employee || employee.status === "Archived" || !isSalesAssignableEmployee(employee)) {
    response.status(400).json({ message: "Lead can only be assigned to a non-archived employee in Sales" });
    return;
  }

  const actor = getActivityActor(request);
  const duplicateGroup = await resolveActiveLeadDuplicateGroups([leadId]);

  if (duplicateGroup.leadIds.length === 0) {
    const existingLead = await Lead.exists({ _id: leadId });
    response.status(existingLead ? 409 : 404).json({
      message: existingLead ? "Archived leads cannot be reassigned." : "Lead not found",
    });
    return;
  }

  await Lead.updateMany(
    { _id: { $in: duplicateGroup.leadIds }, status: { $ne: "Archived" } },
    {
      $set: {
        assignedAgent: new Types.ObjectId(assignedAgent),
        assignedAgentName: employee.name,
        autoAssignedAt: null,
      },
      $push: activityPush(
        "Assigned",
        actor.actorType === "employee"
          ? `${actor.actorName} passed this lead to ${employee.name}.`
          : `${actor.actorName} assigned this lead to ${employee.name}.`,
        actor
      ),
    }
  );
  const lead = await Lead.findById(leadId).populate(populateLead);

  if (!lead) {
    response.status(404).json({ message: "Lead not found" });
    return;
  }

  emitLeadMutation("assigned", lead);
  response.json(lead);
}

export async function scheduleLeadFollowUp(request: Request, response: Response) {
  const leadId = String(request.params.id);
  const followUpAt = request.body.followUpAt ? new Date(String(request.body.followUpAt)) : null;

  if (!followUpAt || Number.isNaN(followUpAt.getTime())) {
    response.status(400).json({ message: "Valid followUpAt is required" });
    return;
  }

  const actor = getActivityActor(request);
  const existingLead = await Lead.findById(leadId).select("leadName businessName status").lean();

  if (!existingLead) {
    response.status(404).json({ message: "Lead not found" });
    return;
  }

  if (existingLead.status === "Qualified") {
    response.status(400).json({ message: "Qualified leads do not use follow-up schedules." });
    return;
  }

  const scheduledLeadName = leadScheduleName(existingLead);
  const scheduledLeadLabel = scheduledLeadName ? `lead ${scheduledLeadName}` : "this lead";
  const activityDetail = [
    `${actor.actorName} scheduled ${scheduledLeadLabel}:`,
    `Eastern Time: ${formatScheduledEasternTime(followUpAt)}`,
    `PH Time: ${formatScheduledPhTime(followUpAt)}`,
  ].join("\n");
  const statusAfterScheduling = existingLead.status === "Ongoing Negotiation"
    ? "Ongoing Negotiation"
    : "Follow up";

  const lead = await Lead.findByIdAndUpdate(
    leadId,
    {
      $set: {
        followUpAt,
        followUpNote: request.body.followUpNote || "",
        followUpPriority: request.body.followUpPriority ?? 100,
        status: statusAfterScheduling,
      },
      $push: activityPush("Follow up scheduled", activityDetail, actor),
    },
    { returnDocument: "after", runValidators: true }
  ).populate(populateLead);

  if (!lead) {
    response.status(404).json({ message: "Lead not found" });
    return;
  }

  emitLeadMutation("follow-up-scheduled", lead);
  response.json(lead);
}

export async function addLeadComment(request: Request, response: Response) {
  const body = String(request.body.body || "").trim();

  if (!body) {
    response.status(400).json({ message: "Comment body is required" });
    return;
  }

  const authorName = String(request.body.authorName || "Employee").trim() || "Employee";
  const authorType = request.body.authorType === "admin" ? "admin" : "employee";
  const comment = {
    authorName,
    authorType,
    body,
    createdAt: new Date(),
  };
  const actor: LeadActivityActor = { actorName: authorName, actorType: authorType as LeadActivityActor["actorType"] };
  const commentActivity = leadActivity("Comment added", `${authorName} added a comment.`, actor);
  const statusActivity = leadActivity("Status changed", `${authorName} moved this lead to Follow up after adding a comment.`, actor);

  let lead = await Lead.findOneAndUpdate(
    { _id: request.params.id, status: "NEW" },
    {
      $push: {
        comments: comment,
        activity: {
          $each: [statusActivity, commentActivity],
          $position: 0,
        },
      },
      $set: { status: "Follow up" },
    },
    { returnDocument: "after", runValidators: true }
  ).populate(populateLead);

  if (!lead) {
    lead = await Lead.findByIdAndUpdate(
      request.params.id,
      {
        $push: {
          comments: comment,
          activity: {
            $each: [commentActivity],
            $position: 0,
          },
        },
      },
      { returnDocument: "after", runValidators: true }
    ).populate(populateLead);
  }

  if (!lead) {
    response.status(404).json({ message: "Lead not found" });
    return;
  }

  emitLeadMutation("comment-added", lead);
  response.json(lead);
}

export async function recordLeadCall(request: Request, response: Response) {
  const leadId = String(request.params.id);
  const existingLead = await Lead.findById(leadId).select("leadName businessName phone").lean();

  if (!existingLead) {
    response.status(404).json({ message: "Lead not found" });
    return;
  }

  const actor = getActivityActor(request);
  const leadLabel = leadScheduleName(existingLead) || "this lead";
  const phoneText = existingLead.phone ? ` at ${existingLead.phone}` : "";
  const callFailedToStart = request.body.callOutcome === "failed";
  const activityLabel = callFailedToStart ? "Call failed to start" : "Call placed";
  const activityDetail = callFailedToStart
    ? `${actor.actorName} could not start a call to ${leadLabel}${phoneText}.`
    : `${actor.actorName} called ${leadLabel}${phoneText}.`;
  let lead;

  if (!callFailedToStart) {
    const headerEmployeeCode = String(request.header("x-crm-user-code") || "").trim();
    const headerUserType = String(request.header("x-crm-user-type") || "").trim().toLowerCase();
    const employeeId = String(request.body.employeeId || "").trim();
    const employee = headerUserType === "employee" && headerEmployeeCode
      ? await Employee.findOne({ employeeCode: headerEmployeeCode, status: { $ne: "Archived" } })
          .select("_id name role team employeeCode")
          .lean()
      : Types.ObjectId.isValid(employeeId)
        ? await Employee.findById(employeeId).select("_id name role team employeeCode").lean()
        : null;

    if (!employee) {
      response.status(401).json({ message: "Employee session not found." });
      return;
    }

    const now = new Date();
    const employeeName = employee.name || employee.employeeCode || "Employee";
    const employeeRole = employee.role || "";
    const employeeTeam = employee.team ? String(employee.team) : "";

    if (
      getCallProvider() === "ringcentral"
      && isRingCentralOutcomeShadowEnabled()
      && !request.body.callOutcome
      && request.business?.id
    ) {
      const Attempt = getCallBridgeAttemptModel();
      const monitor = getRingCentralMonitorStatus(employee.employeeCode);
      const recentThreshold = new Date(now.getTime() - 30_000);
      await Attempt.updateMany(
        {
          employeeCode: employee.employeeCode,
          businessId: request.business.id,
          providerSessionId: { $exists: false },
          phase: { $in: ["reserved", "dialing", "ringing"] },
          reservedAt: { $lt: recentThreshold },
        },
        {
          $set: {
            phase: "failed",
            outcomeReason: "RingCentral did not attach a provider session within 30 seconds.",
            lastError: "No matching RingCentral telephony session was received",
          },
        }
      );
      const existingAttempt = await Attempt.findOne({
        employeeCode: employee.employeeCode,
        businessId: request.business.id,
        leadId,
        providerSessionId: { $exists: false },
        phase: { $in: ["reserved", "dialing", "ringing"] },
        reservedAt: { $gte: recentThreshold },
      }).lean();

      if (!existingAttempt) {
        await Attempt.create({
          employeeCode: employee.employeeCode,
          employeeName,
          businessId: request.business.id,
          leadId,
          phone: String(existingLead.phone || "").trim(),
          provider: "ringcentral",
          extensionId: monitor.extensionId,
          extensionNumber: monitor.extensionNumber,
          phase: "dialing",
          outcome: "pending",
          outcomeReason: "",
          classificationConfidence: "",
          classificationSource: "",
          providerResult: "Manual call handed to RingCentral",
          statusCodes: [],
          reservedAt: now,
          dialStartedAt: now,
          ringingAt: null,
          answeredAt: null,
          endedAt: null,
          classifiedAt: null,
          durationSeconds: 0,
          recordingId: "",
          callStatLogId: "",
          lastError: "",
        });
      }
    }

    const callLog = {
      employee: employee._id,
      employeeName,
      employeeRole,
      employeeTeam,
      calledAt: now,
    };
    const activity = activityPush(activityLabel, activityDetail, actor).activity;

    lead = await Lead.findOneAndUpdate(
      { _id: leadId, "callsByEmployee.employee": employee._id },
      {
        $inc: { callCount: 1, "callsByEmployee.$.count": 1 },
        $set: {
          lastCallAt: now,
          "callsByEmployee.$.lastCallAt": now,
          "callsByEmployee.$.employeeName": employeeName,
          "callsByEmployee.$.employeeRole": employeeRole,
          "callsByEmployee.$.employeeTeam": employeeTeam,
        },
        $push: { callLogs: callLog, activity },
      },
      { returnDocument: "after", runValidators: true }
    ).populate(populateLead);

    if (!lead) {
      lead = await Lead.findOneAndUpdate(
        {
          _id: leadId,
          callsByEmployee: { $not: { $elemMatch: { employee: employee._id } } },
        },
        {
          $inc: { callCount: 1 },
          $set: { lastCallAt: now },
          $push: {
            callsByEmployee: {
              employee: employee._id,
              employeeName,
              employeeRole,
              employeeTeam,
              count: 1,
              lastCallAt: now,
            },
            callLogs: callLog,
            activity,
          },
        },
        { returnDocument: "after", runValidators: true }
      ).populate(populateLead);
    }
  } else {
    lead = await Lead.findByIdAndUpdate(
      leadId,
      { $push: activityPush(activityLabel, activityDetail, actor) },
      { returnDocument: "after", runValidators: true }
    ).populate(populateLead);
  }

  if (!lead) {
    response.status(404).json({ message: "Lead not found" });
    return;
  }

  emitLeadMutation("call-logged", lead);
  response.status(201).json(lead);
}

export async function updateLeadComment(request: Request, response: Response) {
  const body = String(request.body.body || "").trim();

  if (!body) {
    response.status(400).json({ message: "Comment body is required" });
    return;
  }

  const lead = await Lead.findOneAndUpdate(
    { _id: request.params.id, "comments._id": request.params.commentId },
    {
      $set: {
        "comments.$.body": body,
      },
      $push: activityPush("Comment updated", `${getActivityActor(request).actorName} updated a comment.`, getActivityActor(request)),
    },
    { returnDocument: "after", runValidators: true }
  ).populate(populateLead);

  if (!lead) {
    response.status(404).json({ message: "Lead comment not found" });
    return;
  }

  emitLeadMutation("comment-updated", lead);
  response.json(lead);
}

export async function updateLeadStatus(request: Request, response: Response) {
  const statuses = ["NEW", "Follow up", "Ongoing comms", "Qualified", "Ongoing Negotiation", "Dead", "Archived"];
  const status = String(request.body.status || "").trim();

  if (!statuses.includes(status)) {
    response.status(400).json({ message: "Valid status is required" });
    return;
  }

  const actor = getActivityActor(request);
  const setFields: Record<string, unknown> = { status };

  if (status === "Qualified") {
    setFields.followUpAt = null;
    setFields.followUpNote = "";
    setFields.followUpPriority = 0;
  }

  const lead = await Lead.findByIdAndUpdate(
    request.params.id,
    {
      $set: setFields,
      $push: activityPush(
        "Status updated",
        status === "Qualified"
          ? `${actor.actorName} changed status to Qualified and cleared the follow-up schedule.`
          : `${actor.actorName} changed status to ${status}.`,
        actor,
        status === "NEW" ? "Current" : "Done"
      ),
    },
    { returnDocument: "after", runValidators: true }
  ).populate(populateLead);

  if (!lead) {
    response.status(404).json({ message: "Lead not found" });
    return;
  }

  emitLeadMutation("status-updated", lead);
  response.json(lead);
}

export async function toggleLeadFavorite(request: Request, response: Response) {
  const requestedEmployeeId = String(request.body.employeeId || "").trim();
  const employeeCode = String(request.header("x-crm-user-code") || "").trim();
  const userType = String(request.header("x-crm-user-type") || "").trim().toLowerCase();
  const isFavorite = Boolean(request.body.favorite);
  const sessionEmployee = userType === "employee" && employeeCode
    ? await Employee.findOne({ employeeCode, status: { $ne: "Archived" } }).select("_id").lean()
    : null;
  const employeeId = sessionEmployee?._id
    ? String(sessionEmployee._id)
    : requestedEmployeeId;

  if (!Types.ObjectId.isValid(employeeId)) {
    response.status(400).json({ message: "An active employee session is required" });
    return;
  }

  const lead = await Lead.findByIdAndUpdate(
    request.params.id,
    isFavorite
      ? { $addToSet: { favoriteByEmployees: new Types.ObjectId(employeeId) } }
      : { $pull: { favoriteByEmployees: new Types.ObjectId(employeeId) } },
    { returnDocument: "after", runValidators: true }
  ).populate(populateLead);

  if (!lead) {
    response.status(404).json({ message: "Lead not found" });
    return;
  }

  emitLeadMutation("favorite-updated", lead);
  response.json(lead);
}

export async function autoAssignLead(request: Request, response: Response) {
  if (!(await isLeadAutoAssignmentEnabled())) {
    response.status(400).json({ message: "Lead auto assignment is turned off in Settings." });
    return;
  }

  const assignedAgent = pickAssignmentCandidate(await createAssignmentCandidates());

  if (!assignedAgent) {
    response.status(400).json({ message: "No active agents available" });
    return;
  }

  const assignedAgentName = await getEmployeeName(assignedAgent);
  const leadId = String(request.params.id);
  const duplicateGroup = await resolveActiveLeadDuplicateGroups([leadId]);

  if (duplicateGroup.leadIds.length === 0) {
    response.status(404).json({ message: "Lead not found" });
    return;
  }

  await Lead.updateMany(
    { _id: { $in: duplicateGroup.leadIds }, status: { $ne: "Archived" } },
    {
      $set: { assignedAgent, assignedAgentName, autoAssignedAt: new Date() },
      $push: activityPush("Assigned", `Admin auto assigned this lead${assignedAgentName ? ` to ${assignedAgentName}` : ""}.`, { actorName: "Admin", actorType: "admin" }),
    }
  );
  const lead = await Lead.findById(leadId).populate(populateLead);

  if (!lead) {
    response.status(404).json({ message: "Lead not found" });
    return;
  }

  emitLeadMutation("auto-assigned", lead);
  response.json(lead);
}

export async function archiveLead(request: Request, response: Response) {
  const lead = await Lead.findByIdAndUpdate(
    request.params.id,
    {
      $set: { status: "Archived" },
      $push: activityPush("Archived", `${getActivityActor(request).actorName} archived this lead.`, getActivityActor(request)),
    },
    { returnDocument: "after", runValidators: true }
  ).populate(populateLead);

  if (!lead) {
    response.status(404).json({ message: "Lead not found" });
    return;
  }

  emitLeadMutation("archived", lead);
  response.json(lead);
}

export async function restoreLead(request: Request, response: Response) {
  const lead = await Lead.findByIdAndUpdate(
    request.params.id,
    {
      $set: { status: "NEW" },
      $push: activityPush("Restored", `${getActivityActor(request).actorName} restored this lead.`, getActivityActor(request)),
    },
    { returnDocument: "after", runValidators: true }
  ).populate(populateLead);

  if (!lead) {
    response.status(404).json({ message: "Lead not found" });
    return;
  }

  emitLeadMutation("restored", lead);
  response.json(lead);
}

export async function permanentlyDeleteLead(request: Request, response: Response) {
  const result = await Lead.deleteOne({ _id: request.params.id, status: "Archived" });

  if (result.deletedCount === 0) {
    response.status(404).json({ message: "Archived lead not found" });
    return;
  }

  emitLeadChanged({ action: "deleted", leadIds: [String(request.params.id)] });
  response.json({ deletedCount: result.deletedCount });
}

function parseLeadIds(value: unknown) {
  const ids = Array.isArray(value) ? value : String(value || "").split(",");

  return ids
    .map((id) => String(id || "").trim())
    .filter((id) => Types.ObjectId.isValid(id));
}

export async function bulkArchiveLeads(request: Request, response: Response) {
  const leadIds = parseLeadIds(request.body.leadIds);

  if (leadIds.length === 0) {
    response.status(400).json({ message: "Select at least one lead" });
    return;
  }

  const actor = getActivityActor(request);
  const result = await Lead.updateMany(
    { _id: { $in: leadIds }, status: { $ne: "Archived" } },
    {
      $set: { status: "Archived" },
      $push: activityPush("Archived", `${actor.actorName} archived this lead.`, actor),
    }
  );

  emitLeadChanged({ action: "bulk-archived", leadIds });
  response.json({ archivedCount: result.modifiedCount });
}

export async function archiveAllActiveLeads(request: Request, response: Response) {
  if (request.body.confirmation !== "ARCHIVE_ALL_ACTIVE_LEADS") {
    response.status(400).json({ message: "Explicit archive-all confirmation is required." });
    return;
  }

  const actor = getActivityActor(request);
  const result = await Lead.updateMany(
    { status: { $ne: "Archived" } },
    {
      $set: { status: "Archived" },
      $push: activityPush("Archived", `${actor.actorName} archived this lead.`, actor),
    }
  );

  emitLeadChanged({ action: "archive-all" });
  response.json({ archivedCount: result.modifiedCount });
}

export async function bulkRestoreLeads(request: Request, response: Response) {
  const leadIds = parseLeadIds(request.body.leadIds);

  if (leadIds.length === 0) {
    response.status(400).json({ message: "Select at least one lead" });
    return;
  }

  const actor = getActivityActor(request);
  const result = await Lead.updateMany(
    { _id: { $in: leadIds }, status: "Archived" },
    {
      $set: { status: "NEW" },
      $push: activityPush("Restored", `${actor.actorName} restored this lead.`, actor),
    }
  );

  emitLeadChanged({ action: "bulk-restored", leadIds });
  response.json({ restoredCount: result.modifiedCount });
}

export async function bulkAssignLeads(request: Request, response: Response) {
  const leadIds = parseLeadIds(request.body.leadIds);
  const assignedAgent = String(request.body.assignedAgent || "").trim();

  if (leadIds.length === 0) {
    response.status(400).json({ message: "Select at least one lead" });
    return;
  }

  const duplicateGroups = await resolveActiveLeadDuplicateGroups(leadIds);

  if (duplicateGroups.logicalLeadCount === 0) {
    response.json({ assignedCount: 0 });
    return;
  }

  if (assignedAgent === "UNASSIGNED") {
    const actor = getActivityActor(request);
    const result = await Lead.updateMany(
      { _id: { $in: duplicateGroups.leadIds }, status: { $ne: "Archived" } },
      {
        $set: {
          assignedAgent: null,
          assignedAgentName: "",
          autoAssignedAt: null,
        },
        $push: activityPush("Unassigned", `${actor.actorName} unassigned this lead.`, actor),
      }
    );

    emitLeadChanged({ action: "bulk-unassigned", leadIds, assignedAgentId: null });
    response.json({ assignedCount: duplicateGroups.logicalLeadCount, updatedRecordCount: result.modifiedCount });
    return;
  }

  if (!assignedAgent || !Types.ObjectId.isValid(assignedAgent)) {
    response.status(400).json({ message: "Valid assignedAgent is required" });
    return;
  }

  const employee = await Employee.findById(assignedAgent).select("name status role team");

  if (!employee || employee.status === "Archived" || !isSalesAssignableEmployee(employee)) {
    response.status(400).json({ message: "Select a non-archived employee in Sales" });
    return;
  }

  const actor = getActivityActor(request);
  const result = await Lead.updateMany(
    { _id: { $in: duplicateGroups.leadIds }, status: { $ne: "Archived" } },
    {
      $set: {
        assignedAgent: new Types.ObjectId(assignedAgent),
        assignedAgentName: employee.name,
        autoAssignedAt: null,
      },
      $push: activityPush("Assigned", `${actor.actorName} assigned this lead to ${employee.name}.`, actor),
    }
  );

  emitLeadChanged({ action: "bulk-assigned", leadIds, assignedAgentId: assignedAgent });
  response.json({ assignedCount: duplicateGroups.logicalLeadCount, updatedRecordCount: result.modifiedCount });
}

export async function restoreAllArchivedLeads(request: Request, response: Response) {
  if (request.body.confirmation !== "RESTORE_ALL_ARCHIVED_LEADS") {
    response.status(400).json({ message: "Explicit restore-all confirmation is required." });
    return;
  }

  const actor = getActivityActor(request);
  const result = await Lead.updateMany(
    { status: "Archived" },
    {
      $set: { status: "NEW" },
      $push: activityPush("Restored", `${actor.actorName} restored this lead.`, actor),
    }
  );

  emitLeadChanged({ action: "restore-all" });
  response.json({ restoredCount: result.modifiedCount });
}

export async function permanentlyDeleteArchivedLeads(request: Request, response: Response) {
  if (request.body.confirmation !== "DELETE_ALL_ARCHIVED_LEADS") {
    response.status(400).json({ message: "Explicit delete-all confirmation is required." });
    return;
  }

  const result = await Lead.deleteMany({ status: "Archived" });
  emitLeadChanged({ action: "delete-archived" });
  response.json({ deletedCount: result.deletedCount });
}

export async function bulkPermanentlyDeleteArchivedLeads(request: Request, response: Response) {
  const leadIds = parseLeadIds(request.body.leadIds);

  if (leadIds.length === 0) {
    response.status(400).json({ message: "Select at least one lead" });
    return;
  }

  const result = await Lead.deleteMany({ _id: { $in: leadIds }, status: "Archived" });
  emitLeadChanged({ action: "bulk-deleted", leadIds });
  response.json({ deletedCount: result.deletedCount });
}

export async function bulkPermanentlyDeleteActiveLeads(request: Request, response: Response) {
  const leadIds = parseLeadIds(request.body.leadIds);

  if (leadIds.length === 0) {
    response.status(400).json({ message: "Select at least one lead" });
    return;
  }

  const result = await Lead.deleteMany({ _id: { $in: leadIds }, status: { $ne: "Archived" } });
  emitLeadChanged({ action: "bulk-deleted", leadIds });
  response.json({ deletedCount: result.deletedCount });
}

export async function readTomTomPlacesUsage(request: Request, response: Response) {
  const actor = await requirePlacesAdmin(request, response);
  if (!actor) return;

  const location = String(request.query.location || "").trim();
  const targetLeads = Math.min(Math.max(Number(request.query.targetLeads || 1000), 1), 10000);
  const usage = await getTomTomUsage();

  response.json({
    ...usage,
    manualEstimatedRequests: getTomTomSearchRequestEstimate(targetLeads),
    autoEstimatedRequests: getTomTomSearchRequestEstimate(targetLeads),
    geocodingEstimatedRequests: location ? 1 : 0,
    maxResultsPerRequest: 100,
    resetTimeZone: "UTC",
  });
}

export async function searchAndImportTomTomPlacesAsLeads(request: Request, response: Response) {
  const actor = await requirePlacesAdmin(request, response);
  if (!actor) return;

  const textQuery = String(request.body.textQuery || "").trim();
  const category = String(request.body.category || "").trim();
  const location = String(request.body.location || "").trim();
  const radiusMiles = getRadiusMiles(request.body.radiusMiles);
  const maxResults = Math.min(Math.max(Number(request.body.maxResults || 1000), 1), 10000);
  const defaultRequestLimit = getTomTomSearchRequestEstimate(maxResults);
  const requestLimit = Math.min(Math.max(Number(request.body.maxRequests || defaultRequestLimit), 1), TOMTOM_AUTO_SEARCH_REQUEST_LIMIT);

  if (!textQuery) {
    response.status(400).json({ message: "textQuery is required" });
    return;
  }

  if (!isSpecificTomTomSearchQuery(category || textQuery)) {
    response.status(400).json({ message: "Enter a specific business type. Broad searches cannot be validated accurately." });
    return;
  }

  const usageBefore = await getTomTomUsage();
  const rejectedForGeocodingBudget = location
    ? await rejectTomTomSearchWithInsufficientBudget({
      request,
      response,
      actor,
      mode: "manual",
      query: textQuery,
      location,
      radiusMiles,
      requiredRequests: 1,
      remainingRequests: usageBefore.products.geocoding.remaining,
      quotaName: "Geocoding",
    })
    : false;
  if (rejectedForGeocodingBudget) return;
  const rejectedForBudget = await rejectTomTomSearchWithInsufficientBudget({
    request,
    response,
    actor,
    mode: "manual",
    query: textQuery,
    location,
    radiusMiles,
    requiredRequests: requestLimit,
    remainingRequests: usageBefore.remaining,
  });
  if (rejectedForBudget) return;

  try {
    const result = await searchTomTomPlaceQueries({
      queries: [category || textQuery],
      location,
      radiusMiles,
      requestBudget: requestLimit,
      targetCallablePlaces: Math.min(Math.ceil(maxResults * TOMTOM_DUPLICATE_BUFFER_MULTIPLIER), 10000),
    });
    const callablePlaces = onlyPlacesWithPhone(dedupePlaces(result.places));
    const places = callablePlaces.slice(0, maxResults);
    const skippedNoPhoneCount = result.places.length - callablePlaces.length;
    const importResult = await upsertPlacesAsLeads(places, category, { provider: "tomtom", actor });
    const auditStatus = result.limitReached ? "partial" : "completed";

    await recordTomTomSearchAudit({
      request,
      actor,
      mode: "manual",
      query: textQuery,
      location,
      radiusMiles,
      requestCount: result.requestCount,
      returnedCount: result.places.length,
      importedCount: importResult.leads.length,
      duplicateCount: importResult.duplicateCount,
      skippedNoPhoneCount,
      status: auditStatus,
    });

    response.status(201).json({
      provider: "tomtom",
      places: importResult.places,
      leads: importResult.leads,
      skippedNoPhoneCount,
      duplicateCount: importResult.duplicateCount,
      nextPageToken: "",
      searchedQueries: result.searchedQueries,
      searchedPages: result.searchedPages,
      searchedLocations: result.searchedLocations,
      requestCount: result.requestCount,
      rejectedIrrelevantCount: result.rejectedIrrelevantCount,
      limitReached: result.limitReached,
      usage: result.usage,
    });
  } catch (error) {
    const usageAfter = await getTomTomUsage().catch(() => usageBefore);
    await recordTomTomSearchAudit({
      request,
      actor,
      mode: "manual",
      query: textQuery,
      location,
      radiusMiles,
      requestCount: Math.max(0, usageAfter.used - usageBefore.used),
      returnedCount: 0,
      importedCount: 0,
      duplicateCount: 0,
      skippedNoPhoneCount: 0,
      status: "failed",
      errorMessage: (error as Error).message,
    }).catch((auditError) => console.error("Unable to record TomTom search audit", auditError));
    throw error;
  }
}

export async function autoSearchTomTomPlacesForProduct(request: Request, response: Response) {
  const actor = await requirePlacesAdmin(request, response);
  if (!actor) return;

  const product = String(request.body.product || "").trim();
  const location = String(request.body.location || "").trim();
  const radiusMiles = getRadiusMiles(request.body.radiusMiles);
  const maxResults = Math.min(Math.max(Number(request.body.maxResults || 1000), 1), 10000);

  if (!product) {
    response.status(400).json({ message: "product is required" });
    return;
  }

  if (!isSpecificTomTomSearchQuery(product)) {
    response.status(400).json({ message: "Enter a specific product or business type so lead relevance can be verified." });
    return;
  }

  const targets = getAutoSearchTargets(product);
  const defaultRequestLimit = getTomTomSearchRequestEstimate(maxResults);
  const requestLimit = Math.min(Math.max(Number(request.body.maxRequests || defaultRequestLimit), 1), TOMTOM_AUTO_SEARCH_REQUEST_LIMIT);
  const usageBefore = await getTomTomUsage();
  const rejectedForGeocodingBudget = location
    ? await rejectTomTomSearchWithInsufficientBudget({
      request,
      response,
      actor,
      mode: "auto",
      query: product,
      location,
      radiusMiles,
      requiredRequests: 1,
      remainingRequests: usageBefore.products.geocoding.remaining,
      quotaName: "Geocoding",
    })
    : false;
  if (rejectedForGeocodingBudget) return;
  const rejectedForBudget = await rejectTomTomSearchWithInsufficientBudget({
    request,
    response,
    actor,
    mode: "auto",
    query: product,
    location,
    radiusMiles,
    requiredRequests: requestLimit,
    remainingRequests: usageBefore.remaining,
  });
  if (rejectedForBudget) return;

  try {
    const result = await searchTomTomPlaceQueries({
      queries: targets.map((target) => target.query),
      validationQuery: product,
      location,
      radiusMiles,
      requestBudget: requestLimit,
      targetCallablePlaces: Math.min(Math.ceil(maxResults * TOMTOM_DUPLICATE_BUFFER_MULTIPLIER), 10000),
    });
    const callablePlaces = onlyPlacesWithPhone(dedupePlaces(result.places));
    const places = callablePlaces.slice(0, maxResults);
    const skippedNoPhoneCount = result.places.length - callablePlaces.length;
    const importResult = await upsertPlacesAsLeads(places, product, { provider: "tomtom", actor });
    const leads = importResult.leads;
    const scoredAt = new Date();

    if (leads.length > 0) {
      await Lead.bulkWrite(
        leads.map((lead) => {
          const fit = getProductFitScore(
            {
              businessName: lead.businessName,
              category: lead.category,
              phone: lead.phone,
              website: lead.website,
            },
            product
          );

          return {
            updateOne: {
              filter: { _id: lead._id },
              update: {
                $set: {
                  aiScore: fit.score,
                  aiScoreReason: fit.reason,
                  aiScoreSource: "product-fit",
                  aiScoredAt: scoredAt,
                },
              },
            },
          };
        }),
        { ordered: false }
      );
    }

    const refreshedLeads = await Lead.find({ _id: { $in: leads.map((lead) => lead._id) } }).populate(populateLead);
    const auditStatus = result.limitReached ? "partial" : "completed";

    await recordTomTomSearchAudit({
      request,
      actor,
      mode: "auto",
      query: product,
      location,
      radiusMiles,
      requestCount: result.requestCount,
      returnedCount: result.places.length,
      importedCount: refreshedLeads.length,
      duplicateCount: importResult.duplicateCount,
      skippedNoPhoneCount,
      status: auditStatus,
    });

    response.status(201).json({
      provider: "tomtom",
      product,
      location,
      radiusMiles,
      searchedQueries: result.searchedQueries,
      searchedLocations: result.searchedLocations,
      searchedPages: result.searchedPages,
      places: importResult.places,
      skippedNoPhoneCount,
      duplicateCount: importResult.duplicateCount,
      leads: refreshedLeads.sort((first, second) => (second.aiScore || 0) - (first.aiScore || 0)),
      requestCount: result.requestCount,
      rejectedIrrelevantCount: result.rejectedIrrelevantCount,
      limitReached: result.limitReached,
      usage: result.usage,
    });
  } catch (error) {
    const usageAfter = await getTomTomUsage().catch(() => usageBefore);
    await recordTomTomSearchAudit({
      request,
      actor,
      mode: "auto",
      query: product,
      location,
      radiusMiles,
      requestCount: Math.max(0, usageAfter.used - usageBefore.used),
      returnedCount: 0,
      importedCount: 0,
      duplicateCount: 0,
      skippedNoPhoneCount: 0,
      status: "failed",
      errorMessage: (error as Error).message,
    }).catch((auditError) => console.error("Unable to record TomTom search audit", auditError));
    throw error;
  }
}

export async function searchPlacesForLeads(request: Request, response: Response) {
  const textQuery = String(request.body.textQuery || "").trim();
  const pageToken = String(request.body.pageToken || "").trim();

  if (!textQuery) {
    response.status(400).json({ message: "textQuery is required" });
    return;
  }

  const result = await searchGooglePlaces(textQuery, pageToken);
  response.json({
    ...result,
    places: onlyPlacesWithPhone(result.places),
  });
}

export async function importPlacesAsLeads(request: Request, response: Response) {
  const places = Array.isArray(request.body.places) ? request.body.places : [];
  const category = String(request.body.category || "").trim();
  const validPlaces = onlyPlacesWithPhone(places);

  if (validPlaces.length === 0) {
    response.status(400).json({ message: "places with phone numbers are required" });
    return;
  }

  const result = await upsertPlacesAsLeads(validPlaces, category);

  response.status(201).json(result.leads);
}

export async function searchAndImportPlacesAsLeads(request: Request, response: Response) {
  const textQuery = String(request.body.textQuery || "").trim();
  const category = String(request.body.category || "").trim();
  const location = String(request.body.location || "").trim();
  const radiusMiles = getRadiusMiles(request.body.radiusMiles);
  const maxPages = Math.min(Math.max(Number(request.body.maxPages || GOOGLE_AUTO_SEARCH_PAGE_LIMIT), 1), 100);

  if (!textQuery) {
    response.status(400).json({ message: "textQuery is required" });
    return;
  }

  const baseQuery = category || textQuery;
  const result = location ? await searchGooglePlacesWithPageBudget(baseQuery, location, maxPages, radiusMiles) : await searchGooglePlacesPages(textQuery, maxPages);
  const locationContext = location && radiusMiles > 0 ? await getGooglePlacesLocationContext(location, radiusMiles) : { center: null };
  const places = onlyPlacesWithPhone(filterPlacesByRadius(filterPlacesByLocation(dedupePlaces(result.places), location, { matchCity: radiusMiles <= 0 }), locationContext.center, radiusMiles));
  const importResult = await upsertPlacesAsLeads(places, category);

  response.status(201).json({
    places: importResult.places,
    leads: importResult.leads,
    skippedNoPhoneCount: importResult.skippedNoPhoneCount,
    duplicateCount: importResult.duplicateCount,
    nextPageToken: "nextPageToken" in result ? result.nextPageToken : "",
    searchedQueries: "searchedQueries" in result ? result.searchedQueries : [textQuery],
    searchedPages: "searchedPages" in result ? result.searchedPages : result.pageCount,
    searchedLocations: "searchedLocations" in result ? result.searchedLocations : location ? [location] : [],
  });
}

export async function autoSearchPlacesForProduct(request: Request, response: Response) {
  const product = String(request.body.product || "").trim();
  const location = String(request.body.location || "").trim();
  const radiusMiles = getRadiusMiles(request.body.radiusMiles);
  const maxResults = Math.min(Math.max(Number(request.body.maxResults || 10000), 1), 10000);
  const maxPages = Math.min(Math.max(Number(request.body.maxPages || GOOGLE_AUTO_SEARCH_PAGE_LIMIT), 1), 100);

  if (!product) {
    response.status(400).json({ message: "product is required" });
    return;
  }

  const targets = getAutoSearchTargets(product);
  const placesByKey = new Map<string, GooglePlaceLead>();
  const searchedQueries: string[] = [];
  let searchedPages = 0;
  const locationContext = await getGooglePlacesLocationContext(location, radiusMiles);
  const locationFilterOptions = { matchCity: radiusMiles <= 0 };
  const searchLocations = await getNearbyGooglePlacesLocations(location, radiusMiles, locationContext);

  for (const target of targets) {
    const mainLocationQueries = getAutoSearchQueryVariants(target.query, location);
    const nearbyQueries = searchLocations.slice(1).flatMap((searchLocation) => getDirectSearchQueryVariants(target.query, searchLocation));
    const queryVariants = Array.from(new Set([...mainLocationQueries, ...nearbyQueries]));

    for (const textQuery of queryVariants) {
      if (placesByKey.size >= maxResults || searchedPages >= maxPages) {
        break;
      }

      searchedQueries.push(textQuery);
      const pagesForQuery = searchedQueries.length <= mainLocationQueries.length ? Math.min(10, maxPages - searchedPages) : 1;
      const result = await searchGooglePlacesPages(textQuery, pagesForQuery, { locationBias: locationContext.biases[0] });
      searchedPages += result.pageCount;
      onlyPlacesWithPhone(filterPlacesByRadius(filterPlacesByLocation(result.places, location, locationFilterOptions), locationContext.center, radiusMiles)).forEach((place) =>
        placesByKey.set(getGooglePlaceDedupKey(place), place)
      );
    }

    if (placesByKey.size >= maxResults || searchedPages >= maxPages) {
      break;
    }
  }

  const places = onlyPlacesWithPhone(filterPlacesByRadius(filterPlacesByLocation(Array.from(placesByKey.values()), location, locationFilterOptions), locationContext.center, radiusMiles)).slice(0, maxResults);
  const importResult = await upsertPlacesAsLeads(places, product);
  const leads = importResult.leads;
  const scoredAt = new Date();

  if (leads.length > 0) {
    await Lead.bulkWrite(
      leads.map((lead) => {
        const fit = getProductFitScore(
          {
            businessName: lead.businessName,
            category: lead.category,
            phone: lead.phone,
            website: lead.website,
          },
          product
        );

        return {
          updateOne: {
            filter: { _id: lead._id },
            update: {
              $set: {
                aiScore: fit.score,
                aiScoreReason: fit.reason,
                aiScoreSource: "product-fit",
                aiScoredAt: scoredAt,
              },
            },
          },
        };
      }),
      { ordered: false }
    );
  }

  const refreshedLeads = await Lead.find({ _id: { $in: leads.map((lead) => lead._id) } }).populate(populateLead);

  response.status(201).json({
    product,
    location,
    radiusMiles,
    searchedQueries,
    searchedLocations: searchLocations,
    searchedPages,
    places: importResult.places,
    skippedNoPhoneCount: importResult.skippedNoPhoneCount,
    duplicateCount: importResult.duplicateCount,
    leads: refreshedLeads.sort((first, second) => (second.aiScore || 0) - (first.aiScore || 0)),
  });
}

// export async function logCalls(req: any, res: any) {
//   try {
//     const leadId = req.params.id;
//     const body = req.body || {};

//     if (!Types.ObjectId.isValid(leadId)) {
//       return res.status(400).json({
//         message: "Invalid lead ID.",
//       });
//     }

//     const currentEmployeeId =
//       req.employee?._id ||
//       req.user?.employeeId ||
//       req.user?.employee?._id ||
//       req.user?._id ||
//       req.body?.employeeId;

//     if (!currentEmployeeId || !Types.ObjectId.isValid(String(currentEmployeeId))) {
//       return res.status(401).json({
//         message: "Employee session not found.",
//       });
//     }

//     const employee = await Employee.findById(currentEmployeeId).select(
//       "_id name role team"
//     );

//     if (!employee) {
//       return res.status(404).json({
//         message: "Employee not found.",
//       });
//     }

//     const now = new Date();

//     const employeeName = employee.name || "Employee";
//     const employeeRole = employee.role || "";
//     const employeeTeam = employee.team ? String(employee.team) : "";

//     const callLog = {
//       employee: employee._id,
//       employeeName,
//       employeeRole,
//       employeeTeam,
//       calledAt: now,
//     };

//     const activityItem = {
//       label: "Call logged",
//       detail: `${employeeName} logged a call.`,
//       status: "Done",
//       actorName: employeeName,
//       actorType: "employee",
//       createdAt: now,
//     };

//     const newEmployeeCallRow = {
//       employee: employee._id,
//       employeeName,
//       employeeRole,
//       employeeTeam,
//       count: 1,
//       lastCallAt: now,
//     };

//     const updateExistingEmployeeCall = () =>
//       Lead.findOneAndUpdate(
//         {
//           _id: leadId,
//           "callsByEmployee.employee": employee._id,
//         },
//         {
//           $inc: {
//             callCount: 1,
//             "callsByEmployee.$.count": 1,
//           },
//           $set: {
//             lastCallAt: now,
//             "callsByEmployee.$.lastCallAt": now,
//             "callsByEmployee.$.employeeName": employeeName,
//             "callsByEmployee.$.employeeRole": employeeRole,
//             "callsByEmployee.$.employeeTeam": employeeTeam,
//           },
//           $push: {
//             callLogs: callLog,
//             activity: activityItem,
//           },
//         },
//         {
//           new: true,
//           runValidators: true,
//         }
//       );

//     let lead = await updateExistingEmployeeCall();

//     if (!lead) {
//       lead = await Lead.findOneAndUpdate(
//         {
//           _id: leadId,
//           callsByEmployee: {
//             $not: {
//               $elemMatch: {
//                 employee: employee._id,
//               },
//             },
//           },
//         },
//         {
//           $inc: {
//             callCount: 1,
//           },
//           $set: {
//             lastCallAt: now,
//           },
//           $push: {
//             callsByEmployee: newEmployeeCallRow,
//             callLogs: callLog,
//             activity: activityItem,
//           },
//         },
//         {
//           new: true,
//           runValidators: true,
//         }
//       );
//     }

//     // Handles rare case where another request created the employee row
//     // between the first and second update.
//     if (!lead) {
//       lead = await updateExistingEmployeeCall();
//     }

//     if (!lead) {
//       return res.status(404).json({
//         message: "Lead not found.",
//       });
//     }

//     return res.json(lead);
//   } catch (error) {
//     console.error("Log lead call error:", error);

//     return res.status(500).json({
//       message: "Could not log call.",
//     });
//   }
// }
