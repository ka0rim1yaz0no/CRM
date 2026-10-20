import assert from "node:assert/strict";
import crypto from "node:crypto";
import { afterEach, beforeEach, mock, test } from "node:test";
import { AttendanceLedger, AttendancePolicy, type AttendanceLedgerDocument } from "../models/AttendanceLedger";
import { attendanceAutoTimeOutEnabled } from "../config/rolloutFlags";
import { attendanceAutoTimeOutCutoff } from "./attendanceAutoTimeOut";
import { assignAttendanceShift } from "./attendanceShift";
import { projectAttendance, type SessionEvent } from "./attendanceSessionState";
import { attendancePolicy, attendanceSnapshot, autoTimeOutCommandId, executeAttendanceCommand, type AttendanceCommand } from "./attendanceLedgerService";
import { runAttendanceAutoTimeOut, runAttendanceAutoTimeOutCycle } from "./attendanceAutoTimeOutWorker";
import { runAttendanceRecovery } from "./attendanceRecoveryWorker";
import { attendanceError, validateAttendanceAutoTimeOutTime } from "../controllers/attendanceSessionController";

const flagNames = ["CRM_ATTENDANCE_INTEGRITY", "CRM_ATTENDANCE_AUTO_TIMEOUT", "CRM_ATTENDANCE_DURATION_MODEL", "CRM_ATTENDANCE_RECOVERY_CUTOFF", "CRM_ATTENDANCE_BREAK_GAP", "CRM_PAYROLL_ACCURACY"] as const;
let savedFlags: Array<string | undefined>;
let store: AttendanceLedgerDocument;
let leaseLost = false;
let commitCalls = 0;
let onLease: (() => void) | undefined;
let warnings: unknown[][];
let policy = { _id: "global-attendance", revision: 1, breakMinutes: 15, lunchMinutes: 60, graceMinutes: 0,
  shiftStart: "23:00", shiftEnd: "08:00", recoveryEnabled: true, recoveryTime: "07:00", autoTimeOutTime: "08:05", audit: [] };
const identity = { key: "synthetic-ledger", code: "synthetic-only", employeeId: "", canonicalBusinessId: "synthetic-a", businessIds: ["synthetic-a", "synthetic-b"] };
const system = { role: "system" as const, code: "attendance-auto-time-out" };
const cutoff = "2026-10-16T00:05:00.000Z";
const now = (clock: string) => new Date(`2026-10-16T${clock}Z`);
const copy = <T>(value: T): T => structuredClone(value);
function event(source: SessionEvent["source"], at: string, sequence: number): SessionEvent {
  return { id: `synthetic-${sequence}`, source, at: new Date(at).toISOString(), sequence, commandId: `synthetic-command-${sequence}`, recordedAt: new Date(at).toISOString(),
    ...(source === "Time In" ? { sessionId: "synthetic-session", shift: assignAttendanceShift(new Date(at)) } : {}) };
}
function fixture(events = [event("Time In", "2026-10-15T15:00:00Z", 0)]) {
  store = { _id: identity.key, employeeCode: identity.code, canonicalBusinessId: identity.canonicalBusinessId, businessIds: identity.businessIds,
    revision: 1, fence: 0, events, corrections: [], closures: [], commands: [], audit: [], jobs: [] };
  return store;
}
function autoCommand(revision = store.revision): AttendanceCommand {
  return { commandId: autoTimeOutCommandId("synthetic-session"), expectedRevision: revision, operation: "auto-time-out",
    sessionId: "synthetic-session", reason: "Scheduled automatic time-out" };
}
const noDelivery = async () => undefined;

test("accuracy: recovery delivery failure counts the pending job after a durable close", async () => {
  const saved = process.env.CRM_ATTENDANCE_ACCURACY_FIXES;
  process.env.CRM_ATTENDANCE_ACCURACY_FIXES = "true"; process.env.CRM_ATTENDANCE_AUTO_TIMEOUT = "false";
  const query = { select() { return query; }, sort() { return query; }, limit() { return query; }, maxTimeMS() { return query; }, async lean() { return [copy(store)]; } };
  mock.method(AttendanceLedger, "find", () => query as never);
  try {
    const { attendanceWorkersSnapshot } = await import("./attendanceWorkerHealth");
    assert.equal(await runAttendanceRecovery(now("15:00:00"), async () => { throw new Error("Synthetic recovery delivery outage"); }), 0);
    const report = attendanceWorkersSnapshot().find(item => item.name === "recovery")!;
    assert.equal(report.counters.closed, 1); assert.equal(report.counters.deliveryPending, 1);
    assert.equal(store.closures.length, 1);
  } finally { if (saved === undefined) delete process.env.CRM_ATTENDANCE_ACCURACY_FIXES; else process.env.CRM_ATTENDANCE_ACCURACY_FIXES = saved; }
});

