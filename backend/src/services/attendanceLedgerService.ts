import crypto from "node:crypto";
import { AttendanceLedger, AttendancePolicy, type AttendanceActor, type AttendanceLedgerDocument } from "../models/AttendanceLedger";
import { Attendance } from "../models/Attendance";
import { Employee } from "../models/Employee";
import { getAttendanceBusinessIdentity } from "../models/BusinessUserAccess";
import { getBusinessById, getCurrentBusinessId, runWithBusiness } from "../config/tenancy";
import { SystemSettings } from "../models/SystemSettings";
import { attendanceRecoveryEnvironmentEnabled } from "../config/rolloutFlags";
import { assignAttendanceShift } from "./attendanceShift";
import { projectAttendance, sessionTime, type SessionEvent } from "./attendanceSessionState";

export class AttendanceCommandError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: unknown) { super(message); }
}
export type AttendanceIdentity = { key: string; code: string; businessIds: string[]; canonicalBusinessId: string; employeeId: string };
export type AttendanceCommand = { commandId: string; expectedRevision: number; fingerprint?: string; operation: "action" | "correct" | "undo" | "recover";
  source?: SessionEvent["source"]; changes?: Array<{ targetId?: string; source?: SessionEvent["source"]; at?: string; remove?: boolean }>;
  sessionId?: string; targetCommandId?: string; reason?: string; previewRevision?: number };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const supportedSources = new Set(["Login", "Logout", "Time In", "Time Out", "Break Out", "Break In", "Lunch Break Out", "Lunch Break In", "Off the Phone Out", "Off the Phone In"]);
