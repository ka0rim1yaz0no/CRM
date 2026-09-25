export type ConfiguredAdmin = {
  employeeCode: string;
  name: string;
};

export function getConfiguredAdmins(): ConfiguredAdmin[] {
  return [
    {
      employeeCode: String(process.env.CRM_ADMIN_ONE_CODE || "").trim(),
      name: "Administrator One",
    },
    {
      employeeCode: String(process.env.CRM_ADMIN_TWO_CODE || "").trim(),
      name: "Administrator Two",
    },
  ].filter((admin) => Boolean(admin.employeeCode));
}

export function findConfiguredAdmin(employeeCode: string) {
  return getConfiguredAdmins().find((admin) => admin.employeeCode === employeeCode);
}

export function isConfiguredAdminCode(employeeCode: string) {
  return Boolean(findConfiguredAdmin(employeeCode));
}
