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
const { PayrollAttendanceFence } = await import("../models/PayrollAttendanceFence");
const { SystemSettings } = await import("../models/SystemSettings");
const { runWithBusiness, getBusinessConnection } = await import("../config/tenancy");
const { setBusinessAccessForEmployeeCode } = await import("../models/BusinessUserAccess");
const { createAdminDashboardSession } = await import("../config/adminDashboardSession");
const { assignAttendanceShift } = await import("./attendanceShift");
const { executeAttendanceCommand, autoTimeOutCommandId, resolveAttendanceIdentity } = await import("./attendanceLedgerService");
const { deliverAttendanceLedger } = await import("./attendanceLedgerOutbox");
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
  await PayrollAttendanceFence.deleteMany({});
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
    await Attendance.insertMany(events.map(item => ({ employee: employee._id, source: item.source, timeIn: new Date(item.at), eventId: item.id, sequence: item.sequence,
      ledgerIdentity: "synthetic-payroll", ledgerRevision: 1, isEffective: true })));
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
async function correctSyntheticBreak(business = "pay-b") {
  const identity = { key: "synthetic-payroll", code: "90000003", businessIds: ["pay-a", "pay-b"], canonicalBusinessId: "pay-a", employeeId: String(ids[business === "pay-a" ? 0 : 1]) };
  const result = await runWithBusiness(business, () => executeAttendanceCommand(identity, { operation: "correct", commandId: crypto.randomUUID(), expectedRevision: 1,
    reason: "Synthetic concurrent correction", changes: [{ targetId: "e2", at: new Date(start + 77 * 60_000).toISOString() }] }, { role: "admin", code: "90000001" }));
  await deliverAttendanceLedger(identity.key);
  return result;
}

test("an attendance correction after initial validation but before the approval transaction rejects stale pay in every business", async () => {
  const first = await preview(); assert.equal(first.status, 200);
  const startSession = mongoose.startSession.bind(mongoose);
  let corrected = false;
  const stub = mock.method(mongoose, "startSession", async (...args: Parameters<typeof mongoose.startSession>) => {
    if (!corrected) { corrected = true; await correctSyntheticBreak(); }
    return startSession(...args);
  });
  let result;
  try { result = await confirm(first.data); } finally { stub.mock.restore(); }
  assert.equal(result.status, 409, JSON.stringify(result.data));
  assert.equal((await AttendanceLedger.findById("synthetic-payroll").lean())?.revision, 2);
  for (const business of ["pay-a", "pay-b"]) assert.equal(await runWithBusiness(business, () => PayrollRecord.countDocuments()), 0);
});

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

test("attendance membership expansion fences both the stored and newly assigned business", async () => {
  await AttendanceLedger.updateOne({ _id: "synthetic-payroll" }, { businessIds: ["pay-a"] });
  await correctSyntheticBreak("pay-b");
  const fences = await PayrollAttendanceFence.find().sort({ _id: 1 }).lean();
  assert.deepEqual(fences.map(item => JSON.parse(String(item._id))), [["pay-a", "90000003"], ["pay-b", "90000003"]]);
  assert.deepEqual((await AttendanceLedger.findById("synthetic-payroll").lean())?.businessIds, ["pay-a", "pay-b"]);
});

