import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import { after, afterEach, before, beforeEach, mock, test } from "node:test";
import mongoose from "mongoose";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import type { AttendanceDerivedDay } from "./attendanceDerived";
import type { AttendanceCommand } from "./attendanceLedgerService";

process.env.NODE_ENV = "test";
// Legacy policy-refresh/payroll coupling remains available with explicit rollback.
process.env.CRM_PAYROLL_ACCURACY = "false";
const prefix = `att_policy_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;
const businesses = ["policy-a", "policy-b", "policy-c"];
process.env.BUSINESS_DATABASES = JSON.stringify(businesses.map((id, index) => ({ id, name: `Synthetic policy ${index}`, databaseName: `${prefix}_${index}` })));
process.env.DEFAULT_BUSINESS_ID = businesses[0];
process.env.DEFAULT_BUSINESS_DATABASE = `${prefix}_0`;
process.env.CONTROL_DATABASE_NAME = `${prefix}_control`;
process.env.CRM_ADMIN_ONE_CODE = "90000001";
process.env.CRM_ADMIN_SESSION_SECRET = crypto.randomBytes(48).toString("hex");
process.env.CRM_ATTENDANCE_INTEGRITY = "true";
process.env.CRM_ATTENDANCE_DURATION_MODEL = "true";
process.env.CRM_ATTENDANCE_HUB = "true";
process.env.CRM_ATTENDANCE_AUTO_TIMEOUT = "false";
process.env.CRM_ATTENDANCE_RECOVERY_CUTOFF = "false";
if (!process.env.CI) process.env.MONGOMS_RUNTIME_DOWNLOAD = "false";

const { createApp } = await import("../app");
const { Employee } = await import("../models/Employee");
const { Attendance } = await import("../models/Attendance");
const { AttendanceLedger, AttendancePolicy } = await import("../models/AttendanceLedger");
const { PayrollRecord } = await import("../models/Payroll");
const { SystemSettings } = await import("../models/SystemSettings");
const { getBusinessConnection, runWithBusiness } = await import("../config/tenancy");
const { setBusinessAccessForEmployeeCode } = await import("../models/BusinessUserAccess");
const { createAdminDashboardSession } = await import("../config/adminDashboardSession");
const { createAttendanceHubSession } = await import("../config/attendanceHubSession");
const { executeAttendanceCommand, resolveAttendanceIdentity, attendancePolicyRefreshCommandId } = await import("./attendanceLedgerService");
const { runAttendancePolicyRefresh } = await import("./attendancePolicyRefreshWorker");
const { retryAttendanceLedgers } = await import("./attendanceLedgerOutbox");

const admin = { role: "admin" as const, code: "90000001" };
const shiftDay = "2026-10-15";
const period = "Oct 6, 2026 - Oct 20, 2026";
const clock = Date.parse("2026-10-21T02:00:00Z");
const initialPolicy = { _id: "global-attendance", revision: 1, graceMinutes: 0, breakMinutes: 15, lunchMinutes: 60,
  shiftStart: "23:00", shiftEnd: "08:00", recoveryEnabled: false, recoveryTime: "22:59", autoTimeOutTime: "08:05" };
type Person = { code: string; ids: string[]; employeeToken: string; adminToken: string };
type Snapshot = { revision: number; policySyncPending: boolean; syncPending: boolean; derived?: AttendanceDerivedDay[];
  records: Array<{ id: string; source: string; at: string }>;
  dashboardDays: Array<{ dayKey: string; milliseconds: Record<string, number> }> };
let mongo: MongoMemoryReplSet | undefined;
let server: http.Server | undefined;
let base = "";
let counter = 0;

before(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  const uri = mongo.getUri(prefix);
  assert.equal(new URL(uri).hostname, "127.0.0.1");
  await mongoose.connect(uri);
  server = http.createServer(createApp());
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`;
});
beforeEach(async () => {
  mock.timers.enable({ apis: ["Date"], now: clock });
  await AttendanceLedger.deleteMany({});
  await AttendancePolicy.deleteMany({});
  await AttendancePolicy.create(initialPolicy);
  for (const business of businesses) await runWithBusiness(business, async () => {
    await Attendance.deleteMany({});
    await Employee.deleteMany({});
    await PayrollRecord.deleteMany({});
    await SystemSettings.deleteMany({});
    await SystemSettings.create({ key: "system", officialShiftStartTime: "23:00", officialShiftEndTime: "08:00", attendanceTimeZone: "Asia/Manila",
      lateGraceMinutes: 0, officialFirstBreakStartTime: "01:00", officialFirstBreakEndTime: "01:01",
      officialSecondBreakStartTime: "04:00", officialSecondBreakEndTime: "04:01", officialLunchBreakStartTime: "06:00", officialLunchBreakEndTime: "06:01" });
  });
});
afterEach(() => { mock.restoreAll(); mock.timers.reset(); });
after(async () => {
  mock.restoreAll(); mock.timers.reset();
  try {
    if (server?.listening) {
      const closed = new Promise<void>((resolve, reject) => server!.close((error) => error ? reject(error) : resolve()));
      server.closeAllConnections();
      await closed;
    }
  } finally { try { await mongoose.disconnect(); } finally { await mongo?.stop(); } }
});

