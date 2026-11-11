import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import crypto from "node:crypto";
import http from "node:http";
import mongoose from "mongoose";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import type { SessionEvent } from "./attendanceSessionState";

process.env.NODE_ENV = "test";
const prefix = `performance_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
const businesses = Array.from({ length: 6 }, (_, index) => ({ id: `perf-${index}`, name: `Synthetic ${index}`, databaseName: `${prefix}_${index}` }));
Object.assign(process.env, { BUSINESS_DATABASES: JSON.stringify(businesses), DEFAULT_BUSINESS_ID: businesses[0].id,
  DEFAULT_BUSINESS_DATABASE: businesses[0].databaseName, CONTROL_DATABASE_NAME: `${prefix}_control`, CRM_ADMIN_ONE_CODE: "90000001",
  CRM_ADMIN_SESSION_SECRET: crypto.randomBytes(48).toString("hex"), CRM_ATTENDANCE_INTEGRITY: "true", CRM_ATTENDANCE_ACTIVE_SESSION: "true",
  CRM_ATTENDANCE_DURATION_MODEL: "true", CRM_ATTENDANCE_AUTO_TIMEOUT: "false", CRM_PAYROLL_ACCURACY: "true", CRM_DASHBOARD_V2: "true", CRM_ATTENDANCE_HUB: "true" });
const { Employee } = await import("../models/Employee");
const { Attendance } = await import("../models/Attendance");
const { AttendanceLedger, AttendancePolicy } = await import("../models/AttendanceLedger");
const { runWithBusiness } = await import("../config/tenancy");
const { setBusinessAccessForEmployeeCode } = await import("../models/BusinessUserAccess");
const { resolveAttendanceIdentity, readAttendanceLedger, attendanceSnapshot } = await import("./attendanceLedgerService");
const { assignAttendanceShift } = await import("./attendanceShift");
const { createAttendanceHubSession } = await import("../config/attendanceHubSession");
const { createApp } = await import("../app");
const { createAdminDashboardSession } = await import("../config/adminDashboardSession");
const { Lead } = await import("../models/Lead");
let mongo: MongoMemoryReplSet, server: http.Server, base = "", ledgerId = "";
const code = "91000001", employees: string[] = [];

before(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri(prefix));
  await AttendancePolicy.create({ _id: "global-attendance", revision: 1, shiftStart: "23:00", shiftEnd: "08:00", graceMinutes: 0, breakMinutes: 15, lunchMinutes: 60, recoveryTime: "22:59" });
  for (const business of businesses) await runWithBusiness(business.id, async () => {
    const employee = await Employee.create({ employeeCode: code, name: "Synthetic Employee", role: "Sales Agent", team: "Fixture", status: "Active", dateHired: "2026-01-01" });
    employees.push(String(employee._id));
    await Attendance.create({ employee: employee._id, source: "Time In", timeIn: new Date("2026-01-02T15:00:00Z") });
    await mongoose.connection.getClient().db(business.databaseName).collection("payrollrecords").insertOne({ status: "Paid", employee: employee._id,
      netPay: 12345, deductions: 123, paymentDate: new Date("2026-01-15T00:00:00Z"), cutoff: "Synthetic historical payroll" });
  });
  await setBusinessAccessForEmployeeCode(code, businesses.map(business => business.id));
  const identity = await runWithBusiness(businesses[0].id, () => resolveAttendanceIdentity(employees[0], { role: "employee", code }));
  ledgerId = identity.key;
  const events: SessionEvent[] = [], start = Date.now() - 61 * 86400000;
  for (let day = 0; day < 60; day++) for (const [source, offset] of [["Time In", 0], ["Break Out", 3600000], ["Break In", 4500000], ["Time Out", 32400000]] as const) {
    const at = new Date(start + day * 86400000 + offset).toISOString(), index = events.length;
    events.push({ id: `event-${index}`, commandId: `command-${index}`, source, at, recordedAt: at, sequence: index,
      ...(source === "Time In" ? { shift: assignAttendanceShift(new Date(at)) } : {}) });
  }
  const at = new Date(Date.now() - 3600000).toISOString();
  events.push({ id: "current", commandId: "current", source: "Time In", at, recordedAt: at, sequence: events.length, shift: assignAttendanceShift(new Date(at)) });
  await AttendanceLedger.create({ _id: identity.key, employeeCode: code, canonicalBusinessId: businesses[0].id, businessIds: businesses.map(business => business.id),
    revision: 7, events, derived: [], audit: [], jobs: [], corrections: [], closures: [] });
  server = http.createServer(createApp());
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`;
});
after(async () => { await new Promise<void>(resolve => server?.close(() => resolve())); await mongoose.disconnect(); await mongo?.stop(); });

