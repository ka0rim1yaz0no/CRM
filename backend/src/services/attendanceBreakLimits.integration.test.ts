import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import { after, afterEach, before, beforeEach, mock, test } from "node:test";
import mongoose from "mongoose";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import type { AttendanceDerivedDay } from "./attendanceDerived";
import type { AttendanceSource } from "../models/Attendance";

process.env.NODE_ENV = "test";
const prefix = `att_break_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;
const businesses = Array.from({ length: 6 }, (_, index) => `test-${index}`);
process.env.BUSINESS_DATABASES = JSON.stringify(businesses.map((id, index) => ({ id,
  name: `Synthetic break limits ${index}`, databaseName: `${prefix}_${index}` })));
process.env.DEFAULT_BUSINESS_ID = businesses[0];
process.env.DEFAULT_BUSINESS_DATABASE = `${prefix}_0`;
process.env.CONTROL_DATABASE_NAME = `${prefix}_control`;
process.env.CRM_ADMIN_ONE_CODE = "90000001";
process.env.CRM_ADMIN_SESSION_SECRET = crypto.randomBytes(48).toString("hex");
process.env.CRM_ATTENDANCE_INTEGRITY = "true";
process.env.CRM_ATTENDANCE_DURATION_MODEL = "true";
process.env.CRM_ATTENDANCE_HUB = "true";
delete process.env.CRM_ATTENDANCE_BREAK_GAP;
process.env.CRM_ATTENDANCE_AUTO_TIMEOUT = "false";
process.env.CRM_ATTENDANCE_RECOVERY_CUTOFF = "false";
if (!process.env.CI) process.env.MONGOMS_RUNTIME_DOWNLOAD = "false";

const { createApp } = await import("../app");
const { Employee } = await import("../models/Employee");
const { Attendance } = await import("../models/Attendance");
const { AttendanceLedger, AttendancePolicy } = await import("../models/AttendanceLedger");
const { SystemSettings } = await import("../models/SystemSettings");
const { PayrollRecord } = await import("../models/Payroll");
const { runWithBusiness } = await import("../config/tenancy");
const { setBusinessAccessForEmployeeCode } = await import("../models/BusinessUserAccess");
const { createAttendanceHubSession } = await import("../config/attendanceHubSession");
const { createAdminDashboardSession } = await import("../config/adminDashboardSession");

const shiftDay = "2026-10-19";
const start = Date.parse(`${shiftDay}T15:00:00Z`);
const at = (seconds: number) => new Date(start + seconds * 1000).toISOString();
type Snapshot = { revision: number; fingerprint: string; state: string; reviewState: string; syncPending: boolean;
  sessionId: string; allowedActions: string[]; coachingBilling?: import("../../../shared/attendanceCoaching").CoachingBillingSnapshot;
  offPhoneBilling?: import("../../../shared/attendanceOffPhone").OffPhoneBillingSnapshot;
  records: Array<{ id: string; source: AttendanceSource; at: string }>;
  derived: AttendanceDerivedDay[]; allowances: { breakMinutes: number; lunchMinutes: number };
  dashboardDays: Array<{ dayKey: string; milliseconds: Record<string, number> }> };
type Person = { code: string; ids: string[]; employeeToken: string; adminToken: string };
let mongo: MongoMemoryReplSet | undefined;
let server: http.Server | undefined;
let base = "";
let counter = 0;

before(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  const uri = mongo.getUri(prefix);
  assert.equal(new URL(uri).hostname, "127.0.0.1");
  await mongoose.connect(uri);
  await AttendancePolicy.create({ _id: "global-attendance", revision: 1, graceMinutes: 0,
    breakMinutes: 15, lunchMinutes: 60, shiftStart: "23:00", shiftEnd: "08:00",
    recoveryEnabled: false, recoveryTime: "22:59", autoTimeOutTime: "08:05" });
  // Deliberately contradictory legacy windows must not become duration allowances.
  for (const [index, business] of businesses.entries()) await runWithBusiness(business, () => SystemSettings.create({
    key: "system", officialShiftStartTime: "23:00", officialShiftEndTime: "08:00", lateGraceMinutes: 0,
    attendanceTimeZone: "Asia/Manila", officialFirstBreakStartTime: "01:00", officialFirstBreakEndTime: `01:0${index + 1}`,
    officialSecondBreakStartTime: "04:00", officialSecondBreakEndTime: `04:0${index + 1}`,
    officialLunchBreakStartTime: "06:00", officialLunchBreakEndTime: `06:0${index + 1}`,
  }));
  server = http.createServer(createApp());
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`;
});
beforeEach(() => mock.timers.enable({ apis: ["Date"], now: start }));
afterEach(() => mock.timers.reset());
after(async () => {
  mock.timers.reset();
  try {
    if (server?.listening) {
      const closed = new Promise<void>((resolve, reject) => server!.close((error) => error ? reject(error) : resolve()));
      server.closeAllConnections();
      await closed;
    }
  } finally {
    try { await mongoose.disconnect(); } finally { await mongo?.stop(); }
  }
});

