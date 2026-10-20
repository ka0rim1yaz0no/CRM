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
const businesses = ["test-a", "test-b", "test-c"];
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

test("HTTP: completed break rounding is 15:00 = 0, 15:01 = 0, and 15:30 = 1 minute after refresh", async () => {
  for (const [duration, expected] of [[900, 0], [901, 0], [930, 1]]) {
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

test("HTTP: correcting business A recalculates both over-breaks, a 61-minute lunch, hub, stored replicas and payroll in all three businesses", async () => {
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
