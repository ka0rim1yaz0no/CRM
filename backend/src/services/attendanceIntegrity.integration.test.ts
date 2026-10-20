import assert from "node:assert/strict";
// Preserve the legacy rollout characterization; new accounting has its own flag-on fixtures.
process.env.CRM_ATTENDANCE_ACCURACY_FIXES = "false";
import { after, before, mock, test } from "node:test";
import crypto from "node:crypto";
import http from "node:http";
import { manilaCalendarDate, shiftDateOffset } from "../../../shared/attendanceView";
import { hubDayKey } from "./attendanceHubMath";
import mongoose from "mongoose";
import { MongoMemoryReplSet } from "mongodb-memory-server";

process.env.NODE_ENV = "test";
// Characterize rollback, including its automatic draft-payroll refresh.
process.env.CRM_PAYROLL_ACCURACY = "false";
const prefix = `att_test_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;
process.env.BUSINESS_DATABASES = JSON.stringify([{ id: "test-a", name: "Synthetic A", databaseName: `${prefix}_a` }, { id: "test-b", name: "Synthetic B", databaseName: `${prefix}_b` }, { id: "test-c", name: "Synthetic C", databaseName: `${prefix}_c` }]);
process.env.DEFAULT_BUSINESS_ID = "test-a";
process.env.DEFAULT_BUSINESS_DATABASE = `${prefix}_a`;
process.env.CONTROL_DATABASE_NAME = `${prefix}_control`;
process.env.CRM_ADMIN_ONE_CODE = "90000001";
process.env.CRM_ADMIN_SESSION_SECRET = crypto.randomBytes(48).toString("hex");
process.env.CRM_ATTENDANCE_INTEGRITY = "true";
process.env.CRM_ATTENDANCE_HUB = "true";
process.env.CRM_ATTENDANCE_RECOVERY_CUTOFF = "false";
const { Employee } = await import("../models/Employee");
const { Attendance } = await import("../models/Attendance");
const { AttendanceLedger, AttendancePolicy } = await import("../models/AttendanceLedger");
const { runWithBusiness } = await import("../config/tenancy");
const { setBusinessAccessForEmployeeCode } = await import("../models/BusinessUserAccess");
const { acquireAttendanceLease, attendanceSnapshot, commitAttendanceRevision, executeAttendanceCommand, previewAttendanceCommand, readAttendanceLedger, resolveAttendanceIdentity } = await import("./attendanceLedgerService");
const { deliverAttendanceLedger } = await import("./attendanceLedgerOutbox");
const { runAttendanceRecovery } = await import("./attendanceRecoveryWorker");
const { createApp } = await import("../app");
const { createAdminDashboardSession } = await import("../config/adminDashboardSession");
const { createAttendanceHubSession } = await import("../config/attendanceHubSession");
const admin = { role: "admin" as const, code: "90000001" };
const { DashboardWorkspace, DashboardHandover } = await import("../models/DashboardWorkspace");
const { Notice } = await import("../models/Notice");
let mongo: MongoMemoryReplSet;
let server: http.Server;
let base = "";
let counter = 100;
before(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri(prefix));
  await AttendancePolicy.create({ _id: "global-attendance", revision: 1, graceMinutes: 0, breakMinutes: 15, lunchMinutes: 60, shiftStart: "23:00", shiftEnd: "08:00", recoveryEnabled: false, recoveryTime: "22:59" });
  server = http.createServer(createApp());
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`;
});
after(async () => { await new Promise<void>((resolve) => server?.close(() => resolve())); await mongoose.disconnect(); await mongo?.stop(); });
async function fixture(includeReplica = true) {
  const code = String(91000000 + counter++);
  const employees: Array<{ _id: mongoose.Types.ObjectId }> = [];
  for (const business of includeReplica ? ["test-a", "test-b"] : ["test-a"]) employees.push(await runWithBusiness(business, () => Employee.create({ employeeCode: code, name: "Synthetic Employee", role: "Test", team: "Fixture", dateHired: "2026-10-01", businessAccessIds: ["test-a", "test-b"] })));
  await setBusinessAccessForEmployeeCode(code, ["test-a", "test-b"]);
  const identity = await runWithBusiness("test-a", () => resolveAttendanceIdentity(String(employees[0]._id), admin));
  return { identity, employees, actor: { role: "employee" as const, code } };
}
const command = (revision: number, source: "Time In" | "Break Out" | "Break In" | "Lunch Break Out" | "Lunch Break In" | "Time Out" | "Off the Phone Out") => ({ commandId: crypto.randomUUID(), expectedRevision: revision, operation: "action" as const, source });
async function request(path: string, token: string, method = "GET", body?: unknown, adminToken = false) {
  return fetch(`${base}${path}`, { method, headers: { "Content-Type": "application/json", "X-Business-Id": "test-a", [adminToken ? "X-CRM-Admin-Session" : "X-CRM-Attendance-Session"]: token }, ...(body ? { body: JSON.stringify(body) } : {}) });
}

test("automatic break return and checkout keep canonical sequence and accurate payroll in every business", async () => {
  process.env.CRM_ATTENDANCE_DURATION_MODEL = "true";
  process.env.CRM_ATTENDANCE_AUTO_TIMEOUT = "true";
  try {
    const person = await fixture();
    await executeAttendanceCommand(person.identity, { commandId: crypto.randomUUID(), expectedRevision: 0, operation: "correct", reason: "Synthetic open break cutoff",
      changes: [{ source: "Time In", at: "2026-10-15T15:00:00Z" }, { source: "Break Out", at: "2026-10-15T23:45:00Z" }] }, admin, new Date("2026-10-16T00:04:00Z"));
    const { runAttendanceAutoTimeOut } = await import("./attendanceAutoTimeOutWorker");
    const { attendancePayrollDtr } = await import("../controllers/payrollController");
    assert.equal(await runAttendanceAutoTimeOut(new Date("2026-10-16T00:05:00Z")), 1);
    for (const [index, business] of ["test-a", "test-b"].entries()) await runWithBusiness(business, async () => {
      const records = await Attendance.find({ employee: person.employees[index]._id }).sort({ timeIn: 1, sequence: 1, _id: 1 }).lean();
      assert.deepEqual(records.map((record) => record.source), ["Time In", "Break Out", "Break In", "Time Out"]);
      assert.ok(records[2].sequence! < records[3].sequence!);
      assert.equal(records[2].timeIn.toISOString(), "2026-10-16T00:05:00.000Z");
      assert.equal(records[3].autoTimeOut, true);
      const payroll = await attendancePayrollDtr(person.employees[index]._id, "Oct 6, 2026 - Oct 20, 2026");
      const row = payroll.rows.find((day) => day.dateKey === "2026-10-15")!;
      assert.equal(row.excessBreakMinutes, 5);
      assert.equal(row.earlyTimeOutMinutes, 0);
      assert.equal(row.status, "Present");
    });
  } finally { delete process.env.CRM_ATTENDANCE_DURATION_MODEL; process.env.CRM_ATTENDANCE_AUTO_TIMEOUT = "false"; }
});

test("duration model: actual payroll, hub, employee summary and stored replicas remain equal after an edit and fresh reads", async () => {
  process.env.CRM_ATTENDANCE_DURATION_MODEL = "true";
  try {
    const person = await fixture();
    const { attendancePayrollDtr } = await import("../controllers/payrollController");
    const { attendanceDashboardPresentation } = await import("./attendanceDashboardPresentation");
    const changes = [["Time In", "2026-10-15T15:05:00Z"], ["Break Out", "2026-10-15T16:11:00Z"], ["Break In", "2026-10-15T16:26:01Z"],
      ["Break Out", "2026-10-15T18:00:00Z"], ["Break In", "2026-10-15T18:17:30Z"],
      ["Lunch Break Out", "2026-10-15T20:00:00Z"], ["Lunch Break In", "2026-10-15T21:01:00Z"], ["Time Out", "2026-10-15T23:50:00Z"]]
      .map(([source, at]) => ({ source: source as "Time In", at }));
    let result = await executeAttendanceCommand(person.identity, { commandId: crypto.randomUUID(), expectedRevision: 0,
      operation: "correct", reason: "Synthetic parity fixture", changes }, admin);
    await deliverAttendanceLedger(person.identity.key);
    const token = createAdminDashboardSession(admin.code)!;
    const verify = async (expectedBreak: number) => {
      for (const [index, business] of ["test-a", "test-b"].entries()) {
        const payroll = await runWithBusiness(business, () => attendancePayrollDtr(person.employees[index]._id, "Oct 6, 2026 - Oct 20, 2026"));
        const row = payroll.rows.find((day) => day.dateKey === "2026-10-15")!;
        assert.deepEqual([row.lateMinutes, row.excessBreakMinutes, row.excessLunchMinutes, row.earlyTimeOutMinutes], [5, expectedBreak, 1, 10]);
        const response = await request(`/attendance-hub/days?shiftView=date&shiftDate=2026-10-15&employee=${person.actor.code}&business=${business}`, token, "GET", undefined, true);
        assert.equal(response.status, 200);
        const hub = (await response.json()).rows[0];
        assert.deepEqual([hub.milliseconds.late, hub.milliseconds.overBreak, hub.milliseconds.overLunch, hub.milliseconds.underTime].map((value: number) => value / 60_000), [5, expectedBreak, 1, 10]);
        const ledger = await readAttendanceLedger(person.identity);
        const snapshot = attendanceSnapshot(ledger);
        const dashboard = attendanceDashboardPresentation(snapshot, { shiftStart: "23:00", shiftEnd: "08:00", graceMinutes: 0, breakMinutes: 15, lunchMinutes: 60 }, new Date()).dashboardDays[0];
        assert.equal(dashboard.milliseconds.overBreak / 60_000, expectedBreak);
      }
    };
    await verify(3);
    const target = result.records.find((event) => event.source === "Break In")!;
    result = await executeAttendanceCommand(person.identity, { commandId: crypto.randomUUID(), expectedRevision: result.revision, operation: "correct",
      reason: "Extend first synthetic break", changes: [{ targetId: target.id, at: "2026-10-15T16:31:00Z" }] }, admin);
    await deliverAttendanceLedger(person.identity.key);
    await verify(8);
  } finally { delete process.env.CRM_ATTENDANCE_DURATION_MODEL; }
});

