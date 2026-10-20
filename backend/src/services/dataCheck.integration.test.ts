import assert from "node:assert/strict";
import { after, afterEach, before, test } from "node:test";
import crypto from "node:crypto";
import http from "node:http";
import mongoose from "mongoose";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import type { DataCheckReport } from "../../../shared/dataCheck";
import type { Request } from "express";

const prefix = `data_check_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;
process.env.NODE_ENV = "test";
process.env.CRM_DATA_CHECK = "true";
process.env.CRM_SECURITY_LEGACY_AUTH = "true";
process.env.CRM_ATTENDANCE_INTEGRITY = "true";
process.env.CRM_ATTENDANCE_DURATION_MODEL = "true";
process.env.CRM_ATTENDANCE_HUB = "true";
process.env.CRM_DASHBOARD_WORKSPACE = "true";
process.env.CRM_ADMIN_ONE_CODE = "synthetic-admin";
process.env.CRM_ADMIN_TWO_CODE = "synthetic-tracker";
process.env.CRM_TRACKER_ADMIN_CODES = "synthetic-tracker";
process.env.CRM_ADMIN_SESSION_SECRET = crypto.randomBytes(48).toString("hex");
process.env.DEFAULT_BUSINESS_ID = "check-a";
process.env.DEFAULT_BUSINESS_DATABASE = `${prefix}_a`;
process.env.CONTROL_DATABASE_NAME = `${prefix}_control`;
process.env.BUSINESS_DATABASES = JSON.stringify(["a", "b"].map(id => ({ id: `check-${id}`, name: `Synthetic ${id}`, databaseName: `${prefix}_${id}` })));
const { createApp } = await import("../app");
const { runWithBusiness } = await import("../config/tenancy");
const { Employee } = await import("../models/Employee");
const { Attendance } = await import("../models/Attendance");
const { AttendancePolicy } = await import("../models/AttendanceLedger");
const { Lead } = await import("../models/Lead");
const { LeadCallStat } = await import("../models/leadCallStat");
const { CallBridgeObservation } = await import("../models/CallBridgeObservation");
const { getCallBridgeAttemptModel } = await import("../models/CallBridge");
const { setBusinessAccessForEmployeeCode } = await import("../models/BusinessUserAccess");
const { createAdminDashboardSession } = await import("../config/adminDashboardSession");
const { createAttendanceHubSession } = await import("../config/attendanceHubSession");
const { executeAttendanceCommand, resolveAttendanceIdentity } = await import("./attendanceLedgerService");
const { deliverAttendanceLedger } = await import("./attendanceLedgerOutbox");
const { clearDataCheckCache } = await import("../controllers/dataCheckController");
const { dataCheckRateLimit } = await import("../routes/dataCheckRoutes");
const { runDataCheck } = await import("./dataCheckService");
const { getBusinessById } = await import("../config/tenancy");
let mongo: MongoMemoryReplSet; let server: http.Server; let base = "";
const ids: Record<string, mongoose.Types.ObjectId> = {};
const date = "2026-10-15";
const admin = { role: "admin" as const, code: "synthetic-admin" };
const session = () => ({ "X-CRM-Admin-Session": createAdminDashboardSession(admin.code)! });
function request(path: string, headers: Record<string, string> = session()) {
  return fetch(base + path, { headers: { "X-Business-Id": "check-a", ...headers } });
}
async function report(business = "check-a") {
  const response = await request(`/admin/data-check?date=${date}&business=${business}`);
  assert.equal(response.status, 200);
  return await response.json() as DataCheckReport;
}
function row(value: DataCheckReport, id: string) {
  const found = value.checks.find(item => item.id === id);
  assert.ok(found, `Missing check ${id}; returned ${value.checks.map(item => item.id).join(", ")}`);
  return found;
}
async function fingerprint() {
  const output: unknown[] = [];
  for (const name of [`${prefix}_a`, `${prefix}_b`, `${prefix}_control`, prefix]) {
    const db = mongoose.connection.getClient().db(name);
    for (const { name: collection } of (await db.listCollections().toArray()).sort((a, b) => a.name.localeCompare(b.name))) {
      const records = await db.collection(collection).find({}).sort({ _id: 1 }).toArray();
      // Lazy model initialization may create an empty indexed collection, not application records.
      if (records.length) output.push([name, collection, records]);
    }
  }
  return crypto.createHash("sha256").update(JSON.stringify(output)).digest("hex");
}
before(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri(prefix));
  await AttendancePolicy.create({ _id: "global-attendance", revision: 1, graceMinutes: 0, breakMinutes: 15, lunchMinutes: 60, shiftStart: "23:00", shiftEnd: "08:00", recoveryEnabled: false, recoveryTime: "22:59" });
  for (const business of ["check-a", "check-b"]) await runWithBusiness(business, async () => {
    const person = await Employee.create({ employeeCode: "fake-agent", name: "Synthetic Agent", role: "Sales", team: "Sales Outreach", dateHired: "2026-10-01", businessAccessIds: ["check-a", "check-b"], bankAccountNumber: "synthetic-private-bank" });
    ids[business] = person._id;
    const lead = await Lead.create({ businessName: "Synthetic lead", status: "Qualified", assignedAgent: person._id, phone: "synthetic-private-phone", email: "synthetic-private-email" });
    await LeadCallStat.create({ lead: lead._id, callLogs: [{ employee: person._id, employeeName: person.name, outcome: "connected", calledAt: new Date("2026-10-15T16:30:00Z"), durationSeconds: 120 }] });
    await Promise.all([Attendance.init(), Lead.init(), LeadCallStat.init()]);
  });
  await setBusinessAccessForEmployeeCode("fake-agent", ["check-a", "check-b"]);
  const identity = await runWithBusiness("check-a", () => resolveAttendanceIdentity(String(ids["check-a"]), admin));
  await executeAttendanceCommand(identity, { commandId: crypto.randomUUID(), expectedRevision: 0, operation: "correct", reason: "Synthetic Data Check fixture",
    changes: [["Time In", "2026-10-15T15:00:00Z"], ["Break Out", "2026-10-15T16:00:00Z"], ["Break In", "2026-10-15T16:15:00Z"], ["Break Out", "2026-10-15T17:00:00Z"], ["Break In", "2026-10-15T17:15:00Z"], ["Lunch Break Out", "2026-10-15T18:00:00Z"], ["Lunch Break In", "2026-10-15T19:00:00Z"], ["Time Out", "2026-10-16T00:00:00Z"]].map(([source, at]) => ({ source: source as "Time In", at })) }, admin);
  await deliverAttendanceLedger(identity.key);
  await Promise.all([CallBridgeObservation.init(), getCallBridgeAttemptModel().init()]);
  server = http.createServer(createApp());
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`;
});
after(async () => { server?.closeAllConnections(); await new Promise<void>(resolve => server?.close(() => resolve())); await mongoose.disconnect(); await mongo?.stop(); });
afterEach(async () => { await dataCheckRateLimit.resetKey("Administrator One"); });

