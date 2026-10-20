import assert from "node:assert/strict";
import crypto from "node:crypto";
import { afterEach, beforeEach, mock, test } from "node:test";
import { AttendanceLedger, AttendancePolicy, type AttendanceLedgerDocument } from "../models/AttendanceLedger";
import { attendanceDerivedDaysDueForRefresh, deriveAttendanceDays } from "./attendanceDerived";
import { attendanceDerivedAuditDelta, replayAttendanceDerived } from "./attendanceDerivedAudit";
import { attendanceDerivedRefreshCommandId, attendanceSnapshot, executeAttendanceCommand, type AttendanceCommand } from "./attendanceLedgerService";
import { runAttendanceDerivedRefresh } from "./attendanceDerivedRefreshWorker";
import { assignAttendanceShift } from "./attendanceShift";
import type { SessionEvent } from "./attendanceSessionState";

const policy = { _id: "global-attendance", revision: 1, graceMinutes: 0, breakMinutes: 15, lunchMinutes: 60,
  shiftStart: "23:00", shiftEnd: "08:00", recoveryEnabled: false, recoveryTime: "07:00", autoTimeOutTime: "08:05", audit: [] };
const system = { role: "system" as const, code: "attendance-derived-refresh" };
const identity = { key: "fake-derived", code: "fake-code", employeeId: "", canonicalBusinessId: "fake-a", businessIds: ["fake-a", "fake-b"] };
const end = new Date("2026-10-16T00:00:00Z");
const checkout = new Date("2026-10-15T23:00:00Z");
const clone = <T>(value: T): T => structuredClone(value);
let payrollAccuracyFlag: string | undefined;
let store: AttendanceLedgerDocument;
let failCas = false;
let onLease: (() => void) | undefined;
const commits: Array<Record<string, unknown>> = [];
function event(source: SessionEvent["source"], at: string, sequence: number): SessionEvent {
  return { id: `fake-${sequence}`, source, at, sequence, commandId: `seed-${sequence}`, recordedAt: at,
    ...(source === "Time In" ? { shift: assignAttendanceShift(new Date(at)), sessionId: `fake-${sequence}` } : {}) };
}
function fixture() {
  store = { _id: identity.key, employeeCode: identity.code, canonicalBusinessId: identity.canonicalBusinessId, businessIds: identity.businessIds,
    revision: 1, fence: 0, events: [event("Time In", "2026-10-15T15:00:00Z", 0), event("Time Out", checkout.toISOString(), 1)],
    corrections: [], closures: [], commands: [], audit: [], jobs: [] };
  store.derived = deriveAttendanceDays(store, policy, checkout);
}
function command(): AttendanceCommand {
  const day = store.derived![0];
  return { commandId: attendanceDerivedRefreshCommandId(day.dayKey, day.shiftEnd), operation: "recalculate", dayKey: day.dayKey,
    expectedRevision: store.revision, reason: "Finalize closed attendance deductions at shift end" };
}
beforeEach(() => {
  payrollAccuracyFlag = process.env.CRM_PAYROLL_ACCURACY;
  process.env.CRM_PAYROLL_ACCURACY = "false";
  process.env.CRM_ATTENDANCE_INTEGRITY = "true"; process.env.CRM_ATTENDANCE_DURATION_MODEL = "true";
  process.env.CRM_ATTENDANCE_AUTO_TIMEOUT = "false"; process.env.CRM_ATTENDANCE_RECOVERY_CUTOFF = "false";
  fixture(); failCas = false; onLease = undefined; commits.length = 0;
  mock.method(AttendancePolicy, "findById", () => ({ lean: async () => clone(policy) }));
  mock.method(AttendanceLedger, "findById", () => ({ lean: async () => clone(store) }));
  mock.method(AttendanceLedger, "find", () => ({ lean: async () => [clone(store)] }));
  mock.method(AttendanceLedger, "updateOne", async (_query: unknown, update: Record<string, unknown>) => {
    if (update.$unset) { delete store.lockToken; delete store.lockUntil; }
    return { matchedCount: 1, modifiedCount: 1 };
  });
  mock.method(AttendanceLedger, "findOneAndUpdate", (filter: Record<string, unknown>, update: Record<string, unknown>) => ({ lean: async () => {
    if (update.$inc) {
      onLease?.(); onLease = undefined;
      if (store.lockToken) return null;
      Object.assign(store, clone(update.$set)); store.fence++;
      return clone(store);
    }
    if (failCas || filter.revision !== store.revision || filter.fence !== store.fence || filter.lockToken !== store.lockToken) return null;
    commits.push(clone(update));
    Object.assign(store, clone(update.$set));
    const push = update.$push as { audit: AttendanceLedgerDocument["audit"][number]; commands: AttendanceLedgerDocument["commands"][number] };
    store.audit.push(clone(push.audit)); store.commands.push(clone(push.commands));
    return clone(store);
  } }));
});
afterEach(() => {
  mock.restoreAll();
  if (payrollAccuracyFlag === undefined) delete process.env.CRM_PAYROLL_ACCURACY;
  else process.env.CRM_PAYROLL_ACCURACY = payrollAccuracyFlag;
});

