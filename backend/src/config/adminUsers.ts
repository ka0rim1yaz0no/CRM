export type ConfiguredAdmin = {
  employeeCode: string;
  name: string;
  access: "full" | "tracker";
};

export const INTERNAL_ONLY_TRACKER_ADMIN_CODE = "2132123000";

export function isTrackerOnlyAdminCode(employeeCode: string) {
  return String(employeeCode || "").trim() === INTERNAL_ONLY_TRACKER_ADMIN_CODE;
}

export function getConfiguredAdmins(): ConfiguredAdmin[] {
  return [
    {
      employeeCode: String(process.env.CRM_ADMIN_ONE_CODE || "").trim(),
      name: "Administrator One",
      access: isTrackerOnlyAdminCode(String(process.env.CRM_ADMIN_ONE_CODE || "").trim()) ? "tracker" as const : "full" as const,
    },
    {
      employeeCode: String(process.env.CRM_ADMIN_TWO_CODE || "").trim(),
      name: "Administrator Two",
      access: isTrackerOnlyAdminCode(String(process.env.CRM_ADMIN_TWO_CODE || "").trim()) ? "tracker" as const : "full" as const,
    },
    {
      employeeCode: String(process.env.CRM_ADMIN_THREE_CODE || "").trim(),
      name: "Administrator Three",
      access: isTrackerOnlyAdminCode(String(process.env.CRM_ADMIN_THREE_CODE || "").trim()) ? "tracker" as const : "full" as const,
    },
  ].filter((admin) => Boolean(admin.employeeCode));
}

export function findConfiguredAdmin(employeeCode: string) {
  return getConfiguredAdmins().find((admin) => admin.employeeCode === employeeCode);
}

export function isConfiguredAdminCode(employeeCode: string) {
  return Boolean(findConfiguredAdmin(employeeCode));
}
