import assert from "node:assert/strict";
import { afterEach, mock, test } from "node:test";
import { deriveAttendanceDays } from "./attendanceDerived";
import { assignAttendanceShift } from "./attendanceShift";
import type { AttendanceLedgerDocument } from "../models/AttendanceLedger";
import type { SessionEvent } from "./attendanceSessionState";

process.env.NODE_ENV = "test";
process.env.BUSINESS_DATABASES = JSON.stringify([{ id: "fake-a", databaseName: "fake_outbox_a" }, { id: "fake-b", databaseName: "fake_outbox_b" }]);
process.env.DEFAULT_BUSINESS_ID = "fake-a";
process.env.DEFAULT_BUSINESS_DATABASE = "fake_outbox_a";
process.env.CRM_ATTENDANCE_DURATION_MODEL = "true";
const { AttendanceLedger, AttendancePolicy } = await import("../models/AttendanceLedger");
const { getBusinessConnection } = await import("../config/tenancy");
const { deliverAttendanceLedger } = await import("./attendanceLedgerOutbox");
const policy = { breakMinutes: 15, lunchMinutes: 60, graceMinutes: 0, shiftStart: "23:00", shiftEnd: "08:00", revision: 1 };
const now = new Date("2026-10-16T02:00:00Z");
afterEach(() => { mock.restoreAll(); process.env.CRM_ATTENDANCE_DURATION_MODEL = "true"; });

function fixture(operation = "action", canonical = true) {
  const rows = [["Time In", "2026-10-15T15:00:00Z"], ["Break Out", "2026-10-15T23:45:00Z"],
    ["Break In", "2026-10-16T00:05:00Z"], ["Time Out", "2026-10-16T00:05:00Z"]] as const;
  const events: SessionEvent[] = rows.map(([source, at], sequence) => ({ id: `fake-event-${sequence}`, source, at, sequence,
    commandId: "fake-command", recordedAt: at, ...(source === "Time In" ? { shift: assignAttendanceShift(new Date(at)) } : {}),
    ...(sequence >= 2 ? { autoTimeOut: true } : {}) }));
  const ledger: AttendanceLedgerDocument = { _id: "fake-ledger", employeeCode: "fake-code", businessIds: ["fake-a", "fake-b"],
    canonicalBusinessId: "fake-a", revision: 1, fence: 0, events, corrections: [], closures: [], commands: [],
    audit: [{ commandId: "fake-command", actor: { role: "system", code: "fake-system" }, operation, at: now.toISOString(), reason: "Synthetic",
      beforeRevision: 0, afterRevision: 1, targetIds: [], beforeState: "ONLINE", afterState: "OFFLINE" }],
    jobs: ["fake-a", "fake-b"].map((businessId) => ({ businessId, revision: 1, done: false })) };
  if (canonical) ledger.derived = deriveAttendanceDays(ledger, policy, now);
  const writes = new Map<string, Array<{ updateOne: { update: { $set: Record<string, unknown> } } }>>();
  mock.method(AttendanceLedger, "findById", () => ({ lean: async () => ledger }));
  mock.method(AttendancePolicy, "findById", () => ({ lean: async () => policy }));
  mock.method(AttendanceLedger, "updateOne", async (_filter: unknown, _update: unknown, options: { arrayFilters: Array<{ "job.businessId": string }> }) => {
    for (const job of ledger.jobs) if (job.businessId === options.arrayFilters[0]["job.businessId"]) job.done = true;
    return { matchedCount: 1, modifiedCount: 1 };
  });
  for (const businessId of ledger.businessIds) {
    const connection = getBusinessConnection(businessId);
    const attendance = connection.model("Attendance");
    const employee = connection.model("Employee");
    mock.method(attendance, "bulkWrite", async (operations: Array<{ updateOne: { update: { $set: Record<string, unknown> } } }>) => { writes.set(businessId, operations); });
    mock.method(attendance, "updateMany", async () => ({ modifiedCount: 0 }));
    mock.method(attendance, "updateOne", async () => ({ modifiedCount: 0 }));
    mock.method(employee, "findOne", () => ({ select: () => ({ lean: async () => ({ _id: `employee-${businessId}` }) }) }));
    mock.method(employee, "updateOne", async () => ({ modifiedCount: 1 }));
  }
  return { ledger, writes };
}

test("every pending ordinary action copies canonical day derivation and auto markers to each business, then recalculates payroll", async () => {
  const { ledger, writes } = fixture();
  const payrollBusinesses: string[] = [];
  const result = await deliverAttendanceLedger(ledger._id, { now, recalculatePayroll: async (_employee, _from, _to, scope) => {
    payrollBusinesses.push(scope!.businessIds![0]); assert.ok(scope!.attendanceDates!.some((date) => date.toISOString() === "2026-10-15T15:00:00.000Z"));
  } });
  assert.deepEqual(result?.pendingBusinessIds, []); assert.deepEqual(payrollBusinesses, ["fake-a", "fake-b"]);
  for (const operations of writes.values()) {
    assert.equal(operations.length, 4);
    for (const operation of operations) assert.deepEqual(operation.updateOne.update.$set.derived, ledger.derived![0]);
    assert.equal(operations[3].updateOne.update.$set.autoTimeOut, true);
    assert.equal(operations[2].updateOne.update.$set.sequence, 2);
    assert.equal(operations[3].updateOne.update.$set.sequence, 3);
  }
  assert.ok(ledger.jobs.every((job) => job.done));
});