async function person(): Promise<Person> {
  const code = String(97000000 + counter++);
  const ids: string[] = [];
  for (const business of businesses) await runWithBusiness(business, async () => {
    const employee = await Employee.create({ employeeCode: code, name: "Synthetic policy employee", role: "Test", team: "Policy fixture",
      salary: 30000, dateHired: "2026-10-01", businessAccessIds: businesses });
    ids.push(String(employee._id));
  });
  await setBusinessAccessForEmployeeCode(code, businesses);
  const employeeToken = createAttendanceHubSession(code); const adminToken = createAdminDashboardSession(admin.code);
  assert.ok(employeeToken); assert.ok(adminToken);
  return { code, ids, employeeToken, adminToken };
}
async function request<T>(who: Person, path: string, options: { method?: string; body?: unknown; business?: number; employee?: boolean;
  forged?: boolean; expected?: number } = {}): Promise<T> {
  const headers: Record<string, string> = { "Content-Type": "application/json", "X-Business-Id": businesses[options.business ?? 0] };
  if (options.forged) { headers["X-CRM-Admin-Session"] = "synthetic.forged"; headers["X-CRM-User-Type"] = "admin"; headers["X-CRM-User-Code"] = admin.code; }
  else headers[options.employee ? "X-CRM-Attendance-Session" : "X-CRM-Admin-Session"] = options.employee ? who.employeeToken : who.adminToken;
  const response = await fetch(`${base}${path}`, { method: options.method ?? "GET", headers,
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }) });
  const data = await response.json();
  assert.equal(response.status, options.expected ?? 200, `${path}: ${JSON.stringify(data)}`);
  return data as T;
}
const session = (who: Person, business = 0) => request<Snapshot>(who, `/employees/${who.ids[business]}/attendance/session`, { business, employee: true });
async function seed(who: Person, breakMinutes = 20) {
  const input: AttendanceCommand = { commandId: crypto.randomUUID(), expectedRevision: 0, operation: "correct", reason: "Synthetic policy fixture",
    changes: [{ source: "Time In", at: `${shiftDay}T15:00:00Z` }, { source: "Break Out", at: `${shiftDay}T17:00:00Z` },
      { source: "Break In", at: `${shiftDay}T17:${String(breakMinutes).padStart(2, "0")}:00Z` }, { source: "Time Out", at: "2026-10-16T00:00:00Z" }] };
  const result = await request<Snapshot>(who, `/employees/${who.ids[0]}/attendance/commands`, { method: "POST", body: input });
  assert.equal(result.syncPending, false);
  return { input, result };
}
async function savePolicy(who: Person, changes: Record<string, unknown> = {}) {
  const policy = await request<Record<string, unknown>>(who, "/attendance-policy");
  return request<{ revision: number; policySyncPending: boolean }>(who, "/attendance-policy", {
    method: "PUT", body: { ...policy, ...changes, expectedRevision: policy.revision },
  });
}
async function ledger(who: Person) {
  const result = await AttendanceLedger.findOne({ employeeCode: who.code }).lean();
  assert.ok(result); return result;
}
async function evidence(who: Person) {
  const current = await ledger(who);
  return JSON.stringify({ events: current.events, corrections: current.corrections, closures: current.closures });
}
async function parity(who: Person, excess: number, policyRevision: number) {
  const canonical = await ledger(who);
  assert.equal(canonical.derived?.[0].excessBreakMinutes, excess);
  assert.equal(canonical.derived?.[0].policyRevision, policyRevision);
  for (const [index, business] of businesses.entries()) {
    const fresh = await session(who, index);
    assert.equal(fresh.policySyncPending, false); assert.equal(fresh.syncPending, false);
    assert.equal(fresh.derived?.[0].excessBreakMinutes, excess);
    assert.equal(fresh.derived?.[0].policyRevision, policyRevision);
    assert.equal(fresh.dashboardDays.find((day) => day.dayKey === shiftDay)?.milliseconds.overBreak, excess * 60_000);
    const hub = await request<{ rows: Array<{ milliseconds: Record<string, number> }> }>(who,
      `/attendance-hub/days?shiftView=date&shiftDate=${shiftDay}&employee=${who.code}&business=${business}`, { business: index });
    assert.equal(hub.rows[0]?.milliseconds.overBreak, excess * 60_000);
    const payroll = await request<{ rows: Array<{ dateKey: string; excessBreakMinutes: number }> }>(who,
      `/payroll/dtr/${who.ids[index]}?payPeriod=${encodeURIComponent(period)}`, { business: index });
    assert.equal(payroll.rows.find((row) => row.dateKey === shiftDay)?.excessBreakMinutes, excess);
    await runWithBusiness(business, async () => {
      const copies = await Attendance.find({ employee: who.ids[index] }).lean();
      assert.equal(copies.length, 4);
      for (const copy of copies) { assert.equal(copy.derived?.excessBreakMinutes, excess); assert.equal(copy.derived?.policyRevision, policyRevision); }
      const storedPayroll = await PayrollRecord.findOne({ employeeId: who.code, payPeriod: period, isArchived: false }).lean();
      assert.ok(storedPayroll); assert.equal(storedPayroll.excessBreakMinutes, excess);
    });
  }
}

