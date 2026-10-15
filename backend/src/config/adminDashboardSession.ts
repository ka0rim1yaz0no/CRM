import crypto from "node:crypto";
import { findConfiguredAdmin } from "./adminUsers";

const devSecret = crypto.randomBytes(32);
const ttlMs = 12 * 60 * 60_000;

function signingKey() {
  const configured = String(process.env.CRM_ADMIN_SESSION_SECRET || "");
  if (configured.length >= 32) return configured;
  return process.env.NODE_ENV === "development" || process.env.NODE_ENV === "test" ? devSecret : null;
}

export function createAdminDashboardSession(employeeCode: string, now = Date.now()) {
  const admin = findConfiguredAdmin(employeeCode);
  const key = signingKey();
  if (!admin || admin.access !== "full" || !key) return null;
  const payload = Buffer.from(JSON.stringify({ code: employeeCode, exp: now + ttlMs })).toString("base64url");
  const signature = crypto.createHmac("sha256", key).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

export function verifyAdminDashboardSession(token: unknown, now = Date.now()) {
  const key = signingKey();
  const [payload, signature, extra] = String(token || "").split(".");
  if (!key || !payload || !signature || extra) return null;
  const expected = crypto.createHmac("sha256", key).update(payload).digest();
  let actual: Buffer;
  try { actual = Buffer.from(signature, "base64url"); } catch { return null; }
  if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) return null;
  try {
    const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { code?: string; exp?: number };
    if (!decoded.code || !decoded.exp || decoded.exp <= now || decoded.exp > now + ttlMs) return null;
    const admin = findConfiguredAdmin(decoded.code);
    return admin?.access === "full" ? admin : null;
  } catch {
    return null;
  }
}
