import crypto from "node:crypto";
import type { ClientSession } from "mongoose";
import { AttendanceLedger, AttendancePolicy, type AttendanceActor, type AttendanceLedgerDocument } from "../models/AttendanceLedger";
import { Attendance } from "../models/Attendance";
import { Employee } from "../models/Employee";
import { getAttendanceBusinessIdentity } from "../models/BusinessUserAccess";
import { getBusinessById, getCurrentBusinessId, runWithBusiness } from "../config/tenancy";
import { SystemSettings } from "../models/SystemSettings";
import { attendanceAutoTimeOutEnabled, attendanceDurationModelEnabled, attendanceIntegrityEnabled, attendanceRecoveryEnvironmentEnabled, payrollAccuracyEnabled, attendanceAccuracyFixesEnabled } from "../config/rolloutFlags";
import { attendanceMaintenanceState } from "./attendanceWorkerCandidates";
import { assignAttendanceShift } from "./attendanceShift";
import { projectAttendance, sessionTime, type SessionEvent } from "./attendanceSessionState";
import { attendanceAutoTimeOutCutoff } from "./attendanceAutoTimeOut";
import { attendanceDerivedDaysDueForRefresh, deriveAttendanceDays } from "./attendanceDerived";
import { attendanceDerivedAuditDelta, replayAttendanceDerived, sameAttendanceDerivedValues, type AttendanceDerivedAuditDelta } from "./attendanceDerivedAudit";
import { attendancePayrollTransaction, lockPayrollAttendance } from "./payrollAttendanceFence";

export class AttendanceCommandError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: unknown) { super(message); }
}
export type AttendanceIdentity = { key: string; code: string; businessIds: string[]; canonicalBusinessId: string; employeeId: string };
export type AttendanceNoteReference = { businessId: string; dayKey: string; noteRevision: number; contentHash: string };
export type AttendanceCommand = { commandId: string; expectedRevision: number; fingerprint?: string; operation: "action" | "correct" | "undo" | "recover" | "auto-time-out" | "recalculate" | "recalculate-policy" | "confirm-note";
  source?: SessionEvent["source"]; changes?: Array<{ targetId?: string; source?: SessionEvent["source"]; at?: string; remove?: boolean }>;
  sessionId?: string; dayKey?: string; targetCommandId?: string; reason?: string; previewRevision?: number; policyRevision?: number; noteReference?: AttendanceNoteReference };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const supportedSources = new Set(["Login", "Logout", "Time In", "Time Out", "Break Out", "Break In", "Lunch Break Out", "Lunch Break In", "Off the Phone Out", "Off the Phone In"]);
