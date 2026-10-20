import { AttendanceLedger } from "../models/AttendanceLedger";
import { attendanceDurationModelEnabled, attendanceIntegrityEnabled, attendanceAccuracyFixesEnabled } from "../config/rolloutFlags";
import { attendanceWorkerBatch, attendanceWorkerBudget, markAttendanceWorkerCandidate } from "./attendanceWorkerCandidates";
import { attendanceDerivedDaysDueForRefresh } from "./attendanceDerived";
import { attendanceDerivedRefreshCommandId, executeAttendanceCommand, type AttendanceIdentity } from "./attendanceLedgerService";
import { deliverAttendanceLedger } from "./attendanceLedgerOutbox";
import { attendanceWorkerCounter, attendanceWorkerFailure, trackAttendanceWorker } from "./attendanceWorkerHealth";

export async function runAttendanceDerivedRefresh(now = new Date(), deliver = deliverAttendanceLedger) {
  return trackAttendanceWorker("derived-refresh", () => runRefresh(now, deliver));
}
async function runRefresh(now: Date, deliver: typeof deliverAttendanceLedger) {
  if (!attendanceIntegrityEnabled() || !attendanceDurationModelEnabled()) return 0;
  const accuracy = attendanceAccuracyFixesEnabled(); const budget = attendanceWorkerBudget();
  const ledgers = accuracy ? await attendanceWorkerBatch("derived-refresh", { migrationRequired: { $ne: true }, $or: [
    { "maintenance.derivedRefreshAt": { $lte: now } },
    { maintenance: { $exists: false }, derived: { $elemMatch: { accuracyVersion: 1, hasOpenSession: false, shiftEnd: { $lte: now.toISOString() } } },
      $expr: { $anyElementTrue: [{ $map: { input: "$derived", as: "day", in: { $and: [
        { $eq: ["$$day.accuracyVersion", 1] }, { $eq: ["$$day.hasOpenSession", false] },
        { $lt: ["$$day.computedAt", "$$day.shiftEnd"] }, { $lte: ["$$day.shiftEnd", now.toISOString()] },
      ] } } }] } },
  ] }, "_id employeeCode businessIds canonicalBusinessId revision events corrections closures derived migrationRequired")
    : await AttendanceLedger.find({ migrationRequired: { $ne: true }, "derived.0": { $exists: true } }).lean();
  let refreshed = 0;
  for (const ledger of ledgers) {
    if (accuracy && !budget()) break;
    if (accuracy) markAttendanceWorkerCandidate("derived-refresh", ledger._id);
    attendanceWorkerCounter("derived-refresh", "scanned");
    const identity: AttendanceIdentity = { key: ledger._id, code: ledger.employeeCode, employeeId: "",
      canonicalBusinessId: ledger.canonicalBusinessId, businessIds: ledger.businessIds };
    let revision = ledger.revision;
    let due;
    try { due = attendanceDerivedDaysDueForRefresh(ledger, now); } catch (error) {
      attendanceWorkerCounter("derived-refresh", "failed"); attendanceWorkerFailure("derived-refresh", "find-due-days", error, { ledgerId: ledger._id, employeeCode: ledger.employeeCode, businessId: ledger.canonicalBusinessId }); continue; }
    let processedDays = 0;
    for (const day of due) {
      if (accuracy && processedDays++ > 0 && !budget()) break;
      try {
        const result = await executeAttendanceCommand(identity, { operation: "recalculate", expectedRevision: revision, dayKey: day.dayKey,
          commandId: attendanceDerivedRefreshCommandId(day.dayKey, day.shiftEnd), reason: "Finalize closed attendance deductions at shift end" },
        { role: "system", code: "attendance-derived-refresh" }, now);
        revision = result.revision;
        if (!("replayed" in result && result.replayed)) { refreshed++; attendanceWorkerCounter("derived-refresh", "closed"); }
      } catch (error) {
        attendanceWorkerCounter("derived-refresh", "failed"); attendanceWorkerFailure("derived-refresh", "refresh", error, { ledgerId: ledger._id, employeeCode: ledger.employeeCode, businessId: ledger.canonicalBusinessId });
        // Each candidate is independent; a busy, corrected or full ledger cannot starve others.
        continue;
      }
      try { const delivery = await deliver(ledger._id); if (delivery?.pendingBusinessIds.length) attendanceWorkerCounter("derived-refresh", "deliveryPending"); }
      catch (error) { attendanceWorkerCounter("derived-refresh", "deliveryPending"); attendanceWorkerFailure("derived-refresh", "deliver", error, { ledgerId: ledger._id, employeeCode: ledger.employeeCode, businessId: ledger.canonicalBusinessId }); }
    }
  }
  return refreshed;
}
