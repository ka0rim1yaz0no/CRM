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
export const attendanceHubEnabled = () => enabled("CRM_ATTENDANCE_HUB");
export const dashboardWorkspaceEnabled = () => enabled("CRM_DASHBOARD_V2");
export const attendanceIntegrityEnabled = () => enabled("CRM_ATTENDANCE_INTEGRITY");
export const attendanceActiveSessionEnabled = () => attendanceIntegrityEnabled() || enabled("CRM_ATTENDANCE_ACTIVE_SESSION");
export const attendanceRecoveryEnvironmentEnabled = () => String(process.env.CRM_ATTENDANCE_RECOVERY_CUTOFF || "").toLowerCase() === "true";
export const attendanceDurationModelEnabled = () => ["true", "1"].includes(String(process.env.CRM_ATTENDANCE_DURATION_MODEL || "").toLowerCase());
// Duration-mode policy permits the second break immediately; legacy mode retains its original default.
export const attendanceBreakGapEnabled = () => {
  const value = process.env.CRM_ATTENDANCE_BREAK_GAP;
  return value === undefined ? !attendanceDurationModelEnabled() : !["false", "0"].includes(value.toLowerCase());
};
export const attendanceAutoTimeOutEnabled = () => String(process.env.CRM_ATTENDANCE_AUTO_TIMEOUT || "").trim().toLowerCase() === "true";
