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

export async function refreshAttendanceLedgerMemberships(employeeCode?: string) {
  const ledgers = await AttendanceLedger.find(employeeCode ? { employeeCode } : {}).select("_id employeeCode businessIds revision").lean();
  const memberships = await getAttendanceBusinessIdentities(ledgers.map((ledger) => ledger.employeeCode));
  for (const ledger of ledgers) {
    const membership = memberships.get(ledger.employeeCode);
    if (!membership || ledger._id !== `access:${membership.id}` || JSON.stringify([...membership.businessIds].sort()) === JSON.stringify([...ledger.businessIds].sort())) continue;
    await AttendanceLedger.updateOne({ _id: ledger._id, revision: ledger.revision, $or: [{ lockUntil: { $lte: new Date() } }, { lockUntil: { $exists: false } }] },
      { $set: { businessIds: membership.businessIds }, $push: { jobs: { $each: membership.businessIds.map((businessId) => ({ businessId, revision: ledger.revision, done: false })) } } });
  }
  return ledgers.map((ledger) => ledger._id);
}

export async function deliverAttendanceLedger(identityKey: string) {
  const ledger = await AttendanceLedger.findById(identityKey).lean();
  if (!ledger) return;
  const projection = projectAttendance(ledger.events, ledger.corrections, ledger.closures);
  const shifts = new Map(projection.sessions.flatMap((session) => session.events.map((event) => [event.id, session.shift] as const)));
  const policy = await attendancePolicy(ledger.canonicalBusinessId);
  const pending = [...new Set(ledger.jobs.filter((job) => !job.done).map((job) => job.businessId))];
  for (const businessId of pending) {
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
              isEffective: true, ledgerIdentity: ledger._id, ledgerRevision: ledger.revision,
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
        const affected = ledger.audit.filter((audit) => audit.afterRevision >= firstPendingRevision && audit.afterRevision <= ledger.revision && ["correct", "undo", "recover"].includes(audit.operation));
        if (affected.length) {
          const targets = new Set(affected.flatMap((audit) => audit.targetIds));
          const commands = new Set(affected.map((audit) => audit.commandId));
          const dates = ledger.events.filter((event) => targets.has(event.id) || commands.has(event.commandId)).map((event) => new Date(event.at)).sort((a, b) => a.getTime() - b.getTime());
          if (dates.length) await recalculateEmployeePayrollAfterAttendanceEdit(String(employee._id), dates[0], dates.at(-1)!, { businessIds: [businessId], attendanceDates: dates });
        }
        emitEmployeeAvailabilityUpdated({ employeeId: String(employee._id), availabilityStatus: state });
      });
      await AttendanceLedger.updateOne({ _id: identityKey, revision: ledger.revision },
        { $set: { "jobs.$[job].done": true } }, { arrayFilters: [{ "job.businessId": businessId, "job.revision": { $lte: ledger.revision } }] });
    } catch {
      // The command is already durable. The pending job remains retryable.
    }
  }
}
export async function retryAttendanceLedgers() {
  await refreshAttendanceLedgerMemberships();
  const pending = await AttendanceLedger.find({ jobs: { $elemMatch: { done: false } } }).select("_id").limit(100).lean();
  for (const item of pending) await deliverAttendanceLedger(item._id);
}
