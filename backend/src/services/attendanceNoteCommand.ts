import crypto from "node:crypto";
import mongoose, { type ClientSession } from "mongoose";
import { AttendanceDayNote, type AttendanceDayNoteDocument, type NoteRevision } from "../models/AttendanceDayNote";
import { AttendanceLedger, type AttendanceActor } from "../models/AttendanceLedger";
import { Employee } from "../models/Employee";
import { getBusinessConnection, getBusinessById, runWithBusiness } from "../config/tenancy";
import { attendanceDurationModelEnabled, attendanceIntegrityEnabled } from "../config/rolloutFlags";
import { AttendanceCommandError, executeAttendanceCommand, resolveAttendanceIdentity } from "./attendanceLedgerService";
import { deliverAttendanceLedger } from "./attendanceLedgerOutbox";

export type AttendanceNoteCommand = { employeeCode: string; businessId: string; dayKey: string; reason: string; excused: boolean;
  commandId: string; expectedRevision: number; expectedNoteRevision: number };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function attendanceNoteRevision(note: Pick<AttendanceDayNoteDocument, "noteRevision" | "revisions"> | null | undefined) {
  return note?.noteRevision ?? note?.revisions?.length ?? 0;
}

export async function confirmAttendanceNote(input: AttendanceNoteCommand, actor: AttendanceActor, now = new Date(), dependencies: {
  startSession?: () => Promise<ClientSession>; deliver?: typeof deliverAttendanceLedger;
} = {}) {
  if (actor.role !== "admin") throw new AttendanceCommandError(403, "ADMIN_ONLY", "Only administrators can confirm attendance notes.");
  if (!attendanceIntegrityEnabled() || !attendanceDurationModelEnabled()) throw new AttendanceCommandError(404, "NOTE_CONFIRMATION_DISABLED", "Attendance note confirmation is disabled.");
  if (!uuid.test(input.commandId || "") || !Number.isInteger(input.expectedRevision) || input.expectedRevision < 0 ||
      !Number.isInteger(input.expectedNoteRevision) || input.expectedNoteRevision < 0) {
    throw new AttendanceCommandError(426, "ATTENDANCE_REFRESH_REQUIRED", "Refresh this attendance day before saving. Your note draft has not been changed.");
  }
  const date = new Date(`${input.dayKey}T00:00:00Z`);
  if (!input.employeeCode || input.employeeCode.length > 80 || !getBusinessById(input.businessId) ||
      !/^\d{4}-\d{2}-\d{2}$/.test(input.dayKey) || !Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== input.dayKey ||
      typeof input.reason !== "string" || input.reason.length > 1000 || typeof input.excused !== "boolean" || (input.excused && !input.reason.trim())) {
    throw new AttendanceCommandError(422, "INVALID_NOTE_CONFIRMATION", "Check the employee, business, shift day and attendance note.");
  }
  return runWithBusiness(input.businessId, async () => {
    const employee = await Employee.findOne({ employeeCode: input.employeeCode, status: { $ne: "Archived" } }).select("_id").lean();
    if (!employee) throw new AttendanceCommandError(404, "EMPLOYEE_NOT_FOUND", "Employee not found in this business.");
    const identity = await resolveAttendanceIdentity(String(employee._id), actor);
    if (getBusinessConnection(input.businessId).getClient() !== AttendanceLedger.db.getClient()) {
      throw new AttendanceCommandError(503, "NOTE_TRANSACTION_UNAVAILABLE", "The note and attendance ledger must share a transaction-capable database client.");
    }
    const values = { reason: input.reason.trim(), excused: input.excused };
    const contentHash = crypto.createHash("sha256").update(JSON.stringify(values)).digest("hex");
    const session = await (dependencies.startSession || (() => mongoose.startSession()))();
    try {
      const committed = await session.withTransaction(async () => {
        const note = await AttendanceDayNote.findOne({ employeeCode: input.employeeCode, dayKey: input.dayKey }, null, { session }).lean();
        let saved: NoteRevision | undefined;
        const snapshot = await executeAttendanceCommand(identity, { commandId: input.commandId, expectedRevision: input.expectedRevision,
          operation: "confirm-note", dayKey: input.dayKey,
          noteReference: { businessId: input.businessId, dayKey: input.dayKey, noteRevision: input.expectedNoteRevision + 1, contentHash } }, actor, now,
        { session, beforeCommit: async ({ next, policy }) => {
          if (attendanceNoteRevision(note) !== input.expectedNoteRevision) throw new AttendanceCommandError(409, "STALE_NOTE_REVISION", "This business note changed. Refresh and review your retained draft.");
          const currentEmployee = await Employee.findOne({ _id: employee._id, employeeCode: input.employeeCode, status: { $ne: "Archived" } }, null, { session }).select("_id").lean();
          if (!currentEmployee) throw new AttendanceCommandError(404, "EMPLOYEE_NOT_FOUND", "Employee is no longer available in this business.");
          saved = { ...values, by: actor.code, at: now, revision: input.expectedNoteRevision + 1, commandId: input.commandId, contentHash,
            before: { reason: note?.reason || "", excused: note?.excused || false }, after: values, attendanceRevision: next.revision, policyRevision: policy.revision };
          const revisionFilter = note?.noteRevision === undefined
            ? { noteRevision: { $exists: false }, ...(note ? { revisions: { $size: input.expectedNoteRevision } } : {}) }
            : { noteRevision: input.expectedNoteRevision };
          const updated = await AttendanceDayNote.findOneAndUpdate({ employeeCode: input.employeeCode, dayKey: input.dayKey, ...revisionFilter },
            { $set: { ...values, noteRevision: saved.revision }, $push: { revisions: saved } },
            { upsert: !note, returnDocument: "after", runValidators: true, session }).lean();
          if (!updated) throw new AttendanceCommandError(409, "STALE_NOTE_REVISION", "This business note changed before saving. Your draft is retained.");
        } });
        // Replays return the original tenant-local draft, not a later editor's note.
        const revision = saved || note?.revisions.find((item) => item.commandId === input.commandId && item.by === actor.code && item.contentHash === contentHash);
        if (!revision?.after) throw new AttendanceCommandError(409, "NOTE_REPLAY_UNAVAILABLE", "The committed note revision could not be confirmed. No changes were made.");
        return { snapshot, revision };
      }, { readConcern: { level: "snapshot" }, writeConcern: { w: "majority" } });
      if (!committed) throw new AttendanceCommandError(503, "NOTE_TRANSACTION_UNAVAILABLE", "Attendance note transaction did not commit.");
      let syncPending = committed.snapshot.syncPending;
      try {
        const delivery = await (dependencies.deliver || deliverAttendanceLedger)(identity.key);
        if (delivery) syncPending = delivery.pendingBusinessIds.length > 0;
      } catch { syncPending = true; }
      return { employeeCode: input.employeeCode, businessId: input.businessId, dayKey: input.dayKey,
        ...committed.revision.after!, noteRevision: committed.revision.revision!, attendanceRevision: committed.snapshot.revision,
        policyRevision: committed.revision.policyRevision, derived: committed.snapshot.derived?.find((day) => day.dayKey === input.dayKey) || null,
        syncPending, replayed: "replayed" in committed.snapshot && committed.snapshot.replayed === true };
    } catch (error) {
      if ((error as { code?: number }).code === 11000) throw new AttendanceCommandError(409, "STALE_NOTE_REVISION", "Another note save completed first. Refresh and review your retained draft.");
      if ([20, 303].includes(Number((error as { code?: number }).code))) throw new AttendanceCommandError(503, "NOTE_TRANSACTION_UNAVAILABLE", "Atomic attendance notes require transaction support. Nothing was saved.");
      throw error;
    } finally { await session.endSession(); }
  });
}