async function fixture(): Promise<Person> {
  const code = String(96000000 + counter++);
  const ids: string[] = [];
  for (const business of businesses) await runWithBusiness(business, async () => {
    const employee = await Employee.create({ employeeCode: code, name: "Synthetic break limits employee", role: "Test",
      team: "Break limits fixture", dateHired: "2026-10-01", businessAccessIds: businesses, salary: 30000 });
    ids.push(String(employee._id));
  });
  await setBusinessAccessForEmployeeCode(code, businesses);
  const employeeToken = createAttendanceHubSession(code);
  const adminToken = createAdminDashboardSession("90000001");
  assert.ok(employeeToken); assert.ok(adminToken);
  return { code, ids, employeeToken, adminToken };
}

async function request<T>(person: Person, index: number, path: string, options: {
  admin?: boolean; body?: unknown; expected?: number;
} = {}): Promise<T> {
  const response = await fetch(`${base}${path}`, { method: options.body === undefined ? "GET" : "POST",
    headers: { "Content-Type": "application/json", "X-Business-Id": businesses[index],
      [options.admin ? "X-CRM-Admin-Session" : "X-CRM-Attendance-Session"]: options.admin ? person.adminToken : person.employeeToken },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }) });
  const data = await response.json();
  assert.equal(response.status, options.expected ?? 200, `${path}: ${JSON.stringify(data)}`);
  return data as T;
}
const session = (person: Person, index = 0) => request<Snapshot>(person, index, `/employees/${person.ids[index]}/attendance/session`);
async function action<T = Snapshot>(person: Person, source: AttendanceSource, seconds: number, expected = 200, index = 0) {
  mock.timers.setTime(start + seconds * 1000);
  const current = await session(person, index);
  return request<T>(person, index, `/employees/${person.ids[index]}/attendance/commands`, { expected,
    body: { commandId: crypto.randomUUID(), expectedRevision: current.revision, fingerprint: current.fingerprint, operation: "action", source } });
}

async function core(person: Person) {
  const ledger = await AttendanceLedger.findOne({ employeeCode: person.code }).lean();
  const replicas = [];
  for (const [index, business] of businesses.entries()) replicas.push(await runWithBusiness(business, async () => ({
    attendance: await Attendance.collection.find({ employee: new mongoose.Types.ObjectId(person.ids[index]) }).sort({ _id: 1 }).toArray(),
    employee: await Employee.findById(person.ids[index]).select("availabilityStatus attendanceRevision activeAttendanceSessionId").lean(),
    payroll: await PayrollRecord.find({ employeeId: person.code }).sort({ _id: 1 }).lean(),
  })));
  // Lease ownership and fence counters are allowed to change on rejected commands.
  return JSON.stringify({ revision: ledger?.revision ?? 0, events: ledger?.events ?? [], corrections: ledger?.corrections ?? [],
    closures: ledger?.closures ?? [], audit: ledger?.audit ?? [], commands: ledger?.commands ?? [], jobs: ledger?.jobs ?? [],
    derived: ledger?.derived ?? [], derivedBaseline: ledger?.derivedBaseline ?? null, replicas });
}

async function rejectAction(person: Person, source: AttendanceSource, seconds: number, message?: string) {
  const before = await core(person);
  const rejected = await action<{ code: string; message: string }>(person, source, seconds, 409);
  assert.equal(rejected.code, "ATTENDANCE_ACTION_CONFLICT");
  if (message) assert.equal(rejected.message, message);
  assert.equal(await core(person), before, `${source} rejection must not write attendance, revision, audit, outbox, payroll, or availability`);
}