test("HTTP edit, fresh reads, explicit recompute approval and payment stay consistent across business refreshes", async () => {
  const identity = await runWithBusiness("pay-a", () => resolveAttendanceIdentity(String(ids[0]), { role: "admin", code: "90000001" }));
  const seed = await AttendanceLedger.findById("synthetic-payroll").lean(); assert.ok(seed);
  await AttendanceLedger.deleteOne({ _id: seed._id });
  await AttendanceLedger.create({ ...seed, _id: identity.key });
  for (const business of ["pay-a", "pay-b"]) await runWithBusiness(business, () => Attendance.updateMany({}, { ledgerIdentity: identity.key }));
  const first = await preview(); assert.equal((await confirm(first.data)).status, 200);
  const edited = await request(`/employees/${ids[1]}/attendance/commands`, { operation: "correct", commandId: crypto.randomUUID(), expectedRevision: 1,
    reason: "Synthetic refreshed cross-business edit", changes: [{ targetId: "e2", at: new Date(start + 77 * 60_000).toISOString() }] }, "pay-b");
  assert.equal(edited.status, 200, JSON.stringify(edited.data)); assert.equal(edited.data.revision, 2);
  for (const business of ["pay-a", "pay-b"]) {
    const employee = await request("/auth/login", { employeeCode: "90000003" }, business); assert.equal(employee.status, 200);
    const response = await fetch(`${base}/employees/${business === "pay-a" ? ids[0] : ids[1]}/attendance/session`, { headers: { "X-Business-Id": business, "X-CRM-Attendance-Session": employee.data.attendanceHubSession } });
    assert.equal(response.status, 200); const session = await response.json(); assert.equal(session.revision, 2);
    const dtr = await request(`/payroll/dtr/90000003?payPeriod=${encodeURIComponent(period)}`, undefined, business);
    assert.equal(dtr.status, 200); assert.equal(dtr.data.rows[0].deductibleMinutes, 18); assert.equal(dtr.data.rows[0].excessBreakMinutes, 2);
    assert.equal(dtr.data.summary.deductions, 46.20, "reading changed attendance must not silently rewrite the saved cutoff");
    assert.equal((await request("/dashboard-workspace/summary?preset=today", undefined, business)).status, 200);
    assert.equal((await request("/call-dashboard", undefined, business)).status, 200);
  }
  const fresh = await preview(); assert.equal(fresh.status, 200); assert.equal(fresh.data.rows[0].after.deductions, 48.91);
  assert.equal((await confirm(fresh.data)).status, 200);
  for (const business of ["pay-a", "pay-b"]) {
    const records = await request(`/payroll/records?payPeriod=${encodeURIComponent(period)}`, undefined, business);
    assert.equal(records.status, 200); assert.equal(records.data.length, 1); assert.equal(records.data[0].deductions, 48.91); assert.equal(records.data[0].netPay, 14951.09);
    assert.equal(records.data[0].calculationAudit.length, 2);
    const dtr = await request(`/payroll/dtr/90000003?payPeriod=${encodeURIComponent(period)}`, undefined, business);
    assert.equal(dtr.status, 200); assert.equal(dtr.data.summary.deductibleMinutes, 18); assert.equal(dtr.data.summary.deductions, 48.91);
  }
  const record = await runWithBusiness("pay-a", () => PayrollRecord.findOne().lean());
  assert.equal((await request(`/payroll/records/${record!._id}/paid`, {}, "pay-a", token, "PATCH")).status, 200);
  for (const business of ["pay-a", "pay-b"]) {
    const records = await request(`/payroll/records?payPeriod=${encodeURIComponent(period)}`, undefined, business);
    assert.equal(records.data.length, 1); assert.equal(records.data[0].status, "Paid"); assert.equal(records.data[0].deductions, 48.91);
  }
});

test("approval holds every business attendance fence until its complete payroll transaction commits", { timeout: 25000 }, async () => {
  const first = await preview();
  const payrollEntered = gate(), resumePayroll = gate(), editingAtFence = gate();
  const model = getBusinessConnection("pay-a").model("PayrollRecord");
  const originalWrite = model.updateOne.bind(model), originalFence = PayrollAttendanceFence.updateOne.bind(PayrollAttendanceFence);
  let paused = false, observeEdit = false, editComplete = false;
  const writeStub = mock.method(model, "updateOne", async (...args: Parameters<typeof model.updateOne>) => {
    if (!paused) { paused = true; payrollEntered.resolve(); await resumePayroll.promise; }
    return originalWrite(...args);
  });
  const fenceStub = mock.method(PayrollAttendanceFence, "updateOne", (...args: Parameters<typeof PayrollAttendanceFence.updateOne>) => {
    if (observeEdit) editingAtFence.resolve();
    return originalFence(...args);
  });
  const approving = confirm(first.data);
  let editing: Promise<unknown> | undefined;
  try {
    await payrollEntered.promise; observeEdit = true;
    editing = correctSyntheticBreak("pay-b").then(value => { editComplete = true; return value; });
    await editingAtFence.promise; assert.equal(editComplete, false);
    resumePayroll.resolve();
    const approved = await approving; assert.equal(approved.status, 200, JSON.stringify(approved.data));
    await editing;
    for (const business of ["pay-a", "pay-b"]) {
      const record = await runWithBusiness(business, () => PayrollRecord.findOne().lean());
      assert.equal(record?.deductibleMinutes, 17); assert.equal(record?.calculationAudit?.length, 1);
    }
    assert.equal((await AttendanceLedger.findById("synthetic-payroll").lean())?.revision, 2);
    const changed = await preview(); assert.equal(changed.status, 200); assert.equal(changed.data.rows[0].after.deductions, 48.91);
  } finally { resumePayroll.resolve(); writeStub.mock.restore(); fenceStub.mock.restore(); await Promise.allSettled([approving, ...(editing ? [editing] : [])]); }
});

