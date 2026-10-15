function enabled(name: string) {
  const value = String(process.env[name] || "").trim().toLowerCase();
  if (value === "true" || value === "1") return true;
  if (value === "false" || value === "0") return false;
  return process.env.NODE_ENV === "development" || process.env.NODE_ENV === "test";
}

export const callTimingV2Enabled = () => enabled("CRM_CALL_TIMING_V2");
export const attendanceV2Enabled = () => enabled("CRM_ATTENDANCE_V2");
export const timeAccountingV2Enabled = () => enabled("CRM_TIME_ACCOUNTING_V2");
export const callDashboardV2Enabled = () => enabled("CRM_CALL_DASHBOARD_V2");
