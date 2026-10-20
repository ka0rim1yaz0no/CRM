import { AttendanceLedger } from "../models/AttendanceLedger";
import { attendanceDurationModelEnabled, attendanceIntegrityEnabled, attendanceAccuracyFixesEnabled } from "../config/rolloutFlags";
import { attendanceWorkerBatch, attendanceWorkerBudget, markAttendanceWorkerCandidate } from "./attendanceWorkerCandidates";
import { attendancePolicy, attendancePolicyRefreshCommandId, executeAttendanceCommand, type AttendanceIdentity } from "./attendanceLedgerService";
import { deliverAttendanceLedger } from "./attendanceLedgerOutbox";
import { attendanceWorkerCounter, attendanceWorkerFailure, trackAttendanceWorker } from "./attendanceWorkerHealth";

export function attendancePolicySyncPending(ledger: { derived?: Array<{ policyRevision?: number }> }, revision: number) {
  return Boolean(ledger.derived?.some((day) => (!attendanceAccuracyFixesEnabled() || (day as { accuracyVersion?: number }).accuracyVersion === 1) && day.policyRevision !== revision));
}

export async function hasAttendancePolicyRefreshPending(revision: number) {
  if (!attendanceIntegrityEnabled() || !attendanceDurationModelEnabled()) return false;
  const ledgers = await AttendanceLedger.find({ migrationRequired: { $ne: true }, "derived.0": { $exists: true } }).select("derived jobs").lean();
  return ledgers.some((ledger) => attendancePolicySyncPending(ledger, revision) || ledger.jobs.some((job) => !job.done));
}

export async function runAttendancePolicyRefresh(now = new Date(), deliver = deliverAttendanceLedger) {
  return trackAttendanceWorker("policy-refresh", () => runRefresh(now, deliver));
}
async function runRefresh(now: Date, deliver: typeof deliverAttendanceLedger) {
  const report = { refreshed: 0, failed: 0, deliveryPending: 0 };
  if (!attendanceIntegrityEnabled() || !attendanceDurationModelEnabled()) return report;
  const policy = await attendancePolicy();
  // Only already-derived canonical history is eligible; this does not apply the historical backfill.
  const accuracy = attendanceAccuracyFixesEnabled(); const budget = attendanceWorkerBudget();
  const ledgers = accuracy ? await attendanceWorkerBatch("policy-refresh", { migrationRequired: { $ne: true },
    derived: { $elemMatch: { accuracyVersion: 1, policyRevision: { $ne: policy.revision } } } },
    "_id employeeCode businessIds canonicalBusinessId revision derived")
    : await AttendanceLedger.find({ migrationRequired: { $ne: true }, "derived.0": { $exists: true } }).lean();
  for (const ledger of ledgers) {
    if (accuracy && !budget()) break;
    if (accuracy) markAttendanceWorkerCandidate("policy-refresh", ledger._id);
    attendanceWorkerCounter("policy-refresh", "scanned");
    if (!attendancePolicySyncPending(ledger, policy.revision)) continue;
    const identity: AttendanceIdentity = { key: ledger._id, code: ledger.employeeCode, employeeId: "",
      canonicalBusinessId: ledger.canonicalBusinessId, businessIds: ledger.businessIds };
    try {
      const result = await executeAttendanceCommand(identity, { operation: "recalculate-policy", policyRevision: policy.revision,
        expectedRevision: ledger.revision, commandId: attendancePolicyRefreshCommandId(policy.revision), reason: "Apply administrator attendance policy revision" },
      { role: "system", code: "attendance-policy-refresh" }, now);
      if (!("replayed" in result && result.replayed)) { report.refreshed++; attendanceWorkerCounter("policy-refresh", "closed"); }
    } catch (error) {
      report.failed++;
      attendanceWorkerCounter("policy-refresh", "failed"); attendanceWorkerFailure("policy-refresh", "refresh", error, { ledgerId: ledger._id, employeeCode: ledger.employeeCode, businessId: ledger.canonicalBusinessId });
      continue;
    }
    try {
      const result = await deliver(ledger._id);
      if (result?.pendingBusinessIds.length) { report.deliveryPending++; attendanceWorkerCounter("policy-refresh", "deliveryPending"); }
    } catch (error) { report.deliveryPending++; attendanceWorkerCounter("policy-refresh", "deliveryPending");
      attendanceWorkerFailure("policy-refresh", "deliver", error, { ledgerId: ledger._id, employeeCode: ledger.employeeCode, businessId: ledger.canonicalBusinessId }); }
  }
  return report;
}
