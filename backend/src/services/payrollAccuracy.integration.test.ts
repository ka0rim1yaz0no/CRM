import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import { after, before, beforeEach, mock, test } from "node:test";
import mongoose from "mongoose";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import type { SessionEvent } from "./attendanceSessionState";

const root = `pay_accuracy_${crypto.randomUUID().replaceAll("-", "")}`;
process.env.NODE_ENV = "test";
process.env.CRM_PAYROLL_ACCURACY = "true";
process.env.CRM_ATTENDANCE_DURATION_MODEL = "true";
process.env.CRM_ATTENDANCE_BREAK_GAP = "false";
process.env.CRM_ATTENDANCE_AUTO_TIMEOUT = "false";
process.env.CRM_ATTENDANCE_RECOVERY_CUTOFF = "false";
process.env.CRM_ADMIN_ONE_CODE = "90000001";
process.env.CRM_ADMIN_SESSION_SECRET = crypto.randomBytes(48).toString("hex");
process.env.DEFAULT_BUSINESS_ID = "pay-a";
process.env.DEFAULT_BUSINESS_DATABASE = `${root}_a`;
process.env.CONTROL_DATABASE_NAME = `${root}_control`;
process.env.BUSINESS_DATABASES = JSON.stringify(["a", "b"].map(id => ({ id: `pay-${id}`, name: `Synthetic Payroll ${id}`, databaseName: `${root}_${id}` })));
const { createApp } = await import("../app");
const { Employee } = await import("../models/Employee");
const { Attendance } = await import("../models/Attendance");
const { AttendanceLedger, AttendancePolicy } = await import("../models/AttendanceLedger");
const { PayrollRecord } = await import("../models/Payroll");
const { SystemSettings } = await import("../models/SystemSettings");
const { runWithBusiness, getBusinessConnection } = await import("../config/tenancy");
const { setBusinessAccessForEmployeeCode } = await import("../models/BusinessUserAccess");
const { createAdminDashboardSession } = await import("../config/adminDashboardSession");
const { assignAttendanceShift } = await import("./attendanceShift");
const { syncEmployeePayrollRecords } = await import("../controllers/payrollController");
const period = "Oct 15, 2026 - Oct 15, 2026";
const start = Date.parse("2026-10-15T15:00:00Z");
let mongo: MongoMemoryReplSet, server: http.Server, base = "", token = "";
let ids: mongoose.Types.ObjectId[] = [];
let events: SessionEvent[] = [];
before(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri(root));
  server = http.createServer(createApp());
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`;
  token = createAdminDashboardSession("90000001")!;
});
after(async () => {
  if (server?.listening) await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
  await mongoose.disconnect(); await mongo?.stop();
});
beforeEach(async () => {
  ids = [];
  await AttendanceLedger.deleteMany({}); await AttendancePolicy.deleteMany({});
  await AttendancePolicy.create({ _id: "global-attendance", revision: 1, shiftStart: "23:00", shiftEnd: "08:00", breakMinutes: 15, lunchMinutes: 60, graceMinutes: 0 });
  events = [["Time In", 5], ["Break Out", 60], ["Break In", 76], ["Break Out", 120], ["Break In", 135], ["Lunch Break Out", 200], ["Lunch Break In", 261], ["Time Out", 530]]
    .map(([source, minutes], sequence) => ({ id: `e${sequence}`, commandId: `c${sequence}`, source: source as SessionEvent["source"], sequence,
      at: new Date(start + Number(minutes) * 60_000).toISOString(), recordedAt: new Date(start + Number(minutes) * 60_000).toISOString(),
      ...(sequence === 0 ? { shift: assignAttendanceShift(new Date(start)) } : {}) }));
  for (const business of ["pay-a", "pay-b"]) await runWithBusiness(business, async () => {
    await Employee.deleteMany({}); await Attendance.deleteMany({}); await PayrollRecord.deleteMany({}); await SystemSettings.deleteMany({});
    await SystemSettings.create({ key: "system", payrollFirstCutoffStartDay: 15, payrollFirstCutoffEndDay: 15, payrollSecondCutoffStartDay: 16, payrollSecondCutoffEndDay: 14 });
    const employee = await Employee.create({ employeeCode: "90000003", name: "Synthetic Payroll Employee", email: "payroll@example.invalid", salary: 30000,
      status: "Active", role: "Sales", team: "Synthetic", businessAccessIds: ["pay-a", "pay-b"] });
    ids.push(employee._id);
    await Attendance.insertMany(events.map(item => ({ employee: employee._id, source: item.source, timeIn: new Date(item.at), eventId: item.id, sequence: item.sequence })));
    await PayrollRecord.init();
  });
  await setBusinessAccessForEmployeeCode("90000003", ["pay-a", "pay-b"]);
  await AttendanceLedger.create({ _id: "synthetic-payroll", employeeCode: "90000003", businessIds: ["pay-a", "pay-b"], canonicalBusinessId: "pay-a", revision: 1, events });
});
async function request(route: string, body?: unknown, business = "pay-a", auth = token, method?: string) {
  const response = await fetch(`${base}${route}`, { method: method || (body === undefined ? "GET" : "POST"), headers: { "Content-Type": "application/json", "X-Business-Id": business,
    "X-CRM-Admin-Session": auth }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, data: await response.json() };
}
const preview = (overtimeApprovals = {}) => request("/payroll/recompute/preview", { payPeriod: period, overtimeApprovals });
const confirm = (value: { token: string }, extra = {}) => request("/payroll/recompute/confirm", { payPeriod: period, token: value.token, confirm: true, reason: "Synthetic verification", ...extra });
test("preview reads only; explicit confirmation stores identical business mirrors and an audit, once per employee", async () => {
  const before = JSON.stringify(await AttendanceLedger.findById("synthetic-payroll").lean());
  const result = await preview(); assert.equal(result.status, 200, JSON.stringify(result.data));
  assert.equal(result.data.rows.length, 1); assert.equal(result.data.canApply, true);
  assert.equal(result.data.rows[0].after.grossPay, 15000);
  assert.equal(result.data.rows[0].after.deductions, 46.20);
  assert.equal(await runWithBusiness("pay-a", () => PayrollRecord.countDocuments()), 0);
  const applied = await confirm(result.data); assert.equal(applied.status, 200, JSON.stringify(applied.data));
  assert.deepEqual(applied.data, { applied: 1, mirrors: 2, payPeriod: period });
  for (const business of ["pay-a", "pay-b"]) await runWithBusiness(business, async () => {
    const record = await PayrollRecord.findOne().lean(); assert.ok(record);
    assert.equal(record.paidHoursPerDay, 8); assert.equal(record.minuteRate, 30000 / 23 / 8 / 60);
    assert.equal(record.deductibleMinutes, 17); assert.equal(record.missingHours! * 60, 17);
    assert.equal(record.calculationAudit?.length, 1); assert.equal(record.calculationAudit?.[0].actor, "90000001");
    assert.equal(record.payrollOwnerBusinessId, "pay-a"); assert.equal((record.calculationSnapshot?.evidence as unknown[]).length, 8);
  });
  assert.equal(JSON.stringify(await AttendanceLedger.findById("synthetic-payroll").lean()), before);
  assert.equal((await confirm(result.data)).status, 409);
});
test("stored cutoff survives settings changes, attendance sync and repeated GETs in every business", async () => {
  const first = await preview(); assert.equal((await confirm(first.data)).status, 200);
  const before = await runWithBusiness("pay-a", async () => JSON.stringify(await PayrollRecord.findOne().lean()));
  await AttendancePolicy.updateOne({ _id: "global-attendance" }, { shiftStart: "22:00", lunchMinutes: 30 });
  for (const business of ["pay-a", "pay-b"]) {
    assert.equal((await request("/payroll/records", undefined, business)).status, 200);
    assert.equal((await request("/payroll/stats", undefined, business)).status, 200);
    const dtr = await request(`/payroll/dtr/90000003?payPeriod=${encodeURIComponent(period)}`, undefined, business);
    assert.equal(dtr.status, 200); assert.equal(dtr.data.summary.paidHoursPerDay, 8); assert.equal(dtr.data.summary.deductions, 46.20);
    await runWithBusiness(business, () => syncEmployeePayrollRecords(period));
  }
  assert.equal(await runWithBusiness("pay-a", async () => JSON.stringify(await PayrollRecord.findOne().lean())), before);
});
test("invalid/missing shift configuration returns 422 instead of inventing rates", async () => {
  await AttendancePolicy.deleteMany({});
  for (const business of ["pay-a", "pay-b"]) await runWithBusiness(business, () => SystemSettings.deleteMany({}));
  const result = await preview(); assert.equal(result.status, 422); assert.match(result.data.message, /Shift settings are required for payroll/);
  assert.equal(await runWithBusiness("pay-a", () => PayrollRecord.countDocuments()), 0);
});
test("partial or overlapping cutoff ranges cannot generate another half-salary payment", async () => {
  assert.equal((await request("/payroll/recompute/preview", { payPeriod: "Oct 14, 2026 - Oct 15, 2026" })).status, 422);
  await runWithBusiness("pay-a", () => PayrollRecord.create({ employeeName: "Synthetic Payroll Employee", employeeId: "90000003", department: "Synthetic", grossPay: 15000,
    deductions: 0, netPay: 15000, payPeriod: "Oct 6, 2026 - Oct 20, 2026", status: "Paid", isArchived: true }));
  const result = await preview(); assert.equal(result.status, 422); assert.match(result.data.message, /overlaps/);
});
test("payment status failure in a second business leaves the first business unchanged", async () => {
  const result = await preview(); assert.equal((await confirm(result.data)).status, 200);
  const record = await runWithBusiness("pay-a", () => PayrollRecord.findOne().lean());
  const stub = mock.method(getBusinessConnection("pay-b").model("PayrollRecord"), "updateOne", () => { throw new Error("Synthetic payment mirror failure"); });
  try { assert.equal((await request(`/payroll/records/${record!._id}/paid`, {}, "pay-a", token, "PATCH")).status, 500); }
  finally { stub.mock.restore(); }
  for (const business of ["pay-a", "pay-b"]) assert.equal((await runWithBusiness(business, () => PayrollRecord.findOne().lean()))?.status, "Pending");
});
test("unclosed rest and cross-business mismatch block all cutoff writes without changing evidence", async () => {
  await runWithBusiness("pay-b", () => Attendance.updateOne({ eventId: "e2" }, { $set: { timeIn: new Date(start + 77 * 60_000) } }));
  const changed = await preview(); assert.equal(changed.status, 200); assert.equal(changed.data.canApply, false);
  assert.equal((await confirm(changed.data)).status, 422);
  for (const business of ["pay-a", "pay-b"]) assert.equal(await runWithBusiness(business, () => PayrollRecord.countDocuments()), 0);
});
test("stale confirmation and employee/forged sessions cannot write payroll", async () => {
  const first = await preview();
  await runWithBusiness("pay-b", () => Employee.updateOne({ employeeCode: "90000003" }, { $set: { salary: 31000 } }));
  assert.equal((await confirm(first.data)).status, 422);
  assert.equal((await request("/payroll/recompute/preview", { payPeriod: period }, "pay-a", "forged")).status, 401);
  assert.equal((await request("/payroll/recompute/confirm", { payPeriod: period, confirm: false }, "pay-a")).status, 400);
});
test("parallel confirmations cannot create duplicate cutoffs or duplicate audit entries", async () => {
  const first = await preview();
  const results = await Promise.all([confirm(first.data), confirm(first.data)]);
  assert.equal(results.filter(result => result.status === 200).length, 1, JSON.stringify(results));
  for (const business of ["pay-a", "pay-b"]) await runWithBusiness(business, async () => {
    assert.equal(await PayrollRecord.countDocuments(), 1); assert.equal((await PayrollRecord.findOne().lean())?.calculationAudit?.length, 1);
  });
});
test("owner business settles a shared cutoff once and paid cutoffs cannot be recomputed", async () => {
  const first = await preview(); assert.equal((await confirm(first.data)).status, 200);
  const a = await runWithBusiness("pay-a", () => PayrollRecord.findOne().lean()), b = await runWithBusiness("pay-b", () => PayrollRecord.findOne().lean());
  assert.equal((await request(`/payroll/records/${b!._id}/paid`, {}, "pay-b", token, "PATCH")).status, 422);
  assert.equal((await request(`/payroll/records/${a!._id}/paid`, {}, "pay-a", token, "PATCH")).status, 200);
  assert.equal((await preview()).status, 422);
  assert.equal((await runWithBusiness("pay-b", () => PayrollRecord.findOne().lean()))?.status, "Paid");
});
test("signed login, attendance reads, and both dashboards remain available in every business", async () => {
  const employee = await request("/auth/login", { employeeCode: "90000003" }); assert.equal(employee.status, 200);
  const admin = await request("/auth/login", { employeeCode: "90000001" }); assert.equal(admin.status, 200);
  for (const business of ["pay-a", "pay-b"]) {
    assert.equal((await request("/call-dashboard", undefined, business)).status, 200);
    assert.equal((await request("/dashboard-workspace/summary?preset=today", undefined, business)).status, 200);
    const read = await fetch(`${base}/employees/${business === "pay-a" ? ids[0] : ids[1]}/attendance/session`, { headers: { "X-Business-Id": business, "X-CRM-Attendance-Session": employee.data.attendanceHubSession } });
    assert.equal(read.status, 200);
  }
});
test("a failure in the second business rolls back all mirrors and audit entries", async () => {
  const first = await preview();
  const stub = mock.method(getBusinessConnection("pay-b").model("PayrollRecord"), "updateOne", () => { throw new Error("Synthetic transaction failure"); });
  try { assert.equal((await confirm(first.data)).status, 500); } finally { stub.mock.restore(); }
  for (const business of ["pay-a", "pay-b"]) assert.equal(await runWithBusiness(business, () => PayrollRecord.countDocuments()), 0);
});
test("open lunch is never deducted or silently closed at cutoff", async () => {
  events = events.slice(0, 6);
  await AttendanceLedger.updateOne({ _id: "synthetic-payroll" }, { events });
  for (const business of ["pay-a", "pay-b"]) await runWithBusiness(business, () => Attendance.deleteMany({ eventId: { $in: ["e6", "e7"] } }));
  const result = await preview(); assert.equal(result.status, 200); assert.equal(result.data.canApply, false);
  assert.equal(result.data.rows[0].after.deductions, 0); assert.equal((await confirm(result.data)).status, 422);
  assert.equal((await AttendanceLedger.findById("synthetic-payroll").lean())?.events.length, 6);
});
test("weekend work is paid only after an explicit bounded overtime approval in the preview", async () => {
  const weekendPeriod = "Oct 17, 2026 - Oct 17, 2026";
  const date = Date.parse("2026-10-17T15:00:00Z");
  const weekendEvents = [0, 120].map((minutes, sequence) => ({ id: `w${sequence}`, commandId: `w${sequence}`, sequence,
    source: (sequence ? "Time Out" : "Time In") as SessionEvent["source"], at: new Date(date + minutes * 60_000).toISOString(), recordedAt: new Date(date).toISOString(),
    ...(sequence ? {} : { shift: assignAttendanceShift(new Date(date)) }) }));
  await AttendanceLedger.updateOne({ _id: "synthetic-payroll" }, { events: weekendEvents });
  for (const [index, business] of ["pay-a", "pay-b"].entries()) await runWithBusiness(business, async () => {
    await SystemSettings.updateOne({ key: "system" }, { payrollFirstCutoffStartDay: 17, payrollFirstCutoffEndDay: 17, payrollSecondCutoffStartDay: 18, payrollSecondCutoffEndDay: 16 });
    await Attendance.deleteMany({}); await Attendance.insertMany(weekendEvents.map(item => ({ employee: ids[index], source: item.source, timeIn: new Date(item.at), eventId: item.id })));
  });
  const unapproved = await request("/payroll/recompute/preview", { payPeriod: weekendPeriod });
  assert.equal(unapproved.status, 200); assert.equal(unapproved.data.rows[0].after.grossPay, 15000);
  assert.equal((await request("/payroll/recompute/preview", { payPeriod: weekendPeriod, overtimeApprovals: { "90000003": 3 } })).status, 422);
  const approved = await request("/payroll/recompute/preview", { payPeriod: weekendPeriod, overtimeApprovals: { "90000003": 2 } });
  assert.equal(approved.status, 200); assert.equal(approved.data.rows[0].after.grossPay, 15326.09);
  assert.equal((await request("/payroll/recompute/confirm", { payPeriod: weekendPeriod, token: approved.data.token, overtimeApprovals: { "90000003": 2 }, confirm: true, reason: "Synthetic OT approval" })).status, 200);
});
test("a matching code in an unrelated business never borrows another business ledger or salary", async () => {
  await AttendanceLedger.updateOne({ _id: "synthetic-payroll" }, { businessIds: ["pay-a"] });
  await setBusinessAccessForEmployeeCode("90000003", ["pay-b"]);
  await runWithBusiness("pay-b", () => Attendance.updateOne({ eventId: "e0" }, { timeIn: new Date(start + 10 * 60_000) }));
  const result = await request(`/payroll/dtr/90000003?payPeriod=${encodeURIComponent(period)}`, undefined, "pay-b");
  assert.equal(result.status, 200); assert.equal(result.data.rows[0].lateMinutes, 10);
  const scoped = await request("/payroll/recompute/preview", { payPeriod: period }, "pay-b");
  assert.equal(scoped.status, 200); assert.deepEqual(scoped.data.rows[0].businessIds, ["pay-b"]);
});
test("read-only CLI selects the last three available cutoffs and changes no payroll or attendance documents", async () => {
  const periods = ["Jul 6, 2026 - Jul 20, 2026", "Aug 6, 2026 - Aug 20, 2026", "Sep 6, 2026 - Sep 20, 2026", period];
  for (const [index, payPeriod] of periods.entries()) await runWithBusiness("pay-a", () => PayrollRecord.create({ employeeName: "Synthetic Payroll Employee", employeeId: "90000003", department: "Synthetic",
    grossPay: 15000, deductions: 0, netPay: 15000, payPeriod, paidOn: "-", createdAt: new Date(Date.UTC(2026, 6 + index, 21)) }));
  const before = await runWithBusiness("pay-a", async () => JSON.stringify(await PayrollRecord.find().sort({ payPeriod: 1 }).lean()));
  const ledgerBefore = JSON.stringify(await AttendanceLedger.findOne().lean());
  const result = await promisify(execFile)(process.execPath, ["--import", "tsx", fileURLToPath(new URL("../scripts/payrollDryRun.ts", import.meta.url)),
    "--uri", mongo.getUri(root), "--control-db", `${root}_control`, "--businesses", JSON.stringify(["a", "b"].map(id => ({ id: `pay-${id}`, databaseName: `${root}_${id}` })))], { timeout: 30000 });
  const lines = result.stdout.trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
  assert.equal(lines.length, 3); assert.ok(lines.every(line => line.writes === 0)); assert.ok(lines.every(line => line.cutoff !== periods[0]));
  assert.equal(await runWithBusiness("pay-a", async () => JSON.stringify(await PayrollRecord.find().sort({ payPeriod: 1 }).lean())), before);
  assert.equal(JSON.stringify(await AttendanceLedger.findOne().lean()), ledgerBefore);
});
test("golden full configured cutoff reproduces each of eleven weekdays and a hand-calculated net pay", async () => {
  const fullPeriod = "Oct 6, 2026 - Oct 20, 2026";
  const full: SessionEvent[] = [];
  for (let day = 6; day <= 20; day++) {
    const dateKey = `2026-10-${String(day).padStart(2, "0")}`;
    const at = Date.parse(`${dateKey}T15:00:00Z`);
    if ([0, 6].includes(new Date(`${dateKey}T00:00:00Z`).getUTCDay())) continue;
    const minutes = day === 15 ? [5, 60, 76, 120, 135, 200, 261, 530] : [0, 60, 75, 120, 135, 200, 260, 540];
    const sources = ["Time In", "Break Out", "Break In", "Break Out", "Break In", "Lunch Break Out", "Lunch Break In", "Time Out"];
    full.push(...minutes.map((minute, sequence) => ({ id: `${day}-${sequence}`, commandId: `${day}-${sequence}`, sequence: full.length + sequence,
      source: sources[sequence] as SessionEvent["source"], at: new Date(at + minute * 60_000).toISOString(), recordedAt: new Date(at + minute * 60_000).toISOString(),
      ...(sequence === 0 ? { shift: assignAttendanceShift(new Date(at)) } : {}) })));
  }
  await AttendanceLedger.updateOne({ _id: "synthetic-payroll" }, { events: full });
  for (const [index, business] of ["pay-a", "pay-b"].entries()) await runWithBusiness(business, async () => {
    await SystemSettings.updateOne({ key: "system" }, { payrollFirstCutoffStartDay: 6, payrollFirstCutoffEndDay: 20, payrollSecondCutoffStartDay: 21, payrollSecondCutoffEndDay: 5 });
    await Attendance.deleteMany({}); await Attendance.insertMany(full.map(item => ({ employee: ids[index], eventId: item.id, source: item.source, timeIn: new Date(item.at), sequence: item.sequence })));
  });
  const originalToken = token;
  mock.timers.enable({ apis: ["Date"], now: new Date("2026-10-22T01:00:00Z") });
  token = createAdminDashboardSession("90000001")!;
  try {
    const result = await request("/payroll/recompute/preview", { payPeriod: fullPeriod });
    assert.equal(result.status, 200); assert.equal(result.data.canApply, true);
    assert.deepEqual(result.data.rows[0].after, { grossPay: 15000, deductions: 46.20, netPay: 14953.80 });
    assert.equal((await request("/payroll/recompute/confirm", { payPeriod: fullPeriod, token: result.data.token, confirm: true, reason: "Hand-calculated synthetic cutoff" })).status, 200);
    const record = await runWithBusiness("pay-a", () => PayrollRecord.findOne().lean());
    assert.equal(record?.attendanceDays, 11); assert.equal(record?.deductibleMinutes, 17); assert.equal(record?.scheduledHours, 88);
    assert.equal(record?.missingHours, 17 / 60); assert.equal((record?.calculationSnapshot?.evidence as unknown[]).length, 88);
  } finally { mock.timers.reset(); token = originalToken; }
});
