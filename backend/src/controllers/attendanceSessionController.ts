import type { Request, Response } from "express";
import { Types } from "mongoose";
import { verifyAdminDashboardSession } from "../config/adminDashboardSession";
import { verifyAttendanceHubSession } from "../config/attendanceHubSession";
import { attendanceActiveSessionEnabled, attendanceAutoTimeOutEnabled, attendanceDurationModelEnabled, attendanceIntegrityEnabled, attendanceRecoveryEnvironmentEnabled } from "../config/rolloutFlags";
import { AttendanceLedger, AttendancePolicy, type AttendanceActor } from "../models/AttendanceLedger";
import { Attendance } from "../models/Attendance";
import { Employee } from "../models/Employee";
import { getAttendanceBusinessIdentities } from "../models/BusinessUserAccess";
import { getCurrentBusinessId } from "../config/tenancy";
import { projectAttendance } from "../services/attendanceSessionState";
import { attendancePolicy, AttendanceCommandError, attendanceSnapshot, executeAttendanceCommand, previewAttendanceCommand,
  readAttendanceLedger, resolveAttendanceIdentity, type AttendanceCommand } from "../services/attendanceLedgerService";
import { deliverAttendanceLedger } from "../services/attendanceLedgerOutbox";
import { listEmployeeAttendance, listEmployeesAttendance } from "./attendanceController";
import { previewLegacyAttendanceMigration } from "../services/attendanceMigrationPreview";
import { withAttendanceStatuses } from "../services/attendanceSnapshotPresentation";
import { attendanceDashboardPresentation } from "../services/attendanceDashboardPresentation";
import { attendancePolicySyncPending, hasAttendancePolicyRefreshPending, runAttendancePolicyRefresh } from "../services/attendancePolicyRefreshWorker";
import { deriveAttendanceDays } from "../services/attendanceDerived";
import { readEmployeeAttendanceCalendar } from "./attendanceHubController";