async function read(index: number, query = "", token = createAttendanceHubSession(code)!) {
  return fetch(`${base}/employees/${employees[index]}/attendance/session${query}`, { headers: {
    "X-Business-Id": businesses[index].id, "X-CRM-Attendance-Session": token,
  } });
}
async function evidence() {
  const records = [JSON.stringify(await AttendanceLedger.findById(ledgerId).lean())];
  for (const business of businesses) await runWithBusiness(business.id, async () => {
    records.push(JSON.stringify(await Attendance.find({}).sort({ _id: 1 }).lean()));
    records.push(JSON.stringify(await mongoose.connection.getClient().db(business.databaseName).collection("payrollrecords").find({}).sort({ _id: 1 }).toArray()));
  });
  return records;
}

test("six signed business views use compact fresh status and revision-checked deltas without writing attendance or Paid payroll", async () => {
  const before = await evidence();
  for (let index = 0; index < businesses.length; index++) {
    const fullResponse = await read(index); assert.equal(fullResponse.status, 200);
    const full = await fullResponse.json(); assert.equal(full.historyIncluded, true); assert.equal(full.records.length, 241);
    const statusResponse = await read(index, "?view=status"); assert.equal(statusResponse.status, 200);
    const status = await statusResponse.json();
    for (const key of ["revision", "fingerprint", "state", "stateSince", "assignedShift", "reviewState", "allowedActions", "policyRevision"])
      assert.deepEqual(status[key], full[key]);
    assert.equal(status.historyIncluded, false); assert.equal(status.statusOnly, true);
    assert.equal(status.sessions.length, 1); assert.equal(status.sessions[0].id, full.sessionId);
    assert.ok(JSON.stringify(status).length < JSON.stringify(full).length * 0.15);
    assert.equal(status.records.length, 0); assert.ok(status.sessions.every((session: { events: unknown[] }) => session.events.length === 0));
    const params = new URLSearchParams({ knownRevision: String(full.revision), knownFingerprint: full.fingerprint,
      knownPolicyRevision: String(full.policyRevision), knownServerTime: full.serverTime });
    const deltaResponse = await read(index, `?${params}`); assert.equal(deltaResponse.status, 200);
    const delta = await deltaResponse.json(); assert.equal(delta.historyIncluded, false); assert.equal(delta.statusOnly, false);
    assert.ok(delta.dashboardDays.length < full.dashboardDays.length); assert.deepEqual(delta.records, []);
    assert.ok(JSON.stringify(delta).length < JSON.stringify(full).length * 0.6);
    params.set("knownFingerprint", "wrong-evidence");
    const fallback = await (await read(index, `?${params}`)).json();
    assert.equal(fallback.historyIncluded, true); assert.deepEqual(fallback.records, full.records);
  }
  assert.deepEqual(await evidence(), before);
});

test("compact reads retain signed ownership and policy changes force full historical refresh", async () => {
  assert.equal((await read(0, "?view=status", createAttendanceHubSession("91000002")!)).status, 403);
  const full = await (await read(0)).json();
  await AttendancePolicy.updateOne({ _id: "global-attendance" }, { $inc: { revision: 1 } });
  const params = new URLSearchParams({ knownRevision: String(full.revision), knownFingerprint: full.fingerprint,
    knownPolicyRevision: String(full.policyRevision), knownServerTime: full.serverTime });
  const fresh = await (await read(0, `?${params}`)).json();
  assert.equal(fresh.historyIncluded, true); assert.equal(fresh.policyRevision, full.policyRevision + 1);
  await AttendanceLedger.updateOne({ _id: ledgerId }, { $inc: { revision: 1 } });
  params.set("knownPolicyRevision", String(fresh.policyRevision));
  assert.equal((await (await read(0, `?${params}`)).json()).historyIncluded, true);
});

