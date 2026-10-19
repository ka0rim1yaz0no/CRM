export const dashboardWorkspaceEnabled = import.meta.env.VITE_CRM_DASHBOARD_V2 === "true" ||
  (import.meta.env.DEV && import.meta.env.VITE_CRM_DASHBOARD_V2 !== "false");
export const profileUpgradeEnabled = import.meta.env.VITE_CRM_PROFILE_V2 === "true" ||
  (import.meta.env.DEV && import.meta.env.VITE_CRM_PROFILE_V2 !== "false");