test("early checkout stays zero before end, durably finalizes at end without attendance writes and never repeats", async () => {
  const evidence = clone({ events: store.events, corrections: store.corrections, closures: store.closures });
  let deliveries = 0;
  assert.equal(store.derived![0].earlyTimeOutMinutes, 0);
  assert.equal(await runAttendanceDerivedRefresh(new Date(end.getTime() - 1), async () => { deliveries++; }), 0);
  assert.equal(await runAttendanceDerivedRefresh(end, async () => { deliveries++; }), 1);
  assert.equal(store.derived![0].earlyTimeOutMinutes, 60); assert.equal(store.derived![0].deductibleMinutes, 60);
  assert.equal(store.audit[0].operation, "recalculate"); assert.equal(store.audit[0].beforeDerived![0].earlyTimeOutMinutes, 0);
  assert.equal(store.audit[0].afterDerived![0].earlyTimeOutMinutes, 60);
  assert.deepEqual({ events: store.events, corrections: store.corrections, closures: store.closures }, evidence);
  for (const field of ["events", "corrections", "closures"]) assert.equal(Object.hasOwn(commits[0].$set as object, field), false);
  assert.ok(store.jobs.every((job) => !job.done));
  assert.equal(await runAttendanceDerivedRefresh(new Date("2026-10-16T05:00:00Z"), async () => { deliveries++; }), 0);
  assert.equal(deliveries, 1); assert.equal(store.audit.length, 1);
  const durable = clone(store);
  const snapshot = attendanceSnapshot(store, new Date("2026-10-16T06:00:00Z"));
  assert.equal(snapshot.derived![0].earlyTimeOutMinutes, 60); assert.deepEqual(store, durable, "snapshot GET must not finalize or write");
});

test("system-closed zero-amount day finalizes once with metadata-only audit instead of repeating forever", async () => {
  store.events = [store.events[0]];
  store.closures = [{ id: "fake-closure", sessionId: "fake-0", effectiveAt: checkout.toISOString(), processedAt: checkout.toISOString(), commandId: "fake-recovery" }];
  store.derived = deriveAttendanceDays(store, policy, checkout);
  assert.equal(store.derived[0].hasOpenSession, false);
  assert.equal(await runAttendanceDerivedRefresh(end, async () => {}), 1);
  assert.equal(store.derived[0].earlyTimeOutMinutes, 0); assert.equal(store.derived[0].computedAt, end.toISOString());
  assert.deepEqual(store.audit[0].beforeDerived, []); assert.deepEqual(store.audit[0].afterDerived, []);
  assert.equal(store.audit[0].derivedMetadata![0].dayKey, "2026-10-15");
  assert.equal(await runAttendanceDerivedRefresh(new Date(end.getTime() + 1), async () => {}), 0);
});

test("recalculate is system-only, explicitly enabled, deterministic and cannot carry event changes", async () => {
  for (const role of ["admin", "employee"] as const) await assert.rejects(executeAttendanceCommand(identity, command(), { role, code: "fake" }, end), { code: "SYSTEM_ONLY" });
  await assert.rejects(executeAttendanceCommand(identity, { ...command(), commandId: crypto.randomUUID() }, system, end), { code: "INVALID_DERIVED_REFRESH_ID" });
  await assert.rejects(executeAttendanceCommand(identity, { ...command(), changes: [{ source: "Time Out", at: end.toISOString() }] }, system, end), { code: "INVALID_DERIVED_REFRESH" });
  process.env.CRM_ATTENDANCE_DURATION_MODEL = "false";
  await assert.rejects(executeAttendanceCommand(identity, command(), system, end), { code: "DERIVED_REFRESH_NOT_DUE" });
  assert.equal(await runAttendanceDerivedRefresh(end), 0); assert.equal(commits.length, 0);
});

