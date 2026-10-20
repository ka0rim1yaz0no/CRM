import type { Request, Response, NextFunction } from "express";
import { Types } from "mongoose";
import { verifyAdminDashboardSession } from "../config/adminDashboardSession";
import { verifyAttendanceHubSession } from "../config/attendanceHubSession";
import { findConfiguredAdmin } from "../config/adminUsers";
import { securityLegacyAuthEnabled } from "../config/rolloutFlags";
import { Employee } from "../models/Employee";
import { Task } from "../models/Task";
import { Lead } from "../models/Lead";
import { getBusinessAccessForEmployeeCode } from "../models/BusinessUserAccess";

export function signedCrmIdentity(adminToken: unknown, employeeToken: unknown) {
  const expiry = (token: unknown): number => JSON.parse(Buffer.from(String(token).split(".")[0], "base64url").toString("utf8")).exp;
  const admin = verifyAdminDashboardSession(adminToken);
  if (admin) return { type: "admin" as const, code: admin.employeeCode, name: admin.name, access: "full" as const, expiresAt: expiry(adminToken) };
  const code = verifyAttendanceHubSession(employeeToken);
  if (!code) return null;
  const configured = findConfiguredAdmin(code);
  if (configured) return configured.access === "tracker" ? { type: "admin" as const, code, name: configured.name, access: "tracker" as const, expiresAt: expiry(employeeToken) } : null;
  return { type: "employee" as const, code, name: "", access: "employee" as const, expiresAt: expiry(employeeToken) };
}

export async function signedEmployeeInBusiness(code: string, businessId: string) {
  const allowed = await getBusinessAccessForEmployeeCode(code);
  if (allowed.length && !allowed.includes(businessId)) return null;
  const employee = await Employee.findOne({ employeeCode: code, status: { $ne: "Archived" } })
    .select("_id name employeeCode aliases role team businessAccessIds").maxTimeMS(3000).lean();
  if (!employee || (!allowed.length && employee.businessAccessIds?.length && !employee.businessAccessIds.includes(businessId))) return null;
  return employee;
}

function query(request: Request, extra: Record<string, unknown>) {
  Object.defineProperty(request, "query", { value: { ...request.query, ...extra }, configurable: true });
}
function denied(response: Response) { response.status(403).json({ message: "This action is not permitted for your signed CRM session." }); }

export async function authenticateLegacyAuthRoute(request: Request, response: Response, next: NextFunction) {
  if (!securityLegacyAuthEnabled()) return next();
  const actor = signedCrmIdentity(request.header("x-crm-admin-session"), request.header("x-crm-attendance-session"));
  if (!actor) { response.status(401).json({ message: "A signed CRM session is required." }); return; }
  if (actor.access === "tracker") return denied(response);
  if (actor.type === "employee") {
    const employee = await signedEmployeeInBusiness(actor.code, request.business?.id || "");
    if (!employee || (request.query.employeeCode && request.query.employeeCode !== actor.code) ||
      (request.body?.employeeCode && request.body.employeeCode !== actor.code) ||
      (request.body?.employeeId && String(request.body.employeeId) !== String(employee._id))) return denied(response);
  }
  next();
}

// Explicit exceptions continue into handlers which validate their own scoped credentials.
export function usesIndependentCredential(path: string, method: string) {
  return (method === "POST" && ["/integrations/customer-registration-leads", "/call-bridge/claim", "/call-bridge/heartbeat", "/browser-activity/events/bulk", "/browser-activity/screenshots"].includes(path)) ||
    (method === "GET" && path === "/browser-activity/tracking-status");
}