test("HTTP policy change retroactively refreshes already-derived canonical, replicas, dashboard, hub and actual payroll", async () => {
  const who = await person(); const original = await seed(who);
  await parity(who, 5, 1);
  const before = await evidence(who);
  const saved = await savePolicy(who, { breakMinutes: 30 });
  assert.equal(saved.revision, 2); assert.equal(saved.policySyncPending, false);
  await parity(who, 0, 2);
  assert.equal(await evidence(who), before, "policy recomputation must not add, replace or remove attendance events");
  const current = await ledger(who);
  const audit = current.audit.find((entry) => entry.operation === "recalculate-policy");
  assert.ok(audit); assert.equal(audit.beforeDerived?.[0].excessBreakMinutes, 5); assert.equal(audit.afterDerived?.[0].excessBreakMinutes, 0);
  const identity = await runWithBusiness(businesses[0], () => resolveAttendanceIdentity(who.ids[0], admin));
  const snapshotBeforeReplay = JSON.stringify(await ledger(who));
  const replay = await executeAttendanceCommand(identity, original.input, admin);
  assert.ok("replayed" in replay && replay.replayed);
  assert.equal(replay.derived?.[0].excessBreakMinutes, 5); assert.equal(replay.derived?.[0].policyRevision, 1);
  assert.equal(JSON.stringify(await ledger(who)), snapshotBeforeReplay);
});