test("HTTP: Coaching returns ONLINE exactly at its separate shift boundary in all six businesses and freezes paid records", async () => {
  const { runAttendanceCoachingReturns } = await import("./attendanceCoachingWorker");
  const person = await fixture();
  const payrollEvidence = async () => Promise.all(businesses.map(business => runWithBusiness(business, () => PayrollRecord.find({ employeeId: person.code }).sort({ _id: 1 }).lean())));
  for (const business of businesses) await runWithBusiness(business, async () => {
    await Employee.updateOne({ employeeCode: person.code }, { role: "Sales" });
    for (const status of ["Paid", "Completed"]) await PayrollRecord.collection.insertOne({ employeeId: person.code, employeeName: "Synthetic employee",
      status, grossPay: 100, deductions: 5, netPay: 95, paidOn: new Date(start - 86_400_000), payPeriod: "Synthetic protected history" });
  });
  const paidBefore = await payrollEvidence();
  await action(person, "Time In", 0);
  await action(person, "Coaching Out", 60);
  await action(person, "Coaching In", 660);
  await action(person, "Time Out", 700);
  await action(person, "Time In", 800);
  await action(person, "Coaching Out", 900);
  mock.timers.setTime(start + 1200 * 1000);
  for (const index of businesses.keys()) {
    const view = await session(person, index);
    assert.equal(view.coachingBilling?.remainingPaidMs, 300_000);
    assert.equal(view.coachingBilling?.active?.returnAt, at(1500));
    assert.equal(view.coachingBilling?.totalMs, 900_000);
    assert.ok(!view.allowedActions.includes("Off the Phone In"));
  }
  mock.timers.setTime(start + 1_499_999);
  assert.equal(await runAttendanceCoachingReturns(new Date()), 0);
  const before = await AttendanceLedger.findOne({ employeeCode: person.code }).lean();
  mock.timers.setTime(start + 1_500_000);
  const returns = await Promise.all([runAttendanceCoachingReturns(new Date()), runAttendanceCoachingReturns(new Date())]);
  assert.equal(returns.reduce((sum, count) => sum + count, 0), 1);
  assert.equal(await runAttendanceCoachingReturns(new Date()), 0);
  for (const index of businesses.keys()) {
    const view = await session(person, index);
    assert.equal(view.state, "ONLINE");
    assert.equal(view.coachingBilling?.remainingPaidMs, 0);
    assert.equal(view.coachingBilling?.totalMs, 1_200_000);
    assert.equal(view.coachingBilling?.active, null);
    assert.ok(!view.allowedActions.includes("Coaching Out"));
    assert.equal(view.derived[0].nonBillableOffPhoneMinutes, 0);
    const businessAttendance = await runWithBusiness(businesses[index], () => Attendance.find({ employee: person.ids[index] }).lean());
    assert.equal(businessAttendance.filter(row => row.source === "Coaching In").length, 2);
    assert.equal(businessAttendance.find(row => row.source === "Coaching In" && row.timeIn.toISOString() === at(1500))?.timeIn.toISOString(), at(1500));
  }
  const after = await AttendanceLedger.findOne({ employeeCode: person.code }).lean();
  assert.deepEqual(after?.events.slice(0, before!.events.length), before?.events, "original punches remain intact");
  assert.equal(after?.audit.at(-1)?.operation, "coaching-return");
  assert.equal(after?.audit.at(-1)?.actor.role, "system");
  assert.deepEqual(await payrollEvidence(), paidBefore);
  const rejected = await action<{ code: string }>(person, "Coaching Out", 1600, 409, 5);
  assert.equal(rejected.code, "COACHING_ALLOWANCE_EXHAUSTED");
  await action(person, "Off the Phone Out", 1700);
  await action(person, "Off the Phone In", 1760);
  await action(person, "Time Out", 1800);
  mock.timers.setTime(start + 86_400_000);
  person.employeeToken = createAttendanceHubSession(person.code)!;
  await action(person, "Time In", 86_400);
  const next = await action(person, "Coaching Out", 86_460);
  assert.equal(next.coachingBilling?.remainingPaidMs, 1_200_000);
  assert.deepEqual(await payrollEvidence(), paidBefore);
});