const hash = (value: unknown) => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
export function recoveryCommandId(sessionId: string) {
  const hex = hash(`attendance-recovery:${sessionId}`);
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
export async function attendancePolicy(businessId = getCurrentBusinessId()) {
  const stored = await AttendancePolicy.findById("global-attendance").lean();
  if (stored) return stored;
  const settings = await runWithBusiness(businessId, () => SystemSettings.findOne({ key: "system" }).lean());
  return { _id: "global-attendance", revision: 0, graceMinutes: settings?.lateGraceMinutes || 0, breakMinutes: 15, lunchMinutes: 60,
    shiftStart: settings?.officialShiftStartTime || "23:00", shiftEnd: settings?.officialShiftEndTime || "08:00",
    recoveryEnabled: false, recoveryTime: "22:59", audit: [] };
}
export async function readAttendanceLedger(identity: AttendanceIdentity) {
  const ledger = await AttendanceLedger.findById(identity.key).lean();
  if (ledger) return ledger;
  const policy = await attendancePolicy(identity.canonicalBusinessId);
  const events = await runWithBusiness(identity.canonicalBusinessId, async () => {
    const employee = await Employee.findOne({ employeeCode: identity.code }).select("_id").lean();
    if (!employee) throw new AttendanceCommandError(503, "CANONICAL_UNAVAILABLE", "The authoritative employee record is unavailable. Attendance status is unknown.");
    const records = await Attendance.find({ employee: employee._id, isArchived: { $ne: true } }).sort({ timeIn: 1, _id: 1 }).lean();
    return records.map((record, index): SessionEvent => ({ id: record.eventId || `legacy:${identity.canonicalBusinessId}:${record._id}`,
      source: record.source, at: record.timeIn.toISOString(), sequence: index, commandId: record.eventId || `legacy:${record._id}`,
      recordedAt: record.timeIn.toISOString(), origin: { businessId: identity.canonicalBusinessId, recordId: String(record._id) },
      ...(["Time In", "Login"].includes(record.source) ? { shift: assignAttendanceShift(record.timeIn, policy.shiftStart, policy.shiftEnd, policy.recoveryTime) } : {}) }));
  });
  let secondaryHistory = false;
  for (const businessId of identity.businessIds.filter((id) => id !== identity.canonicalBusinessId)) {
    secondaryHistory ||= await runWithBusiness(businessId, async () => {
      const employee = await Employee.findOne({ employeeCode: identity.code }).select("_id").lean();
      return Boolean(employee && await Attendance.exists({ employee: employee._id, isArchived: { $ne: true } }));
    });
  }
  if (!events.length && secondaryHistory) throw new AttendanceCommandError(503, "CANONICAL_HISTORY_MISSING", "Another business has attendance but the authoritative history is missing. Status is unknown; an administrator must review the mismatch.");
  return { _id: identity.key, employeeCode: identity.code, businessIds: identity.businessIds, canonicalBusinessId: identity.canonicalBusinessId,
    revision: 0, fence: 0, events, corrections: [], closures: [], audit: [], commands: [], jobs: [], migrationRequired: events.length > 0 || secondaryHistory } as AttendanceLedgerDocument;
}
export function attendanceSnapshot(ledger: AttendanceLedgerDocument, now = new Date()) {
  const projection = projectAttendance(ledger.events, ledger.corrections, ledger.closures);
  const session = projection.active;
  const last = projection.sessions.at(-1);
  const review = [...projection.issues.map((issue) => issue.message), ...projection.sessions.filter((item) => item.lifecycle === "system-closed").map(() => "Administrative missing-checkout closure requires review.")];
  if (ledger.legacyAdoption?.businessStreamsDiffer) review.push("Historical business copies differed. Their original evidence was backed up and retained during reviewed adoption.");
  if (ledger.migrationRequired) review.push("Legacy history is readable, but adoption requires a reviewed migration and backup. No historical records were changed.");
  if (session?.shift?.ambiguous) review.push("Early clock-in assignment needs review. Automatic recovery is disabled for this ambiguous shift.");
  return { sessionId: session?.id || null, revision: ledger.revision, fingerprint: hash(ledger.events),
    state: session?.mode || "OFFLINE", stateSince: session?.modeSince || last?.modeSince || null,
    lifecycle: session?.lifecycle || last?.lifecycle || "none", assignedShift: session?.shift || null,
    openIntervals: session && session.mode !== "ONLINE" ? [{ mode: session.mode, startedAt: session.modeSince }] : [],
    reviewState: ledger.migrationRequired ? "migration-review" : projection.blockingIssues.length ? "needs-correction" : "verified", review,
    historyReviewRequired: projection.issues.some((issue) => issue.historical) || Boolean(ledger.legacyAdoption?.businessStreamsDiffer), serverTime: now.toISOString(),
    sessions: projection.sessions.map((item) => ({ ...item, time: sessionTime(item, now) })), records: projection.effectiveEvents, audit: ledger.audit,
    time: session ? sessionTime(session, now) : null, syncPending: ledger.jobs.some((job) => !job.done),
    systemClosure: last?.closure || null };
}

function replaySnapshot(ledger: AttendanceLedgerDocument, revision: number, serverTime: string) {
  const all = new Set(ledger.commands.map((command) => command.id));
  const included = new Set(ledger.commands.filter((command) => command.revision <= revision).map((command) => command.id));
  const visible = (commandId: string) => !all.has(commandId) || included.has(commandId);
  return attendanceSnapshot({ ...ledger, revision, events: ledger.events.filter((event) => visible(event.commandId)),
    corrections: ledger.corrections.filter((correction) => visible(correction.commandId)), closures: ledger.closures.filter((closure) => visible(closure.commandId)),
    audit: ledger.audit.filter((audit) => audit.afterRevision <= revision) }, new Date(serverTime));
}

export async function acquireAttendanceLease(id: string, token: string, now = new Date()) {
  return AttendanceLedger.findOneAndUpdate({ _id: id, $or: [{ lockUntil: { $lte: now } }, { lockUntil: { $exists: false } }] },
    { $set: { lockToken: token, lockUntil: new Date(now.getTime() + 30_000) }, $inc: { fence: 1 } }, { returnDocument: "after" }).lean();
}
export async function commitAttendanceRevision(id: string, token: string, fence: number, revision: number,
  update: Record<string, unknown>, now = new Date()) {
  return AttendanceLedger.findOneAndUpdate({ _id: id, revision, lockToken: token, fence, lockUntil: { $gt: now } }, update,
    { returnDocument: "after", runValidators: true }).lean();
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
      !(policy.recoveryEnabled || attendanceRecoveryEnvironmentEnabled())) throw new AttendanceCommandError(409, "RECOVERY_NOT_DUE", "This session is not eligible for recovery.");
    closures.push({ id: crypto.randomUUID(), sessionId: active.id, effectiveAt: active.shift.resetDeadline, processedAt: now.toISOString(), commandId: input.commandId });
  }
  const after = projectAttendance(events, corrections, closures);
  if (after.blockingIssues.length) throw new AttendanceCommandError(422, "INVALID_TIMELINE", "The resulting timeline is invalid. Correct the affected paired or later events together.", after.blockingIssues);
  if (events.length > 10_000 || ledger.commands.length > 10_000) throw new AttendanceCommandError(409, "LEDGER_CAPACITY", "Attendance history requires an administrator archive plan before further changes.");
  return { events, corrections, closures, before, after, targets };
}