export function verifiedAttendanceActor(request: Request): AttendanceActor {
  const admin = verifyAdminDashboardSession(request.header("x-crm-admin-session"));
  if (admin) return { role: "admin", code: admin.employeeCode };
  const employee = verifyAttendanceHubSession(request.header("x-crm-attendance-session"));
  if (employee) return { role: "employee", code: employee };
  throw new AttendanceCommandError(401, "ATTENDANCE_AUTH_REQUIRED", "Sign in again to use attendance.");
}
export function attendanceError(response: Response, error: unknown) {
  if (error instanceof AttendanceCommandError) response.status(error.status).json({ code: error.code, message: error.message, details: error.details });
  else response.status(503).json({ code: "ATTENDANCE_UNAVAILABLE", message: "Attendance could not be confirmed. Keep your draft and retry; status is unknown." });
}
export async function getActiveAttendanceSession(request: Request, response: Response) {
  if (!attendanceActiveSessionEnabled()) { response.status(404).json({ message: "Active session endpoint is disabled." }); return; }
  try {
    const actor = verifiedAttendanceActor(request);
    if (!Types.ObjectId.isValid(String(request.params.employeeId))) throw new AttendanceCommandError(400, "INVALID_EMPLOYEE", "Valid employee ID required.");
    const identity = await resolveAttendanceIdentity(String(request.params.employeeId), actor);
    const ledger = await readAttendanceLedger(identity);
    const policy = await attendancePolicy(identity.canonicalBusinessId);
    const policySyncPending = attendanceDurationModelEnabled() && attendancePolicySyncPending(ledger, policy.revision);
    const stored = attendanceSnapshot(ledger, new Date(), policy);
    const snapshot = withAttendanceStatuses({ ...stored, ...(policySyncPending ? { derived: deriveAttendanceDays(ledger, policy, new Date(stored.serverTime)), syncPending: true } : {}) }, policy.graceMinutes);
    response.set("Cache-Control", "no-store").json({ ...snapshot, ...attendanceDashboardPresentation(snapshot, policy, new Date(snapshot.serverTime)), ...(actor.role === "admin" ? { policy } : {}), profileCalendarEnabled: true,
      allowances: { breakMinutes: policy.breakMinutes, lunchMinutes: policy.lunchMinutes },
      autoTimeOutEnabled: attendanceIntegrityEnabled() && attendanceAutoTimeOutEnabled(), policySyncPending,
      recoveryEnabled: policy.recoveryEnabled || attendanceRecoveryEnvironmentEnabled(),
      resetDeadline: policy.recoveryEnabled || attendanceRecoveryEnvironmentEnabled() ? snapshot.assignedShift?.resetDeadline || null : null });
  } catch (error) { attendanceError(response, error); }
}
export async function getEmployeeAttendanceCalendar(request: Request, response: Response) {
  if (!attendanceActiveSessionEnabled()) { response.status(404).json({ message: "Attendance calendar is disabled." }); return; }
  try {
    const actor = verifiedAttendanceActor(request);
    if (!Types.ObjectId.isValid(String(request.params.employeeId))) throw new AttendanceCommandError(400, "INVALID_EMPLOYEE", "Valid employee ID required.");
    const identity = await resolveAttendanceIdentity(String(request.params.employeeId), actor);
    const month = typeof request.query.month === "string" ? request.query.month : "";
    response.set("Cache-Control", "no-store").json(await readEmployeeAttendanceCalendar(getCurrentBusinessId(), identity.code, month, new Date()));
  } catch (error) { attendanceError(response, error); }
}
export async function getAttendanceMigrationPreview(request: Request, response: Response) {
  try {
    const actor = verifiedAttendanceActor(request);
    if (actor.role !== "admin") throw new AttendanceCommandError(403, "ADMIN_ONLY", "Administrator access required.");
    const identity = await resolveAttendanceIdentity(String(request.params.employeeId), actor);
    response.set("Cache-Control", "no-store").json(await previewLegacyAttendanceMigration(identity));
  } catch (error) { attendanceError(response, error); }
}
export async function submitAttendanceCommand(request: Request, response: Response) {
  if (!attendanceIntegrityEnabled()) { response.status(404).json({ message: "Attendance commands are disabled." }); return; }
  try {
    const actor = verifiedAttendanceActor(request);
    const identity = await resolveAttendanceIdentity(String(request.params.employeeId), actor);
    const input = request.body as AttendanceCommand;
    if (!input || typeof input !== "object" || Array.isArray(input) || (input.reason !== undefined && typeof input.reason !== "string") ||
      (input.changes !== undefined && (!Array.isArray(input.changes) || input.changes.some((change) => !change || typeof change !== "object")))) {
      throw new AttendanceCommandError(422, "INVALID_COMMAND", "Provide a valid attendance command and reason.");
    }
    if (!["action", "correct", "undo", "add-time-out"].includes(input.operation)) throw new AttendanceCommandError(422, "INVALID_OPERATION", "Unsupported attendance command.");
    if (actor.role === "employee" && input.operation !== "action") throw new AttendanceCommandError(403, "ADMIN_ONLY", "Only administrators can correct attendance.");
    if (actor.role === "admin" && input.operation === "action") throw new AttendanceCommandError(403, "EMPLOYEE_BUTTON_ONLY", "Use a reviewed correction to change employee attendance.");
    const policy = await attendancePolicy(identity.canonicalBusinessId);
    const result = withAttendanceStatuses(await executeAttendanceCommand(identity, input, actor), policy.graceMinutes);
    // The canonical command is committed. Delivery/read failures must never turn success into a false failure.
    let syncPending = true;
    try { await deliverAttendanceLedger(identity.key); syncPending = attendanceSnapshot(await readAttendanceLedger(identity)).syncPending; } catch { /* Durable retry worker owns delivery. */ }
    response.json({ ...result, ...attendanceDashboardPresentation(result, policy, new Date(result.serverTime)),
      allowances: { breakMinutes: policy.breakMinutes, lunchMinutes: policy.lunchMinutes },
      autoTimeOutEnabled: attendanceAutoTimeOutEnabled(), syncPending });
  } catch (error) { attendanceError(response, error); }
}
export async function previewAttendanceCorrection(request: Request, response: Response) {
  if (!attendanceIntegrityEnabled()) { response.status(404).json({ message: "Attendance commands are disabled." }); return; }
  try {
    const actor = verifiedAttendanceActor(request);
    if (actor.role !== "admin") throw new AttendanceCommandError(403, "ADMIN_ONLY", "Administrator access required.");
    const identity = await resolveAttendanceIdentity(String(request.params.employeeId), actor);
    response.set("Cache-Control", "no-store").json(await previewAttendanceCommand(identity, request.body as AttendanceCommand, actor));
  } catch (error) { attendanceError(response, error); }
}
export async function getAttendancePolicy(request: Request, response: Response) {
  if (!attendanceIntegrityEnabled()) { response.status(404).json({ message: "Attendance configuration is disabled." }); return; }
  try {
    if (verifiedAttendanceActor(request).role !== "admin") throw new AttendanceCommandError(403, "ADMIN_ONLY", "Attendance configuration is restricted to administrators.");
    const policy = await attendancePolicy();
    response.set("Cache-Control", "no-store").json({ ...policy, autoTimeOutEnabled: attendanceAutoTimeOutEnabled(), policySyncPending: await hasAttendancePolicyRefreshPending(policy.revision) });
  } catch (error) { attendanceError(response, error); }
}
export function validateAttendanceAutoTimeOutTime(value: unknown, shiftEnd = "08:00") {
  if (typeof value !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) {
    throw new AttendanceCommandError(422, "INVALID_POLICY", "Automatic time-out must use HH:MM.");
  }
  if (value < shiftEnd) {
    throw new AttendanceCommandError(422, "AUTO_TIME_OUT_BEFORE_SHIFT_END", "Automatic time-out cannot be before the scheduled shift end.");
  }
}
export async function saveAttendancePolicy(request: Request, response: Response) {
  if (!attendanceIntegrityEnabled()) { response.status(404).json({ message: "Attendance configuration is disabled." }); return; }
  try {
    const actor = verifiedAttendanceActor(request);
    if (actor.role !== "admin") throw new AttendanceCommandError(403, "ADMIN_ONLY", "Administrator access required.");
    const before = await attendancePolicy();
    const body = request.body as Record<string, unknown>;
    const after = { graceMinutes: Number(body.graceMinutes), breakMinutes: Number(body.breakMinutes), lunchMinutes: Number(body.lunchMinutes),
      shiftStart: String(body.shiftStart), shiftEnd: String(body.shiftEnd), recoveryEnabled: body.recoveryEnabled === true, recoveryTime: String(body.recoveryTime),
      autoTimeOutTime: body.autoTimeOutTime === undefined ? before.autoTimeOutTime : body.autoTimeOutTime };
    if (![after.graceMinutes, after.breakMinutes, after.lunchMinutes].every((value) => Number.isInteger(value) && value >= 0 && value <= 240) ||
      ![after.shiftStart, after.shiftEnd, after.recoveryTime, after.autoTimeOutTime].every((value) => typeof value === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(value))) throw new AttendanceCommandError(422, "INVALID_POLICY", "Check the attendance thresholds and times.");
    if (after.breakMinutes < 1 || after.lunchMinutes < 1) throw new AttendanceCommandError(422, "INVALID_POLICY", "Break and lunch allowances must be at least one minute.");
    if (Number(body.expectedRevision) !== before.revision) throw new AttendanceCommandError(409, "STALE_REVISION", "Configuration changed. Refresh it before saving.");
    if (after.shiftStart !== "23:00" || after.shiftEnd !== "08:00") throw new AttendanceCommandError(422, "OFFICIAL_SHIFT_FIXED", "The official schedule remains 23:00 to 08:00 Asia/Manila.");
    validateAttendanceAutoTimeOutTime(after.autoTimeOutTime, after.shiftEnd);
    try {
      const saved = await AttendancePolicy.updateOne({ _id: "global-attendance", revision: before.revision },
        { $set: { ...after, revision: before.revision + 1 }, $push: { audit: { actor: actor.code, at: new Date().toISOString(), before: {
          revision: before.revision, graceMinutes: before.graceMinutes, breakMinutes: before.breakMinutes, lunchMinutes: before.lunchMinutes,
          shiftStart: before.shiftStart, shiftEnd: before.shiftEnd, recoveryEnabled: before.recoveryEnabled, recoveryTime: before.recoveryTime,
          autoTimeOutTime: before.autoTimeOutTime }, after } } }, { upsert: before.revision === 0 });
      if (!saved.modifiedCount && !saved.upsertedCount) throw new AttendanceCommandError(409, "STALE_REVISION", "Configuration changed.");
    } catch (error) { if ((error as { code?: number }).code === 11000) throw new AttendanceCommandError(409, "STALE_REVISION", "Configuration changed."); throw error; }
    let policySyncPending = false;
    if (attendanceDurationModelEnabled()) {
      try { const result = await runAttendancePolicyRefresh(); policySyncPending = Boolean(result.failed || result.deliveryPending); }
      catch { policySyncPending = true; /* The durable policy revision is retried by the worker. */ }
    }
    response.json({ _id: "global-attendance", ...after, revision: before.revision + 1, autoTimeOutEnabled: attendanceAutoTimeOutEnabled(), policySyncPending });
  } catch (error) { attendanceError(response, error); }
}