test("duration payroll preserves weekend waivers and never uses a previous checkout for an open second session", async () => {
  process.env.CRM_ATTENDANCE_DURATION_MODEL = "true";
  try {
    const person = await fixture();
    const changes = [["Time In", "2026-10-15T15:00:00Z"], ["Time Out", "2026-10-15T16:00:00Z"], ["Time In", "2026-10-15T17:00:00Z"],
      ["Time Out", "2026-10-16T00:00:00Z"], ["Time In", "2026-10-17T15:00:00Z"], ["Break Out", "2026-10-17T16:00:00Z"],
      ["Break In", "2026-10-17T16:20:00Z"], ["Time Out", "2026-10-18T00:00:00Z"],
      ["Time In", "2026-10-18T15:00:00Z"], ["Time Out", "2026-10-18T16:00:00Z"], ["Time In", "2026-10-18T17:00:00Z"]]
      .map(([source, at]) => ({ source: source as "Time In", at }));
    await executeAttendanceCommand(person.identity, { commandId: crypto.randomUUID(), expectedRevision: 0, operation: "correct", reason: "Synthetic payroll session boundaries", changes }, admin);
    await deliverAttendanceLedger(person.identity.key);
    const { attendancePayrollDtr } = await import("../controllers/payrollController");
    const payroll = await runWithBusiness("test-a", () => attendancePayrollDtr(person.employees[0]._id, "Oct 6, 2026 - Oct 20, 2026"));
    const weekday = payroll.rows.find((row) => row.dateKey === "2026-10-15")!;
    assert.equal(weekday.grossHours, 8, "offline gaps are not worked time");
    const weekend = payroll.rows.find((row) => row.dateKey === "2026-10-17")!;
    assert.equal(weekend.excessBreakMinutes, 0, "the existing weekend exemption is unchanged");
    const open = payroll.rows.find((row) => row.dateKey === "2026-10-18")!;
    assert.equal(open.status, "Needs Review");
    assert.equal(open.timeOut, "-");
    assert.equal(open.earlyTimeOutMinutes, 0);
  } finally { delete process.env.CRM_ATTENDANCE_DURATION_MODEL; }
});

test("real API: every manual employee attendance action stays consistent across business switches", async () => {
  const person = await fixture();
  const token = createAttendanceHubSession(person.actor.code)!;
  const sources = ["Time In", "Break Out", "Break In", "Lunch Break Out", "Lunch Break In", "Off the Phone Out", "Off the Phone In", "Time Out"];
  const states = ["ONLINE", "BREAK", "ONLINE", "LUNCH", "ONLINE", "OFF THE PHONE", "ONLINE", "OFFLINE"];
  const read = async (index: number) => {
    const response = await fetch(`${base}/employees/${person.employees[index]._id}/attendance/session`, {
      headers: { "X-Business-Id": index ? "test-b" : "test-a", "X-CRM-Attendance-Session": token },
    });
    assert.equal(response.status, 200);
    return response.json();
  };
  for (let index = 0; index < sources.length; index++) {
    const business = index % 2;
    const before = await read(business);
    const input = { commandId: crypto.randomUUID(), operation: "action", expectedRevision: before.revision,
      fingerprint: before.fingerprint, source: sources[index] };
    const response = await fetch(`${base}/employees/${person.employees[business]._id}/attendance/commands`, {
      method: "POST", headers: { "Content-Type": "application/json", "X-Business-Id": business ? "test-b" : "test-a",
        "X-CRM-Attendance-Session": token }, body: JSON.stringify(input),
    });
    assert.equal(response.status, 200, await response.clone().text());
    const saved = await response.json();
    assert.equal(saved.state, states[index]);
    const a = await read(0); const b = await read(1);
    assert.equal(a.state, states[index]); assert.equal(b.state, states[index]);
    assert.deepEqual(a.records, b.records);
    assert.equal(a.records.length, index + 1);
    assert.equal(a.reviewState, "verified");
  }
  const ledgerBefore = JSON.stringify(await AttendanceLedger.findById(person.identity.key).lean());
  await read(0); await read(1);
  assert.equal(JSON.stringify(await AttendanceLedger.findById(person.identity.key).lean()), ledgerBefore, "reads must not change attendance");
});
test("real API: canonical attendance keeps server-computed late and undertime labels in employee history", async () => {
  const person = await fixture();
  await executeAttendanceCommand(person.identity, { commandId: crypto.randomUUID(), expectedRevision: 0, operation: "correct", reason: "Synthetic late arrival", changes: [
    { source: "Time In", at: "2026-10-15T16:00:00Z" }, { source: "Time Out", at: "2026-10-15T20:00:00Z" },
  ] }, admin);
  const token = createAttendanceHubSession(person.actor.code)!;
  const id = String(person.employees[0]._id);
  const response = await request(`/employees/${id}/attendance/session`, token);
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.records[0].attendanceStatus, "Late");
  assert.equal(data.records[1].attendanceStatus, "Undertime");
  assert.equal(data.sessions[0].events[0].attendanceStatus, "Late");
  const history = await (await request(`/employees/${id}/attendance?all=true`, token)).json();
  assert.equal(history.find((event: { source: string }) => event.source === "Time In").attendanceStatus, "Late");
  const replica = await fetch(`${base}/employees/${person.employees[1]._id}/attendance/session`, { headers: { "X-Business-Id": "test-b", "X-CRM-Attendance-Session": token } });
  assert.equal((await replica.json()).records[0].attendanceStatus, "Late");
  const list = await (await request(`/attendance?employeeIds=${id}&all=true`, createAdminDashboardSession(admin.code)!, "GET", undefined, true)).json();
  assert.equal(list.find((event: { source: string }) => event.source === "Time In").attendanceStatus, "Late");
});
test("real API: a business-local attendance note preserves matching events and cross-business totals", async () => {
  const { identity, actor } = await fixture();
  await executeAttendanceCommand(identity, command(0, "Time In"), actor, new Date("2026-10-15T15:00:00Z"));
  await executeAttendanceCommand(identity, command(1, "Time Out"), actor, new Date("2026-10-15T16:00:00Z"));
  await deliverAttendanceLedger(identity.key);
  const token = createAdminDashboardSession(admin.code)!;
  const query = `preset=custom&from=2026-10-15&to=2026-10-15&employee=${actor.code}`;
  const read = async (business = "") => {
    const response = await request(`/attendance-hub/days?${query}${business ? `&business=${business}` : ""}`, token, "GET", undefined, true);
    assert.equal(response.status, 200);
    return response.json();
  };
  const before = await read();
  assert.equal(before.rows[0].mismatch, false);
  const save = await request("/attendance-hub/day/2026-10-15/note", token, "POST", {
    employeeCode: actor.code, businessId: "test-a", reason: "Synthetic note; attendance unchanged", excused: false,
  }, true);
  assert.equal(save.status, 200);
  const after = await read();
  assert.equal(after.rows[0].mismatch, false, "ordinary notes are not conflicting attendance evidence");
  assert.deepEqual(after.summary, before.summary);
  assert.deepEqual(after.rows[0].events, before.rows[0].events);
  const businessA = await read("test-a");
  const businessB = await read("test-b");
  assert.equal(businessA.rows[0].note, "Synthetic note; attendance unchanged");
  assert.equal(businessA.rows[0].noteRevisions.length, 1);
  assert.equal(businessB.rows[0].note, "", "notes remain business scoped rather than being copied");
  assert.equal(businessB.rows[0].noteRevisions.length, 0);
  const excuse = await request("/attendance-hub/day/2026-10-15/note", token, "POST", {
    employeeCode: actor.code, businessId: "test-a", reason: "Synthetic business-specific excuse", excused: true,
  }, true);
  assert.equal(excuse.status, 200);
  assert.equal((await read()).rows[0].mismatch, true, "a differing excuse still changes attendance interpretation and must be reviewed");
});

