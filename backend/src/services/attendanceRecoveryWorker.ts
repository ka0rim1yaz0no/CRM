import { AttendanceLedger } from "../models/AttendanceLedger";
import { attendanceIntegrityEnabled } from "../config/rolloutFlags";
import { attendancePolicy, executeAttendanceCommand, type AttendanceIdentity } from "./attendanceLedgerService";
import { projectAttendance } from "./attendanceSessionState";
import { attendanceRecoveryEnvironmentEnabled } from "../config/rolloutFlags";
import { deliverAttendanceLedger, retryAttendanceLedgers } from "./attendanceLedgerOutbox";
import { recoveryCommandId } from "./attendanceLedgerService";
import { attendanceAutoTimeOutEnabled } from "../config/rolloutFlags";
import { runAttendanceAutoTimeOut } from "./attendanceAutoTimeOutWorker";
import { runAttendanceDerivedRefresh } from "./attendanceDerivedRefreshWorker";

export async function runAttendanceRecovery(now = new Date()) {
  if (!attendanceIntegrityEnabled() || attendanceAutoTimeOutEnabled()) return 0;
  const ledgers = await AttendanceLedger.find({}).lean();
  let closed = 0;
  for (const ledger of ledgers) {
    const active = projectAttendance(ledger.events, ledger.corrections, ledger.closures).active;
    if (!active?.shift || active.shift.ambiguous || now < new Date(active.shift.resetDeadline)) continue;
    const policy = await attendancePolicy(ledger.canonicalBusinessId);
    if (!policy.recoveryEnabled && !attendanceRecoveryEnvironmentEnabled()) continue;
    const identity: AttendanceIdentity = { key: ledger._id, code: ledger.employeeCode, businessIds: ledger.businessIds,
      canonicalBusinessId: ledger.canonicalBusinessId, employeeId: "" };
    try {
      await executeAttendanceCommand(identity, { commandId: recoveryCommandId(active.id), expectedRevision: ledger.revision,
        operation: "recover", sessionId: active.id, reason: "Administrative missing-checkout recovery" }, { role: "system", code: "attendance-recovery" }, now);
      await deliverAttendanceLedger(ledger._id); closed += 1;
    } catch { /* A manual command or another worker may have committed first. */ }
  }
  return closed;
}
let timer: NodeJS.Timeout | null = null;
let running = false;
export function startAttendanceIntegrityWorker() {
  if (timer || !attendanceIntegrityEnabled()) return;
  const cycle = async () => {
    if (running) return;
    running = true;
    try {
      for (const run of [runAttendanceAutoTimeOut, runAttendanceRecovery, runAttendanceDerivedRefresh, retryAttendanceLedgers]) {
        try { await run(); } catch { /* Independent maintenance and pending deliveries must still run. */ }
      }
    }
    finally { running = false; }
  };
  void cycle().catch(() => undefined);
  timer = setInterval(() => { void cycle().catch(() => undefined); }, 15_000);
  timer.unref();
}
