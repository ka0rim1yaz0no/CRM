import type { Request, RequestHandler, Response } from "express";
import { verifyAdminDashboardSession } from "../config/adminDashboardSession";
import { verifyAttendanceHubSession } from "../config/attendanceHubSession";
import { findConfiguredAdmin } from "../config/adminUsers";
import { securityUploadsEnabled, securityLegacyAuthEnabled } from "../config/rolloutFlags";
import { Employee } from "../models/Employee";
import { getBusinessAccessForEmployeeCode } from "../models/BusinessUserAccess";

const cookieName = "crm_file_session";
type FileSession = { type: "admin" | "employee" | "tracker"; token: string };
function cookieOptions() { return { httpOnly: true, sameSite: "lax" as const, secure: process.env.NODE_ENV === "production", path: "/" }; }
export function setFileSession(response: Response, session: FileSession) {
  if (securityUploadsEnabled()) response.cookie(cookieName, JSON.stringify(session), { ...cookieOptions(), maxAge: 12 * 60 * 60_000 });
}
export function clearFileSession(response: Response) { response.clearCookie(cookieName, cookieOptions()); }
function cookieSession(request: Request): Partial<FileSession> {
  try {
    const encoded = String(request.header("cookie") || "").split(";").map(part => part.trim()).find(part => part.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1);
    const value = encoded && encoded.length < 4000 ? JSON.parse(decodeURIComponent(encoded)) : null;
    return value && typeof value === "object" && ["admin", "employee", "tracker"].includes(value.type) && typeof value.token === "string" ? value : {};
  } catch { return {}; }
}

// Cookies authenticate file GETs only. They never authorize profile/attendance writes.
export function requireFileSession(staffOnly = false, allowTracker = true): RequestHandler {
  return async (request, response, next) => {
    if (!securityUploadsEnabled()) return next();
    response.set("Cache-Control", "private, no-store");
    response.vary("Cookie, X-CRM-Admin-Session, X-CRM-Attendance-Session, X-Business-Id");
    const cookie = ["GET", "HEAD"].includes(request.method) ? cookieSession(request) : {};
    const admin = verifyAdminDashboardSession(request.header("x-crm-admin-session") || (cookie.type === "admin" ? cookie.token : ""));
    const trackerCode = verifyAttendanceHubSession(request.header("x-crm-attendance-session") || (cookie.type === "tracker" ? cookie.token : ""));
    const tracker = trackerCode ? findConfiguredAdmin(trackerCode) : null;
    if (!admin && tracker?.access === "tracker" && (!allowTracker || (securityLegacyAuthEnabled() && !staffOnly))) return void response.status(403).json({ message: "Full administrator access is required for this file." });
    if (admin || tracker?.access === "tracker") {
      if (["GET", "HEAD"].includes(request.method)) response.locals.crmVerifiedFileSession = true;
      request.headers["x-crm-user-type"] = "admin";
      request.headers["x-crm-user-code"] = (admin || tracker)!.employeeCode;
      return next();
    }
    const code = verifyAttendanceHubSession(request.header("x-crm-attendance-session") || (cookie.type === "employee" ? cookie.token : ""));
    if (!code) return void response.status(401).json({ message: "A signed CRM session is required to access this file." });
    if (staffOnly) return void response.status(403).json({ message: "Administrator access is required for this file." });
    const allowed = await getBusinessAccessForEmployeeCode(code);
    if (allowed.length && !allowed.includes(request.business?.id || "")) return void response.status(403).json({ message: "You do not have access to this business." });
    const employee = await Employee.findOne({ employeeCode: code, status: { $ne: "Archived" } }).select("businessAccessIds").lean();
    if (!employee || (employee.businessAccessIds?.length && !employee.businessAccessIds.includes(request.business?.id || ""))) return void response.status(403).json({ message: "You do not have access to this business." });
    request.headers["x-crm-user-type"] = "employee";
    request.headers["x-crm-user-code"] = code;
    if (["GET", "HEAD"].includes(request.method)) response.locals.crmVerifiedFileSession = true;
    next();
  };
}