test("real API: repeated note saves, reloads and clearing stay scoped to every configured business", async () => {
  const code = String(91000000 + counter++);
  const token = createAdminDashboardSession(admin.code)!;
  const shiftDay = "2026-10-15";
  const { AttendanceDayNote } = await import("../models/AttendanceDayNote");
  for (const [index, business] of ["test-a", "test-b", "test-c"].entries()) {
    await runWithBusiness(business, () => Employee.create({ employeeCode: code, name: "Synthetic note employee", role: "Test", dateHired: "2026-10-01" }));
    const write = (reason: string, excused = false) => request(`/attendance-hub/day/${shiftDay}/note`, token, "POST", { employeeCode: code, businessId: business, reason, excused }, true);
    for (const reason of [`Synthetic note ${index}`, `Updated synthetic note ${index}`]) {
      const response = await write(reason);
      assert.equal(response.status, 200, await response.clone().text());
      const read = await request(`/attendance-hub/day/${shiftDay}?preset=custom&from=${shiftDay}&to=${shiftDay}&employeeCode=${code}&business=${business}`, token, "GET", undefined, true);
      assert.equal(read.status, 200);
      assert.equal((await read.json()).day.note, reason);
    }
    const saved = await runWithBusiness(business, () => AttendanceDayNote.findOne({ employeeCode: code, dayKey: shiftDay }).lean());
    assert.equal(saved?.revisions.length, 2);
    assert.ok(saved?.revisions.every((revision) => revision.by === admin.code));
    assert.equal((await write("", true)).status, 400);
    assert.equal((await write("x".repeat(1001))).status, 400);
    assert.equal((await write("")).status, 200);
    assert.equal((await runWithBusiness(business, () => AttendanceDayNote.findOne({ employeeCode: code, dayKey: shiftDay }).lean()))?.reason, "");
  }
  const denied = await request(`/attendance-hub/day/${shiftDay}/note`, createAttendanceHubSession(code)!, "POST", { employeeCode: code, businessId: "test-a", reason: "Denied", excused: false });
  assert.equal(denied.status, 403);
});

test("real API: individual break pairs, duration sorting and CSV stay consistent in three businesses", async () => {
  const person = await fixture();
  await runWithBusiness("test-c", () => Employee.create({ employeeCode: person.actor.code, name: "Synthetic break employee", role: "Test", dateHired: "2026-10-01" }));
  await setBusinessAccessForEmployeeCode(person.actor.code, ["test-a", "test-b", "test-c"]);
  const identity = await runWithBusiness("test-a", () => resolveAttendanceIdentity(String(person.employees[0]._id), admin));
  const changes = [
    ["Time In", "2026-10-15T15:00:00Z"], ["Break Out", "2026-10-15T17:00:12Z"], ["Break In", "2026-10-15T17:15:12Z"],
    ["Break Out", "2026-10-15T22:00:00Z"], ["Break In", "2026-10-15T22:18:00Z"], ["Time Out", "2026-10-16T00:00:00Z"],
    ["Time In", "2026-10-16T15:00:00Z"], ["Break Out", "2026-10-16T17:00:00Z"],
  ].map(([source, at]) => ({ source: source as "Time In" | "Time Out" | "Break Out" | "Break In", at }));
  await executeAttendanceCommand(identity, { commandId: crypto.randomUUID(), expectedRevision: 0, operation: "correct", reason: "Synthetic separate-break fixture", changes }, admin);
  await deliverAttendanceLedger(identity.key);
  const token = createAdminDashboardSession(admin.code)!;
  for (const business of ["test-a", "test-b", "test-c"]) {
    const response = await request(`/attendance-hub/days?shiftView=date&shiftDate=2026-10-15&employee=${person.actor.code}&business=${business}&sort=firstBreak`, token, "GET", undefined, true);
    assert.equal(response.status, 200);
    const day = (await response.json()).rows[0];
    assert.deepEqual(day.breakSessions.map((entry: { durationMs: number }) => entry.durationMs), [900_000, 1_080_000]);
    assert.equal(day.breakSessions[0].startedAt, "2026-10-15T17:00:12.000Z");
    assert.equal(day.breakSessions[1].endedAt, "2026-10-15T22:18:00.000Z");
    assert.ok(day.businesses.every((replica: { breakSessions: unknown }) => JSON.stringify(replica.breakSessions) === JSON.stringify(day.breakSessions)));
  }
  const sorted = await request(`/attendance-hub/days?preset=custom&from=2026-10-15&to=2026-10-16&employee=${person.actor.code}&business=test-a&sort=secondBreak&direction=desc`, token, "GET", undefined, true);
  assert.equal(sorted.status, 200);
  const rows = (await sorted.json()).rows;
  assert.deepEqual(rows.map((row: { dayKey: string }) => row.dayKey), ["2026-10-15", "2026-10-16"]);
  assert.equal(rows[1].breakSessions[0].endedAt, null);
  assert.equal(rows[1].breakSessions[0].isOpen, true);
  const csv = await request(`/attendance-hub/export?preset=custom&from=2026-10-15&to=2026-10-15&employee=${person.actor.code}&business=test-a`, token, "GET", undefined, true);
  assert.equal(csv.status, 200);
  const text = await csv.text();
  assert.match(text, /1st break out \(UTC\)/);
  assert.match(text, /2nd break duration seconds/);
  assert.match(text, /"900","false"/);
  assert.match(text, /"1080","false"/);
});

test("real Mongo: one atomic batch preserves original evidence and replays after a lost response", async () => {
  const { identity } = await fixture();
  const input = { commandId: crypto.randomUUID(), expectedRevision: 0, operation: "correct" as const, reason: "Synthetic HR correction", changes: [
    { source: "Login" as const, at: "2026-10-15T14:53:09.123Z" }, { source: "Break Out" as const, at: "2026-10-15T17:03:00Z" }, { source: "Break In" as const, at: "2026-10-15T17:16:00Z" }] };
  const saved = await executeAttendanceCommand(identity, input, admin);
  const replay = await executeAttendanceCommand(identity, input, admin);
  assert.equal(saved.revision, 1); assert.equal(replay.revision, 1); assert.deepEqual(replay.records, saved.records);
  assert.equal(saved.records[0].at, "2026-10-15T14:53:09.123Z"); assert.equal(saved.records.length, 3);
  assert.equal(saved.records.some((event) => event.source === "Time Out"), false);
  const ledger = await AttendanceLedger.findById(identity.key).lean();
  assert.equal(ledger?.commands.length, 1); assert.equal(ledger?.audit.length, 1); assert.equal(ledger?.jobs.length, 2);
  await assert.rejects(executeAttendanceCommand(identity, { ...input, reason: "Changed payload" }, admin), { code: "IDEMPOTENCY_CONFLICT" });
});