export async function getAttendanceHistory(request: Request, response: Response) {
  try {
    const actor = verifiedAttendanceActor(request);
    const identity = await resolveAttendanceIdentity(String(request.params.employeeId), actor);
    if (!attendanceIntegrityEnabled()) { await listEmployeeAttendance(request, response); return; }
    const policy = await attendancePolicy(identity.canonicalBusinessId);
    const snapshot = withAttendanceStatuses(attendanceSnapshot(await readAttendanceLedger(identity)), policy.graceMinutes);
    let records = snapshot.records.map((event) => ({ _id: event.id, employee: identity.employeeId, source: event.source,
      timeIn: event.at, createdAt: event.recordedAt, eventId: event.id, sequence: event.sequence, attendanceStatus: event.attendanceStatus,
      ...(event.shiftDayKey ? { shiftDayKey: event.shiftDayKey } : {}),
      ...(event.autoTimeOut ? { autoTimeOut: true } : {}) } )).reverse();
    if (request.query.from) records = records.filter((event) => event.timeIn >= String(request.query.from));
    if (request.query.to) records = records.filter((event) => event.timeIn <= String(request.query.to));
    const limit = Math.min(1000, Math.max(1, Number(request.query.limit) || 300));
    response.set("Cache-Control", "no-store").json(request.query.all === "true" ? records : records.slice(0, limit));
  } catch (error) { attendanceError(response, error); }
}
export async function getScopedAttendanceList(request: Request, response: Response) {
  try {
    if (verifiedAttendanceActor(request).role !== "admin") throw new AttendanceCommandError(403, "ADMIN_ONLY", "Administrator access required.");
    if (!attendanceIntegrityEnabled()) { await listEmployeesAttendance(request, response); return; }
    const ids = String(request.query.employeeIds || "").split(",").filter((id) => Types.ObjectId.isValid(id)).slice(0, 200);
    const employees = await Employee.find({ _id: { $in: ids }, status: { $ne: "Archived" } }).select("_id employeeCode").lean();
    const identities = await getAttendanceBusinessIdentities(employees.map((employee) => employee.employeeCode));
    const businessId = getCurrentBusinessId();
    const scopes = employees.map((employee) => {
      const mapping = identities.get(employee.employeeCode);
      return { employee, key: mapping ? `access:${mapping.id}` : `tenant:${businessId}:${employee._id}`, authorized: !mapping || mapping.businessIds.includes(businessId) };
    }).filter((scope) => scope.authorized);
    const ledgers = await AttendanceLedger.find({ _id: { $in: scopes.map((scope) => scope.key) } }).lean();
    const fallbackIds = scopes.filter((scope) => !ledgers.some((ledger) => ledger._id === scope.key)).map((scope) => scope.employee._id);
    const records: Array<Record<string, unknown> & { timeIn: string }> = (await Attendance.find({ employee: { $in: fallbackIds }, isArchived: { $ne: true } }).lean())
      .map((event) => ({ ...event, timeIn: event.timeIn.toISOString() }));
    const policies = new Map<string, Awaited<ReturnType<typeof attendancePolicy>>>();
    for (const scope of scopes) {
      const ledger = ledgers.find((item) => item._id === scope.key);
      if (!ledger) continue;
      let policy = policies.get(ledger.canonicalBusinessId);
      if (!policy) { policy = await attendancePolicy(ledger.canonicalBusinessId); policies.set(ledger.canonicalBusinessId, policy); }
      const projection = projectAttendance(ledger.events, ledger.corrections, ledger.closures);
      records.push(...withAttendanceStatuses({ records: projection.effectiveEvents, sessions: projection.sessions }, policy.graceMinutes).records.map((event) => ({ _id: event.id, employee: String(scope.employee._id), eventId: event.id, source: event.source, timeIn: event.at, createdAt: event.recordedAt, attendanceStatus: event.attendanceStatus,
        sequence: event.sequence, ...(event.shiftDayKey ? { shiftDayKey: event.shiftDayKey } : {}),
        ...(event.autoTimeOut ? { autoTimeOut: true } : {}) })));
    }
    const from = request.query.from ? new Date(String(request.query.from)) : request.query.all === "true" ? null : new Date(Date.now() - 72 * 3_600_000);
    const to = request.query.to ? new Date(String(request.query.to)) : null;
    if ((from && !Number.isFinite(from.getTime())) || (to && !Number.isFinite(to.getTime())) || (from && to && from > to)) throw new AttendanceCommandError(400, "INVALID_RANGE", "Check the attendance date range.");
    response.set("Cache-Control", "no-store").json(records.filter((record) => (!from || Date.parse(record.timeIn) >= from.getTime()) && (!to || Date.parse(record.timeIn) <= to.getTime())).sort((a, b) => b.timeIn.localeCompare(a.timeIn)));
  } catch (error) { attendanceError(response, error); }
}

export function requireCurrentAttendanceClient(request: Request, response: Response, next: () => void) {
  if (attendanceIntegrityEnabled()) {
    response.status(426).json({ code: "ATTENDANCE_REFRESH_REQUIRED", message: "Refresh CRM. Attendance changes now require one revision-checked command." }); return;
  }
  void (async () => {
    try {
      const actor = verifiedAttendanceActor(request);
      await resolveAttendanceIdentity(String(request.params.employeeId), actor);
      const source = request.body?.source;
      if (actor.role !== "admin" && (request.method !== "POST" || (!request.path.endsWith("/activity") && !/\/(time-in|time-out|break-in|break-out|lunch-break-in|lunch-break-out)$/.test(request.path)) || source)) {
        throw new AttendanceCommandError(403, "ADMIN_ONLY", "Administrator access is required for attendance corrections.");
      }
      next();
    } catch (error) { attendanceError(response, error); }
  })();
}