test("HTTP policy save reports partial delivery without rollback; background retry repairs only the pending business", async () => {
  const who = await person(); await seed(who);
  const before = await evidence(who);
  const attempts = new Map(businesses.map((business) => [business, 0]));
  let failing = true;
  for (const business of businesses) {
    const model = getBusinessConnection(business).model("Attendance");
    const original = model.bulkWrite.bind(model);
    mock.method(model, "bulkWrite", (async (...args: Parameters<typeof model.bulkWrite>) => {
      attempts.set(business, attempts.get(business)! + 1);
      if (business === businesses[1] && failing) throw new Error("Synthetic policy replica failure");
      return original(...args);
    }) as never);
  }
  const saved = await savePolicy(who, { breakMinutes: 30 });
  assert.equal(saved.revision, 2); assert.equal(saved.policySyncPending, true);
  assert.equal((await AttendancePolicy.findById("global-attendance").lean())?.revision, 2);
  const current = await ledger(who);
  assert.equal(current.derived?.[0].excessBreakMinutes, 0);
  assert.deepEqual([...new Set(current.jobs.filter((job) => !job.done).map((job) => job.businessId))], [businesses[1]]);
  const beforePolicyGets = JSON.stringify(current);
  for (let refresh = 0; refresh < 2; refresh++) {
    const freshPolicy = await request<{ revision: number; policySyncPending: boolean }>(who, "/attendance-policy");
    assert.equal(freshPolicy.revision, 2); assert.equal(freshPolicy.policySyncPending, true);
  }
  assert.equal(JSON.stringify(await ledger(who)), beforePolicyGets, "policy GET invalidations must retain pending notification without writes");
  const pending = await session(who, 1);
  assert.equal(pending.syncPending, true); assert.equal(pending.derived?.[0].excessBreakMinutes, 0);
  await runWithBusiness(businesses[1], async () => {
    const copy = await Attendance.findOne({ employee: who.ids[1] }).lean();
    assert.equal(copy?.derived?.excessBreakMinutes, 5); assert.equal(copy?.derived?.policyRevision, 1);
  });
  const attemptsBefore = new Map(attempts); const revision = current.revision;
  failing = false;
  await runAttendancePolicyRefresh();
  await retryAttendanceLedgers();
  assert.equal(attempts.get(businesses[0]), attemptsBefore.get(businesses[0]));
  assert.equal(attempts.get(businesses[2]), attemptsBefore.get(businesses[2]));
  assert.equal(attempts.get(businesses[1]), attemptsBefore.get(businesses[1])! + 1);
  assert.equal((await ledger(who)).revision, revision, "delivery retry must not drift canonical revision or calculations");
  assert.equal(await evidence(who), before);
  await parity(who, 0, 2);
  const freshPolicy = await request<{ policySyncPending: boolean }>(who, "/attendance-policy");
  assert.equal(freshPolicy.policySyncPending, false);
});

test("stale-policy GET presents explicitly pending current calculations without writing a revision; worker persists them later", async () => {
  const who = await person(); await seed(who);
  const original = AttendanceLedger.findOneAndUpdate.bind(AttendanceLedger);
  const failure = mock.method(AttendanceLedger, "findOneAndUpdate", ((...args: unknown[]) => {
    const update = args[1] as { $push?: { audit?: { operation?: string } } };
    if (update?.$push?.audit?.operation === "recalculate-policy") return { lean: async () => { throw new Error("Synthetic policy commit failure"); } };
    return Reflect.apply(original, AttendanceLedger, args);
  }) as never);
  const saved = await savePolicy(who, { breakMinutes: 30 });
  assert.equal(saved.policySyncPending, true); assert.equal(saved.revision, 2);
  const before = JSON.stringify(await ledger(who));
  assert.equal((await request<{ policySyncPending: boolean }>(who, "/attendance-policy")).policySyncPending, true);
  for (let index = 0; index < businesses.length; index++) {
    const fresh = await session(who, index);
    assert.equal(fresh.policySyncPending, true); assert.equal(fresh.syncPending, true);
    assert.equal(fresh.derived?.[0].excessBreakMinutes, 0); assert.equal(fresh.derived?.[0].policyRevision, 2);
  }
  assert.equal(JSON.stringify(await ledger(who)), before, "fresh GETs must not persist their provisional calculations");
  assert.equal((await ledger(who)).derived?.[0].excessBreakMinutes, 5);
  failure.mock.restore();
  await runAttendancePolicyRefresh();
  await parity(who, 0, 2);
  assert.equal((await request<{ policySyncPending: boolean }>(who, "/attendance-policy")).policySyncPending, false);
});