test("real API: dashboard is admin-only, reads are non-mutating, settings are versioned and notes are business/author scoped", async () => {
  const employee = await fixture();
  const employeeToken = createAttendanceHubSession(employee.actor.code)!;
  const token = createAdminDashboardSession(admin.code)!;
  assert.equal((await request("/dashboard-workspace/summary", employeeToken)).status, 403);
  assert.equal((await request("/dashboard-workspace/settings", employeeToken, "PUT", {})).status, 403);
  const before = JSON.stringify(await AttendanceLedger.find({}).lean());
  const summary = await request("/dashboard-workspace/summary?preset=today", token, "GET", undefined, true);
  assert.equal(summary.status, 200, await summary.clone().text());
  const data = await summary.json(); assert.equal(data.attention.length, 6); assert.equal(data.config.revision, 0);
  const { Lead } = await import("../models/Lead"); const { LeadCallStat } = await import("../models/leadCallStat");
  await runWithBusiness("test-a", async () => {
    await Employee.updateOne({ _id: employee.employees[0]._id }, { $set: { name: "Synthetic Unique Sales", role: "Sales Agent" } });
    const lead = await Lead.create({ businessName: "Synthetic Night Shift Lead", assignedAgent: employee.employees[0]._id, status: "Qualified", activity: [{ actorType: "employee", actorName: "Synthetic Unique Sales", label: "Status changed", detail: "Synthetic event", status: "Qualified", createdAt: new Date("2026-10-15T20:00:00Z") }] });
    await LeadCallStat.create({ lead: lead._id, callCount: 1, callLogs: [{ employee: employee.employees[0]._id, employeeName: "Synthetic Unique Sales", outcome: "connected", calledAt: new Date("2026-10-15T20:00:00Z"), durationSeconds: 90 }] });
  });
  const night = await (await request("/dashboard-workspace/summary?preset=custom&from=2026-10-15&to=2026-10-15", token, "GET", undefined, true)).json();
  assert.equal(night.dashboard.summary.callsToday, 1); assert.equal(night.dashboard.summary.activityToday, 1);
  assert.equal(night.dashboard.monthlyAgents.reduce((sum: number, row: { calls: number }) => sum + row.calls, 0), 1);
  assert.equal(night.calls.reduce((sum: number, row: { count: number }) => sum + row.count, 0), 1);
  assert.equal(night.trend.reduce((sum: number, row: { count: number }) => sum + row.count, 0), 1);
  const legacy = await (await request("/leads/agent-dashboard?dateFrom=2026-10-15&dateTo=2026-10-15&callDate=2026-10-15", token, "GET", undefined, true)).json();
  assert.equal(legacy.summary.callsToday, 0, "Legacy calendar-day API must retain its original contract");
  process.env.CRM_ATTENDANCE_HUB = "false";
  assert.equal((await request("/dashboard-workspace/summary?preset=today", token, "GET", undefined, true)).status, 200, "Dashboard must not require the separate hub UI flag");
  assert.equal((await request(`/dashboard-workspace/employee/${employee.actor.code}?preset=today`, token, "GET", undefined, true)).status, 200);
  process.env.CRM_ATTENDANCE_HUB = "true";
  assert.equal(JSON.stringify(await AttendanceLedger.find({}).lean()), before);
  assert.equal(await runWithBusiness("test-a", () => DashboardWorkspace.countDocuments()), 0);
  assert.equal((await request("/dashboard-workspace/summary?preset=custom&from=bad&to=bad", token, "GET", undefined, true)).status, 400);
  const settings = { revision: 0, targets: [{ metric: "calls", period: "daily", team: "", amount: 25 }], newLeadHours: 24, followUpHours: 1 };
  const saved = await request("/dashboard-workspace/settings", token, "PUT", settings, true);
  assert.equal(saved.status, 200, await saved.clone().text()); assert.equal((await saved.json()).revision, 1);
  assert.equal((await request("/dashboard-workspace/settings", token, "PUT", settings, true)).status, 409);
  const created = await request("/dashboard-workspace/notes", token, "POST", { text: "Synthetic handover only", pinned: false }, true);
  assert.equal(created.status, 201); const note = await created.json();
  assert.equal(await runWithBusiness("test-b", () => DashboardHandover.countDocuments()), 0);
  const foreign = await runWithBusiness("test-a", () => DashboardHandover.create({ text: "Another synthetic author", author: "90009999" }));
  assert.equal((await request(`/dashboard-workspace/notes/${foreign._id}`, token, "PATCH", { text: "Blocked overwrite" }, true)).status, 403);
  assert.equal((await request(`/dashboard-workspace/notes/${note._id}`, token, "PATCH", { text: "Edited synthetic handover", pinned: true }, true)).status, 200);
  assert.equal((await request(`/dashboard-workspace/notes/${note._id}`, token, "DELETE", undefined, true)).status, 200);
  assert.ok((await runWithBusiness("test-a", () => DashboardHandover.findById(note._id).lean()))?.deletedAt);
  process.env.CRM_DASHBOARD_V2 = "false";
  assert.equal((await request("/dashboard-workspace/summary", token, "GET", undefined, true)).status, 404);
  process.env.CRM_DASHBOARD_V2 = "true";
});
test("real API: bulk notice read uses the literal route, signed owner scope and one cross-business transaction", async () => {
  const owner = await fixture(); const other = await fixture();
  const token = createAttendanceHubSession(owner.actor.code)!;
  for (const [index, business] of ["test-a", "test-b"].entries()) {
    await runWithBusiness(business, async () => {
      await Notice.create({ employee: owner.employees[index]._id, title: "Synthetic owner notice", message: "Synthetic read regression" });
      await Notice.create({ employee: other.employees[index]._id, title: "Synthetic other notice", message: "Must stay unread" });
    });
  }
  const path = `/employees/${owner.employees[0]._id}/notices/read`;
  assert.equal((await request(path, "", "PATCH")).status, 401);
  assert.equal((await request(`/employees/${other.employees[0]._id}/notices/read`, token, "PATCH")).status, 403);
  const result = await request(path, token, "PATCH");
  assert.equal(result.status, 200, await result.clone().text());
  const rows = await result.json();
  assert.ok(Array.isArray(rows)); assert.equal(rows.length, 1); assert.equal(rows[0].isRead, true);
  for (const [index, business] of ["test-a", "test-b"].entries()) {
    await runWithBusiness(business, async () => {
      assert.equal(await Notice.countDocuments({ employee: owner.employees[index]._id, isRead: false }), 0);
      assert.equal(await Notice.countDocuments({ employee: other.employees[index]._id, isRead: false }), 1);
    });
  }
  assert.equal((await request(path, token, "PATCH")).status, 200, "Repeat must be idempotent");
  const switched = await fetch(`${base}/employees/${owner.employees[1]._id}/notices`, { headers: { "X-Business-Id": "test-b", "X-CRM-Attendance-Session": token } });
  assert.equal(switched.status, 200);
  assert.ok((await switched.json()).every((row: { isRead: boolean }) => row.isRead), "Reload in another business must not resurrect unread notices");

  const broken = await fixture(false);
  const brokenToken = createAttendanceHubSession(broken.actor.code)!;
  await runWithBusiness("test-a", () => Notice.create({ employee: broken.employees[0]._id, title: "Synthetic rollback notice", message: "Must stay unread after failure" }));
  assert.equal((await request(`/employees/${broken.employees[0]._id}/notices/read`, brokenToken, "PATCH")).status, 503);
  assert.equal(await runWithBusiness("test-a", () => Notice.countDocuments({ employee: broken.employees[0]._id, isRead: false })), 1, "Second-business failure must roll back first-business writes");
  await setBusinessAccessForEmployeeCode(broken.actor.code, ["test-b"]);
  assert.equal((await request(`/employees/${broken.employees[0]._id}/notices/read`, brokenToken, "PATCH")).status, 403, "Matching employee code alone must not grant membership");
});

