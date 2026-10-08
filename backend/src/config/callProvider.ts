export type CallProvider = "nextiva" | "ringcentral";
export const autoCallDisabledReason = "Auto-call is temporarily disabled by an administrator.";
export const requiredAutoCallClientVersion = "2026-10-02-first-lead-lock-v4";
export const legacyAutoCallClientVersion = "2026-10-02-provider-audit-v3";
const compatibleAutoCallClientVersions = new Set([requiredAutoCallClientVersion, legacyAutoCallClientVersion]);

export function isSupportedAutoCallClientVersion(value: unknown) {
  return compatibleAutoCallClientVersions.has(String(value || "").trim());
}

export function getCallProvider(): CallProvider {
  return String(process.env.CALL_PROVIDER || "ringcentral").trim().toLowerCase() === "nextiva"
    ? "nextiva"
    : "ringcentral";
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

export function getRingCentralConfig() {
  const server = String(process.env.RINGCENTRAL_SERVER_URL || "https://platform.ringcentral.com").trim();
  const clientId = String(process.env.RINGCENTRAL_CLIENT_ID || "").trim();
  const clientSecret = String(process.env.RINGCENTRAL_CLIENT_SECRET || "").trim();
  const jwt = String(process.env.RINGCENTRAL_JWT || "").trim();

  return {
    server,
    clientId,
    clientSecret,
    jwt,
    configured: Boolean(server && clientId && clientSecret && jwt),
  };
}