test("HTTP: manual Coaching return, checkout and shift end cannot leave a duplicate or non-billable Coaching interval", async () => {
  const { runAttendanceCoachingReturns } = await import("./attendanceCoachingWorker");
  for (const source of ["Coaching In", "Time Out"] as const) {
    mock.timers.setTime(start);
    const person = await fixture();
    await action(person, "Time In", 0); await action(person, "Coaching Out", 60);
    await action(person, source, 1250);
    mock.timers.setTime(start + 1300 * 1000);
    assert.equal(await runAttendanceCoachingReturns(new Date()), 0);
    const view = await session(person);
    assert.equal(view.records.filter(row => row.source === "Coaching In").length, 1);
  }
  mock.timers.setTime(start);
  const person = await fixture();
  await action(person, "Time In", 0); await action(person, "Coaching Out", 9 * 3600 - 300);
  mock.timers.setTime(start + (9 * 3600 + 10) * 1000);
  assert.equal(await runAttendanceCoachingReturns(new Date()), 1);
  const view = await session(person);
  assert.equal(view.state, "ONLINE");
  assert.equal(view.records.at(-1)?.at, at(9 * 3600));
  assert.equal(view.derived[0].nonBillableOffPhoneMinutes, 0);
});

test("HTTP: one off-phone budget survives refresh, checkout, new Time In, automatic non-billable excess and Undo in all six businesses", async () => {
  const oldLimit = process.env.CRM_OFF_PHONE_PAID_LIMIT_FROM;
  process.env.CRM_OFF_PHONE_PAID_LIMIT_FROM = new Date(start).toISOString();
  try {
    const person = await fixture();
    for (const business of businesses) await runWithBusiness(business, () => Employee.updateOne({ employeeCode: person.code }, { role: "Sales" }));
    await action(person, "Time In", 0); await action(person, "Off the Phone Out", 60); await action(person, "Off the Phone In", 660);
    await action(person, "Time Out", 900); await action(person, "Time In", 1200); await action(person, "Off the Phone Out", 1800);
    mock.timers.setTime(start + 2400 * 1000);
    for (const index of businesses.keys()) {
      const view = await session(person, index);
      assert.equal(view.offPhoneBilling?.remainingPaidMs, 0);
      assert.equal(view.offPhoneBilling?.active?.nonBillableFrom, at(2400));
      assert.equal(view.dashboardDays[0].milliseconds.nonBillableOffPhone, 0);
    }
    mock.timers.setTime(start + 2401 * 1000);
    const unchanged = await core(person);
    for (const index of businesses.keys()) for (let refresh = 0; refresh < 2; refresh++) {
      const view = await session(person, index);
      assert.equal(view.state, "OFF THE PHONE"); assert.equal(view.offPhoneBilling?.remainingPaidMs, 0);
      assert.equal(view.dashboardDays[0].milliseconds.nonBillableOffPhone, 1000);
      const hub = await request<{ rows: Array<{ nonBillableOffPhoneMinutes: number }> }>(person, index,
        `/attendance-hub/days?preset=custom&from=${shiftDay}&to=${shiftDay}&employee=${person.code}`, { admin: true });
      assert.equal(hub.rows[0].nonBillableOffPhoneMinutes, 1);
      const dashboard = await request<{ employees: Array<{ employeeCode: string; offPhoneNonBillable: boolean }> }>(person, index, "/call-dashboard", { admin: true });
      assert.equal(dashboard.employees.find(row => row.employeeCode === person.code)?.offPhoneNonBillable, true);
    }
    assert.equal(await core(person), unchanged, "boundary reads cannot manufacture attendance events or change payroll");
    await action(person, "Off the Phone In", 2401); await action(person, "Off the Phone Out", 2500); await action(person, "Off the Phone In", 2501);
    await action(person, "Time Out", 2600);
    const beforeUndo = await session(person);
    assert.equal(beforeUndo.derived[0].nonBillableOffPhoneMinutes, 2);
    assert.equal(beforeUndo.records.filter(event => event.source === "Non-Billable Off the Phone Out").length, 0, "automatic billing retains original punches");
    const result = await request<Snapshot>(person, 0, `/employees/${person.ids[0]}/attendance/commands`, { admin: true, body: {
      commandId: crypto.randomUUID(), operation: "correct", expectedRevision: beforeUndo.revision, fingerprint: beforeUndo.fingerprint,
      reason: "Reverse the first synthetic paid off-phone interval without changing later actions",
      changes: beforeUndo.records.slice(1, 3).map(event => ({ targetId: event.id, remove: true })),
    } });
    assert.equal(result.state, "OFFLINE");
    for (const index of businesses.keys()) assert.equal((await session(person, index)).derived[0].nonBillableOffPhoneMinutes, 0);
  } finally { if (oldLimit === undefined) delete process.env.CRM_OFF_PHONE_PAID_LIMIT_FROM; else process.env.CRM_OFF_PHONE_PAID_LIMIT_FROM = oldLimit; }
});

