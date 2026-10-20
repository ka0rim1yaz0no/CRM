import { attendanceIntegrityEnabled, attendanceActiveSessionEnabled, attendanceDurationModelEnabled,
  attendanceAutoTimeOutEnabled, attendanceBreakGapEnabled, attendanceAccuracyFixesEnabled, payrollAccuracyEnabled } from "./rolloutFlags";

export function attendanceFlagState() {
  return { INTEGRITY: attendanceIntegrityEnabled(), ACTIVE_SESSION: attendanceActiveSessionEnabled(),
    DURATION_MODEL: attendanceDurationModelEnabled(), AUTO_TIMEOUT: attendanceAutoTimeOutEnabled(),
    BREAK_GAP: attendanceBreakGapEnabled(), ACCURACY_FIXES: attendanceAccuracyFixesEnabled(), PAYROLL_ACCURACY: payrollAccuracyEnabled() };
}
export function attendanceFlagProblems(flags = attendanceFlagState()) {
  const problems: string[] = [];
  if (flags.AUTO_TIMEOUT && !flags.INTEGRITY) problems.push("AUTO_TIMEOUT requires INTEGRITY");
  if (flags.AUTO_TIMEOUT && !flags.DURATION_MODEL) problems.push("AUTO_TIMEOUT requires DURATION_MODEL");
  if (flags.ACCURACY_FIXES && !flags.PAYROLL_ACCURACY) problems.push("ACCURACY_FIXES requires PAYROLL_ACCURACY for matching payroll totals");
  if (flags.ACCURACY_FIXES && !flags.INTEGRITY) problems.push("ACCURACY_FIXES requires INTEGRITY for canonical delivery");
  if (flags.ACCURACY_FIXES && !flags.DURATION_MODEL) problems.push("ACCURACY_FIXES requires DURATION_MODEL for persisted canonical totals");
  return problems;
}
export function assertAttendanceFlagConfiguration() {
  const problems = attendanceFlagProblems();
  const strict = ["true", "1"].includes(String(process.env.CRM_ATTENDANCE_STRICT_FLAGS || "").trim().toLowerCase());
  if (strict && process.env.NODE_ENV === "production" && problems.length) {
    throw new Error(`Invalid attendance flag configuration: ${problems.join("; ")}`);
  }
}
export function logAttendanceFlags() {
  console.info("attendance-flags", attendanceFlagState());
  const problems = attendanceFlagProblems();
  if (problems.length) console.warn("ATTENDANCE FLAG CONFIGURATION WARNING", { problems });
}