beforeEach(() => {
  savedFlags = flagNames.map((name) => process.env[name]);
  // This in-memory worker suite exercises the legacy commit adapter; real fences use Mongo integration fixtures.
  process.env.CRM_PAYROLL_ACCURACY = "false";
  process.env.CRM_ATTENDANCE_INTEGRITY = "true";
  process.env.CRM_ATTENDANCE_AUTO_TIMEOUT = "true";
  process.env.CRM_ATTENDANCE_DURATION_MODEL = "true";
  process.env.CRM_ATTENDANCE_RECOVERY_CUTOFF = "true";
  process.env.CRM_ATTENDANCE_BREAK_GAP = "true";
  policy = { ...policy, autoTimeOutTime: "08:05" };
  fixture(); leaseLost = false; commitCalls = 0; onLease = undefined;
  warnings = [];
  mock.method(console, "warn", (...args: unknown[]) => { warnings.push(args); });
  mock.method(AttendancePolicy, "findById", () => ({ lean: async () => copy(policy) }) as never);
  mock.method(AttendanceLedger, "findById", () => ({ lean: async () => copy(store) }) as never);
  mock.method(AttendanceLedger, "find", () => ({ lean: async () => [copy(store)] }) as never);
  mock.method(AttendanceLedger, "updateOne", async (_filter: Record<string, unknown>, update: Record<string, unknown>) => {
    if (update.$unset) { delete store.lockToken; delete store.lockUntil; }
    return { modifiedCount: 1 } as never;
  });
  mock.method(AttendanceLedger, "findOneAndUpdate", (filter: Record<string, unknown>, update: Record<string, unknown>) => ({ lean: async () => {
    const fields = update.$set as Partial<AttendanceLedgerDocument>;
    if (update.$inc) {
      onLease?.(); onLease = undefined;
      if (store.lockUntil && store.lockUntil > (filter.$or as Array<{ lockUntil?: { $lte: Date } }>)[0].lockUntil!.$lte) return null;
      Object.assign(store, fields); store.fence += 1;
      return copy(store);
    }
    commitCalls += 1;
    if (leaseLost || filter.revision !== store.revision || filter.fence !== store.fence || filter.lockToken !== store.lockToken) return null;
    Object.assign(store, copy(fields));
    const pushed = update.$push as { audit: AttendanceLedgerDocument["audit"][number]; commands: AttendanceLedgerDocument["commands"][number] };
    store.audit.push(copy(pushed.audit)); store.commands.push(copy(pushed.commands));
    return copy(store);
  } }) as never);
});
afterEach(() => {
  mock.restoreAll();
  flagNames.forEach((name, index) => { if (savedFlags[index] === undefined) delete process.env[name]; else process.env[name] = savedFlags[index]; });
});

