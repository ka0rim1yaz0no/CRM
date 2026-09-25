import type { Request, Response } from "express";
import { Types } from "mongoose";
import { runWithBusiness } from "../config/tenancy";
import { Lead, type LeadDocument, type LeadStatus } from "../models/Lead";
import { emitLeadChanged } from "../socket";

const leadStatuses: LeadStatus[] = ["NEW", "Follow up", "Ongoing comms", "Qualified", "Ongoing Negotiation", "Completed", "Dead", "Archived"];
const defaultRegistrationBusinessId = "business-b";
type ActivityActorType = LeadDocument["activity"][number]["actorType"];

function cleanString(value: unknown) {
  return String(value || "").trim();
}

function requestIntegrationKey(request: Request) {
  const authorization = cleanString(request.header("authorization"));

  if (authorization.toLowerCase().startsWith("bearer ")) {
    return authorization.slice(7).trim();
  }

  return cleanString(request.header("x-integration-key"));
}

function isAuthorizedIntegrationRequest(request: Request) {
  const configuredKey = cleanString(process.env.CRM_INTEGRATION_KEY);

  return Boolean(configuredKey && requestIntegrationKey(request) === configuredKey);
}

function normalizeLeadStatus(value: unknown): LeadStatus {
  const normalizedValue = cleanString(value).toLowerCase().replace(/\s+/g, " ");
  const statusMap: Record<string, LeadStatus> = {
    new: "NEW",
    followup: "Follow up",
    "follow up": "Follow up",
    qualified: "Qualified",
    ongoing: "Ongoing comms",
    "ongoing comms": "Ongoing comms",
    negotiation: "Ongoing Negotiation",
    "ongoing negotiation": "Ongoing Negotiation",
    completed: "Completed",
    complete: "Completed",
    dead: "Dead",
    archived: "Archived",
  };

  return statusMap[normalizedValue] || (leadStatuses.includes(value as LeadStatus) ? (value as LeadStatus) : "Qualified");
}

function parseOptionalDate(value: unknown) {
  const rawValue = cleanString(value);

  if (!rawValue) {
    return new Date();
  }

  const date = new Date(rawValue);

  return Number.isNaN(date.getTime()) ? new Date() : date;
}

function normalizeObjectId(value: unknown) {
  const normalizedValue = cleanString(value);

  return Types.ObjectId.isValid(normalizedValue) ? new Types.ObjectId(normalizedValue) : null;
}

function normalizeComments(value: unknown, source: string, note: string) {
  const rawComments = Array.isArray(value) ? value : [];
  const comments = rawComments
    .map((comment) => {
      const record = (comment || {}) as Record<string, unknown>;
      const body = cleanString(record.body);

      if (!body) {
        return null;
      }

      return {
        authorName: cleanString(record.authorName) || source,
        authorType: record.authorType === "employee" ? "employee" as const : "admin" as const,
        body,
        createdAt: parseOptionalDate(record.createdAt),
      };
    })
    .filter((comment): comment is NonNullable<typeof comment> => Boolean(comment));

  if (comments.length > 0 || !note) {
    return comments;
  }

  return [
    {
      authorName: source,
      authorType: "admin" as const,
      body: note,
      createdAt: new Date(),
    },
  ];
}

function normalizeActivity(value: unknown, source: string, category: string) {
  const rawActivity = Array.isArray(value) ? value : [];
  const activity = rawActivity
    .map((item) => {
      const record = (item || {}) as Record<string, unknown>;
      const label = cleanString(record.label) || "Lead created";
      const detail = cleanString(record.detail);

      if (!detail) {
        return null;
      }

      const actorType: ActivityActorType = record.actorType === "admin" || record.actorType === "employee" ? record.actorType : "system";

      return {
        label,
        detail,
        status: cleanString(record.status) || "Done",
        actorName: cleanString(record.actorName) || source,
        actorType,
        createdAt: parseOptionalDate(record.createdAt),
      };
    })
    .filter((item): item is NonNullable<typeof item> => Boolean(item));

  if (activity.length > 0) {
    return activity;
  }

  return [
    {
      label: "Lead created",
      detail: `${source} lead added${category ? ` under ${category}` : ""}.`,
      status: "Done",
      actorName: source,
      actorType: "system" as const,
      createdAt: new Date(),
    },
  ];
}