test("employee and forged policy changes are denied; system-only refresh is not a public attendance operation", async () => {
  const who = await person(); await seed(who);
  const before = JSON.stringify(await AttendancePolicy.findById("global-attendance").lean());
  const body = { ...initialPolicy, breakMinutes: 30, expectedRevision: 1 };
  await request(who, "/attendance-policy", { method: "PUT", body, employee: true, expected: 403 });
  await request(who, "/attendance-policy", { method: "PUT", body, forged: true, expected: 401 });
  await request(who, "/attendance-policy", { employee: true, expected: 403 });
  const command: AttendanceCommand = { commandId: attendancePolicyRefreshCommandId(2), expectedRevision: (await ledger(who)).revision,
    operation: "recalculate-policy", policyRevision: 2, reason: "Synthetic forbidden request" };
  await request(who, `/employees/${who.ids[0]}/attendance/commands`, { method: "POST", body: command, expected: 422 });
  const identity = await runWithBusiness(businesses[0], () => resolveAttendanceIdentity(who.ids[0], admin));
  await assert.rejects(executeAttendanceCommand(identity, command, admin), { status: 403, code: "SYSTEM_ONLY" });
  assert.equal(JSON.stringify(await AttendancePolicy.findById("global-attendance").lean()), before);
});

test("policy refresh never adopts legacy history or backfills canonical ledgers with undefined derived values", async () => {
  const legacy = await person();
  for (const [index, business] of businesses.entries()) await runWithBusiness(business, () => Attendance.create([
    { employee: legacy.ids[index], source: "Login", timeIn: new Date(`${shiftDay}T15:00:00Z`) },
    { employee: legacy.ids[index], source: "Logout", timeIn: new Date("2026-10-16T00:00:00Z") },
  ]));
  const missing = await person(); await seed(missing);
  await AttendanceLedger.updateOne({ employeeCode: missing.code }, { $unset: { derived: "", derivedBaseline: "" } });
  const before = JSON.stringify(await ledger(missing));
  const copiesBefore = await Promise.all(businesses.map((business, index) => runWithBusiness(business, async () => JSON.stringify(
    await Attendance.find({ employee: { $in: [legacy.ids[index], missing.ids[index]] } }).sort({ _id: 1 }).lean()))));
  const saved = await savePolicy(missing, { breakMinutes: 30 });
  assert.equal(saved.policySyncPending, false);
  await runAttendancePolicyRefresh();
  await session(legacy); await session(missing);
  assert.equal(await AttendanceLedger.countDocuments({ employeeCode: legacy.code }), 0);
  assert.equal(JSON.stringify(await ledger(missing)), before);
  for (const [index, business] of businesses.entries()) {
    const after = await runWithBusiness(business, async () => JSON.stringify(await Attendance.find({ employee: { $in: [legacy.ids[index], missing.ids[index]] } }).sort({ _id: 1 }).lean()));
    assert.equal(after, copiesBefore[index]);
  }
});