test("an attendance save winning the shared fence makes a simultaneous payroll approval stale", { timeout: 25000 }, async () => {
  const first = await preview();
  const editingAtCommit = gate(), resumeEdit = gate(), approvalAtFence = gate();
  const originalCommit = AttendanceLedger.findOneAndUpdate.bind(AttendanceLedger), originalFence = PayrollAttendanceFence.updateOne.bind(PayrollAttendanceFence);
  let paused = false, observeApproval = false;
  const editStub = mock.method(AttendanceLedger, "findOneAndUpdate", (...args: Parameters<typeof AttendanceLedger.findOneAndUpdate>) => {
    const update = args[1] as { $set?: { revision?: number } };
    if (!paused && update.$set?.revision === 2) {
      paused = true; editingAtCommit.resolve();
      return { lean: async () => { await resumeEdit.promise; return originalCommit(...args).lean(); } } as ReturnType<typeof AttendanceLedger.findOneAndUpdate>;
    }
    return originalCommit(...args);
  });
  const fenceStub = mock.method(PayrollAttendanceFence, "updateOne", (...args: Parameters<typeof PayrollAttendanceFence.updateOne>) => {
    if (observeApproval) approvalAtFence.resolve();
    return originalFence(...args);
  });
  const editing = correctSyntheticBreak("pay-a");
  let approving: ReturnType<typeof confirm> | undefined;
  try {
    await editingAtCommit.promise; observeApproval = true;
    approving = confirm(first.data); await approvalAtFence.promise; resumeEdit.resolve();
    await editing; const result = await approving;
    assert.equal(result.status, 409, JSON.stringify(result.data));
    for (const business of ["pay-a", "pay-b"]) assert.equal(await runWithBusiness(business, () => PayrollRecord.countDocuments()), 0);
  } finally { resumeEdit.resolve(); editStub.mock.restore(); fenceStub.mock.restore(); await Promise.allSettled([editing, ...(approving ? [approving] : [])]); }
});

test("fence failures roll back approval without modifying either business or attendance evidence", async () => {
  const first = await preview();
  const before = JSON.stringify(await AttendanceLedger.findById("synthetic-payroll").lean());
  const stub = mock.method(PayrollAttendanceFence, "updateOne", () => { throw new Error("Synthetic coordination unavailable"); });
  try { assert.equal((await confirm(first.data)).status, 500); } finally { stub.mock.restore(); }
  assert.equal(await PayrollAttendanceFence.countDocuments(), 0);
  assert.equal(JSON.stringify(await AttendanceLedger.findById("synthetic-payroll").lean()), before);
  for (const business of ["pay-a", "pay-b"]) assert.equal(await runWithBusiness(business, () => PayrollRecord.countDocuments()), 0);
});

test("automatic timeout uses the same atomic fence and a coordination failure cannot create a checkout", async () => {
  const open = events.slice(0, -1);
  await AttendanceLedger.updateOne({ _id: "synthetic-payroll" }, { events: open });
  const identity = { key: "synthetic-payroll", code: "90000003", businessIds: ["pay-a", "pay-b"], canonicalBusinessId: "pay-a", employeeId: String(ids[0]) };
  const input = { operation: "auto-time-out" as const, commandId: autoTimeOutCommandId("e0"), expectedRevision: 1, sessionId: "e0" };
  process.env.CRM_ATTENDANCE_AUTO_TIMEOUT = "true";
  const stub = mock.method(PayrollAttendanceFence, "updateOne", () => { throw new Error("Synthetic fence unavailable"); });
  try {
    await assert.rejects(executeAttendanceCommand(identity, input, { role: "system", code: "attendance-auto-time-out" }, new Date("2026-10-16T00:05:00Z")), /Synthetic fence unavailable/);
    const unchanged = await AttendanceLedger.findById("synthetic-payroll").lean();
    assert.equal(unchanged?.revision, 1); assert.deepEqual(unchanged?.events.map(item => item.id), open.map(item => item.id));
    assert.equal(await PayrollAttendanceFence.countDocuments(), 0);
    stub.mock.restore();
    const completed = await executeAttendanceCommand(identity, input, { role: "system", code: "attendance-auto-time-out" }, new Date("2026-10-16T00:05:00Z"));
    assert.equal(completed.revision, 2); assert.equal(completed.state, "OFFLINE");
    assert.equal(await PayrollAttendanceFence.countDocuments(), 2);
    const replay = await executeAttendanceCommand(identity, input, { role: "system", code: "attendance-auto-time-out" }, new Date("2026-10-16T00:06:00Z"));
    assert.equal(replay.revision, 2); assert.equal((await AttendanceLedger.findById("synthetic-payroll").lean())?.events.filter(item => item.autoTimeOut).length, 1);
  } finally { stub.mock.restore(); process.env.CRM_ATTENDANCE_AUTO_TIMEOUT = "false"; }
});