function duplicateFilters(lead: { email: string; phone: string; businessName: string; businessAddress: string }) {
  const filters: Record<string, unknown>[] = [];

  if (lead.email) {
    filters.push({ email: lead.email });
  }

  if (lead.phone) {
    filters.push({ phone: lead.phone });
  }

  if (lead.businessName && lead.businessAddress) {
    filters.push({ businessName: lead.businessName, businessAddress: lead.businessAddress });
  }

  return filters;
}

export async function createCustomerRegistrationLead(request: Request, response: Response) {
  if (!cleanString(process.env.CRM_INTEGRATION_KEY)) {
    response.status(503).json({ message: "CRM integration key is not configured." });
    return;
  }

  if (!isAuthorizedIntegrationRequest(request)) {
    response.status(401).json({ message: "Invalid CRM integration key." });
    return;
  }

  const targetBusinessId = cleanString(process.env.CRM_REGISTRATION_LEAD_BUSINESS_ID) || defaultRegistrationBusinessId;

  await runWithBusiness(targetBusinessId, async () => {
    const source = cleanString(request.body.source) || "Customer Registration";
    const category = cleanString(request.body.category) || "Customer Registration";
    const leadName = cleanString(request.body.leadName);
    const businessName = cleanString(request.body.businessName) || leadName || "Customer Registration";
    const note = cleanString(request.body.notes) || "Customer registered from the storefront.";
    const assignedAgent = normalizeObjectId(request.body.assignedAgent);
    const assignedTeam = normalizeObjectId(request.body.assignedTeam);
    const leadInput: Partial<LeadDocument> = {
      leadName,
      position: cleanString(request.body.position),
      businessName,
      businessAddress: cleanString(request.body.businessAddress),
      email: cleanString(request.body.email).toLowerCase(),
      phone: cleanString(request.body.phone),
      website: cleanString(request.body.website),
      source,
      category,
      createdByName: source,
      createdByType: "system" as const,
      status: normalizeLeadStatus(request.body.status),
      assignedAgent,
      assignedAgentName: assignedAgent ? cleanString(request.body.assignedAgentName) : "",
      autoAssignedAt: null,
      assignedTeam,
      googlePlaceId: cleanString(request.body.googlePlaceId),
      notes: note,
      comments: normalizeComments(request.body.comments, source, note),
      activity: normalizeActivity(request.body.activity, source, category),
      followUpAt: null,
      followUpNote: cleanString(request.body.followUpNote),
      followUpPriority: Number(request.body.followUpPriority) || 0,
      aiScore: 0,
      aiScoreReason: "",
      aiScoreSource: "",
      aiScoredAt: null,
    };

    const filters = duplicateFilters({
      email: leadInput.email || "",
      phone: leadInput.phone || "",
      businessName: leadInput.businessName || "",
      businessAddress: leadInput.businessAddress || "",
    });
    const duplicateLead = filters.length > 0 ? await Lead.findOne({ $or: filters, status: { $ne: "Archived" } }).sort({ createdAt: -1 }) : null;

    if (duplicateLead) {
      response.status(200).json({ duplicate: true, businessId: targetBusinessId, lead: duplicateLead });
      return;
    }

    const lead = await Lead.create(leadInput);
    const createdLead = await Lead.findById(lead.id);

    emitLeadChanged({ action: "created", lead: createdLead });
    response.status(201).json({ duplicate: false, businessId: targetBusinessId, lead: createdLead });
  });
}