test("partial-derived ledger policy refresh updates only existing day keys without backfilling older canonical or replica days", async () => {
  const who = await person(); const original = await seed(who);
  const omittedDay = "2026-10-14";
  await request(who, `/employees/${who.ids[0]}/attendance/commands`, { method: "POST", body: {
    commandId: crypto.randomUUID(), expectedRevision: original.result.revision, operation: "correct", reason: "Synthetic partial-history fixture",
    changes: [{ source: "Time In", at: `${omittedDay}T15:00:00Z` }, { source: "Break Out", at: `${omittedDay}T17:00:00Z` },
      { source: "Break In", at: `${omittedDay}T17:20:00Z` }, { source: "Time Out", at: "2026-10-15T00:00:00Z" }],
  } });
  const complete = await ledger(who);
  const historical = complete.derived?.find((day) => day.dayKey === omittedDay);
  assert.ok(historical);
  const retained = complete.derived!.filter((day) => day.dayKey === shiftDay);
  await AttendanceLedger.updateOne({ _id: complete._id }, { $set: { derived: retained } });
  for (const [index, business] of businesses.entries()) await runWithBusiness(business, () => Attendance.updateMany(
    { employee: who.ids[index], eventId: { $in: historical.eventIds } }, { $unset: { derived: "" } },
  ));
  const before = await evidence(who);
  const saved = await savePolicy(who, { breakMinutes: 30 });
  assert.equal(saved.policySyncPending, false);
  const refreshed = await ledger(who);
  assert.deepEqual(refreshed.derived?.map((day) => day.dayKey), [shiftDay], "policy refresh must not widen the already-derived day set");
  assert.equal(refreshed.derived?.[0].excessBreakMinutes, 0);
  assert.equal(refreshed.derived?.[0].policyRevision, 2);
  const audit = refreshed.audit.find((entry) => entry.operation === "recalculate-policy");
  assert.ok(audit);
  assert.deepEqual(audit.beforeDerived?.map((day) => day.dayKey), [shiftDay]);
  assert.deepEqual(audit.afterDerived?.map((day) => day.dayKey), [shiftDay]);
  assert.equal(await evidence(who), before);
  for (const [index, business] of businesses.entries()) await runWithBusiness(business, async () => {
    const untouched = await Attendance.find({ employee: who.ids[index], eventId: { $in: historical.eventIds } }).lean();
    assert.equal(untouched.length, 4);
    assert.ok(untouched.every((record) => record.derived === undefined), "un-derived historical replicas must stay un-derived");
    const updated = await Attendance.find({ employee: who.ids[index], eventId: { $in: retained[0].eventIds } }).lean();
    assert.equal(updated.length, 4);
    assert.ok(updated.every((record) => record.derived?.policyRevision === 2 && record.derived.excessBreakMinutes === 0));
  });
  assert.equal((await session(who)).policySyncPending, false);
  assert.equal((await runAttendancePolicyRefresh()).refreshed, 0);
});

test("unchanged monetary values still persist policy-revision metadata and replay the original command snapshot", async () => {
  const who = await person(); const original = await seed(who, 15);
  await parity(who, 0, 1);
  const before = await evidence(who);
  const saved = await savePolicy(who, { breakMinutes: 30 });
  assert.equal(saved.policySyncPending, false);
  await parity(who, 0, 2);
  const current = await ledger(who);
  const audit = current.audit.find((entry) => entry.operation === "recalculate-policy");
  assert.ok(audit); assert.deepEqual(audit.afterDerived, []); assert.deepEqual(audit.beforeDerived, []);
  assert.equal(audit.derivedMetadata?.find((day) => day.dayKey === shiftDay)?.policyRevision, 2);
  const identity = await runWithBusiness(businesses[0], () => resolveAttendanceIdentity(who.ids[0], admin));
  const replay = await executeAttendanceCommand(identity, original.input, admin);
  assert.ok("replayed" in replay && replay.replayed);
  assert.equal(replay.derived?.[0].policyRevision, 1); assert.equal(replay.derived?.[0].deductibleMinutes, 0);
  assert.equal(await evidence(who), before);
  const beforePolicyReplay = JSON.stringify(await ledger(who));
  const reordered: AttendanceCommand = { reason: "Apply administrator attendance policy revision", commandId: attendancePolicyRefreshCommandId(2),
    expectedRevision: current.revision, policyRevision: 2, operation: "recalculate-policy" };
  const policyReplay = await executeAttendanceCommand(identity, reordered, { role: "system", code: "attendance-policy-refresh" });
  assert.ok("replayed" in policyReplay && policyReplay.replayed);
  assert.equal(policyReplay.derived?.[0].policyRevision, 2);
  assert.equal(JSON.stringify(await ledger(who)), beforePolicyReplay, "reordered idempotent policy replay must not commit another revision");
  assert.equal((await runAttendancePolicyRefresh()).refreshed, 0);
});
