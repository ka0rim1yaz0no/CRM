import crypto from "node:crypto";

const localSecret = crypto.randomBytes(32);
const lifetimeMs = 12 * 60 * 60_000;

function secret() {
  const configured = process.env.CRM_ATTENDANCE_HUB_SESSION_SECRET || process.env.CRM_ADMIN_SESSION_SECRET || "";
  if (configured.length >= 32) return configured;
  return process.env.NODE_ENV === "development" || process.env.NODE_ENV === "test" ? localSecret : null;
}

export function createAttendanceHubSession(employeeCode: string, now = Date.now()) {
  const key = secret();
  if (!key || !employeeCode) return null;
  const payload = Buffer.from(JSON.stringify({ code: employeeCode, exp: now + lifetimeMs })).toString("base64url");
  return `${payload}.${crypto.createHmac("sha256", key).update(payload).digest("base64url")}`;
}

export function verifyAttendanceHubSession(token: unknown, now = Date.now()) {
  const key = secret();
  const [payload, signature, extra] = String(token || "").split(".");
  if (!key || !payload || !signature || extra) return null;
  const expected = crypto.createHmac("sha256", key).update(payload).digest();
  let actual: Buffer;
  try { actual = Buffer.from(signature, "base64url"); } catch { return null; }
  if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) return null;
  try {
    const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { code?: unknown; exp?: unknown };
    return typeof decoded.code === "string" && decoded.code.length <= 80 &&
      typeof decoded.exp === "number" && decoded.exp > now && decoded.exp <= now + lifetimeMs
      ? decoded.code : null;
  } catch { return null; }
}
