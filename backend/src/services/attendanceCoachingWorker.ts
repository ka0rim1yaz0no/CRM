import { attendanceIntegrityEnabled } from "../config/rolloutFlags";
import { attendanceCoachingState, coachingReturnCommandId, executeAttendanceCommand } from "./attendanceLedgerService";
import { projectAttendance } from "./attendanceSessionState";
import { deliverAttendanceLedger } from "./attendanceLedgerOutbox";
import { attendanceWorkerBatch, attendanceWorkerBudget, markAttendanceWorkerCandidate } from "./attendanceWorkerCandidates";
import { attendanceWorkerCounter, attendanceWorkerFailure, trackAttendanceWorker } from "./attendanceWorkerHealth";

export async function runAttendanceCoachingReturns(now = new Date(), deliver = deliverAttendanceLedger) {
  return trackAttendanceWorker("coaching-return", async () => {
    if (!attendanceIntegrityEnabled()) return 0;
    const budget = attendanceWorkerBudget();
    const ledgers = await attendanceWorkerBatch("coaching-return", { migrationRequired: { $ne: true }, "maintenance.coachingReturnAt": { $lte: now } },
      "_id employeeCode businessIds canonicalBusinessId revision events corrections closures");
    let returned = 0;
    for (const ledger of ledgers) {
      if (!budget()) break;
      markAttendanceWorkerCandidate("coaching-return", ledger._id);
      attendanceWorkerCounter("coaching-return", "scanned");
      try {
        const projection = projectAttendance(ledger.events, ledger.corrections, ledger.closures);
        const active = projection.active, event = active?.events.at(-1);
        const returnAt = attendanceCoachingState(projection, now)?.active?.returnAt;
        if (projection.blockingIssues.length || !active || event?.source !== "Coaching Out" || !returnAt || +now < Date.parse(returnAt)) continue;
        await executeAttendanceCommand({ key: ledger._id, code: ledger.employeeCode, businessIds: ledger.businessIds,
          canonicalBusinessId: ledger.canonicalBusinessId, employeeId: "" }, {
          operation: "coaching-return", sessionId: active.id, expectedRevision: ledger.revision,
          commandId: coachingReturnCommandId(event.id, returnAt), reason: "Automatic return at the billable Coaching allowance boundary",
        }, { role: "system", code: "attendance-coaching-return" }, now);
        returned++;
        attendanceWorkerCounter("coaching-return", "closed");
      } catch (error) {
        if (["ATTENDANCE_BUSY", "STALE_REVISION", "COACHING_RETURN_NOT_DUE", "LEASE_OR_REVISION_LOST"].includes((error as { code?: string })?.code || "")) continue;
        attendanceWorkerCounter("coaching-return", "failed");
        attendanceWorkerFailure("coaching-return", "return", error);
        continue;
      }
      try { const delivery = await deliver(ledger._id); if (delivery?.pendingBusinessIds.length) attendanceWorkerCounter("coaching-return", "deliveryPending"); }
      catch (error) { attendanceWorkerCounter("coaching-return", "deliveryPending"); attendanceWorkerFailure("coaching-return", "deliver", error); }
    }
    return returned;
  });
}

let timer: NodeJS.Timeout | undefined;
let running = false;
export function startAttendanceCoachingWorker() {
  if (timer || !attendanceIntegrityEnabled()) return;
  const cycle = async () => {
    if (running) return;
    running = true;
    try { await runAttendanceCoachingReturns(); }
    catch (error) { attendanceWorkerFailure("coaching-return", "cycle", error); }
    finally { running = false; }
  };
  void cycle();
  timer = setInterval(() => { void cycle(); }, 1000);
  timer.unref();
}