test("auto timeout defaults off without an explicit opt-in in every environment", () => {
  const original = process.env.NODE_ENV;
  try {
    for (const environment of ["production", "development", "test"]) {
      process.env.NODE_ENV = environment;
      for (const value of [undefined, "", "false", "0", "yes"]) {
        if (value === undefined) delete process.env.CRM_ATTENDANCE_AUTO_TIMEOUT; else process.env.CRM_ATTENDANCE_AUTO_TIMEOUT = value;
        assert.equal(attendanceAutoTimeOutEnabled(), false);
      }
      process.env.CRM_ATTENDANCE_AUTO_TIMEOUT = "true";
      assert.equal(attendanceAutoTimeOutEnabled(), true);
    }
  } finally { if (original === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = original; }
});

for (const [clock, count] of [["23:59:00", 0], ["00:04:59", 0], ["00:05:00", 1], ["00:30:00", 1], ["01:00:00", 1]] as const) {
  test(`cutoff boundary ${clock} UTC: ${count ? "closes at exactly 08:05 Manila" : "no write"}`, async () => {
    const at = clock === "23:59:00" ? new Date("2026-10-15T23:59:00Z") : now(clock);
    assert.equal(await runAttendanceAutoTimeOut(at, noDelivery), count);
    assert.equal(store.events.filter((item) => item.source === "Time Out").length, count);
    if (count) { assert.equal(store.events.at(-1)?.at, cutoff); assert.equal(store.events.at(-1)?.autoTimeOut, true); }
    else assert.equal(commitCalls, 0);
  });
}

test("07:59 Manila never closes a shift; opening the session snapshot is read-only", async () => {
  const before = copy(store);
  assert.equal(await runAttendanceAutoTimeOut(new Date("2026-10-15T23:59:00Z"), noDelivery), 0);
  attendanceSnapshot(store, now("01:00:00"));
  assert.deepEqual(store, before);
});

for (const [out, incoming] of [["Break Out", "Break In"], ["Lunch Break Out", "Lunch Break In"], ["Off the Phone Out", "Off the Phone In"]] as const) {
  test(`closes open ${out} before Time Out at the same cutoff, in sequence`, async () => {
    store.events.push(event(out, "2026-10-15T23:45:00Z", 1));
    assert.equal(await runAttendanceAutoTimeOut(now("00:05:00"), noDelivery), 1);
    assert.deepEqual(store.events.slice(-2).map((item) => item.source), [incoming, "Time Out"]);
    assert.ok(store.events.slice(-2).every((item) => item.at === cutoff && item.autoTimeOut));
    assert.ok(store.events.at(-2)!.sequence < store.events.at(-1)!.sequence);
    assert.equal(projectAttendance(store.events).blockingIssues.length, 0);
    assert.equal(store.derived?.[0].hasOpenSession, false);
    assert.equal(store.derived?.[0].earlyTimeOutMinutes, 0);
    assert.deepEqual(store.audit[0].afterDerived, store.derived);
    assert.ok(store.audit[0].beforeDerived?.[0].hasOpenSession);
    assert.deepEqual(store.jobs.map((job) => job.businessId), identity.businessIds);
  });
}

test("late 07:50 Manila starter still closes at 08:05", async () => {
  fixture([event("Time In", "2026-10-15T23:50:00Z", 0)]);
  assert.equal(await runAttendanceAutoTimeOut(now("00:30:00"), noDelivery), 1);
  assert.equal(store.events.at(-1)?.at, cutoff);
  assert.ok(store.derived?.[0].lateMinutes);
});

test("manual checkout, already automatic checkout and restart never duplicate Time Out", async () => {
  store.events.push(event("Time Out", "2026-10-16T00:02:00Z", 1));
  assert.equal(await runAttendanceAutoTimeOut(now("00:30:00"), noDelivery), 0);
  fixture();
  assert.equal(await runAttendanceAutoTimeOut(now("01:00:00"), noDelivery), 1);
  assert.equal(await runAttendanceAutoTimeOut(now("01:30:00"), noDelivery), 0);
  const replay = await executeAttendanceCommand(identity, autoCommand(), system, now("02:00:00"));
  assert.ok("replayed" in replay && replay.replayed);
  assert.equal(store.events.filter((item) => item.source === "Time Out").length, 1);
});

test("two workers racing commit only once", async () => {
  await Promise.all([runAttendanceAutoTimeOut(now("00:05:00"), noDelivery), runAttendanceAutoTimeOut(now("00:05:00"), noDelivery)]);
  assert.equal(store.commands.length, 1);
  assert.equal(store.events.filter((item) => item.source === "Time Out").length, 1);
});

test("manual checkout wins when committed between candidate scan and lease", async () => {
  onLease = () => { store.events.push(event("Time Out", "2026-10-16T00:03:00Z", 1)); store.revision += 1; };
  assert.equal(await runAttendanceAutoTimeOut(now("00:05:00"), noDelivery), 0);
  assert.equal(store.events.at(-1)?.autoTimeOut, undefined);
  assert.equal(commitCalls, 0);
});

test("worker winning a race rejects a stale manual checkout without duplicating it", async () => {
  const manual: AttendanceCommand = { commandId: crypto.randomUUID(), operation: "action", source: "Time Out", expectedRevision: store.revision };
  assert.equal(await runAttendanceAutoTimeOut(now("00:05:00"), noDelivery), 1);
  await assert.rejects(executeAttendanceCommand(identity, manual, { role: "employee", code: identity.code }, now("00:05:00")), { code: "STALE_REVISION" });
  assert.equal(store.events.filter((item) => item.source === "Time Out").length, 1);
});

test("lease/CAS loss cannot persist auto events, audit or derived values", async () => {
  leaseLost = true;
  assert.equal(await runAttendanceAutoTimeOut(now("00:05:00"), noDelivery), 0);
  assert.equal(store.events.length, 1); assert.equal(store.audit.length, 0); assert.equal(store.derived, undefined);
});

test("failed replica delivery leaves canonical commit and durable pending jobs", async () => {
  assert.equal(await runAttendanceAutoTimeOut(now("00:30:00"), async () => { throw new Error("Synthetic delivery failure"); }), 1);
  assert.equal(store.events.at(-1)?.at, cutoff);
  assert.ok(store.jobs.every((job) => !job.done));
});

test("ambiguous, daytime, malformed, future-event and legacy candidates are skipped", async () => {
  for (const kind of ["ambiguous", "daytime", "missing-shift", "invalid-date", "future-event", "legacy"] as const) {
    fixture();
    if (kind === "ambiguous") store.events[0].shift!.ambiguous = true;
    if (kind === "daytime") store.events[0].shift = assignAttendanceShift(new Date("2026-10-15T01:00:00Z"), "09:00", "18:00");
    if (kind === "missing-shift") delete store.events[0].shift;
    if (kind === "invalid-date") store.events[0].shift!.end = "invalid";
    if (kind === "future-event") store.events.push(event("Break Out", "2026-10-16T00:06:00Z", 1));
    if (kind === "legacy") store.migrationRequired = true;
    assert.equal(await runAttendanceAutoTimeOut(now("01:00:00"), noDelivery), 0, kind);
    assert.equal(store.events.filter((item) => item.source === "Time Out").length, 0, kind);
  }
});

test("custom cutoff uses shift end date; cutoffs before shift end never backdate", async () => {
  policy.autoTimeOutTime = "08:10";
  assert.equal(await runAttendanceAutoTimeOut(now("00:09:59"), noDelivery), 0);
  assert.equal(await runAttendanceAutoTimeOut(now("00:10:00"), noDelivery), 1);
  assert.equal(store.events.at(-1)?.at, "2026-10-16T00:10:00.000Z");
  fixture(); policy.autoTimeOutTime = "07:59";
  assert.equal(await runAttendanceAutoTimeOut(now("01:00:00"), noDelivery), 0);
});

test("system-only, opt-in and stable command ID are enforced by the command service", async () => {
  await assert.rejects(executeAttendanceCommand(identity, autoCommand(), { role: "admin", code: "synthetic-admin" }, now("00:05:00")), { code: "SYSTEM_ONLY" });
  await assert.rejects(executeAttendanceCommand(identity, { ...autoCommand(), commandId: crypto.randomUUID() }, system, now("00:05:00")), { code: "INVALID_AUTO_TIME_OUT_ID" });
  process.env.CRM_ATTENDANCE_AUTO_TIMEOUT = "false";
  await assert.rejects(executeAttendanceCommand(identity, autoCommand(), system, now("00:05:00")), { code: "AUTO_TIME_OUT_NOT_DUE" });
  assert.equal(await runAttendanceAutoTimeOut(now("00:05:00"), noDelivery), 0);
});

test("command service rechecks cutoff and integrity flag instead of trusting the worker scan", async () => {
  await assert.rejects(executeAttendanceCommand(identity, autoCommand(), system, now("00:04:59")), { code: "AUTO_TIME_OUT_NOT_DUE" });
  process.env.CRM_ATTENDANCE_INTEGRITY = "false";
  await assert.rejects(executeAttendanceCommand(identity, autoCommand(), system, now("00:05:00")), { code: "AUTO_TIME_OUT_NOT_DUE" });
  assert.equal(store.events.length, 1);
});

test("flag off preserves old ledger shape without derived values or derived audit additions", async () => {
  process.env.CRM_ATTENDANCE_DURATION_MODEL = "false";
  assert.equal(await runAttendanceAutoTimeOut(now("00:05:00"), noDelivery), 1);
  assert.equal(store.derived, undefined);
  assert.equal(store.audit[0].beforeDerived, undefined);
  assert.equal(store.audit[0].afterDerived, undefined);
});

test("recovery cannot preempt auto timeout even when recovery time has passed", async () => {
  assert.equal(await runAttendanceRecovery(now("01:00:00")), 0);
  await assert.rejects(executeAttendanceCommand(identity, { commandId: crypto.randomUUID(), operation: "recover", sessionId: "synthetic-session", expectedRevision: store.revision }, system, now("15:00:00")), { code: "RECOVERY_NOT_DUE" });
  assert.equal(store.closures.length, 0);
});

test("policy legacy documents default to 08:05 and schema validates HH:MM without a database", async () => {
  mock.method(AttendancePolicy, "findById", () => ({ lean: async () => ({ ...policy, autoTimeOutTime: undefined }) }) as never);
  assert.equal((await attendancePolicy()).autoTimeOutTime, "08:05");
  for (const value of ["8:05", "24:00", "08:60", "invalid"]) {
    await assert.rejects(new AttendancePolicy({ ...policy, autoTimeOutTime: value }).validate());
  }
  await new AttendancePolicy({ ...policy, autoTimeOutTime: "08:05" }).validate();
});

test("snapshot allowed actions follow validation and ignore reviewed historical issues", () => {
  store.events.unshift({ ...event("Break In", "2026-10-14T00:00:00Z", -1), legacyReviewed: true });
  const before = copy(store);
  const snapshot = attendanceSnapshot(store, new Date("2026-10-15T16:00:00Z"));
  assert.ok(snapshot.historyReviewRequired);
  assert.ok(snapshot.allowedActions.includes("Break Out"));
  assert.ok(snapshot.allowedActions.includes("Time Out"));
  assert.ok(!snapshot.allowedActions.includes("Break In"));
  assert.deepEqual(store, before);
  store.events.push(event("Break Out", "2026-10-15T16:00:00Z", 1));
  const onBreak = attendanceSnapshot(store, new Date("2026-10-15T16:05:00Z"));
  assert.ok(onBreak.allowedActions.includes("Break In"));
  assert.ok(!onBreak.allowedActions.includes("Time Out"));
});

test("allowed actions omit exhausted breaks/lunch and include paired off-phone checkout", () => {
  fixture([
    event("Time In", "2026-10-15T15:00:00Z", 0),
    event("Break Out", "2026-10-15T17:00:00Z", 1), event("Break In", "2026-10-15T17:15:00Z", 2),
    event("Break Out", "2026-10-15T18:00:00Z", 3), event("Break In", "2026-10-15T18:15:00Z", 4),
    event("Lunch Break Out", "2026-10-15T19:00:00Z", 5), event("Lunch Break In", "2026-10-15T20:00:00Z", 6),
  ]);
  const snapshot = attendanceSnapshot(store, new Date("2026-10-15T21:00:00Z"));
  assert.ok(!snapshot.allowedActions.includes("Break Out"));
  assert.ok(!snapshot.allowedActions.includes("Lunch Break Out"));
  store.events.push(event("Off the Phone Out", "2026-10-15T21:00:00Z", 7));
  const offPhone = attendanceSnapshot(store, new Date("2026-10-15T21:05:00Z"));
  assert.ok(offPhone.allowedActions.includes("Time Out"));
  assert.ok(offPhone.allowedActions.includes("Off the Phone In"));
});

test("correction atomically persists recomputed deductions, returns them and reloads identically", async () => {
  fixture([
    event("Time In", "2026-10-15T15:00:00Z", 0),
    event("Break Out", "2026-10-15T17:00:00Z", 1), event("Break In", "2026-10-15T17:15:00Z", 2),
    event("Time Out", cutoff, 3),
  ]);
  const result = await executeAttendanceCommand(identity, { commandId: crypto.randomUUID(), operation: "correct", expectedRevision: store.revision,
    reason: "Synthetic duration correction", changes: [{ targetId: "synthetic-2", at: "2026-10-15T17:16:00Z" }] },
  { role: "admin", code: "synthetic-admin" }, now("01:00:00"));
  assert.equal(store.derived?.[0].excessBreakMinutes, 1);
  assert.equal(store.audit[0].beforeDerived?.[0].excessBreakMinutes, 0);
  assert.equal(store.audit[0].afterDerived?.[0].excessBreakMinutes, 1);
  assert.deepEqual(result.derived, store.derived);
  assert.deepEqual(attendanceSnapshot(copy(store), now("02:00:00")).derived, result.derived);
  assert.equal(commitCalls, 1);
});

test("replaying an older command uses its own audited derived snapshot, not a later correction", async () => {
  const original = autoCommand();
  await executeAttendanceCommand(identity, original, system, now("00:05:00"));
  const derived = copy(store.derived);
  await executeAttendanceCommand(identity, { commandId: crypto.randomUUID(), operation: "correct", expectedRevision: store.revision,
    reason: "Synthetic clock-in correction", changes: [{ targetId: "synthetic-0", at: "2026-10-15T15:10:00Z" }] },
  { role: "admin", code: "synthetic-admin" }, now("01:00:00"));
  assert.notDeepEqual(store.derived, derived);
  const replay = await executeAttendanceCommand(identity, original, system, now("02:00:00"));
  assert.deepEqual(replay.derived, derived);
});

test("cutoff calculation does not use slot rollover and handles month/year boundaries", () => {
  for (const at of ["2026-10-31T15:00:00Z", "2026-12-31T15:00:00Z"]) {
    fixture([event("Time In", at, 0)]);
    const session = projectAttendance(store.events).active;
    const expected = new Date(at); expected.setUTCDate(expected.getUTCDate() + 1); expected.setUTCHours(0, 5, 0, 0);
    assert.equal(attendanceAutoTimeOutCutoff(session)?.toISOString(), expected.toISOString());
  }
});

test("weekend overnight sessions close once at their own 08:05 cutoff", async () => {
  for (const day of ["2026-10-17", "2026-10-18"]) {
    fixture([event("Time In", `${day}T15:00:00Z`, 0)]);
    const cutoff = attendanceAutoTimeOutCutoff(projectAttendance(store.events).active)!;
    assert.equal(await runAttendanceAutoTimeOut(new Date(cutoff.getTime() - 1), noDelivery), 0);
    assert.equal(await runAttendanceAutoTimeOut(cutoff, noDelivery), 1);
    assert.equal(store.events.at(-1)?.at, cutoff.toISOString());
    assert.equal(store.events.at(-1)?.autoTimeOut, true);
    assert.equal(await runAttendanceAutoTimeOut(new Date(cutoff.getTime() + 3_600_000), noDelivery), 0);
    assert.equal(store.events.filter((item) => item.source === "Time Out").length, 1);
  }
});

test("policy rejects cutoffs before 08:00 and malformed HH:MM, accepting the exact end and later times", () => {
  for (const value of ["00:00", "07:00", "07:59"]) {
    assert.throws(() => validateAttendanceAutoTimeOutTime(value), { status: 422, code: "AUTO_TIME_OUT_BEFORE_SHIFT_END" });
  }
  for (const value of ["8:05", "24:00", "08:60", "invalid", 805, null, undefined]) {
    assert.throws(() => validateAttendanceAutoTimeOutTime(value), { status: 422, code: "INVALID_POLICY" });
  }
  for (const value of ["08:00", "08:05", "08:30", "23:59"]) {
    assert.doesNotThrow(() => validateAttendanceAutoTimeOutTime(value));
  }
  assert.throws(() => validateAttendanceAutoTimeOutTime("08:05", "08:30"), { code: "AUTO_TIME_OUT_BEFORE_SHIFT_END" });
});

test("a permanent command failure does not prevent a later ledger closing, and reports counts only", async () => {
  const poison = { ...copy(store), _id: "synthetic-poison-ledger", employeeCode: "synthetic-private-employee" };
  mock.method(AttendanceLedger, "find", () => ({ lean: async () => [poison, copy(store)] }) as never);
  mock.method(AttendanceLedger, "findById", (id: string) => ({ lean: async () => {
    if (id === poison._id) throw Object.assign(new Error("Synthetic private identity must not be logged"), { code: "LEDGER_CAPACITY" });
    return copy(store);
  } }) as never);
  assert.equal(await runAttendanceAutoTimeOut(now("00:05:00"), noDelivery), 1);
  assert.equal(store.events.at(-1)?.at, cutoff);
  assert.deepEqual(warnings, [["Attendance auto time-out retry counts", { scanned: 2, closed: 1, skipped: 0, failed: 1, deliveryPending: 0 }]]);
});

test("policy lookup failure is isolated per ledger before command execution", async () => {
  const poison = { ...copy(store), _id: "synthetic-policy-failure" };
  mock.method(AttendanceLedger, "find", () => ({ lean: async () => [poison, copy(store)] }) as never);
  let reads = 0;
  mock.method(AttendancePolicy, "findById", () => ({ lean: async () => {
    if (++reads === 1) throw new Error("Synthetic policy unavailable");
    return copy(policy);
  } }) as never);
  const report = await runAttendanceAutoTimeOutCycle(now("00:05:00"), noDelivery);
  assert.deepEqual(report, { scanned: 2, closed: 1, skipped: 0, failed: 1, deliveryPending: 0 });
  assert.equal(store.events.at(-1)?.at, cutoff);
});

test("malformed timeline cannot abort later ledgers", async () => {
  const malformed = { ...copy(store), events: null };
  mock.method(AttendanceLedger, "find", () => ({ lean: async () => [malformed, copy(store)] }) as never);
  assert.deepEqual(await runAttendanceAutoTimeOutCycle(now("00:05:00"), noDelivery),
    { scanned: 2, closed: 1, skipped: 0, failed: 1, deliveryPending: 0 });
});

test("expected lease races count as skipped rather than failed", async () => {
  leaseLost = true;
  assert.deepEqual(await runAttendanceAutoTimeOutCycle(now("00:05:00"), noDelivery),
    { scanned: 1, closed: 0, skipped: 1, failed: 0, deliveryPending: 0 });
});

test("delivery exceptions and partial outbox results retain a successful close and report pending counts", async () => {
  const failed = await runAttendanceAutoTimeOutCycle(now("00:05:00"), async () => { throw new Error("Synthetic delivery error"); });
  assert.deepEqual(failed, { scanned: 1, closed: 1, skipped: 0, failed: 0, deliveryPending: 1 });
  assert.ok(store.jobs.every((job) => !job.done));
  fixture();
  const partial = await runAttendanceAutoTimeOutCycle(now("00:05:00"), async () => ({
    revision: store.revision, deliveredBusinessIds: ["synthetic-a"], pendingBusinessIds: ["synthetic-b"],
  }));
  assert.deepEqual(partial, { scanned: 1, closed: 1, skipped: 0, failed: 0, deliveryPending: 1 });
  assert.ok(store.jobs.every((job) => !job.done));
});

test("disabled cycles report zero counts without scanning ledgers", async () => {
  process.env.CRM_ATTENDANCE_AUTO_TIMEOUT = "false";
  const scan = mock.method(AttendanceLedger, "find", () => { throw new Error("Disabled worker must not query"); });
  assert.deepEqual(await runAttendanceAutoTimeOutCycle(now("00:05:00"), noDelivery),
    { scanned: 0, closed: 0, skipped: 0, failed: 0, deliveryPending: 0 });
  assert.equal(scan.mock.callCount(), 0);
});

test("08:05 and later Break Out is a 409 pending response with no request-side writes; worker still closes exactly at cutoff", async () => {
  const before = copy(store);
  for (const clock of ["00:05:00", "00:05:01"]) {
    let status = 0; let body: { code?: string } = {};
    const response = { status(value: number) { status = value; return this; }, json(value: { code?: string }) { body = value; return this; } };
    try {
      await executeAttendanceCommand(identity, { commandId: crypto.randomUUID(), expectedRevision: store.revision, operation: "action", source: "Break Out" },
        { role: "employee", code: identity.code }, now(clock));
      assert.fail("Post-cutoff action must be rejected");
    } catch (error) { attendanceError(response as never, error); }
    assert.equal(status, 409);
    assert.equal(body.code, "AUTO_TIME_OUT_PENDING");
    assert.deepEqual(store, before);
  }
  assert.equal(await runAttendanceAutoTimeOut(now("00:05:15"), noDelivery), 1);
  assert.equal(store.events.at(-1)?.at, cutoff);
  assert.equal(store.events.at(-1)?.autoTimeOut, true);
});

test("08:04:59 Break Out succeeds and worker closes the open break at 08:05", async () => {
  await executeAttendanceCommand(identity, { commandId: crypto.randomUUID(), expectedRevision: store.revision, operation: "action", source: "Break Out" },
    { role: "employee", code: identity.code }, now("00:04:59"));
  assert.equal(store.events.at(-1)?.source, "Break Out");
  assert.equal(await runAttendanceAutoTimeOut(now("00:05:15"), noDelivery), 1);
  assert.deepEqual(store.events.slice(-2).map((item) => [item.source, item.at]), [["Break In", cutoff], ["Time Out", cutoff]]);
});

test("all non-checkout actions, including returns, wait for the worker once cutoff is due", async () => {
  const employee = { role: "employee" as const, code: identity.code };
  for (const source of ["Time In", "Login", "Break Out", "Lunch Break Out", "Off the Phone Out"] as const) {
    await assert.rejects(executeAttendanceCommand(identity, { commandId: crypto.randomUUID(), expectedRevision: store.revision, operation: "action", source },
      employee, now("00:05:01")), { status: 409, code: "AUTO_TIME_OUT_PENDING" });
  }
  for (const [out, source] of [["Break Out", "Break In"], ["Lunch Break Out", "Lunch Break In"], ["Off the Phone Out", "Off the Phone In"]] as const) {
    fixture(); store.events.push(event(out, "2026-10-15T23:50:00Z", 1));
    await assert.rejects(executeAttendanceCommand(identity, { commandId: crypto.randomUUID(), expectedRevision: store.revision, operation: "action", source },
      employee, now("00:05:01")), { status: 409, code: "AUTO_TIME_OUT_PENDING" });
    assert.equal(store.events.length, 2);
  }
  assert.equal(commitCalls, 0);
});

test("manual Time Out and legacy Logout keep precedence after cutoff without automatic writes", async () => {
  for (const source of ["Time Out", "Logout"] as const) {
    fixture();
    await executeAttendanceCommand(identity, { commandId: crypto.randomUUID(), expectedRevision: store.revision, operation: "action", source },
      { role: "employee", code: identity.code }, now("00:05:01"));
    assert.equal(store.events.at(-1)?.source, source);
    assert.equal(store.events.at(-1)?.at, "2026-10-16T00:05:01.000Z");
    assert.equal(store.events.at(-1)?.autoTimeOut, undefined);
    assert.equal(await runAttendanceAutoTimeOut(now("00:05:15"), noDelivery), 0);
  }
});

test("snapshot uses the configured cutoff, hides actions only when due, and never writes", () => {
  const before = copy(store);
  assert.ok(attendanceSnapshot(store, now("00:04:59"), policy).allowedActions.includes("Break Out"));
  assert.deepEqual(attendanceSnapshot(store, now("00:05:00"), policy).allowedActions, []);
  assert.ok(attendanceSnapshot(store, now("00:05:00"), { autoTimeOutTime: "08:10" }).allowedActions.includes("Break Out"));
  assert.deepEqual(attendanceSnapshot(store, now("00:10:00"), { autoTimeOutTime: "08:10" }).allowedActions, []);
  assert.deepEqual(store, before);
  process.env.CRM_ATTENDANCE_AUTO_TIMEOUT = "false";
  assert.ok(attendanceSnapshot(store, now("00:05:00"), policy).allowedActions.includes("Break Out"));
});

test("custom cutoff and disabled flag preserve pre-cutoff manual actions", async () => {
  policy.autoTimeOutTime = "08:10";
  await executeAttendanceCommand(identity, { commandId: crypto.randomUUID(), expectedRevision: store.revision, operation: "action", source: "Break Out" },
    { role: "employee", code: identity.code }, now("00:05:01"));
  assert.equal(store.events.at(-1)?.source, "Break Out");
  assert.equal(await runAttendanceAutoTimeOut(now("00:10:00"), noDelivery), 1);
  assert.equal(store.events.at(-1)?.at, "2026-10-16T00:10:00.000Z");
  fixture(); policy.autoTimeOutTime = "08:05"; process.env.CRM_ATTENDANCE_AUTO_TIMEOUT = "false";
  await executeAttendanceCommand(identity, { commandId: crypto.randomUUID(), expectedRevision: store.revision, operation: "action", source: "Break Out" },
    { role: "employee", code: identity.code }, now("00:05:01"));
  assert.equal(store.events.at(-1)?.source, "Break Out");
});

test("cutoff policy is rechecked under the lease before committing a manual action", async () => {
  let reads = 0;
  mock.method(AttendancePolicy, "findById", () => ({ lean: async () => ({ ...policy, autoTimeOutTime: ++reads === 1 ? "08:10" : "08:05" }) }) as never);
  await assert.rejects(executeAttendanceCommand(identity, { commandId: crypto.randomUUID(), expectedRevision: store.revision, operation: "action", source: "Break Out" },
    { role: "employee", code: identity.code }, now("00:05:01")), { status: 409, code: "AUTO_TIME_OUT_PENDING" });
  assert.equal(store.events.length, 1);
  assert.equal(store.commands.length, 0);
  assert.equal(commitCalls, 0);
});
