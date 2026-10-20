import { AttendanceLedger } from "../models/AttendanceLedger";
import { attendanceAutoTimeOutEnabled, attendanceIntegrityEnabled } from "../config/rolloutFlags";
import { attendancePolicy, autoTimeOutCommandId, executeAttendanceCommand, type AttendanceIdentity } from "./attendanceLedgerService";
import { projectAttendance } from "./attendanceSessionState";
import { attendanceAutoTimeOutCutoff } from "./attendanceAutoTimeOut";
import { deliverAttendanceLedger } from "./attendanceLedgerOutbox";

export type AttendanceAutoTimeOutReport = { scanned: number; closed: number; skipped: number; failed: number; deliveryPending: number };

export async function runAttendanceAutoTimeOutCycle(now = new Date(), deliver = deliverAttendanceLedger): Promise<AttendanceAutoTimeOutReport> {
  const report: AttendanceAutoTimeOutReport = { scanned: 0, closed: 0, skipped: 0, failed: 0, deliveryPending: 0 };
  if (!attendanceIntegrityEnabled() || !attendanceAutoTimeOutEnabled()) return report;
  // Only adopted canonical ledgers are candidates; never seed or mutate legacy attendance here.
  const ledgers = await AttendanceLedger.find({ migrationRequired: { $ne: true } }).lean();
  for (const ledger of ledgers) {
    report.scanned += 1;
    try {
      if (ledger.migrationRequired) { report.skipped += 1; continue; }
      const projection = projectAttendance(ledger.events, ledger.corrections, ledger.closures);
      if (projection.blockingIssues.length || !projection.active) { report.skipped += 1; continue; }
      const policy = await attendancePolicy(ledger.canonicalBusinessId);
      const cutoff = attendanceAutoTimeOutCutoff(projection.active, policy.autoTimeOutTime);
      if (!cutoff || now < cutoff) { report.skipped += 1; continue; }
      const identity: AttendanceIdentity = { key: ledger._id, code: ledger.employeeCode, businessIds: ledger.businessIds,
        canonicalBusinessId: ledger.canonicalBusinessId, employeeId: "" };
      await executeAttendanceCommand(identity, { commandId: autoTimeOutCommandId(projection.active.id), expectedRevision: ledger.revision,
        operation: "auto-time-out", sessionId: projection.active.id, reason: "Scheduled automatic time-out" },
      { role: "system", code: "attendance-auto-time-out" }, now);
      report.closed += 1;
    } catch (error) {
      if (["ATTENDANCE_BUSY", "STALE_REVISION", "AUTO_TIME_OUT_NOT_DUE", "LEASE_OR_REVISION_LOST"].includes((error as { code?: string } | null)?.code || "")) report.skipped += 1;
      else report.failed += 1;
      continue;
    }
    // Delivery can fail after the canonical commit; its durable jobs remain pending.
    try {
      const delivery = await deliver(ledger._id);
      if (delivery?.pendingBusinessIds.length) report.deliveryPending += 1;
    } catch { report.deliveryPending += 1; }
  }
  return report;
}

export async function runAttendanceAutoTimeOut(now = new Date(), deliver = deliverAttendanceLedger) {
  const report = await runAttendanceAutoTimeOutCycle(now, deliver);
  if (report.failed || report.deliveryPending) console.warn("Attendance auto time-out retry counts", report);
  return report.closed;
}