test("unguarded legacy attendance cannot silently downgrade payroll approval safety", async () => {
  const first = await preview(); process.env.CRM_ATTENDANCE_INTEGRITY = "false";
  try { const result = await confirm(first.data); assert.equal(result.status, 503); assert.match(result.data.message, /revision-checked/); }
  finally { process.env.CRM_ATTENDANCE_INTEGRITY = "true"; }
  for (const business of ["pay-a", "pay-b"]) assert.equal(await runWithBusiness(business, () => PayrollRecord.countDocuments()), 0);
});
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
    assert.equal(dtr.data.summary.workingDays, 1); assert.equal(dtr.data.summary.monthlyWorkingDays, 23);
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

test("saved payslips remain readable when current settings are missing, without inventing attendance rows", async () => {
  const first = await preview(); assert.equal((await confirm(first.data)).status, 200);
  const before = await runWithBusiness("pay-a", async () => JSON.stringify(await PayrollRecord.findOne().lean()));
  await AttendancePolicy.deleteMany({});
  for (const business of ["pay-a", "pay-b"]) await runWithBusiness(business, () => SystemSettings.deleteMany({}));
  for (const business of ["pay-a", "pay-b"]) {
    const result = await request(`/payroll/dtr/90000003?payPeriod=${encodeURIComponent(period)}`, undefined, business);
    assert.equal(result.status, 200, JSON.stringify(result.data));
    assert.equal(result.data.storedCutoff, true); assert.equal(result.data.summary.netPay, 14953.80);
    assert.equal(result.data.summary.paidHoursPerDay, 8); assert.deepEqual(result.data.rows, []);
    assert.equal(result.data.summary.workingDays, null); assert.equal(result.data.summary.monthlyWorkingDays, 23);
    assert.match(result.data.currentAttendanceWarning, /Shift settings are required/);
  }
  assert.equal((await preview()).status, 422);
  assert.equal(await runWithBusiness("pay-a", async () => JSON.stringify(await PayrollRecord.findOne().lean())), before);
});