test("refresh lease loss commits no derivative, audit, job or event", async () => {
  const before = clone(store); failCas = true;
  assert.equal(await runAttendanceDerivedRefresh(end, async () => { assert.fail("not committed"); }), 0);
  delete before.lockToken; delete before.lockUntil;
  assert.equal(store.revision, before.revision); assert.deepEqual(store.derived, before.derived);
  assert.equal(store.audit.length, 0); assert.equal(store.jobs.length, 0); assert.deepEqual(store.events, before.events);
});

test("racing workers commit once and a deterministic request replays with a different expected revision", async () => {
  const request = command();
  const results = await Promise.all([runAttendanceDerivedRefresh(end, async () => {}), runAttendanceDerivedRefresh(end, async () => {})]);
  assert.equal(results.reduce((sum, value) => sum + value, 0), 1);
  const replay = await executeAttendanceCommand(identity, { ...request, expectedRevision: store.revision }, system, new Date(end.getTime() + 1000));
  assert.ok("replayed" in replay && replay.replayed); assert.equal(store.audit.length, 1);
});

test("restart and failed delivery retain the finalized canonical snapshot and pending jobs", async () => {
  assert.equal(await runAttendanceDerivedRefresh(new Date("2026-10-16T03:00:00Z"), async () => { throw new Error("fake outage"); }), 1);
  assert.equal(store.derived![0].earlyTimeOutMinutes, 60); assert.equal(store.derived![0].computedAt, "2026-10-16T03:00:00.000Z");
  assert.ok(store.jobs.every((job) => !job.done)); assert.equal(await runAttendanceDerivedRefresh(new Date("2026-10-16T04:00:00Z")), 0);
});

test("active, already-finalized, missing-derived and migration days are never refreshed", () => {
  const fixtures: AttendanceLedgerDocument[] = [];
  const active = clone(store); active.events.pop(); fixtures.push(active);
  const final = clone(store); final.derived = deriveAttendanceDays(final, policy, end); fixtures.push(final);
  fixtures.push({ ...clone(store), derived: undefined }, { ...clone(store), migrationRequired: true });
  for (const ledger of fixtures) assert.equal(attendanceDerivedDaysDueForRefresh(ledger, end).length, 0);
});

test("a manual reopen after the scan is rechecked under the lease", async () => {
  onLease = () => { store.events.pop(); };
  assert.equal(await runAttendanceDerivedRefresh(end, async () => { assert.fail("active day"); }), 0);
  assert.equal(commits.length, 0);
});

test("one malformed ledger cannot prevent a later eligible ledger finalizing", async () => {
  const malformed = clone(store); malformed.derived![0].sessionIds = undefined as never;
  mock.method(AttendanceLedger, "find", () => ({ lean: async () => [malformed, clone(store)] }));
  assert.equal(await runAttendanceDerivedRefresh(end, async () => {}), 1);
});

test("accuracy: a new day's manual action cannot silently recalculate an unrelated historical day", async () => {
  const saved = process.env.CRM_ATTENDANCE_ACCURACY_FIXES;
  process.env.CRM_ATTENDANCE_ACCURACY_FIXES = "false";
  store.derived = deriveAttendanceDays(store, policy, checkout);
  const before = clone(store.derived[0]);
  process.env.CRM_ATTENDANCE_ACCURACY_FIXES = "true";
  try {
    await executeAttendanceCommand(identity, { commandId: crypto.randomUUID(), operation: "action", source: "Time In", expectedRevision: store.revision },
      { role: "employee", code: identity.code }, new Date("2026-10-16T15:00:00Z"));
    assert.deepEqual(store.derived!.find(day => day.dayKey === before.dayKey), before);
  } finally { if (saved === undefined) delete process.env.CRM_ATTENDANCE_ACCURACY_FIXES; else process.env.CRM_ATTENDANCE_ACCURACY_FIXES = saved; }
});