const hash = (value: unknown) => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
export function recoveryCommandId(sessionId: string) {
  const hex = hash(`attendance-recovery:${sessionId}`);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
export function autoTimeOutCommandId(sessionId: string) {
  const hex = hash(`attendance-auto-time-out:${sessionId}`);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
export function attendanceDerivedRefreshCommandId(dayKey: string, shiftEnd: string) {
  const hex = hash(`attendance-derived-refresh:${dayKey}:${shiftEnd}`);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
export function attendancePolicyRefreshCommandId(revision: number) {
  const hex = hash(`attendance-policy-refresh:${revision}`);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export async function resolveAttendanceIdentity(employeeId: string, actor: AttendanceActor): Promise<AttendanceIdentity> {
  const current = getCurrentBusinessId();
  const employee = await Employee.findById(employeeId).select("employeeCode status").lean();
  if (!employee || employee.status === "Archived") throw new AttendanceCommandError(404, "EMPLOYEE_NOT_FOUND", "Employee not found.");
  if (actor.role === "employee" && actor.code !== employee.employeeCode) throw new AttendanceCommandError(403, "FORBIDDEN", "You can only access your own attendance.");
  const mapping = await getAttendanceBusinessIdentity(employee.employeeCode);
  if (mapping?.businessIds.length && !mapping.businessIds.includes(current)) throw new AttendanceCommandError(403, "BUSINESS_SCOPE", "Employee is not assigned to this business.");
  const businessIds = mapping?.businessIds.length ? mapping.businessIds.filter((id) => Boolean(getBusinessById(id))) : [current];
  return { key: mapping ? `access:${mapping.id}` : `tenant:${current}:${employee._id}`, code: employee.employeeCode,
    businessIds, canonicalBusinessId: businessIds[0], employeeId: String(employee._id) };
}
export async function attendancePolicy(businessId = getCurrentBusinessId(), session?: ClientSession) {
  const stored = await AttendancePolicy.findById("global-attendance", null, session ? { session } : undefined).lean();
  if (stored) return { ...stored, autoTimeOutTime: stored.autoTimeOutTime ?? "08:05" };
  const settings = await runWithBusiness(businessId, () => SystemSettings.findOne({ key: "system" }, null, session ? { session } : undefined).lean());
  return { _id: "global-attendance", revision: 0, graceMinutes: settings?.lateGraceMinutes || 0, breakMinutes: 15, lunchMinutes: 60,
    shiftStart: settings?.officialShiftStartTime || "23:00", shiftEnd: settings?.officialShiftEndTime || "08:00",
    recoveryEnabled: false, recoveryTime: "22:59", autoTimeOutTime: "08:05", audit: [] };
}
export async function readAttendanceLedger(identity: AttendanceIdentity, session?: ClientSession) {
  const ledger = await AttendanceLedger.findById(identity.key, null, session ? { session } : undefined).lean();
  if (ledger) return ledger;
  const policy = await attendancePolicy(identity.canonicalBusinessId, session);
  const events = await runWithBusiness(identity.canonicalBusinessId, async () => {
    const employee = await Employee.findOne({ employeeCode: identity.code }, null, session ? { session } : undefined).select("_id").lean();
    if (!employee) throw new AttendanceCommandError(503, "CANONICAL_UNAVAILABLE", "The authoritative employee record is unavailable. Attendance status is unknown.");
    const records = await Attendance.find({ employee: employee._id, isArchived: { $ne: true } }, null, session ? { session } : undefined).sort({ timeIn: 1, _id: 1 }).lean();
    return records.map((record, index): SessionEvent => ({ id: record.eventId || `legacy:${identity.canonicalBusinessId}:${record._id}`,
      source: record.source, at: record.timeIn.toISOString(), sequence: index, commandId: record.eventId || `legacy:${record._id}`,
      recordedAt: record.timeIn.toISOString(), origin: { businessId: identity.canonicalBusinessId, recordId: String(record._id) },
      ...(["Time In", "Login"].includes(record.source) ? { shift: assignAttendanceShift(record.timeIn, policy.shiftStart, policy.shiftEnd, policy.recoveryTime) } : {}) }));
  });
  let secondaryHistory = false;
  for (const businessId of identity.businessIds.filter((id) => id !== identity.canonicalBusinessId)) {
    secondaryHistory ||= await runWithBusiness(businessId, async () => {
      const employee = await Employee.findOne({ employeeCode: identity.code }, null, session ? { session } : undefined).select("_id").lean();
      return Boolean(employee && (session
        ? await Attendance.findOne({ employee: employee._id, isArchived: { $ne: true } }, null, { session }).select("_id").lean()
        : await Attendance.exists({ employee: employee._id, isArchived: { $ne: true } })));
    });
  }
  if (!events.length && secondaryHistory) throw new AttendanceCommandError(503, "CANONICAL_HISTORY_MISSING", "Another business has attendance but the authoritative history is missing. Status is unknown; an administrator must review the mismatch.");
  return { _id: identity.key, employeeCode: identity.code, businessIds: identity.businessIds, canonicalBusinessId: identity.canonicalBusinessId,
    revision: 0, fence: 0, events, corrections: [], closures: [], audit: [], commands: [], jobs: [], migrationRequired: events.length > 0 || secondaryHistory } as AttendanceLedgerDocument;
}
type AttendanceCutoffContext = { autoTimeOutTime?: string };
function attendanceAutoTimeOutPending(session: ReturnType<typeof projectAttendance>["active"], now: Date, policy: AttendanceCutoffContext) {
  if (!attendanceIntegrityEnabled() || !attendanceAutoTimeOutEnabled()) return false;
  const cutoff = attendanceAutoTimeOutCutoff(session, policy.autoTimeOutTime);
  return Boolean(cutoff && now >= cutoff);
}
function guardAttendanceActionCutoff(input: AttendanceCommand, session: ReturnType<typeof projectAttendance>["active"], policy: AttendanceCutoffContext, now: Date) {
  if (input.operation === "action" && input.source && supportedSources.has(input.source) && input.source !== "Time Out" && input.source !== "Logout" && attendanceAutoTimeOutPending(session, now, policy)) {
    throw new AttendanceCommandError(409, "AUTO_TIME_OUT_PENDING", "Automatic time-out is pending. Refresh attendance after the worker closes this shift.");
  }
}
export function attendanceSnapshot(ledger: AttendanceLedgerDocument, now = new Date(), cutoffContext?: AttendanceCutoffContext) {
  const projection = projectAttendance(ledger.events, ledger.corrections, ledger.closures);
  const session = projection.active;
  const eventDays = new Map(projection.sessions.flatMap(item => item.events.map(event => [event.id, item.shift?.dayKey] as const)));
  const last = projection.sessions.at(-1);
  const sequence = ledger.events.reduce((max, event) => Math.max(max, event.sequence), -1) + 1;
  const allowedActions = ledger.migrationRequired || projection.blockingIssues.length ||
    (cutoffContext && attendanceAutoTimeOutPending(session, now, cutoffContext)) ? [] : [...supportedSources].filter((source) => {
    const additions: SessionEvent[] = [];
    const append = (candidate: SessionEvent["source"]) => additions.push({ id: `allowed:${sequence + additions.length}:${candidate}`,
      commandId: "allowed-action-preview", sequence: sequence + additions.length, source: candidate, at: now.toISOString(), recordedAt: now.toISOString() });
    if (source === "Time Out" && session?.mode === "OFF THE PHONE") append("Off the Phone In");
    append(source as SessionEvent["source"]);
    return !projectAttendance([...ledger.events, ...additions], ledger.corrections, ledger.closures).blockingIssues.length;
  });
  const review = [...projection.issues.map((issue) => issue.message), ...projection.sessions.filter((item) => item.lifecycle === "system-closed").map(() => "Administrative missing-checkout closure requires review.")];
  if (ledger.legacyAdoption?.businessStreamsDiffer) review.push("Historical business copies differed. Their original evidence was backed up and retained during reviewed adoption.");
  if (ledger.migrationRequired) review.push("Legacy history is readable, but adoption requires a reviewed migration and backup. No historical records were changed.");
  if (session?.shift?.ambiguous) review.push("Early clock-in assignment needs review. Automatic recovery is disabled for this ambiguous shift.");
  return { sessionId: session?.id || null, revision: ledger.revision, fingerprint: hash(ledger.events),
    state: session?.mode || "OFFLINE", stateSince: session?.modeSince || last?.modeSince || null,
    lifecycle: session?.lifecycle || last?.lifecycle || "none", assignedShift: session?.shift || null, allowedActions,
    openIntervals: session && session.mode !== "ONLINE" ? [{ mode: session.mode, startedAt: session.modeSince }] : [],
    reviewState: ledger.migrationRequired ? "migration-review" : projection.blockingIssues.length ? "needs-correction" : "verified", review,
    historyReviewRequired: projection.issues.some((issue) => issue.historical) || Boolean(ledger.legacyAdoption?.businessStreamsDiffer), serverTime: now.toISOString(),
    sessions: projection.sessions.map((item) => ({ ...item, time: sessionTime(item, now) })),
    records: projection.effectiveEvents.map(event => ({ ...event, ...(eventDays.get(event.id) ? { shiftDayKey: eventDays.get(event.id) } : {}) })), audit: ledger.audit,
    time: session ? sessionTime(session, now) : null, syncPending: ledger.jobs.some((job) => !job.done),
    systemClosure: last?.closure || null, ...(attendanceDurationModelEnabled() ? { derived: ledger.derived } : {}) };
}

function replaySnapshot(ledger: AttendanceLedgerDocument, revision: number, serverTime: string) {
  const all = new Set(ledger.commands.map((command) => command.id));
  const included = new Set(ledger.commands.filter((command) => command.revision <= revision).map((command) => command.id));
  const visible = (commandId: string) => !all.has(commandId) || included.has(commandId);
  return attendanceSnapshot({ ...ledger, revision,
    derived: revision === ledger.revision ? ledger.derived : replayAttendanceDerived(ledger, revision),
    events: ledger.events.filter((event) => visible(event.commandId)),
    corrections: ledger.corrections.filter((correction) => visible(correction.commandId)), closures: ledger.closures.filter((closure) => visible(closure.commandId)),
    audit: ledger.audit.filter((audit) => audit.afterRevision <= revision) }, new Date(serverTime));
}

export async function acquireAttendanceLease(id: string, token: string, now = new Date(), session?: ClientSession) {
  return AttendanceLedger.findOneAndUpdate({ _id: id, $or: [{ lockUntil: { $lte: now } }, { lockUntil: { $exists: false } }] },
    { $set: { lockToken: token, lockUntil: new Date(now.getTime() + 30_000) }, $inc: { fence: 1 } }, { returnDocument: "after", ...(session ? { session } : {}) }).lean();
}
export async function commitAttendanceRevision(id: string, token: string, fence: number, revision: number,
  update: Record<string, unknown>, now = new Date(), session?: ClientSession) {
  const commit = (activeSession?: ClientSession) => AttendanceLedger.findOneAndUpdate({ _id: id, revision, lockToken: token, fence, lockUntil: { $gt: now } }, update,
    { returnDocument: "after", runValidators: true, ...(activeSession ? { session: activeSession } : {}) }).lean();
  if (!payrollAccuracyEnabled()) return commit(session);
  return attendancePayrollTransaction(async activeSession => {
    const ledger = await AttendanceLedger.findById(id, null, { session: activeSession }).select("employeeCode businessIds").lean();
    if (!ledger) return null;
    const assigned = (update.$set as { businessIds?: string[] } | undefined)?.businessIds || [];
    const businessIds = [...new Set([...ledger.businessIds, ...assigned])];
    await lockPayrollAttendance(businessIds.map(businessId => ({ businessId, employeeCode: ledger.employeeCode })), activeSession);
    return commit(activeSession);
  }, session);
}

function applyAttendanceCommand(ledger: AttendanceLedgerDocument, input: AttendanceCommand, actor: AttendanceActor,
  policy: Awaited<ReturnType<typeof attendancePolicy>>, now: Date) {
  if ((input.reason?.length || 0) > 1000) throw new AttendanceCommandError(422, "INVALID_REASON", "Reasons must be at most 1000 characters.");
  const before = projectAttendance(ledger.events, ledger.corrections, ledger.closures);
  const events = [...ledger.events]; const corrections = [...ledger.corrections]; const closures = [...ledger.closures];
  let sequence = events.reduce((max, event) => Math.max(max, event.sequence), -1) + 1;
  const targets: string[] = [];
  const append = (source: SessionEvent["source"], at: string, shift?: SessionEvent["shift"], sessionId?: string) => {
    if (!supportedSources.has(source)) throw new AttendanceCommandError(422, "INVALID_SOURCE", "Unsupported attendance event type.");
    const date = new Date(at);
    if (!Number.isFinite(date.getTime()) || date > now) throw new AttendanceCommandError(422, "INVALID_TIME", "Attendance time must be valid and cannot be in the future.");
    const event: SessionEvent = { id: crypto.randomUUID(), commandId: input.commandId, source, at: date.toISOString(), sequence: sequence++, recordedAt: now.toISOString(), ...(shift ? { shift } : {}) };
    if (["Time In", "Login"].includes(source)) {
      event.sessionId = sessionId || event.id;
      if (!shift) event.shift = assignAttendanceShift(date, policy.shiftStart, policy.shiftEnd, policy.recoveryTime);
    }
    events.push(event); return event;
  };
  if (input.operation === "action") {
    if (!input.source) throw new AttendanceCommandError(422, "INVALID_ACTION", "Attendance action is required.");
    if (before.blockingIssues.length) throw new AttendanceCommandError(409, "TIMELINE_REVIEW_REQUIRED", "The current attendance session needs an administrator correction before another action.", before.blockingIssues);
    guardAttendanceActionCutoff(input, before.active, policy, now);
    if (input.source === "Time Out" && before.active?.mode === "OFF THE PHONE") append("Off the Phone In", now.toISOString());
    append(input.source, now.toISOString());
  } else if (input.operation === "correct") {
    if (actor.role !== "admin" || !input.reason?.trim()) throw new AttendanceCommandError(403, "ADMIN_REASON_REQUIRED", "An administrator and correction reason are required.");
    if (!input.changes?.length || input.changes.length > 30) throw new AttendanceCommandError(422, "INVALID_CHANGES", "Provide 1 to 30 intentional changes.");
    for (const change of input.changes) {
      const original = change.targetId ? before.effectiveEvents.find((event) => event.id === change.targetId) : null;
      if (change.targetId && !original) throw new AttendanceCommandError(409, "EVENT_NOT_EFFECTIVE", "This attendance event was already corrected or reversed.");
      if (change.remove && !original) throw new AttendanceCommandError(422, "INVALID_CHANGE", "An explicit removal must identify an effective event.");
      if (original) targets.push(original.id);
      if (!change.remove) {
        const source = change.source || original?.source; const at = change.at || original?.at;
        if (!source || !at) throw new AttendanceCommandError(422, "INVALID_CHANGE", "Source and timestamp are required for a new event.");
        if (!Number.isFinite(new Date(at).getTime())) throw new AttendanceCommandError(422, "INVALID_TIME", "Check the attendance timestamp.");
        const isStart = ["Time In", "Login"].includes(source);
        const stableSessionId = original && ["Time In", "Login"].includes(original.source) ? original.sessionId || original.id : undefined;
        const assigned = isStart ? assignAttendanceShift(new Date(at), policy.shiftStart, policy.shiftEnd, policy.recoveryTime) : undefined;
        if (original?.shift && assigned?.dayKey !== original.shift.dayKey && ledger.closures.some((closure) => closure.sessionId === stableSessionId)) {
          throw new AttendanceCommandError(409, "SYSTEM_CLOSURE_REVIEW_REQUIRED", "A system-closed session cannot be moved to another shift by a plain correction.");
        }
        const replacement = append(source, at, original?.shift && assigned?.dayKey === original.shift.dayKey ? original.shift : assigned, stableSessionId);
        if (original?.legacyReviewed) replacement.legacyReviewed = true;
        if (original?.legacyBoundary && isStart) replacement.legacyBoundary = true;
      }
    }
    corrections.push({ commandId: input.commandId, targets, reason: input.reason, actor: actor.code, at: now.toISOString() });
  } else if (input.operation === "undo") {
    if (actor.role !== "admin" || !input.reason?.trim()) throw new AttendanceCommandError(403, "ADMIN_REASON_REQUIRED", "An administrator and undo reason are required.");
    const target = input.targetCommandId || before.effectiveEvents.at(-1)?.commandId;
    const eligible = before.effectiveEvents.filter((event) => event.commandId === target);
    if (!eligible.length) throw new AttendanceCommandError(409, "ALREADY_REVERSED", "This action has already been reversed or is not eligible.");
    targets.push(...eligible.map((event) => event.id));
    if (ledger.audit.some((audit) => audit.commandId === target && audit.operation !== "action") || before.sessions.some((session) => session.lifecycle === "system-closed" && session.events.some((event) => targets.includes(event.id)))) {
      throw new AttendanceCommandError(409, "REVIEWED_CORRECTION_REQUIRED", "Administrative corrections and system-closed sessions require a reviewed HR correction.");
    }
    if (eligible.some((event) => event.source === "Time Out" || event.source === "Logout")) {
      const session = before.sessions.find((item) => item.events.some((event) => targets.includes(event.id)));
      if (!session || before.sessions.at(-1)?.id !== session.id || (session.shift && now >= new Date(session.shift.resetDeadline))) {
        throw new AttendanceCommandError(409, "HISTORICAL_CORRECTION_REQUIRED", "This checkout cannot reopen an old session. Use a reviewed HR correction.");
      }
    }
    corrections.push({ commandId: input.commandId, targets, reason: input.reason, actor: actor.code, at: now.toISOString() });
  } else if (input.operation === "recover") {
    if (actor.role !== "system") throw new AttendanceCommandError(403, "SYSTEM_ONLY", "Recovery is a system operation.");
    const active = before.active;
    if (!active || active.id !== input.sessionId || !active.shift || active.shift.ambiguous || now < new Date(active.shift.resetDeadline) ||
      attendanceAutoTimeOutEnabled() || !(policy.recoveryEnabled || attendanceRecoveryEnvironmentEnabled())) throw new AttendanceCommandError(409, "RECOVERY_NOT_DUE", "This session is not eligible for recovery.");
    closures.push({ id: crypto.randomUUID(), sessionId: active.id, effectiveAt: active.shift.resetDeadline, processedAt: now.toISOString(), commandId: input.commandId });
  } else if (input.operation === "auto-time-out") {
    if (actor.role !== "system") throw new AttendanceCommandError(403, "SYSTEM_ONLY", "Automatic time-out is a system operation.");
    const active = before.active;
    const cutoff = attendanceAutoTimeOutCutoff(active, policy.autoTimeOutTime);
    if (!attendanceIntegrityEnabled() || !attendanceAutoTimeOutEnabled() || before.blockingIssues.length || !active || active.id !== input.sessionId ||
        !cutoff || now < cutoff || now < new Date(active.shift!.end)) {
      throw new AttendanceCommandError(409, "AUTO_TIME_OUT_NOT_DUE", "This session is not eligible for automatic time-out.");
    }
    if (input.commandId !== autoTimeOutCommandId(active.id)) throw new AttendanceCommandError(422, "INVALID_AUTO_TIME_OUT_ID", "Automatic time-out requires its stable session command ID.");
    const at = cutoff.toISOString();
    const returnSource = active.mode === "BREAK" ? "Break In" : active.mode === "LUNCH" ? "Lunch Break In" : active.mode === "OFF THE PHONE" ? "Off the Phone In" : null;
    if (returnSource) append(returnSource, at).autoTimeOut = true;
    append("Time Out", at).autoTimeOut = true;
  } else if (input.operation === "recalculate-policy") {
    if (actor.role !== "system") throw new AttendanceCommandError(403, "SYSTEM_ONLY", "Policy recalculation is a system operation.");
    if (!attendanceIntegrityEnabled() || !attendanceDurationModelEnabled() || input.policyRevision !== policy.revision || !ledger.derived?.length ||
      !ledger.derived.some((day) => day.policyRevision !== policy.revision)) throw new AttendanceCommandError(409, "POLICY_REFRESH_NOT_DUE", "This attendance policy revision is not pending.");
    if (input.commandId !== attendancePolicyRefreshCommandId(policy.revision) || input.source || input.changes || input.sessionId || input.targetCommandId || input.dayKey) {
      throw new AttendanceCommandError(422, "INVALID_POLICY_REFRESH", "Policy recalculation cannot change attendance events.");
    }
    targets.push(...before.effectiveEvents.map((event) => event.id));
  } else if (input.operation === "recalculate") {
    if (actor.role !== "system") throw new AttendanceCommandError(403, "SYSTEM_ONLY", "Derived attendance refresh is a system operation.");
    const day = attendanceDerivedDaysDueForRefresh(ledger, now).find((item) => item.dayKey === input.dayKey);
    if (!attendanceIntegrityEnabled() || !attendanceDurationModelEnabled() || !day) {
      throw new AttendanceCommandError(409, "DERIVED_REFRESH_NOT_DUE", "This closed attendance day is not due for derived refresh.");
    }
    if (input.commandId !== attendanceDerivedRefreshCommandId(day.dayKey, day.shiftEnd)) {
      throw new AttendanceCommandError(422, "INVALID_DERIVED_REFRESH_ID", "Derived refresh requires its stable shift-day command ID.");
    }
    if (input.source || input.changes || input.sessionId || input.targetCommandId) {
      throw new AttendanceCommandError(422, "INVALID_DERIVED_REFRESH", "Derived refresh cannot change attendance events.");
    }
    targets.push(...day.eventIds);
  }
  if (input.operation === "confirm-note") {
    const reference = input.noteReference;
    if (actor.role !== "admin") throw new AttendanceCommandError(403, "ADMIN_ONLY", "Only administrators can confirm attendance notes.");
    if (!attendanceIntegrityEnabled() || !attendanceDurationModelEnabled() || !reference || reference.dayKey !== input.dayKey ||
        !/^\d{4}-\d{2}-\d{2}$/.test(reference.dayKey) || !ledger.businessIds.includes(reference.businessId) ||
        !Number.isInteger(reference.noteRevision) || reference.noteRevision < 1 || !/^[a-f0-9]{64}$/.test(reference.contentHash) ||
        input.source || input.changes || input.sessionId || input.targetCommandId) {
      throw new AttendanceCommandError(422, "INVALID_NOTE_CONFIRMATION", "Provide a scoped attendance note confirmation without event changes.");
    }
    targets.push(...before.sessions.filter((session) => session.shift?.dayKey === reference.dayKey).flatMap((session) => session.events.map((event) => event.id)));
  }
  const after = projectAttendance(events, corrections, closures);
  if (after.blockingIssues.length) {
    if (input.operation === "action") throw new AttendanceCommandError(409, "ATTENDANCE_ACTION_CONFLICT", after.blockingIssues[0].message, after.blockingIssues);
    throw new AttendanceCommandError(422, "INVALID_TIMELINE", "The resulting timeline is invalid. Correct the affected paired or later events together.", after.blockingIssues);
  }
  if (events.length > 10_000 || ledger.commands.length > 10_000) throw new AttendanceCommandError(409, "LEDGER_CAPACITY", "Attendance history requires an administrator archive plan before further changes.");
  return { events, corrections, closures, before, after, targets };
}

export async function previewAttendanceCommand(identity: AttendanceIdentity, input: AttendanceCommand, actor: AttendanceActor, now = new Date()) {
  const ledger = await readAttendanceLedger(identity);
  if (ledger.revision !== input.expectedRevision) throw new AttendanceCommandError(409, "STALE_REVISION", "Attendance changed. Refresh the correction preview.");
  const policy = await attendancePolicy(identity.canonicalBusinessId);
  const plan = applyAttendanceCommand(ledger, input, actor, policy, now);
  const next = { ...ledger, events: plan.events, corrections: plan.corrections, closures: plan.closures };
  if (attendanceDurationModelEnabled()) next.derived = deriveAttendanceDays(next, policy, now);
  return { revision: ledger.revision, employeeCode: identity.code, businessIds: identity.businessIds, targets: plan.targets,
    before: attendanceSnapshot(ledger, now, policy), after: attendanceSnapshot(next, now, policy),
    payrollImpact: "Pending payroll will be recalculated; finalized payroll remains finalized.", allowed: true };
}

export type AttendanceCommandTransaction = {
  session?: ClientSession;
  beforeCommit?: (context: { ledger: AttendanceLedgerDocument; next: AttendanceLedgerDocument; policy: Awaited<ReturnType<typeof attendancePolicy>> }) => Promise<void>;
};
export async function executeAttendanceCommand(identity: AttendanceIdentity, input: AttendanceCommand, actor: AttendanceActor, now = new Date(), options: AttendanceCommandTransaction = {}) {
  if (input.operation === "confirm-note") {
    if (actor.role !== "admin") throw new AttendanceCommandError(403, "ADMIN_ONLY", "Only administrators can confirm attendance notes.");
    if (!options.session?.inTransaction() || !options.beforeCommit) throw new AttendanceCommandError(503, "NOTE_TRANSACTION_REQUIRED", "Attendance notes require an atomic server transaction.");
  }
  if (["auto-time-out", "recalculate", "recalculate-policy"].includes(input.operation) && actor.role !== "system") throw new AttendanceCommandError(403, "SYSTEM_ONLY", "This attendance operation is system-only.");
  if (!uuid.test(input.commandId) || !Number.isInteger(input.expectedRevision) || input.expectedRevision < 0) throw new AttendanceCommandError(426, "ATTENDANCE_REFRESH_REQUIRED", "Refresh CRM to use the current attendance controls.");
  const request = { ...input, fingerprint: undefined, ...(["auto-time-out", "recalculate", "recalculate-policy"].includes(input.operation) ? { expectedRevision: undefined } : {}) };
  const requestHash = hash(["recalculate", "recalculate-policy", "confirm-note"].includes(input.operation) ? Object.fromEntries(Object.entries(request).sort(([a], [b]) => a.localeCompare(b))) : request);
  let ledger = await readAttendanceLedger(identity, options.session);
  if (ledger.migrationRequired) throw new AttendanceCommandError(409, "MIGRATION_REVIEW_REQUIRED", "Legacy attendance needs a reviewed adoption plan and database backup before enabling writes. No attendance was changed.");
  const replay = ledger.commands.find((command) => command.id === input.commandId);
  if (replay) {
    if (replay.hash !== requestHash || replay.actor !== `${actor.role}:${actor.code}`) throw new AttendanceCommandError(409, "IDEMPOTENCY_CONFLICT", "This command ID belongs to a different request.");
    return { ...replaySnapshot(ledger, replay.revision, String(replay.result.serverTime)), replayed: true };
  }
  const due = projectAttendance(ledger.events, ledger.corrections, ledger.closures).active;
  const currentPolicy = await attendancePolicy(identity.canonicalBusinessId, options.session);
  guardAttendanceActionCutoff(input, due, currentPolicy, now);
  if (!attendanceAutoTimeOutEnabled() && input.operation === "action" && due?.shift && !due.shift.ambiguous && now >= new Date(due.shift.resetDeadline) &&
      (currentPolicy.recoveryEnabled || attendanceRecoveryEnvironmentEnabled())) {
    await executeAttendanceCommand(identity, { commandId: recoveryCommandId(due.id), expectedRevision: ledger.revision,
      operation: "recover", sessionId: due.id, reason: "Configured administrative missing-checkout recovery" }, { role: "system", code: "attendance-recovery" }, now);
    throw new AttendanceCommandError(409, "RECOVERY_COMPLETED", "The previous session was administratively closed without a checkout. Refresh before starting a new session.");
  }
  if (ledger.revision !== input.expectedRevision || (ledger.revision === 0 && input.fingerprint && input.fingerprint !== hash(ledger.events))) throw new AttendanceCommandError(409, "STALE_REVISION", "Attendance changed. Your draft is retained; refresh and review it before saving.");
  const seed = { _id: ledger._id, employeeCode: ledger.employeeCode, businessIds: ledger.businessIds,
    canonicalBusinessId: ledger.canonicalBusinessId, revision: ledger.revision, fence: ledger.fence,
    events: ledger.events, corrections: ledger.corrections, closures: ledger.closures, audit: ledger.audit, commands: ledger.commands, jobs: ledger.jobs };
  try { if (input.operation !== "recalculate") await AttendanceLedger.updateOne({ _id: identity.key }, { $setOnInsert: seed }, { upsert: true, ...(options.session ? { session: options.session } : {}) }); }
  catch (error) { if ((error as { code?: number }).code !== 11000) throw error; }
  const token = crypto.randomUUID();
  const locked = await acquireAttendanceLease(identity.key, token, now, options.session);
  if (!locked) throw new AttendanceCommandError(409, "ATTENDANCE_BUSY", "Another attendance command is saving. Retry this command shortly.");
  const renewal = options.session ? undefined : setInterval(() => { void AttendanceLedger.updateOne({ _id: identity.key, lockToken: token, fence: locked.fence },
    { $set: { lockUntil: new Date(Date.now() + 30_000) } }).catch(() => undefined); }, 10_000);
  renewal?.unref();
  try {
    ledger = locked;
    const duplicate = ledger.commands.find((command) => command.id === input.commandId);
    if (duplicate) {
      if (duplicate.hash !== requestHash || duplicate.actor !== `${actor.role}:${actor.code}`) throw new AttendanceCommandError(409, "IDEMPOTENCY_CONFLICT", "Command ID conflict.");
      return { ...replaySnapshot(ledger, duplicate.revision, String(duplicate.result.serverTime)), replayed: true };
    }
    if (ledger.revision !== input.expectedRevision) throw new AttendanceCommandError(409, "STALE_REVISION", "Attendance changed. Refresh and review your retained draft.");
    const policy = await attendancePolicy(identity.canonicalBusinessId, options.session);
    const active = projectAttendance(ledger.events, ledger.corrections, ledger.closures).active;
    if (!attendanceAutoTimeOutEnabled() && input.operation === "action" && active?.shift && !active.shift.ambiguous && now >= new Date(active.shift.resetDeadline) && (policy.recoveryEnabled || attendanceRecoveryEnvironmentEnabled())) {
      throw new AttendanceCommandError(409, "RECOVERY_PENDING", "The previous shift is due for administrative recovery. Refresh after recovery completes.");
    }
    const plan = applyAttendanceCommand(ledger, input, actor, policy, now);
    const revision = ledger.revision + 1;
    const next = { ...ledger, events: plan.events, corrections: plan.corrections, closures: plan.closures, revision,
      jobs: [...ledger.jobs, ...identity.businessIds.map((businessId) => ({ businessId, revision, done: false,
        ...(attendanceAccuracyFixesEnabled() ? { createdAt: now.toISOString() } : {}) }))] };
    let derivedDelta: AttendanceDerivedAuditDelta | undefined;
    if (attendanceDurationModelEnabled()) {
      const beforeDerived = ledger.derived ?? deriveAttendanceDays(ledger, policy, now);
      const previous = new Map(beforeDerived.map((day) => [day.dayKey, day]));
      const calculated = deriveAttendanceDays(next, policy, now);
      next.derived = input.operation === "recalculate-policy" ? calculated.filter((day) => previous.has(day.dayKey))
        .map(day => attendanceAccuracyFixesEnabled() && previous.get(day.dayKey)?.accuracyVersion !== 1 ? previous.get(day.dayKey)! : day) : input.operation === "recalculate"
        ? beforeDerived.map((day) => day.dayKey === input.dayKey ? calculated.find((item) => item.dayKey === day.dayKey)! : day)
        : calculated.map((day) => {
          const old = previous.get(day.dayKey);
          const confirmedNoteDay = input.operation === "confirm-note" && input.noteReference?.dayKey === day.dayKey;
          if (attendanceAccuracyFixesEnabled() && !confirmedNoteDay && old && !old.hasOpenSession && !day.hasOpenSession &&
            JSON.stringify(old.eventIds) === JSON.stringify(day.eventIds) &&
            (old.accuracyVersion !== 1 || old.policyRevision === day.policyRevision)) return old;
          return old && old.policyRevision === day.policyRevision && sameAttendanceDerivedValues(old, day) ? old : day;
        });
      derivedDelta = attendanceDerivedAuditDelta(beforeDerived, next.derived);
      const changed = new Set(derivedDelta.afterDerived.map((day) => day.dayKey));
      const metadata = next.derived.filter((day) => !changed.has(day.dayKey) && previous.get(day.dayKey)?.policyRevision !== day.policyRevision)
        .map(({ dayKey, computedAt, revision, policyRevision }) => ({ dayKey, computedAt, revision, policyRevision }));
      if (metadata.length) derivedDelta.derivedMetadata = metadata;
      if (input.operation === "recalculate" && !derivedDelta.afterDerived.some((day) => day.dayKey === input.dayKey)) {
        const day = next.derived.find((item) => item.dayKey === input.dayKey)!;
        derivedDelta.derivedMetadata = [{ dayKey: day.dayKey, computedAt: day.computedAt, revision: day.revision, policyRevision: day.policyRevision }];
      }
      next.derivedBaseline = ledger.derivedBaseline ?? { revision: ledger.revision, days: beforeDerived };
    }
    const result = attendanceSnapshot(next, now, policy);
    const audit = { commandId: input.commandId, actor, reason: input.operation === "confirm-note" ? "Business-local attendance note confirmed" : input.reason || "Manual attendance button", operation: input.operation,
      at: now.toISOString(), beforeRevision: ledger.revision, afterRevision: revision, targetIds: plan.targets,
      beforeState: plan.before.active?.mode || "OFFLINE", afterState: plan.after.active?.mode || "OFFLINE",
      ...(derivedDelta || {}), ...(input.operation === "confirm-note" ? { noteReference: input.noteReference } : {}) };
    await options.beforeCommit?.({ ledger, next, policy });
    const committed = await commitAttendanceRevision(identity.key, token, ledger.fence, ledger.revision, {
      $set: { ...(["recalculate", "recalculate-policy", "confirm-note"].includes(input.operation) ? {} : { events: plan.events, corrections: plan.corrections, closures: plan.closures }),
        revision, jobs: next.jobs, businessIds: identity.businessIds,
        ...(attendanceAccuracyFixesEnabled() ? { maintenance: attendanceMaintenanceState(plan.after, next.derived) } : {}),
        ...(derivedDelta ? { derived: next.derived, ...(!ledger.derivedBaseline ? { derivedBaseline: next.derivedBaseline } : {}) } : {}) },
      $push: { audit, commands: { id: input.commandId, actor: `${actor.role}:${actor.code}`, hash: requestHash, revision,
        result: { serverTime: result.serverTime, state: result.state, sessionId: result.sessionId } } },
    }, now, options.session);
    if (!committed) throw new AttendanceCommandError(409, "LEASE_OR_REVISION_LOST", "The attendance lock or revision changed. Your command was not committed.");
    return attendanceSnapshot(committed, now, policy);
  } finally {
    if (renewal) clearInterval(renewal);
    await AttendanceLedger.updateOne({ _id: identity.key, lockToken: token, fence: locked.fence },
      { $unset: { lockToken: "", lockUntil: "" } }, options.session ? { session: options.session } : undefined).catch(() => undefined);
  }
}
