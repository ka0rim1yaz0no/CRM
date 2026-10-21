import crypto from "node:crypto";
import express, { type Request, type RequestHandler } from "express";
import helmet from "helmet";
import { rateLimit, ipKeyGenerator } from "express-rate-limit";
import { verifyAdminDashboardSession } from "../config/adminDashboardSession";
import { verifyAttendanceHubSession } from "../config/attendanceHubSession";
import { securityHardeningEnabled } from "../config/rolloutFlags";

function numberSetting(name: string, fallback: number, maximum: number) {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value > 0 && value <= maximum ? value : fallback;
}
function guarded(middleware: RequestHandler): RequestHandler {
  return (request, response, next) => securityHardeningEnabled() ? middleware(request, response, next) : next();
}
function hash(value: string) { return crypto.createHash("sha256").update(value).digest("hex"); }
function apiKey(request: Request) {
  const identity = verifyAdminDashboardSession(request.header("x-crm-admin-session"))?.employeeCode
    || verifyAttendanceHubSession(request.header("x-crm-attendance-session"));
  return identity ? `session:${hash(identity)}` : ipKeyGenerator(request.ip || "127.0.0.1");
}
export function securityMiddleware() {
  const windowMs = numberSetting("CRM_SECURITY_LOGIN_WINDOW_MS", 15 * 60_000, 24 * 60 * 60_000);
  const loginOptions = { windowMs, limit: numberSetting("CRM_SECURITY_LOGIN_MAX", 10, 100), standardHeaders: "draft-8" as const,
    legacyHeaders: false, skipSuccessfulRequests: true, message: { message: "Too many login attempts. Please wait before trying again." } };
  return {
    headers: guarded(helmet({ crossOriginResourcePolicy: { policy: "same-site" }, strictTransportSecurity: process.env.NODE_ENV === "production" ? undefined : false })),
    apiLimit: guarded(rateLimit({ windowMs: 60_000, limit: numberSetting("CRM_SECURITY_API_MAX", 600, 60_000), keyGenerator: apiKey,
      standardHeaders: "draft-8", legacyHeaders: false, skip: request => request.method === "OPTIONS" || request.path === "/health",
      message: { message: "Too many requests. Please try again shortly." } })),
    loginIpLimit: guarded(rateLimit({ ...loginOptions, limit: numberSetting("CRM_SECURITY_LOGIN_IP_MAX", loginOptions.limit, 1_000), requestPropertyName: "loginIpLimit" })),
    loginCodeLimit: guarded(rateLimit({ ...loginOptions, requestPropertyName: "loginCodeLimit", keyGenerator: request => hash(String(request.body?.employeeCode || "").trim().slice(0, 100)) })),
  };
}

export function securityBodyParser(): RequestHandler {
  const legacy = process.env.REQUEST_BODY_LIMIT || "500mb";
  const small = process.env.REQUEST_BODY_LIMIT || "2mb";
  // Only these exact upload handlers receive an enlarged JSON budget.
  const uploads = new Map<RegExp, string>([
    [/^POST \/api\/media\/?$/, "70mb"],
    [/^POST \/api\/messages\/conversations\/[^/]+\/attachments\/?$/, "70mb"],
    [/^POST \/api\/knowledge-base\/documents\/?$/, "70mb"],
    [/^POST \/api\/knowledge-base\/photos\/?$/, "20mb"],
    [/^POST \/api\/browser-activity\/screenshots\/?$/, "20mb"],
    [/^PATCH \/api\/employees\/[^/]+\/profile\/?$/, "4mb"],
    [/^(POST \/api\/employees\/?|PUT \/api\/employees\/[^/]+\/?)$/, "4mb"],
  ]);
  const parsers = new Map<string, RequestHandler>();
  return (request, response, next) => {
    let limit = securityHardeningEnabled() ? small : legacy;
    if (securityHardeningEnabled()) for (const [pattern, budget] of uploads) if (pattern.test(`${request.method} ${request.path}`)) { limit = budget; break; }
    const key = `${request.is("application/x-www-form-urlencoded") ? "form" : "json"}:${limit}`;
    let parser = parsers.get(key);
    if (!parser) { parser = key.startsWith("form:") ? express.urlencoded({ extended: true, limit }) : express.json({ limit }); parsers.set(key, parser); }
    parser(request, response, next);
  };
}