test("audit delta ignores timestamps/revisions, preserves historical values and records day removals", () => {
  const day = store.derived![0];
  const metadataOnly = { ...day, computedAt: end.toISOString(), revision: 99, policyRevision: 2 };
  assert.deepEqual(attendanceDerivedAuditDelta([day], [metadataOnly]), { derivedAuditVersion: 1, beforeDerived: [], afterDerived: [], removedDerivedDays: [] });
  assert.deepEqual(attendanceDerivedAuditDelta([day], []).removedDerivedDays, [day.dayKey]);
  const ledger = { derivedBaseline: { revision: 1, days: [day] }, audit: [
    { afterRevision: 2, ...attendanceDerivedAuditDelta([day], [metadataOnly]), derivedMetadata: [{ dayKey: day.dayKey, computedAt: end.toISOString(), revision: 99, policyRevision: 2 }] },
    { afterRevision: 3, ...attendanceDerivedAuditDelta([metadataOnly], []) },
  ] };
  assert.deepEqual(replayAttendanceDerived(ledger, 1), [day]); assert.deepEqual(replayAttendanceDerived(ledger, 2), [metadataOnly]);
  assert.deepEqual(replayAttendanceDerived(ledger, 3), []);
});

test("legacy full-snapshot audits remain readable before a newly added baseline", () => {
  const day = store.derived![0];
  const ledger = { derivedBaseline: { revision: 2, days: [day] }, audit: [
    { afterRevision: 1, afterDerived: [day] }, { afterRevision: 2, afterDerived: [day] },
    { afterRevision: 3, ...attendanceDerivedAuditDelta([day], []) },
  ] };
  assert.deepEqual(replayAttendanceDerived(ledger, 1), [day]); assert.deepEqual(replayAttendanceDerived(ledger, 2), [day]);
  assert.deepEqual(replayAttendanceDerived(ledger, 3), []);
});

test("older command replay reconstructs unchanged days and removals across real audited commands", async () => {
  const refresh = command();
  const first = await executeAttendanceCommand(identity, refresh, system, end);
  const removal: AttendanceCommand = { commandId: crypto.randomUUID(), expectedRevision: store.revision, operation: "correct", reason: "Synthetic removal",
    changes: store.events.map((item) => ({ targetId: item.id, remove: true })) };
  await executeAttendanceCommand(identity, removal, { role: "admin", code: "fake-admin" }, new Date("2026-10-16T02:00:00Z"));
  assert.deepEqual(store.derived, []); assert.deepEqual(store.audit.at(-1)!.removedDerivedDays, ["2026-10-15"]);
  const replay = await executeAttendanceCommand(identity, { ...refresh, expectedRevision: store.revision }, system, new Date("2026-10-16T03:00:00Z"));
  assert.deepEqual(replay.derived, first.derived); assert.equal(replay.records.length, 2);
});

test("many-day action audits grow with changed days, not the entire attendance history", async () => {
  store.events = []; store.derived = []; store.revision = 0;
  const requests: Array<{ input: AttendanceCommand; derived: AttendanceLedgerDocument["derived"] }> = [];
  for (let day = 1; day <= 30; day++) {
    for (const [source, at] of [["Time In", new Date(Date.UTC(2026, 8, day, 15))], ["Time Out", new Date(Date.UTC(2026, 8, day + 1, 0))]] as const) {
      const input: AttendanceCommand = { commandId: crypto.randomUUID(), expectedRevision: store.revision, operation: "action", source };
      const result = await executeAttendanceCommand(identity, input, { role: "employee", code: identity.code }, at);
      requests.push({ input, derived: clone(result.derived) });
      assert.ok(store.audit.at(-1)!.beforeDerived!.length <= 1); assert.equal(store.audit.at(-1)!.afterDerived!.length, 1);
    }
  }
  assert.equal(store.derived!.length, 30); assert.equal(store.derivedBaseline!.days.length, 0);
  assert.equal(store.audit.reduce((sum, audit) => sum + audit.afterDerived!.length, 0), 60);
  for (const index of [0, 9, 30, 58]) {
    const replay = await executeAttendanceCommand(identity, requests[index].input, { role: "employee", code: identity.code }, end);
    assert.deepEqual(replay.derived, requests[index].derived);
  }
});
