import { AttendanceLedger } from "../models/AttendanceLedger";
import { attendanceDurationModelEnabled, attendanceIntegrityEnabled } from "../config/rolloutFlags";
import { attendancePolicy, attendancePolicyRefreshCommandId, executeAttendanceCommand, type AttendanceIdentity } from "./attendanceLedgerService";
import { deliverAttendanceLedger } from "./attendanceLedgerOutbox";

export function attendancePolicySyncPending(ledger: { derived?: Array<{ policyRevision?: number }> }, revision: number) {
  return Boolean(ledger.derived?.some((day) => day.policyRevision !== revision));
}

export async function hasAttendancePolicyRefreshPending(revision: number) {
  if (!attendanceIntegrityEnabled() || !attendanceDurationModelEnabled()) return false;
  const ledgers = await AttendanceLedger.find({ migrationRequired: { $ne: true }, "derived.0": { $exists: true } }).select("derived jobs").lean();
  return ledgers.some((ledger) => attendancePolicySyncPending(ledger, revision) || ledger.jobs.some((job) => !job.done));
}

export async function runAttendancePolicyRefresh(now = new Date(), deliver = deliverAttendanceLedger) {
  const report = { refreshed: 0, failed: 0, deliveryPending: 0 };
  if (!attendanceIntegrityEnabled() || !attendanceDurationModelEnabled()) return report;
  const policy = await attendancePolicy();
  // Only already-derived canonical history is eligible; this does not apply the historical backfill.
  const ledgers = await AttendanceLedger.find({ migrationRequired: { $ne: true }, "derived.0": { $exists: true } }).lean();
  for (const ledger of ledgers) {
    if (!attendancePolicySyncPending(ledger, policy.revision)) continue;
    const identity: AttendanceIdentity = { key: ledger._id, code: ledger.employeeCode, employeeId: "",
      canonicalBusinessId: ledger.canonicalBusinessId, businessIds: ledger.businessIds };
    try {
      const result = await executeAttendanceCommand(identity, { operation: "recalculate-policy", policyRevision: policy.revision,
        expectedRevision: ledger.revision, commandId: attendancePolicyRefreshCommandId(policy.revision), reason: "Apply administrator attendance policy revision" },
      { role: "system", code: "attendance-policy-refresh" }, now);
      if (!("replayed" in result && result.replayed)) report.refreshed++;
    } catch {
      report.failed++;
      continue;
    }
    try {
      const result = await deliver(ledger._id);
      if (result?.pendingBusinessIds.length) report.deliveryPending++;
    } catch { report.deliveryPending++; }
  }
  return report;
}
