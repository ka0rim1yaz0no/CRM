import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import mongoose from "mongoose";
import { MongoMemoryReplSet } from "mongodb-memory-server";

const prefix = `legacy_adoption_test_${crypto.randomUUID().replaceAll("-", "")}`;
process.env.NODE_ENV = "test";
process.env.CRM_ATTENDANCE_INTEGRITY = "true";
process.env.CRM_ATTENDANCE_ACTIVE_SESSION = "true";
process.env.CRM_ATTENDANCE_RECOVERY_CUTOFF = "false";
process.env.CRM_ADMIN_SESSION_SECRET = crypto.randomBytes(48).toString("hex");
process.env.BUSINESS_DATABASES = JSON.stringify(["a", "b"].map((id) => ({ id: `fake-${id}`, name: `Synthetic ${id}`, databaseName: `${prefix}_${id}` })));
process.env.DEFAULT_BUSINESS_ID = "fake-a";
process.env.DEFAULT_BUSINESS_DATABASE = `${prefix}_a`;
process.env.CONTROL_DATABASE_NAME = `${prefix}_control`;
const root = await fs.mkdtemp(path.join(os.tmpdir(), "assistly-legacy-test-"));
const { runWithBusiness } = await import("../config/tenancy");
const { Employee } = await import("../models/Employee");
const { Attendance } = await import("../models/Attendance");
const { AttendanceLedger, AttendancePolicy } = await import("../models/AttendanceLedger");
const { setBusinessAccessForEmployeeCode } = await import("../models/BusinessUserAccess");
const { readLocalLegacyAdoptionPlan, adoptLocalLegacyAttendance } = await import("./localLegacyAttendanceAdoption");
const { resolveAttendanceIdentity, attendanceSnapshot, readAttendanceLedger } = await import("./attendanceLedgerService");
const { deliverAttendanceLedger } = await import("./attendanceLedgerOutbox");
const { createAttendanceHubSession } = await import("../config/attendanceHubSession");
const { createApp } = await import("../app");
let mongo: MongoMemoryReplSet; let server: http.Server; let base = ""; let counter = 0;
before(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri(prefix));
  await fs.writeFile(path.join(root, "empty-database-before-seed.json"), JSON.stringify({ database: prefix, collections: [] }));
  await AttendanceLedger.init();
  await AttendancePolicy.create({ _id: "global-attendance", shiftStart: "23:00", shiftEnd: "08:00", recoveryEnabled: false, recoveryTime: "22:59" });
  server = http.createServer(createApp());
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`;
});
after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await mongoose.disconnect(); await mongo.stop();
  assert.equal(path.dirname(root), path.resolve(os.tmpdir())); assert.ok(path.basename(root).startsWith("assistly-legacy-test-"));
  await fs.rm(root, { recursive: true, force: true });
});
const punch = (source: string, at: string) => ({ source, timeIn: new Date(at) });
async function fixture(problem = false) {
  const code = `99000${String(++counter).padStart(3, "0")}`; const ids: string[] = [];
  for (const business of ["fake-a", "fake-b"]) await runWithBusiness(business, async () => {
    const employee = await Employee.create({ name: "Synthetic Legacy Employee", employeeCode: code, role: "Test", salary: 30_000, businessAccessIds: ["fake-a", "fake-b"] });
    ids.push(String(employee._id));
    const records = problem ? [punch("Time In", "2026-10-15T15:00:00Z"), punch("Break Out", "2026-10-15T17:00:00Z"), punch("Lunch Break Out", "2026-10-15T17:01:00Z")] :
      business === "fake-a" ? [punch("Time In", "2026-10-12T15:00:00Z"), punch("Time In", "2026-10-13T15:00:00Z"),
        punch("Break Out", "2026-10-13T17:00:00Z"), punch("Break Out", "2026-10-13T17:00:00Z"), punch("Break In", "2026-10-13T17:10:00Z"),
        punch("Break Out", "2026-10-13T17:20:00Z"), punch("Time Out", "2026-10-14T00:00:00Z")] :
      [punch("Time In", "2026-10-13T15:00:00Z"), punch("Time Out", "2026-10-14T00:00:00Z")];
    await Attendance.insertMany(records.map((record) => ({ ...record, employee: employee._id })));
  });
  await setBusinessAccessForEmployeeCode(code, ["fake-a", "fake-b"]);
  const identity = await runWithBusiness("fake-a", () => resolveAttendanceIdentity(ids[0], { role: "admin", code: "synthetic-reviewer" }));
  return { code, ids, identity };
}
async function backup(identity: Awaited<ReturnType<typeof fixture>>["identity"]) {
  const folder = path.join(root, crypto.randomUUID()); await fs.mkdir(folder);
  const plan = await readLocalLegacyAdoptionPlan(identity);
  const files: Array<{ path: string; sha256: string }> = [];
  const databases = [prefix, `${prefix}_a`, `${prefix}_b`, `${prefix}_control`];
  for (const database of databases) {
    await fs.mkdir(path.join(folder, database));
    const db = mongoose.connection.getClient().db(database);
    for (const collection of await db.listCollections({}, { nameOnly: true }).toArray()) {
      const records = await db.collection(collection.name).find({}).toArray();
      const bytes = Buffer.concat(records.map((record) => Buffer.from(mongoose.mongo.BSON.serialize(record))));
      const name = path.join(database, `${collection.name}.bson`); await fs.writeFile(path.join(folder, name), bytes);
      files.push({ path: name, sha256: crypto.createHash("sha256").update(bytes).digest("hex") });
    }
  }
  const manifest = path.join(folder, "manifest.json");
  await fs.writeFile(manifest, JSON.stringify({ id: crypto.randomUUID(), createdAt: new Date().toISOString(), target: "127.0.0.1:27119", databases, files,
    fingerprints: { [identity.key]: plan.fingerprint } }));
  return { manifest, plan, folder, files };
}

test("backed-up local adoption preserves every original punch, retains history warnings and enables manual actions in both businesses", async () => {
  const person = await fixture(); const { manifest, plan } = await backup(person.identity);
  const result = await adoptLocalLegacyAttendance(person.identity, manifest);
  assert.equal(result?.status, "adopted");
  await deliverAttendanceLedger(person.identity.key);
  const ledger = await readAttendanceLedger(person.identity); const snapshot = attendanceSnapshot(ledger);
  assert.equal(snapshot.reviewState, "verified"); assert.equal(snapshot.historyReviewRequired, true);
  assert.equal(snapshot.state, "OFFLINE"); assert.equal(snapshot.syncPending, false);
  assert.equal(snapshot.sessions[0].endedAt, null); assert.equal(snapshot.sessions[0].lifecycle, "open");
  assert.equal(ledger.closures.length, 0); assert.equal(ledger.audit[0].operation, "legacy-adopt");
  assert.equal(snapshot.records.filter((event) => event.source === "Time Out").length, 1);
  for (const replica of plan.replicas) await runWithBusiness(replica.businessId, async () => {
    for (const original of replica.records) {
      const saved = await Attendance.collection.findOne({ _id: new mongoose.Types.ObjectId(original.id) });
      assert.equal(saved?.source, original.source); assert.equal(saved?.timeIn.toISOString(), original.at);
    }
    const effective = await Attendance.find({ ledgerIdentity: person.identity.key }).lean();
    assert.equal(effective.length, snapshot.records.length);
  });
  const token = createAttendanceHubSession(person.code)!;
  const response = await fetch(`${base}/employees/${person.ids[1]}/attendance/commands`, { method: "POST", headers: {
    "Content-Type": "application/json", "X-Business-Id": "fake-b", "X-CRM-Attendance-Session": token,
  }, body: JSON.stringify({ commandId: crypto.randomUUID(), operation: "action", expectedRevision: snapshot.revision, source: "Time In", legacyReviewed: true, legacyBoundary: true }) });
  assert.equal(response.status, 200, await response.clone().text());
  const current = await response.json(); assert.equal(current.state, "ONLINE"); assert.equal(current.reviewState, "verified");
  assert.equal(current.records.at(-1).legacyReviewed, undefined, "employee payload cannot create trusted legacy markers");
  for (const [index, business] of ["fake-a", "fake-b"].entries()) {
    const read = await fetch(`${base}/employees/${person.ids[index]}/attendance/session`, { headers: { "X-Business-Id": business, "X-CRM-Attendance-Session": token } });
    assert.equal(read.status, 200); const data = await read.json(); assert.equal(data.state, "ONLINE"); assert.equal(data.revision, current.revision);
  }
  assert.equal((await adoptLocalLegacyAttendance(person.identity, manifest))?.status, "already-adopted");
});

test("uncertain current sessions, stale previews and incomplete/tampered backups fail without adopting data", async () => {
  const uncertain = await fixture(true); const unsafe = await backup(uncertain.identity);
  assert.equal((await adoptLocalLegacyAttendance(uncertain.identity, unsafe.manifest))?.status, "blocked");
  assert.equal(await AttendanceLedger.findById(uncertain.identity.key), null);
  const person = await fixture(); const stale = await backup(person.identity);
  await runWithBusiness("fake-a", () => Attendance.collection.updateOne({ employee: new mongoose.Types.ObjectId(person.ids[0]), source: "Time In" }, { $set: { timeIn: new Date("2026-10-12T15:01:00Z") } }));
  await assert.rejects(adoptLocalLegacyAttendance(person.identity, stale.manifest), /changed after review/);
  assert.equal(await AttendanceLedger.findById(person.identity.key), null);
  const tampered = await backup(person.identity);
  await fs.appendFile(path.join(tampered.folder, tampered.files[0].path), "invalid");
  await assert.rejects(adoptLocalLegacyAttendance(person.identity, tampered.manifest), /integrity check/);
  await assert.rejects(adoptLocalLegacyAttendance(person.identity, path.join(root, "missing.json")));
});

test("concurrent adoption is idempotent and business membership changes abort the transaction", async () => {
  const person = await fixture(); const receipt = await backup(person.identity);
  const results = await Promise.all(Array.from({ length: 3 }, () => adoptLocalLegacyAttendance(person.identity, receipt.manifest)));
  assert.equal(results.filter((result) => result?.status === "adopted").length, 1);
  assert.equal(await AttendanceLedger.countDocuments({ _id: person.identity.key }), 1);
  const changed = await fixture(); const original = await backup(changed.identity);
  await setBusinessAccessForEmployeeCode(changed.code, ["fake-a"]);
  await assert.rejects(adoptLocalLegacyAttendance(changed.identity, original.manifest), /membership changed/);
  assert.equal(await AttendanceLedger.findById(changed.identity.key), null);
  const environment = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  try { await assert.rejects(adoptLocalLegacyAttendance(person.identity, receipt.manifest), /restricted/); }
  finally { process.env.NODE_ENV = environment; }
});
