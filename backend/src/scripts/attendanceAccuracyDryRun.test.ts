import assert from "node:assert/strict";
import { afterEach, mock, test } from "node:test";
import { mongo } from "mongoose";
import { attendanceAccuracyDryRun } from "./attendanceAccuracyDryRun";
const beforeFlags = { ...process.env };
afterEach(() => { mock.restoreAll(); for (const flag of ["CRM_ATTENDANCE_ACCURACY_FIXES", "CRM_PAYROLL_ACCURACY", "CRM_ATTENDANCE_DURATION_MODEL", "CRM_ATTENDANCE_BREAK_GAP"]) {
  if (beforeFlags[flag] === undefined) delete process.env[flag]; else process.env[flag] = beforeFlags[flag];
} });
const args = (uri: string) => ["--dry-run", "--uri", uri, "--ledger-database", "fake", "--business", "fake-a=fake_a", "--as-of", "2026-10-21T01:00:00Z"];
test("accuracy CLI rejects nonlocal, credential-bearing and apply targets before connecting", async () => {
  let calls = 0; mock.method(mongo.MongoClient.prototype, "connect", async () => { calls++; });
  const credentialBearing = new URL("mongodb://localhost/fake");
  credentialBearing.username = "synthetic-user";
  credentialBearing.password = "synthetic-password";
  for (const uri of ["mongodb://remote.example.invalid/fake", "mongodb+srv://remote.example.invalid/fake", credentialBearing.href]) {
    await assert.rejects(attendanceAccuracyDryRun(args(uri)), /loopback Mongo/);
  }
  await assert.rejects(attendanceAccuracyDryRun([...args("mongodb://127.0.0.1:1/fake"), "--apply"]));
  assert.equal(calls, 0);
});
test("accuracy CLI uses read-only raw collections and emits a 60-day per-business ranked report", async () => {
  process.env.CRM_ATTENDANCE_DURATION_MODEL = "false"; process.env.CRM_ATTENDANCE_BREAK_GAP = "true";
  const collections: string[] = []; let closed = false;
  mock.method(mongo.MongoClient.prototype, "connect", async () => undefined);
  mock.method(mongo.MongoClient.prototype, "close", async () => { closed = true; });
  mock.method(mongo.MongoClient.prototype, "db", () => ({ collection(name: string) {
    collections.push(name);
    if (name === "attendancepolicies") return { findOne: async () => ({ breakMinutes: 15, lunchMinutes: 60, graceMinutes: 0, shiftStart: "23:00", shiftEnd: "08:00" }) };
    if (name === "employees") return { find: () => [] };
    throw new Error("Unexpected collection or write");
  } }) as never);
  const result = await attendanceAccuracyDryRun(args("mongodb://127.0.0.1:1/fake"));
  assert.equal(result.writes, 0); assert.equal(result.days, 60);
  assert.deepEqual(result.businesses[0].accuracy, { changedStoredRecords: 0, minutesDifference: 0, unverifiableRecords: 0, unverifiableDays: 0, topEmployees: [] });
  assert.deepEqual(collections, ["attendancepolicies", "employees"]); assert.equal(closed, true);
  assert.equal(process.env.CRM_ATTENDANCE_DURATION_MODEL, "true");
  assert.equal(process.env.CRM_ATTENDANCE_BREAK_GAP, "false");
});
