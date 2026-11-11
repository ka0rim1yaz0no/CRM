import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { before, after, test } from "node:test";
import mongoose from "mongoose";
import { MongoMemoryReplSet } from "mongodb-memory-server";

const root = `projection_${crypto.randomUUID().replaceAll("-", "")}`, now = new Date("2026-10-30T20:30:00Z");
const businesses = Array.from({ length: 6 }, (_, index) => ({ id: `projection-${index}`, databaseName: `${root}_${index}` }));
Object.assign(process.env, { NODE_ENV: "test", BUSINESS_DATABASES: JSON.stringify(businesses), DEFAULT_BUSINESS_ID: businesses[0].id,
  DEFAULT_BUSINESS_DATABASE: businesses[0].databaseName, CONTROL_DATABASE_NAME: root + "_control", CRM_SECURITY_LEGACY_AUTH: "true",
  CRM_ADMIN_SESSION_SECRET: crypto.randomBytes(48).toString("hex"), CRM_ATTENDANCE_INTEGRITY: "true", CRM_ATTENDANCE_ACTIVE_SESSION: "true", CRM_ATTENDANCE_DURATION_MODEL: "true" });
const baseline = process.env.CRM_PROJECTION_BASELINE_SOURCE;
if (baseline) assert.ok(path.isAbsolute(baseline), "The optional projection baseline must be an absolute path");
const { createApp } = await import("../app");
const old = baseline ? await import(pathToFileURL(path.join(baseline, "backend/src/app.ts")).href) : null;
const { runWithBusiness } = await import("../config/tenancy"), { Employee } = await import("../models/Employee");
const { AttendanceLedger, AttendancePolicy } = await import("../models/AttendanceLedger");
const { setBusinessAccessForEmployeeCode, getAttendanceBusinessIdentity } = await import("../models/BusinessUserAccess");
const { createAttendanceHubSession } = await import("../config/attendanceHubSession"), { assignAttendanceShift } = await import("./attendanceShift");
const people: Array<{ id: string; business: typeof businesses[number] }> = [], servers: http.Server[] = [], origins: string[] = [];
const code = "synthetic-projection"; let mongo: MongoMemoryReplSet, writes = 0;
before(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 }, instanceOpts: [{ args: ["--wiredTigerCacheSizeGB", "0.25"] }] });
  const uri = mongo.getUri(root);
  assert.equal(new URL(uri).hostname, "127.0.0.1");
  await mongoose.connect(uri, { monitorCommands: true });
  await AttendancePolicy.create({ _id: "global-attendance", revision: 1, shiftStart: "23:00", shiftEnd: "08:00", breakMinutes: 15, lunchMinutes: 60 });
  for (const business of businesses) await runWithBusiness(business.id, async () => {
    const person = await Employee.create({ employeeCode: code, name: "Synthetic", role: "Sales", status: "Active" });
    people.push({ id: String(person._id), business });
    await mongoose.connection.getClient().db(business.databaseName).collection("payrollrecords").insertOne({ employee: person._id, status: "Paid", netPay: 12345, paidOn: "Synthetic date" });
  });
  await setBusinessAccessForEmployeeCode(code, businesses.map(row => row.id)); const identity = await getAttendanceBusinessIdentity(code); assert.ok(identity);
  const at = new Date(+now - 3600_000).toISOString();
  await AttendanceLedger.create({ _id: `access:${identity.id}`, employeeCode: code, businessIds: businesses.map(row => row.id), canonicalBusinessId: businesses[0].id,
    revision: 1, events: [{ id: "in", source: "Time In", at, recordedAt: at, sequence: 1, commandId: "in", shift: assignAttendanceShift(new Date(at)) }],
    commands: [{ id: "internal-command", result: { synthetic: "x".repeat(500_000) } }], audit: [{ reason: "x".repeat(500_000) }], derivedBaseline: { synthetic: "x".repeat(500_000) }, jobs: [] });
  for (const factory of old ? [createApp, old.createApp] : [createApp]) {
    const app = factory(), server = http.createServer((request, response) => { if (request.method !== "GET") { writes++; response.writeHead(403).end(); return; } app(request, response); });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve)); servers.push(server); origins.push(`http://127.0.0.1:${(server.address() as { port: number }).port}/api`);
  }
});
after(async () => { for (const server of servers) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } await mongoose.disconnect(); await mongo?.stop(); });
const digest = async () => {
  const values: unknown[] = [await AttendanceLedger.find({}).lean()];
  for (const business of businesses) values.push(await mongoose.connection.getClient().db(business.databaseName).collection("payrollrecords").find({}).toArray());
  return crypto.createHash("sha256").update(JSON.stringify(values)).digest("hex");
};
test("10/25/50 concurrent status reads preserve unlimited Coaching and exclude large audit data", async context => {
  context.mock.timers.enable({ apis: ["Date"], now });
  try {
    const before = await digest(), token = createAttendanceHubSession(code)!, reports = [];
    const ledger = await AttendanceLedger.findOne().lean();
    assert.ok(ledger);
    const fullLedgerBytes = mongoose.mongo.BSON.calculateObjectSize(ledger);
    assert.ok(fullLedgerBytes > 1_000_000, "the fixture must include large audit, command and derived baseline fields");
    const client = mongoose.connection.getClient();
    for (const users of [10, 25, 50]) {
      const rounds = [];
      for (const origin of origins) {
        const projections: Array<Record<string, unknown> | undefined> = [];
        const observe = (event: { command: { find?: string; projection?: Record<string, unknown> } }) => {
          if (event.command.find === AttendanceLedger.collection.name) projections.push(event.command.projection);
        };
        const network = await client.db("admin").command({ serverStatus: 1 });
        const cpu = process.cpuUsage(), started = performance.now();
        if (origin === origins[0]) client.on("commandStarted", observe);
        const responses = await Promise.all(Array.from({ length: users }, async (_, index) => {
          const person = people[index % people.length], response = await fetch(`${origin}/employees/${person.id}/attendance/session?view=status`, {
            headers: { "X-Business-Id": person.business.id, "X-CRM-Attendance-Session": token }, signal: AbortSignal.timeout(30_000) });
          assert.equal(response.status, 200); return response.json();
        })).finally(() => client.off("commandStarted", observe));
        if (origin === origins[0]) {
          assert.ok(projections.length >= users, "status reads must query their attendance ledger");
          for (const projection of projections) assert.deepEqual(
            [projection?.audit, projection?.commands, projection?.derivedBaseline], [0, 0, 0], "status reads must exclude oversized fields");
        }
        const elapsedMs = performance.now() - started, used = process.cpuUsage(cpu), after = await client.db("admin").command({ serverStatus: 1 });
        rounds.push({ responses, elapsedMs: Math.round(elapsedMs), cpuMs: Math.round((used.user + used.system) / 1000), databaseBytes: after.network.bytesOut - network.network.bytesOut });
      }
      const [candidate, historical] = rounds;
      for (const snapshot of candidate.responses) {
        assert.equal(snapshot.state, "ONLINE");
        assert.equal(snapshot.revision, 1);
        assert.equal(snapshot.coachingBilling.limited, false);
        assert.equal(snapshot.coachingBilling.remainingPaidMs, null);
        assert.equal(snapshot.coachingBilling.totalMs, 0);
        assert.equal(snapshot.coachingBilling.active, null);
      }
      assert.ok(candidate.databaseBytes < fullLedgerBytes * users * .2, "status reads must transfer much less than unprojected ledgers");
      if (historical) {
        const expected = historical.responses.map(snapshot => {
          assert.equal(snapshot.coachingBilling.limited, true, "the immutable baseline still has its original Coaching allowance");
          assert.equal(snapshot.coachingBilling.totalMs, 0);
          assert.equal(snapshot.coachingBilling.active, null);
          return { ...snapshot, coachingBilling: { ...snapshot.coachingBilling, limited: false, remainingPaidMs: null } };
        });
        assert.deepEqual(candidate.responses, expected, "only the two explicitly changed Coaching contract fields may differ");
        assert.ok(candidate.databaseBytes < historical.databaseBytes * .2);
      }
      const stats = ({ elapsedMs, cpuMs, databaseBytes }: typeof candidate) => ({ elapsedMs, cpuMs, databaseBytes });
      reports.push({ users, ...(historical ? { baseline: stats(historical) } : {}), candidate: stats(candidate) });
    }
    assert.equal(await digest(), before); assert.equal(writes, 0);
    console.log(JSON.stringify({ isolatedProjectionLoad: reports, businesses: 6, callsPlaced: 0, productionWrites: 0, unchangedAttendanceAndPayroll: true }));
  } finally { context.mock.timers.reset(); }
});
