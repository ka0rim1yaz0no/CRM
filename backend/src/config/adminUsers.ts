export type ConfiguredAdmin = {
  employeeCode: string;
  name: string;
  access: "full" | "tracker";
};

import { securityEnvironmentCodesEnabled } from "./rolloutFlags";

function codeList(name: string) { return String(process.env[name] || "").split(",").map(code => code.trim()).filter(Boolean); }

export function isTrackerOnlyAdminCode(employeeCode: string) {
  const code = String(employeeCode || "").trim();
  return Boolean(code) && (codeList("CRM_TRACKER_ADMIN_CODES").includes(code) || ["ONE", "TWO", "THREE"].some(slot =>
    String(process.env[`CRM_ADMIN_${slot}_CODE`] || "").trim() === code && (process.env[`CRM_ADMIN_${slot}_ACCESS`] === "tracker"
      || (securityEnvironmentCodesEnabled() && process.env.NODE_ENV === "production" && process.env[`CRM_ADMIN_${slot}_ACCESS`] !== "full"))));
}

export function isDeniedEmployeeCode(employeeCode: string) { return codeList("CRM_DENIED_EMPLOYEE_CODES").includes(employeeCode); }

function adminAccess(slot: string, code: string): "full" | "tracker" {
  if (isTrackerOnlyAdminCode(code)) return "tracker";
  const explicit = process.env[`CRM_ADMIN_${slot}_ACCESS`];
  // Opted-in production must explicitly classify every configured admin; missing means no elevation.
  if (securityEnvironmentCodesEnabled() && process.env.NODE_ENV === "production" && explicit !== "full") return "tracker";
  return explicit === "tracker" ? "tracker" : "full";
}

export function getConfiguredAdmins(): ConfiguredAdmin[] {
  return [
    {
      employeeCode: String(process.env.CRM_ADMIN_ONE_CODE || "").trim(),
      name: "Administrator One",
      access: adminAccess("ONE", String(process.env.CRM_ADMIN_ONE_CODE || "").trim()),
    },
    {
      employeeCode: String(process.env.CRM_ADMIN_TWO_CODE || "").trim(),
      name: "Administrator Two",
      access: adminAccess("TWO", String(process.env.CRM_ADMIN_TWO_CODE || "").trim()),
    },
    {
      employeeCode: String(process.env.CRM_ADMIN_THREE_CODE || "").trim(),
      name: "Administrator Three",
      access: adminAccess("THREE", String(process.env.CRM_ADMIN_THREE_CODE || "").trim()),
    },
  ].filter((admin) => Boolean(admin.employeeCode));
}

export function findConfiguredAdmin(employeeCode: string) {
  return getConfiguredAdmins().find((admin) => admin.employeeCode === employeeCode);
}

export function isConfiguredAdminCode(employeeCode: string) {
  return Boolean(findConfiguredAdmin(employeeCode));
}
