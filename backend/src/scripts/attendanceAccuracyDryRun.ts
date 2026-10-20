import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { backfillAttendanceDerivedDryRun, parseAttendanceDerivedBackfillArguments } from "./backfillAttendanceDerived";

export async function attendanceAccuracyDryRun(args: string[]) {
  const options = parseAttendanceDerivedBackfillArguments(args);
  const target = new URL(options.uri);
  if (target.protocol !== "mongodb:" || !["127.0.0.1", "localhost", "[::1]"].includes(target.hostname) || target.username || target.password) {
    throw new Error("Attendance accuracy dry-run requires a credential-free loopback Mongo copy. No writes are supported.");
  }
  process.env.CRM_ATTENDANCE_ACCURACY_FIXES = "true";
  process.env.CRM_PAYROLL_ACCURACY = "true";
  process.env.CRM_ATTENDANCE_DURATION_MODEL = "true";
  process.env.CRM_ATTENDANCE_BREAK_GAP = "false";
  const report = await backfillAttendanceDerivedDryRun(args, { accuracyReport: true });
  return { ...report, interpretation: { accuracyFixes: true, payrollAccuracy: true, durationModel: true, breakGap: false,
    rounding: "ceil completed rest minutes; floor late after grace; ceil early-out", advisoryOnly: true } };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(await attendanceAccuracyDryRun(process.argv.slice(2)), null, 2)); }
  catch { console.error("Local attendance accuracy dry-run failed. No writes requested; check explicit arguments and read-only copy access."); process.exitCode = 1; }
}