export async function previewAttendanceCommand(identity: AttendanceIdentity, input: AttendanceCommand, actor: AttendanceActor, now = new Date()) {
  const ledger = await readAttendanceLedger(identity);
  if (ledger.revision !== input.expectedRevision) throw new AttendanceCommandError(409, "STALE_REVISION", "Attendance changed. Refresh the correction preview.");
  const plan = applyAttendanceCommand(ledger, input, actor, await attendancePolicy(identity.canonicalBusinessId), now);
  return { revision: ledger.revision, employeeCode: identity.code, businessIds: identity.businessIds, targets: plan.targets,
    before: attendanceSnapshot(ledger, now), after: attendanceSnapshot({ ...ledger, events: plan.events, corrections: plan.corrections, closures: plan.closures }, now),
    payrollImpact: "Pending payroll will be recalculated; finalized payroll remains finalized.", allowed: true };
}

export async function executeAttendanceCommand(identity: AttendanceIdentity, input: AttendanceCommand, actor: AttendanceActor, now = new Date()) {
  if (!uuid.test(input.commandId) || !Number.isInteger(input.expectedRevision) || input.expectedRevision < 0) throw new AttendanceCommandError(426, "ATTENDANCE_REFRESH_REQUIRED", "Refresh CRM to use the current attendance controls.");
  const requestHash = hash({ ...input, fingerprint: undefined });
  let ledger = await readAttendanceLedger(identity);
  if (ledger.migrationRequired) throw new AttendanceCommandError(409, "MIGRATION_REVIEW_REQUIRED", "Legacy attendance needs a reviewed adoption plan and database backup before enabling writes. No attendance was changed.");
  const replay = ledger.commands.find((command) => command.id === input.commandId);
  if (replay) {
    if (replay.hash !== requestHash || replay.actor !== `${actor.role}:${actor.code}`) throw new AttendanceCommandError(409, "IDEMPOTENCY_CONFLICT", "This command ID belongs to a different request.");
    return { ...replaySnapshot(ledger, replay.revision, String(replay.result.serverTime)), replayed: true };
  }
  const due = projectAttendance(ledger.events, ledger.corrections, ledger.closures).active;
  const currentPolicy = await attendancePolicy(identity.canonicalBusinessId);
  if (input.operation === "action" && due?.shift && !due.shift.ambiguous && now >= new Date(due.shift.resetDeadline) &&
      (currentPolicy.recoveryEnabled || attendanceRecoveryEnvironmentEnabled())) {
    await executeAttendanceCommand(identity, { commandId: recoveryCommandId(due.id), expectedRevision: ledger.revision,
      operation: "recover", sessionId: due.id, reason: "Configured administrative missing-checkout recovery" }, { role: "system", code: "attendance-recovery" }, now);
    throw new AttendanceCommandError(409, "RECOVERY_COMPLETED", "The previous session was administratively closed without a checkout. Refresh before starting a new session.");
  }
  if (ledger.revision !== input.expectedRevision || (ledger.revision === 0 && input.fingerprint && input.fingerprint !== hash(ledger.events))) throw new AttendanceCommandError(409, "STALE_REVISION", "Attendance changed. Your draft is retained; refresh and review it before saving.");
  const seed = { _id: ledger._id, employeeCode: ledger.employeeCode, businessIds: ledger.businessIds,
    canonicalBusinessId: ledger.canonicalBusinessId, revision: ledger.revision, fence: ledger.fence,
    events: ledger.events, corrections: ledger.corrections, closures: ledger.closures, audit: ledger.audit, commands: ledger.commands, jobs: ledger.jobs };
  try { await AttendanceLedger.updateOne({ _id: identity.key }, { $setOnInsert: seed }, { upsert: true }); }
  catch (error) { if ((error as { code?: number }).code !== 11000) throw error; }
  const token = crypto.randomUUID();
  const locked = await acquireAttendanceLease(identity.key, token, now);
  if (!locked) throw new AttendanceCommandError(409, "ATTENDANCE_BUSY", "Another attendance command is saving. Retry this command shortly.");
  const renewal = setInterval(() => { void AttendanceLedger.updateOne({ _id: identity.key, lockToken: token, fence: locked.fence },
    { $set: { lockUntil: new Date(Date.now() + 30_000) } }).catch(() => undefined); }, 10_000);
  renewal.unref();
  try {
    ledger = locked;
    const duplicate = ledger.commands.find((command) => command.id === input.commandId);
    if (duplicate) {
      if (duplicate.hash !== requestHash || duplicate.actor !== `${actor.role}:${actor.code}`) throw new AttendanceCommandError(409, "IDEMPOTENCY_CONFLICT", "Command ID conflict.");
      return { ...replaySnapshot(ledger, duplicate.revision, String(duplicate.result.serverTime)), replayed: true };
    }
    if (ledger.revision !== input.expectedRevision) throw new AttendanceCommandError(409, "STALE_REVISION", "Attendance changed. Refresh and review your retained draft.");
    const policy = await attendancePolicy(identity.canonicalBusinessId);
    const active = projectAttendance(ledger.events, ledger.corrections, ledger.closures).active;
    if (input.operation === "action" && active?.shift && !active.shift.ambiguous && now >= new Date(active.shift.resetDeadline) && (policy.recoveryEnabled || attendanceRecoveryEnvironmentEnabled())) {
      throw new AttendanceCommandError(409, "RECOVERY_PENDING", "The previous shift is due for administrative recovery. Refresh after recovery completes.");
    }
    const plan = applyAttendanceCommand(ledger, input, actor, policy, now);
    const revision = ledger.revision + 1;
    const next = { ...ledger, events: plan.events, corrections: plan.corrections, closures: plan.closures, revision,
      jobs: [...ledger.jobs, ...identity.businessIds.map((businessId) => ({ businessId, revision, done: false }))] };
    const result = attendanceSnapshot(next, now);
    const audit = { commandId: input.commandId, actor, reason: input.reason || "Manual attendance button", operation: input.operation,
      at: now.toISOString(), beforeRevision: ledger.revision, afterRevision: revision, targetIds: plan.targets,
      beforeState: plan.before.active?.mode || "OFFLINE", afterState: plan.after.active?.mode || "OFFLINE" };
    const committed = await commitAttendanceRevision(identity.key, token, ledger.fence, ledger.revision, {
      $set: { events: plan.events, corrections: plan.corrections, closures: plan.closures, revision, jobs: next.jobs, businessIds: identity.businessIds },
      $push: { audit, commands: { id: input.commandId, actor: `${actor.role}:${actor.code}`, hash: requestHash, revision,
        result: { serverTime: result.serverTime, state: result.state, sessionId: result.sessionId } } },
    }, now);
    if (!committed) throw new AttendanceCommandError(409, "LEASE_OR_REVISION_LOST", "The attendance lock or revision changed. Your command was not committed.");
    return attendanceSnapshot(committed, now);
  } finally {
    clearInterval(renewal);
    await AttendanceLedger.updateOne({ _id: identity.key, lockToken: token, fence: locked.fence },
      { $unset: { lockToken: "", lockUntil: "" } }).catch(() => undefined);
  }
}