test("real Mongo: invalid batch writes no fields; two tabs cannot double clock in", async () => {
  const { identity, actor } = await fixture();
  await assert.rejects(executeAttendanceCommand(identity, { commandId: crypto.randomUUID(), expectedRevision: 0, operation: "correct", reason: "Invalid order", changes: [{ source: "Break In", at: "2026-10-15T17:00:00Z" }] }, admin), { code: "INVALID_TIMELINE" });
  assert.equal((await readAttendanceLedger(identity)).events.length, 0);
  const results = await Promise.allSettled([executeAttendanceCommand(identity, command(0, "Time In"), actor), executeAttendanceCommand(identity, command(0, "Time In"), actor)]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal((await readAttendanceLedger(identity)).events.length, 1);
});
test("real Mongo: expired owner cannot commit or release a newer fenced lease", async () => {
  const { identity, actor } = await fixture();
  await executeAttendanceCommand(identity, command(0, "Time In"), actor);
  const now = new Date(); const first = await acquireAttendanceLease(identity.key, "owner-a", now);
  const second = await acquireAttendanceLease(identity.key, "owner-b", new Date(now.getTime() + 31000));
  assert.ok(second!.fence > first!.fence);
  assert.equal(await commitAttendanceRevision(identity.key, "owner-a", first!.fence, 1, { $set: { revision: 99 } }, new Date(now.getTime() + 32000)), null);
  assert.equal((await readAttendanceLedger(identity)).revision, 1);
});
test("real API: signed role scoping, read-only GET, employee hub/config forbidden, old writes rejected", async () => {
  const owner = await fixture(); const other = await fixture();
  await executeAttendanceCommand(owner.identity, command(0, "Time In"), owner.actor);
  const token = createAttendanceHubSession(owner.actor.code)!;
  const path = `/employees/${owner.employees[0]._id}/attendance/session`;
  const before = JSON.stringify(await AttendanceLedger.findById(owner.identity.key).lean());
  const response = await request(path, token); assert.equal(response.status, 200);
  assert.equal((await response.json()).state, "ONLINE");
  assert.equal(JSON.stringify(await AttendanceLedger.findById(owner.identity.key).lean()), before);
  assert.equal((await request(`/employees/${other.employees[0]._id}/attendance/session`, token)).status, 403);
  assert.equal((await request("/attendance-policy", token)).status, 403);
  assert.equal((await request("/attendance-hub/days", token)).status, 403);
  assert.equal((await request(path, "forged")).status, 401);
  assert.equal((await request(`/employees/${owner.employees[0]._id}/attendance/time-out`, token, "POST", {})).status, 426);
});
test("real Mongo: shared business identity, checkout after 08:01, and independent employees", async () => {
  const { identity, employees, actor } = await fixture();
  const start = new Date("2026-10-15T14:53:00Z");
  const opened = await executeAttendanceCommand(identity, command(0, "Time In"), actor, start);
  const sibling = await runWithBusiness("test-b", () => resolveAttendanceIdentity(String(employees[1]._id), actor));
  assert.equal(identity.key, sibling.key);
  assert.equal(attendanceSnapshot(await readAttendanceLedger(sibling), new Date("2026-10-16T00:01:00Z")).sessionId, opened.sessionId);
  const paused = await executeAttendanceCommand(sibling, command(1, "Break Out"), actor, new Date("2026-10-16T00:01:00Z"));
  assert.equal(paused.state, "BREAK");
  await executeAttendanceCommand(identity, command(2, "Break In"), actor, new Date("2026-10-16T00:10:00Z"));
  const closed = await executeAttendanceCommand(identity, command(3, "Time Out"), actor, new Date("2026-10-16T00:20:00Z"));
  assert.equal(closed.sessions[0].id, opened.sessionId); assert.equal(closed.state, "OFFLINE");
  await deliverAttendanceLedger(identity.key);
  for (let i = 0; i < 2; i++) assert.equal(await runWithBusiness(i ? "test-b" : "test-a", () => Attendance.countDocuments({ employee: employees[i]._id })), 4);
});
test("real Mongo: undo restores original lunch/break timers, validates dependencies, and is audited", async () => {
  const { identity, actor } = await fixture();
  const start = new Date("2026-10-15T15:00:00Z");
  await executeAttendanceCommand(identity, command(0, "Time In"), actor, start);
  const lunch = command(1, "Lunch Break Out");
  await executeAttendanceCommand(identity, lunch, actor, new Date("2026-10-15T18:00:00Z"));
  const undo = { commandId: crypto.randomUUID(), expectedRevision: 2, operation: "undo" as const, targetCommandId: lunch.commandId, reason: "Accidental lunch" };
  const preview = await previewAttendanceCommand(identity, undo, admin, new Date("2026-10-15T18:01:00Z"));
  assert.equal(preview.after.state, "ONLINE");
  const saved = await executeAttendanceCommand(identity, undo, admin, new Date("2026-10-15T18:01:00Z"));
  assert.equal(saved.records.length, 1); assert.equal((await readAttendanceLedger(identity)).events.length, 2);
  assert.equal((await executeAttendanceCommand(identity, undo, admin)).revision, 3);
  const out = command(3, "Break Out"); await executeAttendanceCommand(identity, out, actor, new Date("2026-10-15T18:02:00Z"));
  const back = command(4, "Break In"); await executeAttendanceCommand(identity, back, actor, new Date("2026-10-15T18:10:00Z"));
  await assert.rejects(executeAttendanceCommand(identity, { ...undo, commandId: crypto.randomUUID(), expectedRevision: 5, targetCommandId: out.commandId }, admin), { code: "INVALID_TIMELINE" });
  const restored = await executeAttendanceCommand(identity, { ...undo, commandId: crypto.randomUUID(), expectedRevision: 5, targetCommandId: back.commandId }, admin);
  assert.equal(restored.state, "BREAK"); assert.equal(restored.stateSince, "2026-10-15T18:02:00.000Z");
});
test("real Mongo: cutoff default off; overdue catch-up is idempotent and never invents checkout or hours", async () => {
  const { identity, actor } = await fixture();
  const opened = await executeAttendanceCommand(identity, command(0, "Time In"), actor, new Date("2026-10-15T14:45:00Z"));
  assert.equal(opened.assignedShift?.dayKey, "2026-10-15");
  assert.equal(opened.assignedShift?.resetDeadline, "2026-10-16T14:59:00.000Z");
  await runAttendanceRecovery(new Date("2026-10-16T15:00:00Z"));
  assert.ok(attendanceSnapshot(await readAttendanceLedger(identity)).sessionId);
  await AttendancePolicy.updateOne({ _id: "global-attendance" }, { $set: { recoveryEnabled: true } });
  await Promise.all([runAttendanceRecovery(new Date("2026-10-16T15:10:00Z")), runAttendanceRecovery(new Date("2026-10-16T15:10:00Z"))]);
  const ledger = await readAttendanceLedger(identity); const snapshot = attendanceSnapshot(ledger);
  assert.equal(ledger.closures.length, 1); assert.equal(snapshot.state, "OFFLINE");
  assert.equal(snapshot.records.some((event) => event.source === "Time Out"), false);
  assert.equal(snapshot.sessions[0].closure?.effectiveAt, "2026-10-16T14:59:00.000Z");
  await AttendancePolicy.updateOne({ _id: "global-attendance" }, { $set: { recoveryEnabled: false } });
});
test("real API: hub range validation, employee dedupe, filtering, pagination, export and policy CAS", async () => {
  const token = createAdminDashboardSession(admin.code)!;
  const response = await request("/attendance-hub/days?preset=custom&from=2026-10-15&to=2026-10-16&pageSize=1", token, "GET", undefined, true);
  assert.equal(response.status, 200); const data = await response.json();
  assert.equal(new Set(data.rows.map((row: { employeeCode: string }) => row.employeeCode)).size, 1);
  assert.equal(data.pageSize, 1);
  assert.equal((await request("/attendance-hub/days?preset=custom&from=2026-01-01&to=2026-12-31", token, "GET", undefined, true)).status, 400);
  const csv = await request("/attendance-hub/export?preset=custom&from=2026-10-15&to=2026-10-16", token, "GET", undefined, true);
  assert.equal(csv.status, 200); assert.match(await csv.text(), /Employee code/);
  const policy = await (await request("/attendance-policy", token, "GET", undefined, true)).json();
  assert.equal((await request("/attendance-policy", token, "PUT", { ...policy, expectedRevision: policy.revision }, true)).status, 200);
  assert.equal((await request("/attendance-policy", token, "PUT", { ...policy, expectedRevision: policy.revision }, true)).status, 409);
});
test("real API: shift views retain empty roster cards, page history, preserve overnight grouping and never write", async () => {
  const { identity, actor } = await fixture();
  const today = manilaCalendarDate(new Date());
  const oldDay = shiftDateOffset(today, -62);
  const recentDay = shiftDateOffset(today, -1);
  await executeAttendanceCommand(identity, command(0, "Time In"), actor, new Date(`${oldDay}T23:00:00+08:00`));
  await executeAttendanceCommand(identity, command(1, "Time Out"), actor, new Date(`${shiftDateOffset(oldDay, 1)}T08:00:00+08:00`));
  await executeAttendanceCommand(identity, command(2, "Time In"), actor, new Date(`${recentDay}T23:00:00+08:00`));
  await deliverAttendanceLedger(identity.key);
  const before = JSON.stringify(await AttendanceLedger.findById(identity.key).lean());
  const token = createAdminDashboardSession(admin.code)!;
  const query = (suffix: string) => request(`/attendance-hub/days?business=test-a&employee=${actor.code}&${suffix}`, token, "GET", undefined, true);
  const current = await (await query("shiftView=today")).json();
  assert.equal(current.total, 1);
  assert.equal(current.employees.length, 1);
  assert.equal(current.employees[0].employeeCode, actor.code);
  const shiftDay = hubDayKey(new Date(), { officialShiftStartTime: "23:00", officialShiftEndTime: "08:00", attendanceTimeZone: "Asia/Manila", lateGraceMinutes: 0 });
  assert.equal(current.rows.length, Number(shiftDay === recentDay));
  assert.equal(current.summary.daysWorked, Number(shiftDay === recentDay));
  assert.deepEqual(current.range, { from: shiftDay, to: shiftDay });
  const specific = await (await query(`shiftView=date&shiftDate=${recentDay}`)).json();
  assert.equal(specific.rows.length, 1);
  assert.equal(specific.rows[0].dayKey, recentDay);
  assert.ok(specific.rows[0].issues.includes("OPEN SESSION"));
  assert.equal(specific.rows[0].timeOut, null);
  assert.equal(specific.rows[0].businesses.length, 2);
  const history = await (await query("shiftView=all")).json();
  assert.equal(history.history.hasOlder, true);
  assert.ok(history.rows.every((row: { dayKey: string }) => row.dayKey >= history.range.from && row.dayKey <= history.range.to));
  const older = await (await query("shiftView=all&historyPage=3")).json();
  assert.ok(older.rows.some((row: { dayKey: string }) => row.dayKey === oldDay));
  assert.equal(older.history.hasNewer, true);
  assert.equal(older.history.hasOlder, false);
  const keys = older.rows.map((row: { scopeKey: string; dayKey: string }) => `${row.scopeKey}:${row.dayKey}`);
  assert.equal(new Set(keys).size, keys.length);
  assert.equal((await query(`shiftView=date&shiftDate=${shiftDateOffset(today, 1)}`)).status, 400);
  assert.equal((await query("shiftView=all&historyPage=0")).status, 400);
  assert.equal((await query("shiftView=invalid")).status, 400);
  assert.equal((await request("/attendance-hub/days?shiftView=today", createAttendanceHubSession(actor.code)!)).status, 403);
  assert.equal(JSON.stringify(await AttendanceLedger.findById(identity.key).lean()), before);
  assert.ok((await AttendanceLedger.findById(identity.key).lean())!.audit.length > 0);
});

test("real API: Today shows the same overnight shift in all three businesses, including after PH midnight", async () => {
  mock.timers.enable({ apis: ["Date"], now: new Date("2026-10-19T18:00:00Z") });
  try {
    const businesses = ["test-a", "test-b", "test-c"];
    const code = String(91000000 + counter++);
    const ids: string[] = [];
    for (const business of businesses) await runWithBusiness(business, async () => {
      const employee = await Employee.create({ employeeCode: code, name: "Synthetic Midnight Employee", role: "Test", team: "Fixture",
        dateHired: "2026-10-01", businessAccessIds: businesses });
      ids.push(String(employee._id));
    });
    await setBusinessAccessForEmployeeCode(code, businesses);
    const actor = { role: "employee" as const, code };
    const identity = await runWithBusiness("test-a", () => resolveAttendanceIdentity(ids[0], actor));
    await executeAttendanceCommand(identity, command(0, "Time In"), actor, new Date("2026-10-19T15:00:00Z"));
    await executeAttendanceCommand(identity, command(1, "Break Out"), actor, new Date("2026-10-19T17:00:00Z"));
    await deliverAttendanceLedger(identity.key);
    const before = JSON.stringify(await AttendanceLedger.findById(identity.key).lean());
    const token = createAdminDashboardSession(admin.code)!;
    for (const business of businesses) {
      const headers = { "X-Business-Id": business, "X-CRM-Admin-Session": token };
      const query = `business=${business}&employee=${code}&shiftView=today`;
      const response = await fetch(`${base}/attendance-hub/days?${query}`, { headers });
      assert.equal(response.status, 200);
      const data = await response.json();
      assert.deepEqual(data.range, { from: "2026-10-19", to: "2026-10-19" });
      assert.equal(data.history.today, "2026-10-20", "calendar-date input limits remain separate from the selected shift day");
      assert.equal(data.rows.length, 1);
      assert.equal(data.rows[0].dayKey, "2026-10-19");
      assert.equal(data.rows[0].businessId, business);
      assert.equal(data.rows[0].events.length, 2);
      assert.equal(data.summary.daysWorked, 1);
      assert.equal(data.summary.online, 2 * 3_600_000);
      assert.equal(data.summary.break, 3_600_000);
      assert.equal(data.rows[0].timeOut, null, "viewing Today must not invent a checkout");
      const csv = await fetch(`${base}/attendance-hub/export?${query}`, { headers });
      assert.equal(csv.status, 200);
      assert.ok((await csv.text()).includes('"Attendance","2026-10-19","2026-10-19"'));
      const nextDate = await fetch(`${base}/attendance-hub/days?business=${business}&employee=${code}&shiftView=date&shiftDate=2026-10-20`, { headers });
      assert.equal(nextDate.status, 200);
      assert.deepEqual((await nextDate.json()).rows, [], "an explicit next-shift date must not inherit the previous shift's punches");
    }
    assert.equal(JSON.stringify(await AttendanceLedger.findById(identity.key).lean()), before, "all list and export reads remain non-mutating");
  } finally { mock.timers.reset(); }
});

  test("real API: shift-view employee sorting survives pagination and keeps business-only roster members scoped", async () => {
    const marker = `SortFixture${counter++}`;
    const today = manilaCalendarDate(new Date());
    for (const [business, names] of [["test-a", ["Alpha", "Zulu"]], ["test-b", ["Other"]]] as const) {
      for (const name of names) await runWithBusiness(business, () => Employee.create({
        employeeCode: String(95000000 + counter++), name: `${marker} ${name}`, role: "Test", team: marker,
        dateHired: today,
      }));
    }
    const token = createAdminDashboardSession(admin.code)!;
    const read = async (business: string, direction: string, page = 1) => {
      const response = await request(`/attendance-hub/days?business=${business}&team=${marker}&shiftView=today&sort=employee&direction=${direction}&pageSize=1&page=${page}`, token, "GET", undefined, true);
      assert.equal(response.status, 200);
      return response.json();
    };
    const descending = await read("test-a", "desc");
    assert.equal(descending.total, 2);
    assert.equal(descending.employees[0].employeeName, `${marker} Zulu`);
    assert.equal((await read("test-a", "desc", 2)).employees[0].employeeName, `${marker} Alpha`);
    assert.equal((await read("test-a", "asc")).employees[0].employeeName, `${marker} Alpha`);
    const other = await read("test-b", "asc");
    assert.equal(other.total, 1);
    assert.equal(other.employees[0].employeeName, `${marker} Other`);
    assert.deepEqual(other.rows, []);
    const shiftDay = shiftDateOffset(today, -1);
    await runWithBusiness("test-a", async () => {
      for (const [name, minutes] of [["Alpha", 10], ["Zulu", 30]] as const) {
        const employee = await Employee.findOne({ name: `${marker} ${name}` }).lean();
        const identity = await resolveAttendanceIdentity(String(employee!._id), admin);
        const start = new Date(`${shiftDay}T23:00:00+08:00`);
        const actor = { role: "employee" as const, code: employee!.employeeCode };
        await executeAttendanceCommand(identity, command(0, "Time In"), actor, start);
        await executeAttendanceCommand(identity, command(1, "Time Out"), actor, new Date(start.getTime() + minutes * 60_000));
        await deliverAttendanceLedger(identity.key);
      }
    });
    const worked = await (await request(`/attendance-hub/days?business=test-a&team=${marker}&shiftView=date&shiftDate=${shiftDay}&sort=worked&direction=desc&pageSize=1`, token, "GET", undefined, true)).json();
    assert.equal(worked.employees[0].employeeName, `${marker} Zulu`);
    assert.equal(worked.rows[0].milliseconds.online, 30 * 60_000);
  });

  test("real API: missing business replica reports committed sync-pending, then retries without duplicate events", async () => {
  const { identity, employees, actor } = await fixture(false);
  const token = createAttendanceHubSession(actor.code)!;
  const input = command(0, "Time In");
  const first = await request(`/employees/${employees[0]._id}/attendance/commands`, token, "POST", input);
  assert.equal(first.status, 200); const body = await first.json();
  assert.equal(body.revision, 1); assert.equal(body.syncPending, true);
  const replica = await runWithBusiness("test-b", () => Employee.create({ employeeCode: actor.code, name: "Synthetic recovered replica", role: "Test", team: "Fixture" }));
  const canonicalRead = await fetch(`${base}/attendance?employeeIds=${replica._id}&all=true`, { headers: { "X-Business-Id": "test-b", "X-CRM-Admin-Session": createAdminDashboardSession(admin.code)! } });
  assert.equal(canonicalRead.status, 200); assert.equal((await canonicalRead.json()).length, 1);
  await deliverAttendanceLedger(identity.key);
  const replay = await request(`/employees/${employees[0]._id}/attendance/commands`, token, "POST", input);
  assert.equal(replay.status, 200); const saved = await replay.json();
  assert.equal(saved.revision, 1); assert.equal(saved.syncPending, false); assert.equal(saved.records.length, 1);
  assert.equal((await readAttendanceLedger(identity)).commands.length, 1);
});
test("real Mongo: recovery runs before a due manual action and stale delivery cannot override a newer shift", async () => {
  const { identity, actor } = await fixture();
  await executeAttendanceCommand(identity, command(0, "Time In"), actor, new Date("2026-10-15T14:45:00Z"));
  await AttendancePolicy.updateOne({ _id: "global-attendance" }, { $set: { recoveryEnabled: true } });
  const next = new Date("2026-10-16T15:00:00Z");
  await assert.rejects(executeAttendanceCommand(identity, command(1, "Time In"), actor, next), { code: "RECOVERY_COMPLETED" });
  const open = await executeAttendanceCommand(identity, command(2, "Time In"), actor, next);
  assert.equal(open.assignedShift?.dayKey, "2026-10-16");
  await runAttendanceRecovery(new Date("2026-10-16T15:01:00Z"));
  await deliverAttendanceLedger(identity.key);
  const latest = attendanceSnapshot(await readAttendanceLedger(identity));
  assert.equal(latest.sessionId, open.sessionId); assert.equal(latest.state, "ONLINE");
  assert.equal((await readAttendanceLedger(identity)).closures.length, 1);
  await AttendancePolicy.updateOne({ _id: "global-attendance" }, { $set: { recoveryEnabled: false } });
});
test("real Mongo: matching codes without explicit control membership are not merged across tenants", async () => {
  const code = String(92000000 + counter++);
  const identities = [];
  for (const business of ["test-a", "test-b"]) identities.push(await runWithBusiness(business, async () => {
    const employee = await Employee.create({ employeeCode: code, name: "Unrelated synthetic identity", role: "Test", team: "Fixture" });
    return resolveAttendanceIdentity(String(employee._id), admin);
  }));
  assert.notEqual(identities[0].key, identities[1].key);
  await executeAttendanceCommand(identities[0], command(0, "Time In"), { role: "employee", code });
  assert.equal(attendanceSnapshot(await readAttendanceLedger(identities[1])).state, "OFFLINE");
    await executeAttendanceCommand(identities[1], command(0, "Time In"), { role: "employee", code });
    for (const identity of identities) await deliverAttendanceLedger(identity.key);
    const response = await request(`/attendance-hub/days?shiftView=all&employee=${code}`, createAdminDashboardSession(admin.code)!, "GET", undefined, true);
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.total, 2);
    assert.equal(result.summary.employeesPresent, 2);
    assert.equal(new Set(result.employees.map((employee: { scopeKey: string }) => employee.scopeKey)).size, 2);
    assert.ok(result.rows.every((row: { mismatch: boolean }) => !row.mismatch));
});
test("real Mongo: correcting a system-closed clock-in preserves session identity and never reopens it", async () => {
  const { identity, actor } = await fixture();
  const opened = await executeAttendanceCommand(identity, command(0, "Time In"), actor, new Date("2026-10-15T14:45:00Z"));
  await AttendancePolicy.updateOne({ _id: "global-attendance" }, { $set: { recoveryEnabled: true } });
  await runAttendanceRecovery(new Date("2026-10-16T15:00:00Z"));
  const corrected = await executeAttendanceCommand(identity, { commandId: crypto.randomUUID(), expectedRevision: 2, operation: "correct", reason: "Reviewed historical minute correction",
    changes: [{ targetId: opened.records[0].id, at: "2026-10-15T14:46:00Z" }] }, admin);
  assert.equal(corrected.state, "OFFLINE"); assert.equal(corrected.sessions[0].id, opened.sessionId);
  assert.equal(corrected.sessions[0].lifecycle, "system-closed"); assert.equal(corrected.sessions[0].time.scheduled.online, 0);
  await AttendancePolicy.updateOne({ _id: "global-attendance" }, { $set: { recoveryEnabled: false } });
});
test("real Mongo: dependent lunch corrections require the whole pair, not an orphan return", async () => {
  const { identity, actor } = await fixture();
  await executeAttendanceCommand(identity, command(0, "Time In"), actor, new Date("2026-10-15T15:00:00Z"));
  const out = await executeAttendanceCommand(identity, command(1, "Lunch Break Out"), actor, new Date("2026-10-15T17:00:00Z"));
  const back = await executeAttendanceCommand(identity, command(2, "Lunch Break In"), actor, new Date("2026-10-15T17:13:00Z"));
  const change = { commandId: crypto.randomUUID(), expectedRevision: 3, operation: "correct" as const, reason: "Lunch should have been break", changes: [{ targetId: out.records.at(-1)!.id, source: "Break Out" as const }] };
  await assert.rejects(executeAttendanceCommand(identity, change, admin), { code: "INVALID_TIMELINE" });
  const fixed = await executeAttendanceCommand(identity, { ...change, changes: [...change.changes, { targetId: back.records.at(-1)!.id, source: "Break In" }] }, admin);
  assert.equal(fixed.revision, 4); assert.equal(fixed.records[1].at, out.records.at(-1)!.at); assert.equal(fixed.records[2].source, "Break In");
});
test("real Mongo: one off-phone checkout command is undone as a whole action", async () => {
  const { identity, actor } = await fixture();
  await executeAttendanceCommand(identity, command(0, "Time In"), actor, new Date("2026-10-15T15:00:00Z"));
  await executeAttendanceCommand(identity, command(1, "Off the Phone Out"), actor, new Date("2026-10-15T17:00:00Z"));
  const checkout = command(2, "Time Out");
  // Force reverse-lexical IDs so losing canonical order fails deterministically.
  let nextId = 999999999999;
  const ids = mock.method(crypto, "randomUUID", () => `ffffffff-ffff-4fff-bfff-${nextId--}` as ReturnType<typeof crypto.randomUUID>);
  let closed: Awaited<ReturnType<typeof executeAttendanceCommand>>;
  try {
    closed = await executeAttendanceCommand(identity, checkout, actor, new Date("2026-10-15T17:01:00Z"));
  } finally {
    ids.mock.restore();
  }
  assert.equal(closed.records.filter((event) => event.commandId === checkout.commandId).length, 2);
  await deliverAttendanceLedger(identity.key);
  const hubResponse = await request(`/attendance-hub/days?preset=custom&from=2026-10-15&to=2026-10-15&employee=${actor.code}`,
    createAdminDashboardSession(admin.code)!, "GET", undefined, true);
  assert.equal(hubResponse.status, 200);
  const hub = await hubResponse.json();
  assert.equal(hub.rows.length, 1);
  const day = hub.rows[0];
  assert.deepEqual(day.review, []);
  assert.equal(day.mismatch, false);
  assert.equal(day.milliseconds.online, 120 * 60_000);
  assert.equal(day.milliseconds.offPhone, 60_000);
  assert.equal(day.businesses.length, 2);
  for (const business of day.businesses) {
    assert.equal(business.milliseconds.online, 120 * 60_000);
    assert.deepEqual(business.events.slice(-2).map((event: { source: string }) => event.source), ["Off the Phone In", "Time Out"]);
  }
  const reopened = await executeAttendanceCommand(identity, { commandId: crypto.randomUUID(), expectedRevision: 3, operation: "undo", reason: "Accidental checkout", targetCommandId: checkout.commandId }, admin, new Date("2026-10-15T17:02:00Z"));
  assert.equal(reopened.state, "OFF THE PHONE"); assert.equal(reopened.stateSince, "2026-10-15T17:00:00.000Z"); assert.equal(reopened.records.length, 2);
});
test("real API: a session remains readable beyond the 250-record history page", async () => {
  const { identity, actor, employees } = await fixture();
  const start = Date.parse("2026-10-15T15:00:00Z");
  const opened = await executeAttendanceCommand(identity, command(0, "Time In"), actor, new Date(start));
  for (let batch = 0; batch < 10; batch++) {
    const changes = Array.from({ length: 26 }, (_, index) => ({ source: (index % 2 ? "Off the Phone In" : "Off the Phone Out") as "Off the Phone In" | "Off the Phone Out",
      at: new Date(start + (batch * 26 + index + 1) * 1000).toISOString() }));
    await executeAttendanceCommand(identity, { commandId: crypto.randomUUID(), expectedRevision: batch + 1, operation: "correct", reason: "Synthetic long history fixture", changes }, admin, new Date(start + 300000));
  }
  const token = createAttendanceHubSession(actor.code)!;
  const history = await (await request(`/employees/${employees[0]._id}/attendance?limit=250`, token)).json();
  assert.equal(history.length, 250); assert.equal(history.some((event: { source: string }) => event.source === "Time In"), false);
  const active = await (await request(`/employees/${employees[0]._id}/attendance/session`, token)).json();
  assert.equal(active.sessionId, opened.sessionId); assert.equal(active.state, "ONLINE");
});
test("real API: legacy migration preview is read-only and unreviewed historical adoption fails closed", async () => {
  const { identity, actor, employees } = await fixture();
  await runWithBusiness("test-a", () => Attendance.create({ employee: employees[0]._id, source: "Time In", timeIn: new Date("2026-10-15T15:00:00Z") }));
  const snapshot = attendanceSnapshot(await readAttendanceLedger(identity));
  assert.equal(snapshot.state, "ONLINE"); assert.equal(snapshot.reviewState, "migration-review");
  const token = createAdminDashboardSession(admin.code)!;
  const response = await request(`/employees/${employees[0]._id}/attendance/migration-preview`, token, "GET", undefined, true);
  assert.equal(response.status, 200); const report = await response.json();
  assert.equal(report.writes, 0); assert.equal(report.crossBusinessMismatch, true);
  assert.equal(await AttendanceLedger.exists({ _id: identity.key }), null);
  await assert.rejects(executeAttendanceCommand(identity, command(0, "Time Out"), actor), { code: "MIGRATION_REVIEW_REQUIRED" });
});
test("real API: settings reads do not create a document; forged role headers cannot change thresholds", async () => {
  const { SystemSettings } = await import("../models/SystemSettings");
  const count = await runWithBusiness("test-a", () => SystemSettings.countDocuments({}));
  assert.equal((await request("/system-settings", "")).status, 401);
  const response = await request("/system-settings", createAdminDashboardSession(admin.code)!, "GET", undefined, true); assert.equal(response.status, 200);
  assert.equal(await runWithBusiness("test-a", () => SystemSettings.countDocuments({})), count);
  const forged = await fetch(`${base}/system-settings`, { method: "PUT", headers: { "Content-Type": "application/json", "X-Business-Id": "test-a", "X-CRM-User-Type": "admin", "X-CRM-User-Code": admin.code }, body: JSON.stringify({ lateGraceMinutes: 15 }) });
  assert.equal(forged.status, 401);
});
test("legacy HR characterization: parallel same-employee handlers self-conflict after one field persisted", async () => {
  const { withAttendanceActionLock } = await import("../middleware/attendanceActionLock");
  const { employees } = await fixture();
  let release!: () => void; let entered!: () => void;
  const hold = new Promise<void>((resolve) => { release = resolve; });
  const written = new Promise<void>((resolve) => { entered = resolve; });
  const handler = withAttendanceActionLock(async (_request, response) => {
    await Attendance.create({ employee: employees[0]._id, source: "Time In", timeIn: new Date("2026-10-15T15:00:00Z") });
    entered(); await hold; response.json({ saved: true });
  });
  const request = { params: { employeeId: String(employees[0]._id) } } as unknown as import("express").Request;
  const firstResponse = { json: () => undefined } as unknown as import("express").Response;
  let status = 200;
  const secondResponse = { status: (code: number) => { status = code; return secondResponse; }, json: () => undefined } as unknown as import("express").Response;
  const first = runWithBusiness("test-a", () => handler(request, firstResponse));
  try {
    await written;
    await runWithBusiness("test-a", () => handler(request, secondResponse));
    assert.equal(status, 409);
    assert.equal(await runWithBusiness("test-a", () => Attendance.countDocuments({ employee: employees[0]._id })), 1);
  } finally { release(); await first; }
});
test("legacy synchronization regression: a stale snapshot cannot archive a concurrently added punch", async () => {
  const { syncEmployeeAttendanceAcrossBusinesses } = await import("./employeeAttendanceSyncService");
  const { identity, employees } = await fixture();
  const initial = await runWithBusiness("test-a", () => Attendance.create({ employee: employees[0]._id, source: "Time In", timeIn: new Date("2026-10-15T15:00:00Z") }));
  const added = await runWithBusiness("test-a", () => Attendance.create({ employee: employees[0]._id, source: "Break Out", timeIn: new Date("2026-10-15T17:00:00Z") }));
  const staleSnapshotWouldArchive = await runWithBusiness("test-a", () => Attendance.find({ employee: employees[0]._id, isArchived: false, $nor: [{ source: initial.source, timeIn: initial.timeIn }] }).lean());
  assert.equal(String(staleSnapshotWouldArchive[0]._id), String(added._id));
  process.env.CRM_ATTENDANCE_INTEGRITY = "false";
  try { await runWithBusiness("test-a", () => syncEmployeeAttendanceAcrossBusinesses(identity.code)); }
  finally { process.env.CRM_ATTENDANCE_INTEGRITY = "true"; }
  for (let index = 0; index < 2; index++) assert.equal(await runWithBusiness(index ? "test-b" : "test-a", () => Attendance.countDocuments({ employee: employees[index]._id, source: "Break Out", isArchived: false })), 1);
  assert.equal((await runWithBusiness("test-a", () => Attendance.findById(added._id).lean()))?.isArchived, false);
});
test("measurement: 200 synthetic employees over 31 days are batched, capped and use the attendance index", async (context) => {
  const codes = Array.from({ length: 200 }, (_, index) => String(93000000 + index));
  let example: mongoose.Types.ObjectId | undefined;
  for (const business of ["test-a", "test-b"]) await runWithBusiness(business, async () => {
    const employees = await Employee.insertMany(codes.map((employeeCode) => ({ employeeCode, name: `Synthetic Load ${employeeCode}`, role: "Test", team: "Load test", dateHired: "2026-07-01" })));
    example ||= employees[0]._id;
    await Attendance.insertMany(employees.flatMap((employee) => Array.from({ length: 31 }, (_, index) => [
      { employee: employee._id, source: "Time In", timeIn: new Date(Date.UTC(2026, 7, index + 1, 15)) },
      { employee: employee._id, source: "Time Out", timeIn: new Date(Date.UTC(2026, 7, index + 2, 0)) },
    ]).flat()));
  });
  for (const code of codes) await setBusinessAccessForEmployeeCode(code, ["test-a", "test-b"]);
  await runWithBusiness("test-a", () => Attendance.collection.createIndex({ employee: 1, isArchived: 1, timeIn: -1 }));
  const plan = await runWithBusiness("test-a", () => Attendance.collection.find({ employee: example, isArchived: false, timeIn: { $gte: new Date("2026-08-01T00:00:00Z"), $lte: new Date("2026-09-02T00:00:00Z") } }).explain("executionStats"));
  assert.match(JSON.stringify(plan.queryPlanner.winningPlan), /IXSCAN/);
  const began = performance.now();
  const response = await request("/attendance-hub/days?preset=custom&from=2026-08-01&to=2026-08-31&team=Load%20test&pageSize=25", createAdminDashboardSession(admin.code)!, "GET", undefined, true);
  const data = await response.json();
  assert.equal(response.status, 200); assert.equal(data.total, 200); assert.ok(data.rows.length <= 500); assert.equal(data.pageSize, 16);
  context.diagnostic(`31-day / 200-employee server request: ${Math.round(performance.now() - began)}ms; ${data.rows.length} returned days; ${plan.executionStats.totalDocsExamined} indexed documents examined for one employee.`);
});
test("real Mongo: adding an assigned business copies canonical stable events, not a legacy duplicate", async () => {
  const { employees, actor } = await fixture();
  const { syncEmployeeAttendanceAcrossBusinesses } = await import("./employeeAttendanceSyncService");
  await setBusinessAccessForEmployeeCode(actor.code, ["test-a"]);
  const identity = await runWithBusiness("test-a", () => resolveAttendanceIdentity(String(employees[0]._id), actor));
  const saved = await executeAttendanceCommand(identity, command(0, "Time In"), actor);
  await deliverAttendanceLedger(identity.key);
  assert.equal(await runWithBusiness("test-b", () => Attendance.countDocuments({ employee: employees[1]._id })), 0);
  await setBusinessAccessForEmployeeCode(actor.code, ["test-a", "test-b"]);
  await runWithBusiness("test-a", () => syncEmployeeAttendanceAcrossBusinesses(actor.code));
  const copied = await runWithBusiness("test-b", () => Attendance.find({ employee: employees[1]._id }).lean());
  assert.equal(copied.length, 1); assert.equal(copied[0].eventId, saved.records[0].id);
  assert.deepEqual((await readAttendanceLedger(identity)).businessIds.sort(), ["test-a", "test-b"]);
});

