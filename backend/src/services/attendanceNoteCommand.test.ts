import assert from "node:assert/strict";
import crypto from "node:crypto";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { after, before, beforeEach, mock, test } from "node:test";
import mongoose from "mongoose";
import { MongoMemoryReplSet } from "mongodb-memory-server";

const prefix = `synthetic_note_${crypto.randomUUID().replaceAll("-", "").slice(0, 10)}`;
process.env.NODE_ENV = "test";
process.env.BUSINESS_DATABASES = JSON.stringify(["note-a", "note-b"].map((id) => ({ id, databaseName: `${prefix}_${id.replace("-", "_")}` })));
process.env.DEFAULT_BUSINESS_ID = "note-a"; process.env.DEFAULT_BUSINESS_DATABASE = `${prefix}_note_a`;
process.env.CONTROL_DATABASE_NAME = `${prefix}_control`;
if (!process.env.CI) process.env.MONGOMS_RUNTIME_DOWNLOAD = "false";
process.env.CRM_ADMIN_ONE_CODE = "99009990";
process.env.CRM_ADMIN_SESSION_SECRET = crypto.randomBytes(48).toString("hex");
const { AttendanceLedger, AttendancePolicy } = await import("../models/AttendanceLedger");
const { AttendanceDayNote } = await import("../models/AttendanceDayNote");
const { Employee } = await import("../models/Employee");
const { Attendance } = await import("../models/Attendance");
const { runWithBusiness, getBusinessConnection } = await import("../config/tenancy");
const { setBusinessAccessForEmployeeCode } = await import("../models/BusinessUserAccess");
const { confirmAttendanceNote } = await import("./attendanceNoteCommand");
const { resolveAttendanceIdentity, executeAttendanceCommand } = await import("./attendanceLedgerService");
const { deriveAttendanceDays } = await import("./attendanceDerived");
const { assignAttendanceShift } = await import("./attendanceShift");
const { deliverAttendanceLedger } = await import("./attendanceLedgerOutbox");
const { createAdminDashboardSession } = await import("../config/adminDashboardSession");
const { getHubDay, saveHubDayNote } = await import("../controllers/attendanceHubController");
const now = new Date("2026-10-16T02:00:00Z");
const admin = { role: "admin" as const, code: "99009990" };
const policy = { _id: "global-attendance", revision: 1, graceMinutes: 0, breakMinutes: 15, lunchMinutes: 60,
  shiftStart: "23:00", shiftEnd: "08:00", recoveryEnabled: false, recoveryTime: "22:59", autoTimeOutTime: "08:05", audit: [] };
