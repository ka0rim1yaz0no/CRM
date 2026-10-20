import { AttendanceLedger } from "../models/AttendanceLedger";
import { attendanceIntegrityEnabled, attendanceAccuracyFixesEnabled } from "../config/rolloutFlags";
import { logAttendanceFlags } from "../config/attendanceFlags";
import { activeAttendanceWorkerFilter, attendanceWorkerBatch, attendanceWorkerBudget, markAttendanceWorkerCandidate } from "./attendanceWorkerCandidates";
import { attendancePolicy, executeAttendanceCommand, type AttendanceIdentity } from "./attendanceLedgerService";
import { projectAttendance } from "./attendanceSessionState";
import { attendanceRecoveryEnvironmentEnabled } from "../config/rolloutFlags";
import { deliverAttendanceLedger, retryAttendanceLedgers } from "./attendanceLedgerOutbox";
import { recoveryCommandId } from "./attendanceLedgerService";
import { attendanceAutoTimeOutEnabled } from "../config/rolloutFlags";
import { runAttendanceAutoTimeOut } from "./attendanceAutoTimeOutWorker";
import { runAttendanceDerivedRefresh } from "./attendanceDerivedRefreshWorker";
import { runAttendancePolicyRefresh } from "./attendancePolicyRefreshWorker";
import { attendanceWorkerCounter, attendanceWorkerFailure, trackAttendanceWorker } from "./attendanceWorkerHealth";

export async function runAttendanceRecovery(now = new Date(), deliver = deliverAttendanceLedger) {
  return trackAttendanceWorker("recovery", () => runRecovery(now, deliver));
}
async function runRecovery(now: Date, deliver: typeof deliverAttendanceLedger) {
  if (!attendanceIntegrityEnabled() || attendanceAutoTimeOutEnabled()) return 0;
  const accuracy = attendanceAccuracyFixesEnabled(); const budget = attendanceWorkerBudget();
  const ledgers = accuracy ? await attendanceWorkerBatch("recovery", activeAttendanceWorkerFilter(),
    "_id employeeCode businessIds canonicalBusinessId revision events corrections closures") : await AttendanceLedger.find({}).lean();
  let closed = 0;
  for (const ledger of ledgers) {
    if (accuracy && !budget()) break;
    if (accuracy) markAttendanceWorkerCandidate("recovery", ledger._id);
    attendanceWorkerCounter("recovery", "scanned");
    let commandStarted = false;
    let committed = false;
    try {
    const active = projectAttendance(ledger.events, ledger.corrections, ledger.closures).active;
    if (!active?.shift || active.shift.ambiguous || now < new Date(active.shift.resetDeadline)) continue;
    const policy = await attendancePolicy(ledger.canonicalBusinessId);
    if (!policy.recoveryEnabled && !attendanceRecoveryEnvironmentEnabled()) continue;
    const identity: AttendanceIdentity = { key: ledger._id, code: ledger.employeeCode, businessIds: ledger.businessIds,
      canonicalBusinessId: ledger.canonicalBusinessId, employeeId: "" };
      commandStarted = true;
      await executeAttendanceCommand(identity, { commandId: recoveryCommandId(active.id), expectedRevision: ledger.revision,
        operation: "recover", sessionId: active.id, reason: "Administrative missing-checkout recovery" }, { role: "system", code: "attendance-recovery" }, now);
      attendanceWorkerCounter("recovery", "closed");
      committed = true;
      const delivery = await deliver(ledger._id);
      closed += 1;
      if (delivery?.pendingBusinessIds.length) attendanceWorkerCounter("recovery", "deliveryPending");
    } catch (error) { if (!attendanceAccuracyFixesEnabled() && !commandStarted) throw error;
      attendanceWorkerCounter("recovery", "failed");
      if (committed) attendanceWorkerCounter("recovery", "deliveryPending");
      attendanceWorkerFailure("recovery", "recover-or-deliver", error, { ledgerId: ledger._id, employeeCode: ledger.employeeCode, businessId: ledger.canonicalBusinessId }); }
  }
  return closed;
}
let timer: NodeJS.Timeout | null = null;
let running = false;
export function startAttendanceIntegrityWorker() {
  if (!timer) logAttendanceFlags();
  if (timer || !attendanceIntegrityEnabled()) return;
  const cycle = async () => {
    if (running) return;
    running = true;
    try {
      for (const run of [runAttendanceAutoTimeOut, runAttendanceRecovery, runAttendancePolicyRefresh, runAttendanceDerivedRefresh, retryAttendanceLedgers]) {
        try { await run(); } catch (error) { attendanceWorkerFailure("recovery", `maintenance:${run.name}`, error); }
      }
    }
    finally { running = false; }
  };
  void cycle().catch(error => attendanceWorkerFailure("recovery", "cycle", error));
  timer = setInterval(() => { void cycle().catch(error => attendanceWorkerFailure("recovery", "cycle", error)); }, 15_000);
  timer.unref();
}
