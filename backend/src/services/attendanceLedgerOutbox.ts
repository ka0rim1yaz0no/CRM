import { AttendanceLedger } from "../models/AttendanceLedger";
import { Attendance } from "../models/Attendance";
import { Employee } from "../models/Employee";
import { runWithBusiness } from "../config/tenancy";
import { projectAttendance } from "./attendanceSessionState";
import { emitEmployeeAvailabilityUpdated } from "../socket";
import { recalculateEmployeePayrollAfterAttendanceEdit } from "../controllers/payrollController";
import { attendanceEventStatus } from "./attendanceShift";
import { attendancePolicy } from "./attendanceLedgerService";
import { getAttendanceBusinessIdentities } from "../models/BusinessUserAccess";
import { attendanceDurationModelEnabled, attendanceAccuracyFixesEnabled } from "../config/rolloutFlags";
import { deriveAttendanceDays } from "./attendanceDerived";
import { attendanceWorkerCounter, attendanceWorkerFailure, trackAttendanceWorker } from "./attendanceWorkerHealth";
import { attendanceWorkerBatch, attendanceWorkerBudget, markAttendanceWorkerCandidate } from "./attendanceWorkerCandidates";

export async function refreshAttendanceLedgerMemberships(employeeCode?: string) {
  const bounded = attendanceAccuracyFixesEnabled() && !employeeCode;
  const ledgers = bounded ? await attendanceWorkerBatch("membership", {}, "_id employeeCode businessIds revision")
    : await AttendanceLedger.find(employeeCode ? { employeeCode } : {}).select("_id employeeCode businessIds revision").lean();
  const memberships = await getAttendanceBusinessIdentities(ledgers.map((ledger) => ledger.employeeCode));
  const budget = attendanceWorkerBudget();
  for (const ledger of ledgers) {
    if (bounded && !budget()) break;
    if (bounded) markAttendanceWorkerCandidate("membership", ledger._id);
    const membership = memberships.get(ledger.employeeCode);
    if (!membership || ledger._id !== `access:${membership.id}` || JSON.stringify([...membership.businessIds].sort()) === JSON.stringify([...ledger.businessIds].sort())) continue;
    await AttendanceLedger.updateOne({ _id: ledger._id, revision: ledger.revision, $or: [{ lockUntil: { $lte: new Date() } }, { lockUntil: { $exists: false } }] },
      { $set: { businessIds: membership.businessIds }, $push: { jobs: { $each: membership.businessIds.map((businessId) => ({ businessId, revision: ledger.revision, done: false })) } } });
  }
  return ledgers.map((ledger) => ledger._id);
}