test("HTTP: non-billable off-phone is exclusive, idempotent, closes on checkout and refreshes in six businesses", async () => {
  const person = await fixture();
  await action(person, "Time In", 0);
  await action(person, "Non-Billable Off the Phone Out", 60);
  const current = await session(person);
  const command = { commandId: crypto.randomUUID(), expectedRevision: current.revision, fingerprint: current.fingerprint, operation: "action", source: "Off the Phone In" };
  await rejectAction(person, "Break Out", 61);
  await rejectAction(person, "Off the Phone Out", 62);
  await rejectAction(person, "Non-Billable Off the Phone Out", 63);
  mock.timers.setTime(start + 121000);
  const returned = await request<Snapshot>(person, 0, `/employees/${person.ids[0]}/attendance/commands`, { body: command });
  const replay = await request<Snapshot>(person, 0, `/employees/${person.ids[0]}/attendance/commands`, { body: command });
  assert.equal(returned.revision, replay.revision);
  await action(person, "Off the Phone Out", 180);
  await action(person, "Off the Phone In", 1200);
  await action(person, "Non-Billable Off the Phone Out", 1800);
  await action(person, "Time Out", 1861);
  for (const index of businesses.keys()) {
    for (let refresh = 0; refresh < 2; refresh++) {
      const view = await session(person, index);
      assert.equal(view.state, "OFFLINE"); assert.equal(view.reviewState, "verified"); assert.equal(view.syncPending, false);
      assert.equal(view.derived[0].nonBillableOffPhoneMinutes, 4);
      assert.equal(view.records.filter(event => event.source === "Non-Billable Off the Phone Out").length, 2);
      assert.deepEqual(view.records.slice(-2).map(event => event.source), ["Off the Phone In", "Time Out"]);
      const hub = await request<{ rows: Array<{ nonBillableOffPhoneMinutes: number; review: string[] }> }>(person, index,
        `/attendance-hub/days?preset=custom&from=${shiftDay}&to=${shiftDay}&employee=${person.code}`, { admin: true });
      assert.equal(hub.rows[0].nonBillableOffPhoneMinutes, 4);
      assert.deepEqual(hub.rows[0].review, []);
    }
  }
  const beforeUndo = await session(person);
  const undo = await request<Snapshot>(person, 0, `/employees/${person.ids[0]}/attendance/commands`, { admin: true, body: {
    commandId: crypto.randomUUID(), operation: "correct", expectedRevision: beforeUndo.revision, fingerprint: beforeUndo.fingerprint,
    reason: "Reverse the first synthetic non-billable interval while retaining all later actions",
    changes: beforeUndo.records.slice(1, 3).map(event => ({ targetId: event.id, remove: true })),
  } });
  assert.equal(undo.state, "OFFLINE"); assert.equal(undo.derived[0].nonBillableOffPhoneMinutes, 2);
  for (const index of businesses.keys()) assert.equal((await session(person, index)).derived[0].nonBillableOffPhoneMinutes, 2);
  const audit = await AttendanceLedger.findOne({ employeeCode: person.code }).lean();
  assert.equal(audit!.events.filter(event => event.source === "Non-Billable Off the Phone Out").length, 2, "undo preserves original evidence");
});

test("HTTP: automatic 08:05 checkout caps non-billable time at 08:00 on its original overnight shift", async () => {
  const { runAttendanceAutoTimeOutCycle } = await import("./attendanceAutoTimeOutWorker");
  const old = process.env.CRM_ATTENDANCE_AUTO_TIMEOUT;
  process.env.CRM_ATTENDANCE_AUTO_TIMEOUT = "true";
  try {
    const person = await fixture(); await action(person, "Time In", 0);
    await action(person, "Non-Billable Off the Phone Out", 8 * 3600 + 55 * 60);
    mock.timers.setTime(start + 9 * 3600000 + 6 * 60000);
    const result = await runAttendanceAutoTimeOutCycle(new Date()); assert.equal(result.failed, 0);
    for (const index of businesses.keys()) {
      const view = await session(person, index);
      assert.equal(view.state, "OFFLINE"); assert.equal(view.derived[0].dayKey, shiftDay);
      assert.equal(view.derived[0].nonBillableOffPhoneMinutes, 5);
    }
  } finally { if (old === undefined) delete process.env.CRM_ATTENDANCE_AUTO_TIMEOUT; else process.env.CRM_ATTENDANCE_AUTO_TIMEOUT = old; }
});