test("six dashboard summaries retain exact lead/SLA counts and the latest twelve activities without altering saved records", async () => {
  const before = await evidence(), now = Date.now(), token = createAdminDashboardSession("90000001")!;
  const statuses = ["NEW", "NEW", "Follow up", "Follow up", "Qualified", "Ongoing Negotiation", "Dead", "Archived", "Completed"] as const;
  for (let index = 0; index < businesses.length; index++) {
    const expectedEvents: Array<{ at: number; comment: boolean }> = [];
    await runWithBusiness(businesses[index].id, async () => {
      for (const [leadIndex, status] of statuses.entries()) {
        const activities = Array.from({ length: 25 }, (_, activity) => ({ label: "Work updated", actorType: "employee" as const, actorName: "Synthetic Employee",
          detail: "Synthetic activity", createdAt: new Date(now - 100000 - (leadIndex * 50 + activity) * 60000) }));
        const comments = leadIndex === 1 ? [{ authorType: "admin" as const, authorName: "Fixture", body: "A long synthetic body ".repeat(100), createdAt: new Date(now - 1000000) }] : [];
        // The untouched NEW row has no history; all other rows exercise bounded activity selection.
        const activity = leadIndex === 0 ? [] : activities;
        expectedEvents.push(...activity.map(item => ({ at: item.createdAt.getTime(), comment: false })));
        await Lead.create({ businessName: `Synthetic lead ${leadIndex}`, phone: `+1202555${String(1000 + leadIndex)}`, assignedAgent: employees[index], assignedAgentName: "Synthetic Employee",
          status, createdAt: new Date(now - 48 * 3600000), comments, activity,
          ...(status === "Follow up" ? { followUpAt: new Date(now + (leadIndex === 2 ? -1 : 1) * 7200000) } : {}) });
      }
    });
    const response = await fetch(`${base}/dashboard-workspace/summary?preset=today`, { headers: { "X-Business-Id": businesses[index].id, "X-CRM-Admin-Session": token } });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.overdueTotal, 2); assert.equal(body.overdue.length, 2);
    assert.equal(body.dashboard.summary.totalOpenLeads, 7);
    assert.deepEqual(body.dashboard.recentActivity.map((item: { createdAt: string }) => Date.parse(item.createdAt)),
      expectedEvents.map(item => item.at).sort((a, b) => b - a).slice(0, 12));
    const rangeStart = Date.parse(body.range.fromTime), rangeEnd = Date.parse(body.range.toTime);
    assert.equal(body.dashboard.summary.activityToday, expectedEvents.filter(item => item.at >= rangeStart && item.at <= rangeEnd).length);
    assert.equal(body.dashboard.summary.commentsToday, 0);
  }
  assert.deepEqual(await evidence(), before);
});