test("overtime approvals reject coerced values and unknown employee codes", async () => {
  for (const value of [null, true, false, "", "0", [], {}]) {
    const result = await preview({ "90000003": value });
    assert.equal(result.status, 422, JSON.stringify({ value, result }));
  }
  assert.equal((await preview({ "missing-synthetic-employee": 0 })).status, 422);
  assert.equal((await preview({ "90000003": 0 })).status, 200);
  for (const business of ["pay-a", "pay-b"]) assert.equal(await runWithBusiness(business, () => PayrollRecord.countDocuments()), 0);
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

test("payment retains original cutoff mirrors after an employee's current business membership changes", async () => {
  const first = await preview(); assert.equal((await confirm(first.data)).status, 200);
  await setBusinessAccessForEmployeeCode("90000003", ["pay-a"]);
  await AttendanceLedger.updateOne({ _id: "synthetic-payroll" }, { businessIds: ["pay-a"] });
  const a = await runWithBusiness("pay-a", () => PayrollRecord.findOne().lean());
  assert.equal((await request(`/payroll/records/${a!._id}/paid`, {}, "pay-a", token, "PATCH")).status, 200);
  for (const business of ["pay-a", "pay-b"]) assert.equal((await runWithBusiness(business, () => PayrollRecord.findOne().lean()))?.status, "Paid");
});

test("payment rejects differing mirror ownership and changes neither business", async () => {
  const first = await preview(); assert.equal((await confirm(first.data)).status, 200);
  await runWithBusiness("pay-b", () => PayrollRecord.updateOne({}, { payrollOwnerBusinessId: "pay-b" }));
  const a = await runWithBusiness("pay-a", () => PayrollRecord.findOne().lean());
  const result = await request(`/payroll/records/${a!._id}/paid`, {}, "pay-a", token, "PATCH");
  assert.equal(result.status, 422, JSON.stringify(result.data));
  for (const business of ["pay-a", "pay-b"]) assert.equal((await runWithBusiness(business, () => PayrollRecord.findOne().lean()))?.status, "Pending");
});

test("equivalent legacy attendance copies do not conflict over database IDs or business display details", async () => {
  await AttendanceLedger.deleteMany({});
  await runWithBusiness("pay-b", () => Employee.updateOne({ employeeCode: "90000003" }, { name: "Synthetic Payroll B", team: "Synthetic B", email: "pay-b@example.invalid" }));
  const result = await preview(); assert.equal(result.status, 200, JSON.stringify(result.data));
  assert.equal(result.data.canApply, true); assert.equal((await confirm(result.data)).status, 200);
  const a = await runWithBusiness("pay-a", () => PayrollRecord.findOne().lean()), b = await runWithBusiness("pay-b", () => PayrollRecord.findOne().lean());
  assert.equal(a?.netPay, b?.netPay); assert.equal(b?.employeeName, "Synthetic Payroll B"); assert.equal(b?.department, "Synthetic B");
  assert.notEqual((a?.calculationSnapshot?.evidence as Array<{ id: string }>)[0].id, (b?.calculationSnapshot?.evidence as Array<{ id: string }>)[0].id);
  await runWithBusiness("pay-b", () => Attendance.updateOne({ eventId: "e2" }, { timeIn: new Date(start + 78 * 60_000) }));
  assert.equal((await preview()).status, 422);
});

test("live business comparisons use one server timestamp even while the clock advances", async () => {
  events = events.slice(0, 5);
  await AttendanceLedger.updateOne({ _id: "synthetic-payroll" }, { events });
  for (const business of ["pay-a", "pay-b"]) await runWithBusiness(business, () => Attendance.deleteMany({ eventId: { $in: ["e5", "e6", "e7"] } }));
  const originalToken = token;
  mock.timers.enable({ apis: ["Date"], now: new Date("2026-10-15T19:00:00Z") });
  token = createAdminDashboardSession("90000001")!;
  let now = Date.now();
  const clock = mock.method(Date, "now", () => ++now);
  try {
    const result = await preview(); assert.equal(result.status, 200, JSON.stringify(result.data));
    assert.equal(result.data.canApply, false); assert.equal(result.data.rows[0].reviewDays, 1);
    assert.equal(result.data.rows[0].after.deductions, 0);
  } finally { clock.mock.restore(); mock.timers.reset(); token = originalToken; }
});

test("legacy payment uses known ledger mirrors even when current access only lists the owner", async () => {
  const first = await preview(); assert.equal((await confirm(first.data)).status, 200);
  for (const business of ["pay-a", "pay-b"]) await runWithBusiness(business, () => PayrollRecord.updateOne({}, { $unset: { "calculationSnapshot.businessIds": 1 } }));
  await setBusinessAccessForEmployeeCode("90000003", ["pay-a"]);
  const a = await runWithBusiness("pay-a", () => PayrollRecord.findOne().lean());
  assert.equal((await request(`/payroll/records/${a!._id}/paid`, {}, "pay-a", token, "PATCH")).status, 200);
  const before = await runWithBusiness("pay-a", async () => JSON.stringify(await PayrollRecord.findOne().lean()));
  assert.equal((await request(`/payroll/records/${a!._id}/paid`, {}, "pay-a", token, "PATCH")).status, 200);
  assert.equal(await runWithBusiness("pay-a", async () => JSON.stringify(await PayrollRecord.findOne().lean())), before);
  assert.equal((await runWithBusiness("pay-b", () => PayrollRecord.findOne().lean()))?.status, "Paid");
});

test("a stored cutoff does not mask database failures as an empty attendance result", async () => {
  const first = await preview(); assert.equal((await confirm(first.data)).status, 200);
  const stub = mock.method(getBusinessConnection("pay-a").model("Attendance"), "find", () => { throw new Error("Synthetic attendance database failure"); });
  try { assert.equal((await request(`/payroll/dtr/90000003?payPeriod=${encodeURIComponent(period)}`)).status, 500); }
  finally { stub.mock.restore(); }
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
  assert.equal(await PayrollAttendanceFence.countDocuments(), 0);
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
  const saved = await runWithBusiness("pay-a", async () => JSON.stringify(await PayrollRecord.findOne().lean()));
  await AttendanceLedger.updateOne({ _id: "synthetic-payroll" }, { events: [] });
  for (const business of ["pay-a", "pay-b"]) await runWithBusiness(business, () => Attendance.deleteMany({}));
  const dtr = await request(`/payroll/dtr/90000003?payPeriod=${encodeURIComponent(weekendPeriod)}`);
  assert.equal(dtr.status, 200, JSON.stringify(dtr.data));
  assert.equal(dtr.data.summary.grossPay, 15326.09); assert.equal(dtr.data.summary.overtimeHours, 2);
  assert.equal(dtr.data.potentialOvertimeHours, 0);
  assert.equal((await request("/payroll/recompute/preview", { payPeriod: weekendPeriod })).status, 422);
  assert.equal(await runWithBusiness("pay-a", async () => JSON.stringify(await PayrollRecord.findOne().lean())), saved);
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