test("real API: all manual buttons update three assigned business replicas exactly once", async () => {
  const businesses = ["test-a", "test-b", "test-c"];
  const code = String(91000000 + counter++);
  const ids: string[] = [];
  for (const business of businesses) await runWithBusiness(business, async () => {
    const employee = await Employee.create({ employeeCode: code, name: "Synthetic Three Business Employee", role: "Test", team: "Fixture",
      dateHired: "2026-10-01", businessAccessIds: businesses });
    ids.push(String(employee._id));
  });
  await setBusinessAccessForEmployeeCode(code, businesses);
  const token = createAttendanceHubSession(code)!;
  const headers = (index: number) => ({ "Content-Type": "application/json", "X-Business-Id": businesses[index], "X-CRM-Attendance-Session": token });
  const read = async (index: number) => {
    const response = await fetch(`${base}/employees/${ids[index]}/attendance/session`, { headers: headers(index) });
    assert.equal(response.status, 200);
    return response.json();
  };
  const sources = ["Time In", "Break Out", "Break In", "Lunch Break Out", "Lunch Break In", "Off the Phone Out", "Time Out"];
  const states = ["ONLINE", "BREAK", "ONLINE", "LUNCH", "ONLINE", "OFF THE PHONE", "OFFLINE"];
  for (let step = 0; step < sources.length; step++) {
    const index = step % businesses.length;
    const before = await read(index);
    const input = { commandId: crypto.randomUUID(), expectedRevision: before.revision, fingerprint: before.fingerprint,
      operation: "action", source: sources[step] };
    const send = () => fetch(`${base}/employees/${ids[index]}/attendance/commands`, {
      method: "POST", headers: headers(index), body: JSON.stringify(input),
    });
    const response = await send();
    assert.equal(response.status, 200, await response.clone().text());
    const saved = await response.json();
    assert.equal(saved.state, states[step]);
    assert.equal(saved.syncPending, false);
    const replay = await send();
    assert.equal(replay.status, 200);
    assert.equal((await replay.json()).revision, saved.revision, "a repeated click/request must not append twice");
    for (let replica = 0; replica < businesses.length; replica++) {
      const snapshot = await read(replica);
      assert.equal(snapshot.state, states[step]);
      assert.equal(snapshot.revision, saved.revision);
      assert.deepEqual(snapshot.records, saved.records);
      assert.equal(snapshot.reviewState, "verified");
      const shiftDay = snapshot.sessions.at(-1).shift.dayKey;
      const dashboardDay = snapshot.dashboardDays.find((day: { dayKey: string }) => day.dayKey === shiftDay);
      assert.deepEqual(dashboardDay.eventIds, saved.records.map((event: { id: string }) => event.id), "dashboard shift records update after every manual action");
      const historyResponse = await fetch(`${base}/employees/${ids[replica]}/attendance?all=true`, { headers: headers(replica) });
      assert.equal(historyResponse.status, 200);
      assert.deepEqual((await historyResponse.json()).map((event: { eventId: string }) => event.eventId).sort(), [...dashboardDay.eventIds].sort());
      const hubResponse = await fetch(`${base}/attendance-hub/days?business=${businesses[replica]}&preset=custom&from=${shiftDay}&to=${shiftDay}&employee=${code}`, {
        headers: { "X-Business-Id": businesses[replica], "X-CRM-Admin-Session": createAdminDashboardSession(admin.code)! },
      });
      assert.equal(hubResponse.status, 200);
      const hub = await hubResponse.json();
      assert.equal(hub.rows.length, 1);
      assert.deepEqual(hub.rows[0].events.map((event: { eventId: string }) => event.eventId).sort(), [...dashboardDay.eventIds].sort(), "admin shift list sees the same canonical events in every business");
      await runWithBusiness(businesses[replica], async () => {
        const employee = await Employee.findById(ids[replica]).select("availabilityStatus attendanceRevision").lean();
        assert.equal(employee?.availabilityStatus, states[step]);
        assert.equal(employee?.attendanceRevision, saved.revision);
        const events = await Attendance.find({ employee: ids[replica], isEffective: { $ne: false } }).select("eventId source timeIn").lean();
        assert.equal(events.length, saved.records.length);
        assert.deepEqual(events.map((event) => event.eventId).sort(), saved.records.map((event: { id: string }) => event.id).sort());
      });
    }
  }
  const final = await read(0);
  assert.deepEqual(final.records.map((event: { source: string }) => event.source), [
    "Time In", "Break Out", "Break In", "Lunch Break Out", "Lunch Break In", "Off the Phone Out", "Off the Phone In", "Time Out",
  ], "explicit checkout from off-phone records the return and checkout as one command");
});