let mongo: MongoMemoryReplSet;
let counter = 0;
before(async () => {
  // Local checks use the cached executable; a clean CI runner may provision its test-only binary.
  const executable = fileURLToPath(new URL("../../node_modules/.cache/mongodb-memory-server/mongod-x64-win32-8.2.6.exe", import.meta.url));
  mongo = await MongoMemoryReplSet.create({ binary: { ...(existsSync(executable) ? { systemBinary: executable } : {}), version: "8.2.6" }, replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri(`${prefix}_canonical`));
  await AttendanceLedger.init(); await AttendancePolicy.init(); await AttendancePolicy.create(policy);
  for (const business of ["note-a", "note-b"]) await runWithBusiness(business, async () => {
    await Employee.init(); await Attendance.init(); await AttendanceDayNote.init();
  });
});
after(async () => { mock.restoreAll(); await mongoose.disconnect(); await mongo?.stop(); });
beforeEach(() => {
  mock.restoreAll(); process.env.CRM_ATTENDANCE_INTEGRITY = "true"; process.env.CRM_ATTENDANCE_DURATION_MODEL = "true";
  process.env.CRM_ATTENDANCE_AUTO_TIMEOUT = "false"; process.env.CRM_ATTENDANCE_RECOVERY_CUTOFF = "false";
  process.env.CRM_ATTENDANCE_HUB = "true";
});
async function fixture() {
  const employeeCode = `synthetic-note-${counter++}`;
  const ids: Array<{ _id: mongoose.Types.ObjectId }> = [];
  for (const business of ["note-a", "note-b"]) ids.push(await runWithBusiness(business, () => Employee.create({ employeeCode, name: "Synthetic Note Employee", status: "Active" })));
  await setBusinessAccessForEmployeeCode(employeeCode, ["note-a", "note-b"]);
  const identity = await runWithBusiness("note-a", () => resolveAttendanceIdentity(String(ids[0]._id), admin));
  const rows = [["Time In", "2026-10-15T15:10:00Z"], ["Break Out", "2026-10-15T17:00:00Z"],
    ["Break In", "2026-10-15T17:20:00Z"], ["Time Out", "2026-10-15T23:00:00Z"]] as const;
  const events = rows.map(([source, at], sequence) => ({ source, at: new Date(at).toISOString(), sequence, id: `${employeeCode}-${sequence}`,
    commandId: `seed-${employeeCode}-${sequence}`, recordedAt: new Date(at).toISOString(), ...(source === "Time In" ? { shift: assignAttendanceShift(new Date(at)) } : {}) }));
  const ledger = { _id: identity.key, employeeCode, canonicalBusinessId: "note-a", businessIds: ["note-a", "note-b"], revision: 1,
    fence: 0, events, corrections: [], closures: [], audit: [], commands: [], jobs: [] };
  await AttendanceLedger.create({ ...ledger, derived: deriveAttendanceDays(ledger, policy, new Date("2026-10-15T23:00:00Z")) });
  return { identity, employeeCode, ids, input: { employeeCode, businessId: "note-a", dayKey: "2026-10-15", reason: "Private synthetic tenant note",
    excused: false, commandId: crypto.randomUUID(), expectedRevision: 1, expectedNoteRevision: 0 } };
}
const deferDelivery = { deliver: async () => undefined };

test("real shared-client transaction commits tenant note + canonical derivatives/audit/jobs, without leaking note or changing events", async () => {
  const person = await fixture(); const before = await AttendanceLedger.findById(person.identity.key).lean();
  assert.equal(getBusinessConnection("note-a").getClient(), AttendanceLedger.db.getClient());
  const saved = await confirmAttendanceNote({ ...person.input, excused: true }, admin, now, deferDelivery);
  assert.equal(saved.noteRevision, 1); assert.equal(saved.attendanceRevision, 2); assert.equal(saved.syncPending, true);
  assert.equal(saved.derived!.earlyTimeOutMinutes, 60); assert.equal(saved.derived!.excessBreakMinutes, 5);
  assert.equal(saved.derived!.deductibleMinutes, 75, "business-local excuse must not globally waive deductions");
  const ledger = (await AttendanceLedger.findById(person.identity.key).lean())!;
  assert.deepEqual(ledger.events, before!.events); assert.deepEqual(ledger.corrections, before!.corrections);
  assert.equal(ledger.audit[0].operation, "confirm-note"); assert.equal(ledger.audit[0].noteReference!.businessId, "note-a");
  assert.equal(JSON.stringify(ledger).includes(person.input.reason), false); assert.equal(Object.hasOwn(ledger.audit[0].noteReference!, "excused"), false);
  const note = await runWithBusiness("note-a", () => AttendanceDayNote.findOne({ employeeCode: person.employeeCode }).lean());
  assert.deepEqual(note!.revisions[0].before!.reason, ""); assert.equal(note!.revisions[0].after!.excused, true);
  assert.equal(note!.revisions[0].attendanceRevision, 2); assert.equal(note!.revisions[0].policyRevision, 1);
  assert.equal(await runWithBusiness("note-b", () => AttendanceDayNote.countDocuments({ employeeCode: person.employeeCode })), 0);
  assert.deepEqual(ledger.jobs.map((job) => job.businessId), ["note-a", "note-b"]);
});

test("real transaction rolls tenant note and lease back if the fenced canonical CAS fails", async () => {
  const person = await fixture(); const before = await AttendanceLedger.findById(person.identity.key).lean();
  const original = AttendanceLedger.findOneAndUpdate.bind(AttendanceLedger);
  mock.method(AttendanceLedger, "findOneAndUpdate", (...args: unknown[]) => {
    if ((args[1] as { $push?: unknown }).$push) return { lean: async () => null };
    return Reflect.apply(original, AttendanceLedger, args);
  });
  await assert.rejects(confirmAttendanceNote(person.input, admin, now, deferDelivery), { code: "LEASE_OR_REVISION_LOST" });
  assert.equal(await runWithBusiness("note-a", () => AttendanceDayNote.countDocuments({ employeeCode: person.employeeCode })), 0);
  const after = await AttendanceLedger.findById(person.identity.key).lean();
  assert.equal(after!.revision, before!.revision); assert.equal(after!.fence, before!.fence);
  assert.deepEqual(after!.derived, before!.derived); assert.deepEqual(after!.audit, []); assert.deepEqual(after!.jobs, []);
});

test("real transaction rolls canonical state back when tenant note CAS rejects a stale note revision", async () => {
  const person = await fixture();
  await assert.rejects(confirmAttendanceNote({ ...person.input, expectedNoteRevision: 2 }, admin, now, deferDelivery), { code: "STALE_NOTE_REVISION" });
  const ledger = (await AttendanceLedger.findById(person.identity.key).lean())!;
  assert.equal(ledger.revision, 1); assert.equal(ledger.fence, 0); assert.equal(ledger.audit.length, 0);
});

test("duplicate command returns its original note revision even after a later note save", async () => {
  const person = await fixture();
  const first = await confirmAttendanceNote(person.input, admin, now, deferDelivery);
  await confirmAttendanceNote({ ...person.input, reason: "A different private draft", commandId: crypto.randomUUID(), expectedRevision: 2, expectedNoteRevision: 1 }, admin, now, deferDelivery);
  const replay = await confirmAttendanceNote(person.input, admin, now, deferDelivery);
  assert.equal(replay.replayed, true); assert.equal(replay.reason, first.reason); assert.equal(replay.noteRevision, 1); assert.equal(replay.attendanceRevision, 2);
  const note = await runWithBusiness("note-a", () => AttendanceDayNote.findOne({ employeeCode: person.employeeCode }).lean());
  assert.equal(note!.noteRevision, 2); assert.equal(note!.revisions.length, 2);
  assert.equal((await AttendanceLedger.findById(person.identity.key).lean())!.audit.length, 2);
  await assert.rejects(confirmAttendanceNote({ ...person.input, excused: true }, admin, now, deferDelivery), { code: "IDEMPOTENCY_CONFLICT" });
});

test("racing real transactions with the same command commit once and replay without extra note audit", async () => {
  const person = await fixture();
  const results = await Promise.all([confirmAttendanceNote(person.input, admin, now, deferDelivery), confirmAttendanceNote(person.input, admin, now, deferDelivery)]);
  assert.equal(results.filter((result) => result.replayed).length, 1);
  const note = await runWithBusiness("note-a", () => AttendanceDayNote.findOne({ employeeCode: person.employeeCode }).lean());
  assert.equal(note!.revisions.length, 1); assert.equal((await AttendanceLedger.findById(person.identity.key).lean())!.audit.length, 1);
});

test("racing different note commands cannot silently overwrite the same revisions", async () => {
  const person = await fixture();
  const results = await Promise.allSettled([confirmAttendanceNote(person.input, admin, now, deferDelivery),
    confirmAttendanceNote({ ...person.input, commandId: crypto.randomUUID(), reason: "Concurrent private text" }, admin, now, deferDelivery)]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  const rejected = results.find((result) => result.status === "rejected") as PromiseRejectedResult;
  assert.ok(["STALE_REVISION", "STALE_NOTE_REVISION"].includes(rejected.reason.code));
});

test("old clients require refresh, non-admin callers cannot confirm, and HTTP-like calls cannot supply hooks", async () => {
  const person = await fixture();
  await assert.rejects(confirmAttendanceNote({ ...person.input, expectedRevision: undefined as never }, admin, now), { code: "ATTENDANCE_REFRESH_REQUIRED" });
  await assert.rejects(confirmAttendanceNote(person.input, { role: "employee", code: person.employeeCode }, now), { code: "ADMIN_ONLY" });
  await assert.rejects(executeAttendanceCommand(person.identity, { operation: "confirm-note", commandId: person.input.commandId, expectedRevision: 1 }, admin, now), { code: "NOTE_TRANSACTION_REQUIRED" });
});

test("invalid projection prevents a note and canonical commit together", async () => {
  const person = await fixture();
  await AttendanceLedger.updateOne({ _id: person.identity.key }, { $push: { events: { source: "Break In", at: now.toISOString(), sequence: 20, id: "orphan", commandId: "orphan", recordedAt: now.toISOString() } } });
  await assert.rejects(confirmAttendanceNote(person.input, admin, now, deferDelivery), { code: "INVALID_TIMELINE" });
  assert.equal(await runWithBusiness("note-a", () => AttendanceDayNote.countDocuments({ employeeCode: person.employeeCode })), 0);
});

test("legacy note revisions acquire a safe numeric revision without rewriting historical entries", async () => {
  const person = await fixture();
  await runWithBusiness("note-a", () => AttendanceDayNote.create({ employeeCode: person.employeeCode, dayKey: person.input.dayKey, reason: "Legacy local text", excused: false,
    revisions: [{ reason: "First local text", excused: false, by: admin.code, at: now }, { reason: "Legacy local text", excused: false, by: admin.code, at: now }] }));
  const saved = await confirmAttendanceNote({ ...person.input, expectedNoteRevision: 2 }, admin, now, deferDelivery);
  assert.equal(saved.noteRevision, 3);
  const note = await runWithBusiness("note-a", () => AttendanceDayNote.findOne({ employeeCode: person.employeeCode }).lean());
  assert.equal(note!.revisions.length, 3); assert.equal(note!.revisions[0].reason, "First local text"); assert.equal(note!.revisions[2].before!.reason, "Legacy local text");
});

test("committed notes stay local while outbox updates both business derivatives, payroll and notifications", async () => {
  const person = await fixture(); const payroll: string[] = []; const notifications: string[] = [];
  const saved = await confirmAttendanceNote(person.input, admin, now, { deliver: (key) => deliverAttendanceLedger(key, {
    recalculatePayroll: async (_id, _from, _to, scope) => { payroll.push(scope!.businessIds![0]); },
    emitAvailability: (payload) => { notifications.push(payload.employeeId); },
  }) });
  assert.equal(saved.syncPending, false); assert.deepEqual(payroll, ["note-a", "note-b"]); assert.equal(notifications.length, 2);
  for (const business of ["note-a", "note-b"]) {
    const records = await runWithBusiness(business, () => Attendance.find({ ledgerIdentity: person.identity.key }).lean());
    assert.equal(records.length, 4); assert.equal(records[0].derived!.earlyTimeOutMinutes, 60);
  }
});

test("delivery failure reports pending after a successful atomic note save", async () => {
  const person = await fixture();
  const saved = await confirmAttendanceNote(person.input, admin, now, { deliver: async () => { throw new Error("Synthetic delivery outage"); } });
  assert.equal(saved.syncPending, true); assert.equal(saved.noteRevision, 1);
  assert.ok((await AttendanceLedger.findById(person.identity.key).lean())!.jobs.every((job) => !job.done));
});

function responseCapture() {
  const captured = { status: 200, data: undefined as unknown };
  const response = { status: (status: number) => { captured.status = status; return response; },
    json: (data: unknown) => { captured.data = data; return response; }, set: () => response };
  return { captured, response: response as unknown as import("express").Response };
}
function request(person: Awaited<ReturnType<typeof fixture>>, body: unknown, business = "note-a") {
  return { params: { dayKey: person.input.dayKey }, body,
    header: (name: string) => name.toLowerCase() === "x-crm-admin-session" ? createAdminDashboardSession(admin.code) : undefined,
    query: { preset: "custom", from: person.input.dayKey, to: person.input.dayKey, employeeCode: person.employeeCode, business },
  } as unknown as import("express").Request;
}

test("note endpoint requires revisions only with duration flag on; legacy flag-off note writes remain unchanged", async () => {
  const person = await fixture();
  const legacyBody = { employeeCode: person.employeeCode, businessId: "note-a", reason: "Synthetic old-client note", excused: false };
  const denied = responseCapture();
  await saveHubDayNote(request(person, legacyBody), denied.response);
  assert.equal(denied.captured.status, 426);
  assert.equal((denied.captured.data as { code: string }).code, "ATTENDANCE_REFRESH_REQUIRED");
  assert.equal(await runWithBusiness("note-a", () => AttendanceDayNote.countDocuments({ employeeCode: person.employeeCode })), 0);
  process.env.CRM_ATTENDANCE_DURATION_MODEL = "false";
  const accepted = responseCapture();
  await saveHubDayNote(request(person, legacyBody), accepted.response);
  assert.equal(accepted.captured.status, 200);
  assert.equal((accepted.captured.data as { reason: string }).reason, legacyBody.reason);
  assert.equal((await AttendanceLedger.findById(person.identity.key).lean())!.revision, 1);
});

test("hub day reads return the actual business-local note revision and canonical attendance revision", async () => {
  const person = await fixture();
  await confirmAttendanceNote(person.input, admin, now, deferDelivery);
  const a = responseCapture(); const b = responseCapture();
  await getHubDay(request(person, undefined), a.response);
  await getHubDay(request(person, undefined, "note-b"), b.response);
  assert.equal(a.captured.status, 200); assert.equal(b.captured.status, 200);
  const first = (a.captured.data as { day: { noteRevision: number; attendanceRevision: number; note: string; noteExcused: boolean } }).day;
  const other = (b.captured.data as { day: typeof first }).day;
  assert.equal(first.noteRevision, 1); assert.equal(first.attendanceRevision, 2); assert.equal(first.note, person.input.reason); assert.equal(first.noteExcused, false);
  assert.equal(other.noteRevision, 0); assert.equal(other.attendanceRevision, 2); assert.equal(other.note, "");
});