export async function legacyAuthentication(request: Request, response: Response, next: NextFunction) {
  if (!securityLegacyAuthEnabled()) return next();
  let path: string;
  try { path = decodeURIComponent(request.path).replace(/\/+$/, "").toLowerCase() || "/"; }
  catch { response.status(400).json({ message: "Invalid request path." }); return; }
  if (usesIndependentCredential(path, request.method) || response.locals.crmVerifiedFileSession) return next();
  const actor = signedCrmIdentity(request.header("x-crm-admin-session"), request.header("x-crm-attendance-session"));
  if (!actor) { response.status(401).json({ message: "Sign in again. A signed CRM session is required." }); return; }
  const employee = actor.type === "employee" ? await signedEmployeeInBusiness(actor.code, request.business?.id || "") : null;
  if (actor.type === "employee" && !employee) return denied(response);
  const name = employee?.name || actor.name;
  request.headers["x-crm-user-type"] = actor.type;
  request.headers["x-crm-user-code"] = actor.code;
  request.headers["x-crm-user-name"] = name;
  response.locals.crmActor = { ...actor, name, employeeId: employee ? String(employee._id) : null };
  if (actor.access === "full") return next();
  if (actor.access === "tracker") {
    const allowed = request.method === "GET" && (/^\/browser-activity\/(events|screenshots(?:\/file\/[^/]+\/[^/]+)?|extension-package|live-view-agent-package)$/.test(path) || ["/employees", "/teams", "/features", "/system-settings"].includes(path));
    if (!allowed) return denied(response);
    if (path === "/employees") query(request, { summary: "true" });
    return next();
  }
  const ownId = String(employee!._id);
  const target = path.match(/^\/employees\/([^/]+)(.*)$/);
  if (target) {
    if (target[1] !== ownId.toLowerCase()) {
      if (request.method === "GET" && !target[2] && request.query.summary === "true") return next();
      return denied(response);
    }
    const suffix = target[2];
    const allowed = request.method === "GET" ||
      (request.method === "PATCH" && ["/profile", "/bank"].includes(suffix)) ||
      (request.method === "POST" && (/^\/(attendance(?:\/commands|\/preview|\/time-in|\/time-out|\/break-out|\/break-in|\/lunch-break-out|\/lunch-break-in)?|activity|leave-requests)$/.test(suffix) || /\/replies$/.test(suffix))) ||
      (request.method === "PATCH" && (/^\/notices\/(?:read|[^/]+\/(?:read|acknowledge))$/.test(suffix) || /^\/leave-requests\/[^/]+(?:\/replies)?$/.test(suffix)));
    if (!allowed) return denied(response);
    return next();
  }
  if (path === "/employees" && request.method === "GET") { query(request, { summary: "true" }); return next(); }
  if (path.startsWith("/auth/")) {
    if (request.query.employeeCode && request.query.employeeCode !== actor.code) return denied(response);
    if (request.body?.employeeCode && request.body.employeeCode !== actor.code) return denied(response);
    if (request.body?.employeeId && String(request.body.employeeId) !== ownId) return denied(response);
    return next();
  }
  if (["/attendance-policy", "/attendance-hub/live"].includes(path) && request.method === "GET") return next();
  if (/^\/(roles|branches|tools|product-categories|teams|features|system-settings|media)(?:\/[^/]+)?$/.test(path) && request.method === "GET") return next();
  if (path.startsWith("/knowledge-base")) {
    if (request.method === "GET" && !path.startsWith("/knowledge-base/suggestions")) return next();
    if (request.method === "POST" && path === "/knowledge-base/suggestions") {
      request.body.submittedById = ownId; request.body.submittedByName = name; return next();
    }
    return denied(response);
  }
  if (path.startsWith("/messages/")) return next(); // Conversation membership uses the verified headers above.
  if (path.startsWith("/tasks")) {
    if (path === "/tasks" && request.method === "GET") { query(request, { assignedTo: ownId }); return next(); }
    const match = path.match(/^\/tasks\/([a-f0-9]{24})(?:\/(status|comments))?$/);
    if (!match || !["GET", "PATCH", "POST"].includes(request.method) || (request.method !== "GET" && !match[2])) return denied(response);
    if (!await Task.exists({ _id: match[1], assignedTo: employee!._id, isArchived: false })) return denied(response);
    if (request.body && typeof request.body === "object") { request.body.authorName = name; request.body.authorType = "employee"; }
    return next();
  }
  if (path.startsWith("/call-bridge/")) {
    const code = request.query.employeeCode || request.body?.employeeCode;
    if (code && code !== actor.code) return denied(response);
    if (["/call-bridge/status", "/call-bridge/attempts/latest", "/call-bridge/package"].includes(path) && request.method === "GET") return next();
    if (["/call-bridge/pairings", "/call-bridge/activate", "/call-bridge/reserve", "/call-bridge/dial-start", "/call-bridge/release", "/call-bridge/devices"].includes(path)) return next();
    return denied(response);
  }
  if (/^\/(leads|my-leads|log)(\/|$)/.test(path)) {
    const names = [name, ...(employee!.aliases || [])];
    query(request, { employeeId: ownId, employeeCode: actor.code, employeeName: name, employeeNames: names.join(","), assignedAgent: ownId, assignedAgentName: name, assignedAgentNames: names.join(",") });
    const record = path.match(/^\/(?:leads|log)\/([a-f0-9]{24})(?:\/|$)/);
    if (record) {
      if (request.method === "DELETE" || /\/(assign|auto-assign|permanent)$/.test(path)) return denied(response);
      if (!Types.ObjectId.isValid(record[1])) return denied(response);
      const lead = await Lead.findById(record[1]).select("assignedAgent assignedAgentName status").lean();
      const owns = lead && (String(lead.assignedAgent) === ownId || (!lead.assignedAgent && names.includes(lead.assignedAgentName)));
      const existingReadRole = /outside.*sales|sales.*outside/i.test(`${employee!.role} ${employee!.team}`) || (lead?.status === "Completed" && /inside.*sales|sales.*inside/i.test(`${employee!.role} ${employee!.team}`));
      if (!owns && !(request.method === "GET" && existingReadRole)) return denied(response);
    } else if (request.method !== "GET" || (!/^\/my-leads(?:\/[^/]+)?$/.test(path) && !["/leads", "/leads/my", "/leads/counts", "/leads/call-stats/me", "/log/call-stats/me", "/log/call-summary/me"].includes(path))) return denied(response);
    if (request.body && typeof request.body === "object") {
      request.body.employeeId = ownId; request.body.employeeCode = actor.code; request.body.employeeName = name;
      if (request.method === "PUT") { request.body.assignedAgent = ownId; request.body.assignedAgentName = name; }
    }
    if (request.body && typeof request.body === "object") for (const key of ["author", "actor"]) {
      request.body[`${key}Name`] = name; request.body[`${key}Type`] = "employee";
    }
    return next();
  }
  return denied(response);
}