test("Data Check requires signed full admin; employee, tracker, forged and expired tokens cannot read it", async () => {
  for (const headers of [{}, { "X-CRM-User-Type": "admin", "X-CRM-User-Code": admin.code }, { "X-CRM-Admin-Session": "forged" }, { "X-CRM-Admin-Session": createAdminDashboardSession(admin.code, Date.now() - 13 * 3600_000)! }, { "X-CRM-Attendance-Session": createAttendanceHubSession("fake-agent") }, { "X-CRM-Attendance-Session": createAttendanceHubSession("synthetic-tracker") }] as Record<string, string>[]) {
    assert.ok([401, 403].includes((await request(`/admin/data-check?date=${date}`, headers)).status));
  }
  assert.equal((await request("/admin/data-check/config")).status, 200);
});
test("Data Check validates dates/businesses and can be disabled without altering old dashboards", async () => {
  for (const query of ["date=2026-02-30", "date=2999-01-01", "date[]=2026-10-15", `date=${date}&business=not-configured`]) assert.equal((await request(`/admin/data-check?${query}`)).status, 400);
  process.env.CRM_DATA_CHECK = "false";
  try {
    assert.equal((await request(`/admin/data-check?date=${date}`)).status, 404);
    assert.equal((await (await request("/admin/data-check/config")).json()).enabled, false);
    assert.equal((await request("/dashboard-workspace/summary?preset=today")).status, 200);
  } finally { process.env.CRM_DATA_CHECK = "true"; }
});
test("navigation is hidden independently of signed diagnostics, and restoring it does not change dashboard access", async () => {
  delete process.env.CRM_DATA_CHECK_NAV;
  const config = await (await request("/admin/data-check/config")).json();
  assert.equal(config.enabled, true); assert.equal(config.navigationVisible, false);
  process.env.CRM_DATA_CHECK_NAV = "true";
  try {
    assert.equal((await (await request("/admin/data-check/config")).json()).navigationVisible, true);
    assert.equal((await request("/dashboard-workspace/summary?preset=today")).status, 200);
  } finally { delete process.env.CRM_DATA_CHECK_NAV; }
});
test("normal hand-calculated fixtures compare screen totals, two breaks, lunch, deductions, calls and status cards in both businesses", async () => {
  for (const business of ["check-a", "check-b"]) {
    clearDataCheckCache(); const value = await report(business);
    for (const suffix of ["present", "late-count", "late-minutes", "deductible-minutes", "fake-agent-break-1", "fake-agent-break-2", "fake-agent-lunch", "fake-agent-limits", "fake-agent-open-rest", "fake-agent-open-shift", "fake-agent-integrity", "logged-call-total", "logged-answered", "workspace-talk", "call-log-durations", "leads-qualified", "lead-missingAgent", "lead-missingStatus", "lead-future", "lead-overdue"]) assert.equal(row(value, `${business}:${suffix}`).status, "match", `${business}:${suffix}`);
    assert.equal(row(value, `${business}:fake-agent-break-1`).recomputedValue, 900_000);
    assert.equal(row(value, `${business}:fake-agent-break-2`).recomputedValue, 900_000);
    assert.equal(row(value, `${business}:fake-agent-lunch`).recomputedValue, 3_600_000);
    assert.equal(row(value, `${business}:workspace-talk`).recomputedValue, 120);
    assert.equal(row(value, `${business}:cross-business-fake-agent`).status, "match");
    assert.equal(row(value, `${business}:bridge-disconnect-gaps`).status, "cannot-verify");
    assert.equal(row(value, `${business}:bridge-freshness`).status, "cannot-verify");
    assert.equal(row(value, `${business}:percent-change`).status, "match");
    for (const status of ["NEW", "Follow up", "Ongoing comms", "Qualified", "Ongoing Negotiation", "Completed", "Dead", "Archived"]) assert.equal(row(value, `${business}:status-${status}`).status, "match");
    assert.equal(row(value, `${business}:fake-agent-dtr`).proof, "same-code, weaker proof");
    assert.ok(value.checks.every(item => item.samples.length <= 10));
    assert.doesNotMatch(JSON.stringify(value), /synthetic-private-(bank|phone|email)|bankAccount|password|credential/i);
  }
});
test("cached all-business report is read-only down to the stored document hashes", async () => {
  clearDataCheckCache();
  await report("all"); // Initialize read-side models/indexes before checking document stability.
  clearDataCheckCache(); const before = await fingerprint();
  const first = await report("all"); const second = await report("all");
  assert.equal(first.cached, false); assert.equal(second.cached, true);
  assert.equal(first.generatedAt, second.generatedAt);
  assert.equal(Date.parse(first.expiresAt) - Date.parse(first.generatedAt), 60_000);
  assert.equal(await fingerprint(), before, "GET must not write attendance, caches, repairs or audit documents");
});
test("running dashboard and hub totals compare at one exact server instant, without changing open attendance", async () => {
  for (const business of ["check-a", "check-b"]) await runWithBusiness(business, () => Employee.create({ employeeCode: "fake-open", name: "Synthetic Open", role: "Sales", team: "Sales Outreach", dateHired: "2026-10-01", businessAccessIds: ["check-a", "check-b"] }));
  await setBusinessAccessForEmployeeCode("fake-open", ["check-a", "check-b"]);
  const person = await runWithBusiness("check-a", () => Employee.findOne({ employeeCode: "fake-open" }).select("_id").lean()); assert.ok(person);
  const identity = await runWithBusiness("check-a", () => resolveAttendanceIdentity(String(person._id), admin));
  const at = new Date("2026-10-16T16:00:00Z");
  await executeAttendanceCommand(identity, { commandId: crypto.randomUUID(), expectedRevision: 0, operation: "correct", reason: "Synthetic open comparison", changes: [{ source: "Time In", at: "2026-10-16T15:00:00Z" }] }, admin, at);
  await deliverAttendanceLedger(identity.key);
  const token = createAdminDashboardSession(admin.code)!;
  const req = { business: getBusinessById("check-a"), header: (name: string) => name.toLowerCase() === "x-crm-admin-session" ? token : undefined } as unknown as Request;
  const before = await fingerprint();
  const value = await runWithBusiness("check-a", () => runDataCheck(req, "2026-10-16", "all", at));
  for (const business of ["check-a", "check-b"]) {
    const online = row(value, `${business}:workspace-hub-online`);
    assert.equal(online.status, "match"); assert.equal(online.dashboardValue, 3600_000); assert.equal(online.recomputedValue, 3600_000);
  }
  assert.equal(await fingerprint(), before, "Reading a fixed instant never closes or rewrites attendance");
});
test("stored stale derivatives warn without silently repairing them", async () => {
  await runWithBusiness("check-a", () => Attendance.updateMany({ employee: ids["check-a"] }, { $set: { "derived.excessBreakMinutes": 99 } }));
  clearDataCheckCache(); const value = await report();
  const stale = row(value, "check-a:stale-rows"); assert.equal(stale.status, "mismatch"); assert.equal(stale.warningOnly, true); assert.equal(stale.recomputedValue, 8);
  assert.equal(await runWithBusiness("check-a", () => Attendance.countDocuments({ "derived.excessBreakMinutes": 99 })), 8);
});
test("raw cross-business differences and negative/reversed calls produce FAIL, not a fake match", async () => {
  await runWithBusiness("check-b", () => Attendance.updateOne({ employee: ids["check-b"], source: "Break In" }, { $set: { timeIn: new Date("2026-10-15T16:16:00Z") } }));
  await runWithBusiness("check-a", () => LeadCallStat.collection.updateOne({}, { $set: { "callLogs.0.durationSeconds": -5 } }));
  await CallBridgeObservation.collection.insertOne({ employeeCode: "fake-agent", businessIds: ["check-a"], startedAt: new Date("2026-10-15T17:00:00Z"), endedAt: new Date("2026-10-15T16:00:00Z"), durationMs: -1 });
  clearDataCheckCache(); const value = await report();
  assert.equal(value.verdict, "FAIL");
  assert.equal(row(value, "check-a:cross-business-fake-agent").status, "mismatch");
  assert.equal(row(value, "check-a:call-log-durations").recomputedValue, 1);
  assert.equal(row(value, "check-a:bridge-times").recomputedValue, 1);
});
test("window query indexes are additive and selectable on synthetic data", async () => {
  await runWithBusiness("check-a", async () => {
    const attendance = await Attendance.find({ employee: ids["check-a"], isArchived: false, timeIn: { $gte: new Date("2026-10-15T15:00:00Z") } }).hint({ employee: 1, isArchived: 1, timeIn: -1 }).explain("queryPlanner") as unknown as { queryPlanner: unknown };
    assert.match(JSON.stringify(attendance.queryPlanner), /IXSCAN/);
    const leads = await Lead.find({ createdAt: { $gte: new Date("2026-10-15") } }).hint({ createdAt: 1 }).explain("queryPlanner") as unknown as { queryPlanner: unknown };
    assert.match(JSON.stringify(leads.queryPlanner), /IXSCAN/);
  });
  const observations = await CallBridgeObservation.find({ businessIds: "check-a", startedAt: { $gte: new Date("2026-10-15") } }).hint({ businessIds: 1, startedAt: 1 }).explain("queryPlanner") as unknown as { queryPlanner: unknown };
  assert.match(JSON.stringify(observations.queryPlanner), /IXSCAN/);
});
test("repeated checks are rate limited even when cached", async () => {
  clearDataCheckCache();
  for (let i = 0; i < 10; i++) assert.equal((await request(`/admin/data-check?date=${date}&business=check-a`)).status, 200);
  assert.equal((await request(`/admin/data-check?date=${date}&business=check-a`)).status, 429);
});
