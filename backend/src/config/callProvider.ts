import { CALLING_QUEUE_POLICY_VERSION } from "../../../shared/leadCallingPolicy";

// Historical RingCentral attempt records remain readable; live calls use Nextiva.
export type CallProvider = "nextiva" | "ringcentral";
export const autoCallDisabledReason = "Auto-call is temporarily disabled by an administrator.";
export const requiredAutoCallClientVersion = CALLING_QUEUE_POLICY_VERSION;
export const legacyAutoCallClientVersion = "2026-10-02-provider-audit-v3";

export function isSupportedAutoCallClientVersion(value: unknown) {
  return String(value || "").trim() === requiredAutoCallClientVersion;
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