test("payroll failure leaves only that business pending; retry uses the same committed snapshot and processes only pending work", async () => {
  const { ledger, writes } = fixture("auto-time-out");
  const before = structuredClone(ledger.derived);
  const failed = await deliverAttendanceLedger(ledger._id, { now, recalculatePayroll: async (_employee, _from, _to, scope) => {
    if (scope!.businessIds![0] === "fake-b") throw new Error("Synthetic payroll outage");
  } });
  assert.deepEqual(failed?.deliveredBusinessIds, ["fake-a"]); assert.deepEqual(failed?.pendingBusinessIds, ["fake-b"]);
  writes.clear();
  const calls: string[] = [];
  const retry = await deliverAttendanceLedger(ledger._id, { now: new Date("2026-12-01T00:00:00Z"), recalculatePayroll: async (_employee, _from, _to, scope) => { calls.push(scope!.businessIds![0]); } });
  assert.deepEqual(calls, ["fake-b"]); assert.equal(writes.has("fake-a"), false);
  assert.deepEqual(writes.get("fake-b")![0].updateOne.update.$set.derived, before![0]);
  assert.deepEqual(retry?.pendingBusinessIds, []);
});

test("flag off neither writes derived fields nor adds ordinary-action payroll work", async () => {
  const { ledger, writes } = fixture(); process.env.CRM_ATTENDANCE_DURATION_MODEL = "false";
  let calls = 0;
  await deliverAttendanceLedger(ledger._id, { now, recalculatePayroll: async () => { calls++; } });
  assert.equal(calls, 0);
  for (const operations of writes.values()) for (const operation of operations) assert.equal(Object.hasOwn(operation.updateOne.update.$set, "derived"), false);
});

test("pre-derived ledger fallback calculates for each delivery at the committed audit clock", async () => {
  const { ledger, writes } = fixture("correct", false);
  await deliverAttendanceLedger(ledger._id, { now: new Date("2027-01-01T00:00:00Z"), recalculatePayroll: async () => {} });
  const expected = deriveAttendanceDays(ledger, policy, now)[0];
  for (const operations of writes.values()) assert.deepEqual(operations[0].updateOne.update.$set.derived, expected);
  assert.equal(ledger.derived, undefined, "delivery must not bypass canonical commit ownership");
});

test("subsequent policy changes never silently replace a committed canonical day snapshot", async () => {
  const { ledger, writes } = fixture();
  const changedPolicy = { ...policy, breakMinutes: 30, revision: 2 };
  mock.method(AttendancePolicy, "findById", () => ({ lean: async () => changedPolicy }));
  await deliverAttendanceLedger(ledger._id, { now, recalculatePayroll: async () => {} });
  for (const operations of writes.values()) assert.deepEqual(operations[0].updateOne.update.$set.derived, ledger.derived![0]);
});

test("lost completion compare-and-set reports pending businesses rather than claiming success", async () => {
  const { ledger } = fixture();
  mock.method(AttendanceLedger, "updateOne", async () => ({ matchedCount: 0, modifiedCount: 0 }));
  const result = await deliverAttendanceLedger(ledger._id, { now, recalculatePayroll: async () => {} });
  assert.deepEqual(result?.deliveredBusinessIds, []); assert.deepEqual(result?.pendingBusinessIds, ["fake-a", "fake-b"]);
  assert.ok(ledger.jobs.every((job) => !job.done));
});

test("derived-only refresh delivers stored deductions, emits updates and recalculates both business payrolls", async () => {
  const { ledger, writes } = fixture("recalculate");
  ledger.events.at(-1)!.at = "2026-10-15T23:00:00.000Z";
  ledger.events.splice(1, 2);
  ledger.events.forEach((event) => { event.commandId = "earlier-attendance-command"; });
  ledger.derived = deriveAttendanceDays(ledger, policy, now);
  ledger.audit[0].targetIds = ledger.events.map((event) => event.id);
  ledger.audit[0].afterDerived = ledger.derived;
  const actions: string[] = [];
  await deliverAttendanceLedger(ledger._id, { now, emitAvailability: (payload) => { actions.push(`emit:${payload.employeeId}`); },
    recalculatePayroll: async (_id, _from, _to, scope) => {
      actions.push(`payroll:${scope!.businessIds![0]}`);
      assert.ok(scope!.attendanceDates!.some((date) => date.toISOString() === "2026-10-15T15:00:00.000Z"));
    } });
  assert.deepEqual(actions, ["payroll:fake-a", "emit:employee-fake-a", "payroll:fake-b", "emit:employee-fake-b"]);
  for (const operations of writes.values()) assert.equal((operations[0].updateOne.update.$set.derived as { earlyTimeOutMinutes: number }).earlyTimeOutMinutes, 60);
  assert.ok(ledger.jobs.every((job) => job.done));
});

test("payroll failure still publishes the confirmed attendance state while leaving the business pending", async () => {
  const { ledger } = fixture();
  const emitted: string[] = [];
  const result = await deliverAttendanceLedger(ledger._id, { now,
    emitAvailability: (payload) => { emitted.push(payload.employeeId); },
    recalculatePayroll: async (_id, _from, _to, scope) => { if (scope!.businessIds![0] === "fake-b") throw new Error("Synthetic failure"); } });
  assert.deepEqual(emitted, ["employee-fake-a", "employee-fake-b"]);
  assert.deepEqual(result?.pendingBusinessIds, ["fake-b"]);
});