test("revision-zero read policies use a policy fingerprint for exact deltas and force full history when unversioned settings change", async () => {
  const policy = await AttendancePolicy.findById("global-attendance").lean();
  assert.ok(policy);
  await AttendancePolicy.updateOne({ _id: "global-attendance" }, { $set: { revision: 0 } });
  try {
    const before = await evidence();
    for (let index = 0; index < businesses.length; index++) {
      const full = await (await read(index)).json();
      assert.equal(full.policyRevision, 0);
      assert.match(full.policyFingerprint || "", /^[a-f0-9]{64}$/);
      const query = new URLSearchParams({ knownRevision: String(full.revision), knownFingerprint: full.fingerprint,
        knownPolicyRevision: "0", knownPolicyFingerprint: full.policyFingerprint, knownServerTime: full.serverTime });
      const delta = await (await read(index, `?${query}`)).json();
      assert.equal(delta.historyIncluded, false); assert.equal(delta.policyFingerprint, full.policyFingerprint);
      for (const key of ["state", "stateSince", "revision", "fingerprint", "allowedActions", "reviewState"])
        assert.deepEqual(delta[key], full[key]);
      assert.ok(JSON.stringify(delta).length < JSON.stringify(full).length * .2);
      query.delete("knownPolicyFingerprint");
      assert.equal((await (await read(index, `?${query}`)).json()).historyIncluded, true, "older revision-zero clients retain a safe full response");
    }
    assert.deepEqual(await evidence(), before);
    const full = await (await read(0)).json();
    await AttendancePolicy.updateOne({ _id: "global-attendance" }, { $inc: { graceMinutes: 1 } });
    const query = new URLSearchParams({ knownRevision: String(full.revision), knownFingerprint: full.fingerprint,
      knownPolicyRevision: "0", knownPolicyFingerprint: full.policyFingerprint, knownServerTime: full.serverTime });
    const changed = await (await read(0, `?${query}`)).json();
    assert.equal(changed.historyIncluded, true); assert.notEqual(changed.policyFingerprint, full.policyFingerprint);
  } finally {
    await AttendancePolicy.updateOne({ _id: "global-attendance" }, { $set: { revision: policy.revision, graceMinutes: policy.graceMinutes } });
  }
});

test("read projections omit internal history from MongoDB while retaining complete commands, audit, status and saved evidence", async () => {
  const original = await AttendanceLedger.findById(ledgerId).lean(); assert.ok(original);
  await AttendanceLedger.updateOne({ _id: ledgerId }, { $set: { commands: [{ id: "synthetic", result: { large: "x".repeat(400_000) } }],
    audit: [{ commandId: "synthetic", reason: "x".repeat(400_000) }], derivedBaseline: { synthetic: "x".repeat(400_000) } } });
  try {
    const before = await evidence(), at = new Date();
    for (let index = 0; index < businesses.length; index++) await runWithBusiness(businesses[index].id, async () => {
      const identity = await resolveAttendanceIdentity(employees[index], { role: "employee", code });
      const complete = await readAttendanceLedger(identity), presentation = await readAttendanceLedger(identity, undefined, "presentation"), status = await readAttendanceLedger(identity, undefined, "status");
      assert.equal(complete.commands.length, 1); assert.ok(complete.derivedBaseline);
      assert.equal(presentation.commands, undefined); assert.equal(presentation.derivedBaseline, undefined);
      assert.deepEqual(presentation.audit, complete.audit); assert.equal(status.audit, undefined);
      assert.deepEqual(attendanceSnapshot(presentation, at), attendanceSnapshot(complete, at));
      assert.deepEqual(attendanceSnapshot(status, at, undefined, { statusOnly: true }), attendanceSnapshot(complete, at, undefined, { statusOnly: true }));
      assert.ok(JSON.stringify(status).length < JSON.stringify(complete).length * .2);
    });
    assert.deepEqual(await evidence(), before);
  } finally {
    await AttendanceLedger.updateOne({ _id: ledgerId }, { $set: { commands: original.commands, audit: original.audit }, $unset: { derivedBaseline: "" } });
  }
});

test("unchanged legacy review history can use deltas but never enables attendance actions", async () => {
  await AttendanceLedger.deleteOne({ _id: ledgerId });
  const before=await evidence(), full=await (await read(0)).json();
  assert.equal(full.reviewState,"migration-review");assert.deepEqual(full.allowedActions,[]);
  const params=new URLSearchParams({knownRevision:"0",knownFingerprint:full.fingerprint,knownPolicyRevision:String(full.policyRevision),knownServerTime:full.serverTime});
  const delta=await (await read(0,`?${params}`)).json();
  assert.equal(delta.historyIncluded,false);assert.equal(delta.reviewState,full.reviewState);assert.deepEqual(delta.allowedActions,[]);
  assert.deepEqual(await evidence(),before);
});