test("HTTP: delivery health is admin-only, business-scoped and read-only", async () => {
  const person = await fixture();
  const before = await core(person);
  await request(person, 0, "/attendance-hub/delivery-health", { expected: 403 });
  for (const [index, businessId] of businesses.entries()) {
    const health = await request<{ businesses: Array<{ businessId: string; pending: number }>; workers: unknown[] }>(person, index,
      `/attendance-hub/delivery-health?business=${businessId}`, { admin: true });
    assert.deepEqual(health.businesses.map(item => item.businessId), [businessId]);
    assert.equal(health.businesses[0].pending, 0); assert.ok(Array.isArray(health.workers));
  }
  assert.equal(await core(person), before);
});

test("HTTP: bounded worker still auto-closes at 08:05 and delivers the same rest deductions to all businesses", async () => {
  const { runAttendanceAutoTimeOutCycle } = await import("./attendanceAutoTimeOutWorker");
  const { resetAttendanceWorkerCursors } = await import("./attendanceWorkerCandidates");
  const old = process.env.CRM_ATTENDANCE_AUTO_TIMEOUT;
  process.env.CRM_ATTENDANCE_AUTO_TIMEOUT = "true"; resetAttendanceWorkerCursors();
  try {
    const person = await fixture();
    await action(person, "Time In", 0); await action(person, "Break Out", 8.75 * 3600);
    mock.timers.setTime(start + 9 * 3_600_000 + 6 * 60_000);
    const report = await runAttendanceAutoTimeOutCycle(new Date());
    assert.ok(report.closed >= 1); assert.equal(report.failed, 0); assert.equal(report.deliveryPending, 0);
    const canonical = await AttendanceLedger.findOne({ employeeCode: person.code }).lean();
    assert.ok(canonical!.events.at(-1)!.autoTimeOut);
    assert.equal(canonical!.events.at(-1)!.at, new Date(start + 9 * 3_600_000 + 5 * 60_000).toISOString());
    assert.equal(canonical!.derived![0].excessBreakMinutes, 5);
    for (const [index] of businesses.entries()) {
      const refreshed = await session(person, index);
      assert.equal(refreshed.state, "OFFLINE"); assert.equal(refreshed.derived[0].excessBreakMinutes, 5);
      const hub = await request<{ rows: Array<{ milliseconds: { overBreak: number } }> }>(person, index,
        `/attendance-hub/days?preset=custom&from=${shiftDay}&to=${shiftDay}&employee=${person.code}`, { admin: true });
      assert.equal(hub.rows[0].milliseconds.overBreak, 5 * 60_000);
    }
    assert.equal((await runAttendanceAutoTimeOutCycle(new Date())).closed, 0);
  } finally { if (old === undefined) delete process.env.CRM_ATTENDANCE_AUTO_TIMEOUT; else process.env.CRM_ATTENDANCE_AUTO_TIMEOUT = old; resetAttendanceWorkerCursors(); }
});

test("HTTP: two back-to-back 15-minute breaks, one 60-minute lunch, and atomic rejections", async () => {
  const person = await fixture();
  await action(person, "Time In", 0);
  await rejectAction(person, "Break In", 1);
  await rejectAction(person, "Lunch Break In", 2);
  await action(person, "Break Out", 60);
  await rejectAction(person, "Break Out", 61);
  await rejectAction(person, "Lunch Break Out", 62);
  await rejectAction(person, "Time Out", 63);
  await action(person, "Break In", 960);
  await action(person, "Break Out", 961, 200, 1);
  await action(person, "Break In", 1861, 200, 2);
  await action(person, "Lunch Break Out", 1862);
  await rejectAction(person, "Break Out", 1863);
  await rejectAction(person, "Lunch Break Out", 1864);
  await action(person, "Lunch Break In", 5462);
  await action(person, "Time Out", 5500);
  await action(person, "Time In", 5501, 200, 2);
  await rejectAction(person, "Break Out", 5522, "Only two breaks are allowed per attendance slot.");
  await rejectAction(person, "Lunch Break Out", 5523, "Lunch was already started for this attendance slot.");
  await action(person, "Time Out", 32400);
  for (let index = 0; index < businesses.length; index++) {
    const refreshed = await session(person, index);
    assert.equal(refreshed.state, "OFFLINE"); assert.equal(refreshed.reviewState, "verified");
    assert.equal(refreshed.syncPending, false);
    assert.deepEqual(refreshed.allowances, { breakMinutes: 15, lunchMinutes: 60 });
    assert.equal(refreshed.records.filter((event) => event.source === "Break Out").length, 2);
    assert.equal(refreshed.records.filter((event) => event.source === "Lunch Break Out").length, 1);
    const day = refreshed.derived.find((item) => item.dayKey === shiftDay)!;
    assert.deepEqual(day.breakSessions.map((item) => item.excessMinutes), [0, 0]);
    assert.equal(day.lunchSessions.length, 1); assert.equal(day.excessLunchMinutes, 0);
  }
});