export async function deliverAttendanceLedger(identityKey: string, options: {
  now?: Date; recalculatePayroll?: typeof recalculateEmployeePayrollAfterAttendanceEdit;
  emitAvailability?: typeof emitEmployeeAvailabilityUpdated;
} = {}) {
  const ledger = await AttendanceLedger.findById(identityKey).lean();
  if (!ledger) return;
  const projection = projectAttendance(ledger.events, ledger.corrections, ledger.closures);
  const shifts = new Map(projection.sessions.flatMap((session) => session.events.map((event) => [event.id, session.shift] as const)));
  const policy = await attendancePolicy(ledger.canonicalBusinessId);
  const pending = [...new Set(ledger.jobs.filter((job) => !job.done).map((job) => job.businessId))];
  const durationModel = attendanceDurationModelEnabled();
  // Retry the committed snapshot's clock, not a later delivery-time clock.
  const computedAt = ledger.derived?.[0]?.computedAt || ledger.audit.at(-1)?.at;
  const days = durationModel ? ledger.derived ?? deriveAttendanceDays(ledger, policy, computedAt ? new Date(computedAt) : options.now || new Date()) : undefined;
  const derivedByEvent = new Map(days?.flatMap((day) => day.eventIds.map((id) => [id, day] as const)));
  const recalculatePayroll = options.recalculatePayroll || recalculateEmployeePayrollAfterAttendanceEdit;
  const emitAvailability = options.emitAvailability || emitEmployeeAvailabilityUpdated;
  const deliveredBusinessIds: string[] = [];
  for (const businessId of pending) {
    attendanceWorkerCounter("outbox", "scanned");
    let notification: Parameters<typeof emitAvailability>[0] | undefined;
    let completed = false;
    try {
      await runWithBusiness(businessId, async () => {
        const employee = await Employee.findOne({ employeeCode: ledger.employeeCode, status: { $ne: "Archived" } }).select("_id").lean();
        if (!employee) throw new Error("Attendance membership is unavailable");
        const effectiveIds = projection.effectiveEvents.map((event) => event.id);
        if (projection.effectiveEvents.length) {
          await Attendance.bulkWrite(projection.effectiveEvents.map((event) => {
            const origin = event.replicaOrigins?.find((item) => item.businessId === businessId) || (event.origin?.businessId === businessId ? event.origin : undefined);
            return { updateOne: {
            filter: origin
              ? { _id: origin.recordId, $or: [{ ledgerRevision: { $lte: ledger.revision } }, { ledgerRevision: { $exists: false } }] }
              : { employee: employee._id, eventId: event.id, $or: [{ ledgerRevision: { $lte: ledger.revision } }, { ledgerRevision: { $exists: false } }] },
            update: { $set: { employee: employee._id, eventId: event.id, source: event.source, timeIn: new Date(event.at),
              isEffective: true, ledgerIdentity: ledger._id, ledgerRevision: ledger.revision, sequence: event.sequence,
              ...(event.autoTimeOut === undefined ? {} : { autoTimeOut: event.autoTimeOut }),
              ...(durationModel && derivedByEvent.has(event.id) ? { derived: derivedByEvent.get(event.id) } : {}),
              attendanceStatus: attendanceEventStatus(event.source, new Date(event.at), shifts.get(event.id) || null, policy.graceMinutes) },
              $setOnInsert: { isArchived: false } }, upsert: true,
          } }; }));
        }
        await Attendance.updateMany({ ledgerIdentity: ledger._id, ledgerRevision: { $lte: ledger.revision }, eventId: { $nin: effectiveIds } },
          { $set: { isEffective: false, ledgerRevision: ledger.revision } });
        for (const event of ledger.events.filter((item) => !effectiveIds.includes(item.id))) {
          const origin = event.replicaOrigins?.find((item) => item.businessId === businessId) || (event.origin?.businessId === businessId ? event.origin : undefined);
          if (!origin) continue;
          await Attendance.updateOne({ _id: origin.recordId, $or: [{ ledgerRevision: { $lte: ledger.revision } }, { ledgerRevision: { $exists: false } }] },
            { $set: { isEffective: false, ledgerIdentity: ledger._id, ledgerRevision: ledger.revision } });
        }
        const state = projection.active?.mode || "OFFLINE";
        await Employee.updateOne({ _id: employee._id, $or: [{ attendanceRevision: { $lte: ledger.revision } }, { attendanceRevision: { $exists: false } }] },
          { $set: { availabilityStatus: state, availabilityStatusReason: "manual-attendance-ledger", attendanceRevision: ledger.revision,
            activeAttendanceSessionId: projection.active?.id || "" } });
        const firstPendingRevision = Math.min(...ledger.jobs.filter((job) => !job.done && job.businessId === businessId).map((job) => job.revision));
        const affected = ledger.audit.filter((audit) => audit.afterRevision >= firstPendingRevision && audit.afterRevision <= ledger.revision &&
          (durationModel || ["correct", "undo", "recover", "auto-time-out"].includes(audit.operation)));
        notification = { employeeId: String(employee._id), availabilityStatus: state };
        if (affected.length || durationModel) {
          const targets = new Set(affected.flatMap((audit) => audit.targetIds));
          const commands = new Set(affected.map((audit) => audit.commandId));
          const closedSessions = new Set(ledger.closures.filter((closure) => commands.has(closure.commandId)).map((closure) => closure.sessionId));
          const closedEventIds = new Set(projection.sessions.filter((session) => closedSessions.has(session.id)).flatMap((session) => session.events.map((event) => event.id)));
          const events = ledger.events.filter((event) => targets.has(event.id) || commands.has(event.commandId) || closedEventIds.has(event.id) || !affected.length);
          const derivedDates = affected.flatMap((audit) => [...(audit.beforeDerived || []), ...(audit.afterDerived || [])]
            .flatMap((day) => [day.shiftStart, day.shiftEnd]));
          const dates = [...new Set([...derivedDates, ...events.flatMap((event) => [event.at, shifts.get(event.id)?.start].filter((at): at is string => Boolean(at)))])]
            .map((at) => new Date(at)).sort((a, b) => a.getTime() - b.getTime());
          if (dates.length) await recalculatePayroll(String(employee._id), dates[0], dates.at(-1)!, { businessIds: [businessId], attendanceDates: dates });
        }
      });
      const completion = await AttendanceLedger.updateOne({ _id: identityKey, revision: ledger.revision },
        { $set: { "jobs.$[job].done": true } }, { arrayFilters: [{ "job.businessId": businessId, "job.revision": { $lte: ledger.revision } }] });
      if (completion.matchedCount) { deliveredBusinessIds.push(businessId); completed = true; attendanceWorkerCounter("outbox", "closed"); }
      else if (attendanceAccuracyFixesEnabled()) throw Object.assign(new Error("Completion marker changed"), { code: "STALE_REVISION" });
    } catch (error) {
      attendanceWorkerCounter("outbox", "failed"); attendanceWorkerCounter("outbox", "deliveryPending");
      const detail = attendanceWorkerFailure("outbox", "deliver", error, { ledgerId: identityKey, employeeCode: ledger.employeeCode, businessId });
      if (attendanceAccuracyFixesEnabled()) {
        try {
          await AttendanceLedger.updateOne({ _id: identityKey, revision: ledger.revision },
            { $set: { "jobs.$[job].lastErrorCode": detail.code, "jobs.$[job].lastErrorAt": new Date().toISOString() } },
            { arrayFilters: [{ "job.businessId": businessId, "job.revision": { $lte: ledger.revision }, "job.done": false }] });
        } catch (markerError) { attendanceWorkerFailure("outbox", "save-error-marker", markerError, { ledgerId: identityKey, businessId }); }
      }
    } finally {
      // Publish after payroll and the completion marker so a refreshing tab cannot race the saved totals.
      if (notification && (!attendanceAccuracyFixesEnabled() || completed)) {
        try { await runWithBusiness(businessId, () => emitAvailability(notification!)); }
        catch (error) {
          attendanceWorkerFailure("outbox", "emit-availability", error, { ledgerId: identityKey, employeeCode: ledger.employeeCode, businessId });
          if (attendanceAccuracyFixesEnabled()) {
            deliveredBusinessIds.splice(deliveredBusinessIds.indexOf(businessId), 1);
            attendanceWorkerCounter("outbox", "failed"); attendanceWorkerCounter("outbox", "deliveryPending");
            try { await AttendanceLedger.updateOne({ _id: identityKey }, { $set: { "jobs.$[job].done": false,
              "jobs.$[job].lastErrorCode": "AVAILABILITY_EMIT_FAILED", "jobs.$[job].lastErrorAt": new Date().toISOString() } },
              { arrayFilters: [{ "job.businessId": businessId, "job.revision": { $lte: ledger.revision } }] }); }
            catch (retryError) { attendanceWorkerFailure("outbox", "restore-pending-marker", retryError, { ledgerId: identityKey, businessId }); }
          }
        }
      }
    }
  }
  return { revision: ledger.revision, deliveredBusinessIds, pendingBusinessIds: pending.filter((id) => !deliveredBusinessIds.includes(id)) };
}
export async function retryAttendanceLedgers() { return trackAttendanceWorker("outbox", retryAttendanceLedgersInternal); }
async function retryAttendanceLedgersInternal() {
  await refreshAttendanceLedgerMemberships();
  const accuracy = attendanceAccuracyFixesEnabled(); const budget = attendanceWorkerBudget();
  const pending = accuracy ? await attendanceWorkerBatch("outbox", { jobs: { $elemMatch: { done: false } } }, "_id")
    : await AttendanceLedger.find({ jobs: { $elemMatch: { done: false } } }).select("_id").limit(100).lean();
  for (const item of pending) {
    if (accuracy && !budget()) break;
    if (accuracy) markAttendanceWorkerCandidate("outbox", item._id);
    await deliverAttendanceLedger(item._id);
  }
}
