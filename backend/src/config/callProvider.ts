import { callTimingV2Enabled } from "./rolloutFlags";

// Historical RingCentral attempt records remain readable; live calls use Nextiva.
export type CallProvider = "nextiva" | "ringcentral";
export const autoCallDisabledReason = "Auto-call is temporarily disabled by an administrator.";
export const requiredAutoCallClientVersion = "2026-10-15-call-timing-v6";
export const legacyAutoCallClientVersion = "2026-10-02-provider-audit-v3";
const previousAutoCallClientVersion = "2026-10-14-comment-lock-v5";

export function isSupportedAutoCallClientVersion(value: unknown) {
  return String(value || "").trim() ===
    (callTimingV2Enabled() ? requiredAutoCallClientVersion : previousAutoCallClientVersion);
}
export function getCallProvider(): CallProvider {
  return "nextiva";
}

export function parseAutoCallDisabledEmployeeCodes(rawValue: string) {
  return new Set(
    String(rawValue || "")
      .split(/[,;\n]+/)
      .map((value) => value.trim())
      .filter(Boolean)
  );
}

export function isAutoCallDisabledForEmployee(employeeCode: unknown) {
  const normalizedCode = String(employeeCode || "").trim();
  const disabledEmployeeCodes = parseAutoCallDisabledEmployeeCodes(
    process.env.AUTO_CALL_DISABLED_EMPLOYEE_CODES || ""
  );

  return Boolean(
    normalizedCode &&
    (disabledEmployeeCodes.has("*") || disabledEmployeeCodes.has(normalizedCode))
  );
}