test("HTTP: early Offline shows undertime immediately in every business; active and reopened modes clear it", async () => {
  const person = await fixture();
  const verify = async (expected: number, mode: string) => {
    const before = await core(person);
    for (const [index, business] of businesses.entries()) {
      const current = await session(person, index);
      assert.equal(current.state, mode); assert.equal(current.syncPending, false);
      assert.equal(current.derived[0].earlyTimeOutMinutes, expected);
      assert.equal(current.dashboardDays[0].milliseconds.underTime, expected * 60_000);
      const hub = await request<{ rows: Array<{ mismatch: boolean; timeOut: string | null; issues: string[];
        milliseconds: { underTime: number } }>; summary: { underTimeCount: number; underTime: number } }>(person, index,
        `/attendance-hub/days?business=${business}&employee=${person.code}&shiftView=date&shiftDate=${shiftDay}`, { admin: true });
      assert.equal(hub.rows.length, 1); assert.equal(hub.rows[0].mismatch, false);
      assert.equal(hub.rows[0].milliseconds.underTime, expected * 60_000);
      assert.equal(hub.rows[0].issues.includes("UNDER TIME"), expected > 0);
      assert.equal(Boolean(hub.rows[0].timeOut), mode === "OFFLINE");
      assert.equal(hub.summary.underTimeCount, expected > 0 ? 1 : 0);
      assert.equal(hub.summary.underTime, expected * 60_000);
      await runWithBusiness(business, async () => {
        const copies = await Attendance.find({ employee: person.ids[index], isEffective: { $ne: false } }).lean();
        assert.ok(copies.length);
        for (const copy of copies) assert.equal(copy.derived!.earlyTimeOutMinutes, expected);
      });
    }
    assert.equal(await core(person), before, "refreshing cannot write attendance or payroll");
  };
  await action(person, "Time In", 454 * 60);
  await verify(0, "ONLINE");
  await action(person, "Time Out", 455 * 60 + 11);
  await verify(85, "OFFLINE");
  await action(person, "Time In", 456 * 60, 200, 1);
  await verify(0, "ONLINE");
  await action(person, "Break Out", 456 * 60 + 1);
  await verify(0, "BREAK");
  await action(person, "Break In", 456 * 60 + 2);
  await action(person, "Lunch Break Out", 456 * 60 + 3);
  await verify(0, "LUNCH");
  await action(person, "Lunch Break In", 456 * 60 + 4);
  await action(person, "Off the Phone Out", 456 * 60 + 5);
  await verify(0, "OFF THE PHONE");
  await action(person, "Time Out", 480 * 60, 200, 2);
  await verify(60, "OFFLINE");
});

test("HTTP: accuracy rounding is 15:00 = 0, 15:01 = 1, and 15:30 = 1 minute after refresh", async () => {
  for (const [duration, expected] of [[900, 0], [901, 1], [930, 1]]) {
    mock.timers.setTime(start);
    const person = await fixture();
    await action(person, "Time In", 0);
    await action(person, "Break Out", 3600);
    const saved = await action(person, "Break In", 3600 + duration);
    assert.equal(saved.derived[0].excessBreakMinutes, expected);
    await action(person, "Time Out", 32400);
    for (let index = 0; index < businesses.length; index++) {
      const refreshed = await session(person, index);
      assert.equal(refreshed.derived[0].excessBreakMinutes, expected);
      assert.equal(refreshed.dashboardDays[0].milliseconds.overBreak, expected * 60_000);
    }
  }
});

