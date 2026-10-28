import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import crypto from "node:crypto";
import http from "node:http";
import { readFile } from "node:fs/promises";
import mongoose from "mongoose";
import { MongoMemoryReplSet } from "mongodb-memory-server";

const prefix = `bridge_download_test_${crypto.randomUUID().replaceAll("-", "")}`;
const businesses = ["a", "b", "c", "d", "e", "f"].map(id => `test-${id}`);
const employeeCode = "synthetic-bridge-download";
process.env.NODE_ENV = "test";
process.env.CRM_SECURITY_UPLOAD_AUTH = "true";
process.env.CRM_SECURITY_LEGACY_AUTH = "true";
process.env.CRM_ATTENDANCE_RECOVERY_CUTOFF = "false";
process.env.CRM_ADMIN_ONE_CODE = "synthetic-download-admin";
process.env.CRM_ADMIN_TWO_CODE = "synthetic-download-tracker";
process.env.CRM_ADMIN_TWO_ACCESS = "tracker";
process.env.CRM_ADMIN_SESSION_SECRET = crypto.randomBytes(48).toString("hex");
process.env.BUSINESS_DATABASES = JSON.stringify(businesses.map(id => ({
  id, name: `Synthetic ${id}`, databaseName: `${prefix}_${id}`,
})));
process.env.DEFAULT_BUSINESS_ID = businesses[0];
process.env.DEFAULT_BUSINESS_DATABASE = `${prefix}_${businesses[0]}`;
process.env.CONTROL_DATABASE_NAME = `${prefix}_control`;

const { createApp } = await import("../app");
const { createAttendanceHubSession } = await import("../config/attendanceHubSession");
const { runWithBusiness } = await import("../config/tenancy");
const { Employee } = await import("../models/Employee");
const { setBusinessAccessForEmployeeCode } = await import("../models/BusinessUserAccess");
let mongo: MongoMemoryReplSet;
let server: http.Server;
let base = "";
let expectedPackageHash = "";
const cookie = (code: string, token = createAttendanceHubSession(code)!) =>
  `crm_file_session=${encodeURIComponent(JSON.stringify({ type: "employee", token }))}`;
const digest = (bytes: Uint8Array) => crypto.createHash("sha256").update(bytes).digest("hex");

before(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri(prefix));
  for (const business of businesses) {
    const code = business === businesses[0] ? "synthetic-default-download" : employeeCode;
    const allowed = business === businesses[0] ? [business] : businesses.slice(1);
    await runWithBusiness(business, () => Employee.create({ name: "Synthetic Download Employee",
      employeeCode: code, role: "Sales", team: "Synthetic", businessAccessIds: allowed }));
    await setBusinessAccessForEmployeeCode(code, allowed);
  }
  expectedPackageHash = digest(await readFile(new URL("../../../callbridge/dist/assistly-call-bridge.zip", import.meta.url)));
  server = http.createServer(createApp());
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`;
});

after(async () => {
  if (server) await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
  await mongoose.disconnect();
  await mongo?.stop();
});

test("browser download reproduces the default-business denial for non-default employees", async () => {
  const response = await fetch(`${base}/call-bridge/package`, { headers: { Cookie: cookie(employeeCode) } });
  assert.equal(response.status, 403);
  assert.equal((await response.json()).message, "You do not have access to this business.");
});

test("real signed login cookies download the exact bridge in every assigned business without API headers", async () => {
  for (const business of businesses) {
    const code = business === businesses[0] ? "synthetic-default-download" : employeeCode;
    const login = await fetch(`${base}/auth/login?businessId=${business}`, { method: "POST",
      headers: { "Content-Type": "application/json" }, body: JSON.stringify({ employeeCode: code }) });
    assert.equal(login.status, 200);
    assert.match(login.headers.get("set-cookie") || "", /HttpOnly/i);
    const response = await fetch(`${base}/call-bridge/package?businessId=${business}`, {
      headers: { Cookie: login.headers.get("set-cookie")!.split(";")[0] },
    });
    assert.equal(response.status, 200, `signed browser download in ${business}`);
    assert.match(response.headers.get("content-disposition") || "", /attachment;.*assistly-call-bridge\.zip/);
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    assert.equal(digest(new Uint8Array(await response.arrayBuffer())), expectedPackageHash);
  }
});

test("business-aware downloads do not grant anonymous, forged, expired, tracker or foreign-business access", async () => {
  const url = `${base}/call-bridge/package?businessId=test-b`;
  assert.equal((await fetch(url)).status, 401);
  for (const token of ["forged", createAttendanceHubSession(employeeCode, Date.now() - 13 * 60 * 60_000)!]) {
    assert.equal((await fetch(url, { headers: { Cookie: cookie(employeeCode, token) } })).status, 401);
  }
  const tracker = `crm_file_session=${encodeURIComponent(JSON.stringify({
    type: "tracker", token: createAttendanceHubSession("synthetic-download-tracker"),
  }))}`;
  assert.equal((await fetch(url, { headers: { Cookie: tracker } })).status, 403);
  assert.equal((await fetch(`${base}/call-bridge/package?businessId=test-a`, {
    headers: { Cookie: cookie(employeeCode) },
  })).status, 403);
});

test("download cookies remain file-GET credentials and cannot authorize ordinary API reads or attendance writes", async () => {
  const headers = { Cookie: cookie(employeeCode), "Content-Type": "application/json" };
  assert.equal((await fetch(`${base}/system-settings?businessId=test-b`, { headers })).status, 401);
  assert.equal((await fetch(`${base}/call-bridge/activate?businessId=test-b`, {
    method: "POST", headers, body: JSON.stringify({ employeeCode }),
  })).status, 401);
  const beforeCounts = await Promise.all(businesses.map(id => runWithBusiness(id, () =>
    mongoose.connection.useDb(`${prefix}_${id}`, { useCache: true }).collection("attendances").countDocuments())));
  assert.equal((await fetch(`${base}/attendance?businessId=test-b`, {
    method: "POST", headers, body: JSON.stringify({ source: "Time In" }),
  })).status, 401);
  const afterCounts = await Promise.all(businesses.map(id => runWithBusiness(id, () =>
    mongoose.connection.useDb(`${prefix}_${id}`, { useCache: true }).collection("attendances").countDocuments())));
  assert.deepEqual(afterCounts, beforeCounts);
});
