import { AttendanceLedger } from "../models/AttendanceLedger";
import { attendanceDurationModelEnabled, attendanceIntegrityEnabled } from "../config/rolloutFlags";
import { attendanceDerivedDaysDueForRefresh } from "./attendanceDerived";
import { attendanceDerivedRefreshCommandId, executeAttendanceCommand, type AttendanceIdentity } from "./attendanceLedgerService";
import { deliverAttendanceLedger } from "./attendanceLedgerOutbox";

export async function runAttendanceDerivedRefresh(now = new Date(), deliver = deliverAttendanceLedger) {
  if (!attendanceIntegrityEnabled() || !attendanceDurationModelEnabled()) return 0;
  const ledgers = await AttendanceLedger.find({ migrationRequired: { $ne: true }, "derived.0": { $exists: true } }).lean();
  let refreshed = 0;
  for (const ledger of ledgers) {
    const identity: AttendanceIdentity = { key: ledger._id, code: ledger.employeeCode, employeeId: "",
      canonicalBusinessId: ledger.canonicalBusinessId, businessIds: ledger.businessIds };
    let revision = ledger.revision;
    let due;
    try { due = attendanceDerivedDaysDueForRefresh(ledger, now); } catch { continue; }
    for (const day of due) {
      try {
        const result = await executeAttendanceCommand(identity, { operation: "recalculate", expectedRevision: revision, dayKey: day.dayKey,
          commandId: attendanceDerivedRefreshCommandId(day.dayKey, day.shiftEnd), reason: "Finalize closed attendance deductions at shift end" },
        { role: "system", code: "attendance-derived-refresh" }, now);
        revision = result.revision;
        if (!("replayed" in result && result.replayed)) refreshed++;
      } catch {
        // Each candidate is independent; a busy, corrected or full ledger cannot starve others.
        continue;
      }
      try { await deliver(ledger._id); } catch { /* Canonical outbox jobs remain retryable. */ }
    }
  }
  return refreshed;
}
