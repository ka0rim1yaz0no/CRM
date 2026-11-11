import { attendanceIntegrityEnabled } from "../config/rolloutFlags";
import type { deliverAttendanceLedger } from "./attendanceLedgerOutbox";
import { attendanceWorkerFailure, trackAttendanceWorker } from "./attendanceWorkerHealth";

export async function runAttendanceCoachingReturns(now?: Date, deliver?: typeof deliverAttendanceLedger) {
  // Keep the worker health contract, but never consume old allowance deadlines.
  // Coaching now ends only through an attendance return or the normal checkout.
  void now;
  void deliver;
  return trackAttendanceWorker("coaching-return", async () => 0);
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