test("HTTP: correcting business A recalculates both over-breaks, a 61-minute lunch, hub, stored replicas and payroll in all six businesses", async () => {
  const person = await fixture();
  for (const [source, seconds] of [["Time In", 300], ["Break Out", 3600], ["Break In", 4530],
    ["Break Out", 7200], ["Break In", 8220], ["Lunch Break Out", 10800], ["Lunch Break In", 14460], ["Time Out", 32400]] as const) {
    await action(person, source, seconds);
  }
  mock.timers.setTime(start + 32460_000);
  const policy = await request<{ breakMinutes: number; lunchMinutes: number }>(person, 0, "/attendance-policy", { admin: true });
  assert.deepEqual([policy.breakMinutes, policy.lunchMinutes], [15, 60]);
  const verify = async (expectedBreak: number, expectedDeductible: number) => {
    const before = await core(person);
    let canonicalRecords: Snapshot["records"] | undefined;
    for (const [index, business] of businesses.entries()) {
      const refreshed = await session(person, index);
      assert.equal(refreshed.syncPending, false);
      if (canonicalRecords) assert.deepEqual(refreshed.records, canonicalRecords); else canonicalRecords = refreshed.records;
      const day = refreshed.derived.find((item) => item.dayKey === shiftDay)!;
      const metrics = [day.lateMinutes, day.excessBreakMinutes, day.excessLunchMinutes, day.earlyTimeOutMinutes, day.deductibleMinutes];
      assert.deepEqual(metrics, [5, expectedBreak, 1, 0, expectedDeductible]);
      const dashboard = refreshed.dashboardDays.find((item) => item.dayKey === shiftDay)!;
      const expected = [5, expectedBreak, 1, 0];
      assert.deepEqual(["late", "overBreak", "overLunch", "underTime"].map((key) => dashboard.milliseconds[key] / 60_000), expected);
      const hub = await request<{ rows: Array<{ businessId: string; mismatch: boolean; milliseconds: Record<string, number> }> }>(person, index,
        `/attendance-hub/days?business=${business}&employee=${person.code}&shiftView=date&shiftDate=${shiftDay}`, { admin: true });
      assert.equal(hub.rows.length, 1); assert.equal(hub.rows[0].businessId, business); assert.equal(hub.rows[0].mismatch, false);
      assert.deepEqual(["late", "overBreak", "overLunch", "underTime"].map((key) => hub.rows[0].milliseconds[key] / 60_000), expected);
      const payroll = await request<{ rows: Array<{ dateKey: string; lateMinutes: number; excessBreakMinutes: number;
        excessLunchMinutes: number; earlyTimeOutMinutes: number }> }>(person, index,
        `/payroll/dtr/${person.ids[index]}?payPeriod=${encodeURIComponent("Oct 6, 2026 - Oct 20, 2026")}`, { admin: true });
      const row = payroll.rows.find((item) => item.dateKey === shiftDay)!;
      assert.ok(row, `payroll must include the edited shift in ${business}`);
      assert.deepEqual([row.lateMinutes, row.excessBreakMinutes, row.excessLunchMinutes, row.earlyTimeOutMinutes], expected);
      await runWithBusiness(business, async () => {
        const stored = await Attendance.find({ employee: person.ids[index] }).lean();
        assert.equal(stored.length, refreshed.records.length);
        for (const record of stored) {
          assert.ok(record.derived, `stored event ${record.eventId} must retain recomputed deductions`);
          assert.deepEqual([record.derived.lateMinutes, record.derived.excessBreakMinutes, record.derived.excessLunchMinutes,
            record.derived.earlyTimeOutMinutes, record.derived.deductibleMinutes], metrics);
          const event = refreshed.records.find((item) => item.id === record.eventId)!;
          assert.ok(event); assert.equal(record.timeIn.toISOString(), event.at);
        }
      });
      await session(person, index);
    }
    assert.equal(await core(person), before, "fresh session, hub and payroll GETs must not mutate attendance or stored deductions");
  };
  await verify(3, 9);
  const before = await session(person);
  const target = before.records.find((event) => event.source === "Break In")!;
  const corrected = await request<Snapshot>(person, 0, `/employees/${person.ids[0]}/attendance/commands`, { admin: true, body: {
    commandId: crypto.randomUUID(), operation: "correct", expectedRevision: before.revision, fingerprint: before.fingerprint,
    reason: "Synthetic correction: extend the first break to 20 minutes", changes: [{ targetId: target.id, at: at(4800) }],
  } });
  assert.equal(corrected.revision, before.revision + 1);
  assert.equal(corrected.derived[0].excessBreakMinutes, 7);
  assert.equal(corrected.derived[0].deductibleMinutes, 13);
  await verify(7, 13);
  const ledger = await AttendanceLedger.findOne({ employeeCode: person.code }).lean();
  assert.equal(ledger?.audit.at(-1)?.actor.role, "admin");
  assert.equal(ledger?.audit.at(-1)?.actor.code, "90000001");
  assert.ok(ledger?.audit.at(-1)?.beforeDerived?.length);
  assert.ok(ledger?.audit.at(-1)?.afterDerived?.length);
});
