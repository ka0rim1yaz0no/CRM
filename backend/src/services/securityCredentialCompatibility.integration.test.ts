import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import { after, before, mock, test } from "node:test";
import mongoose from "mongoose";
import { MongoMemoryReplSet } from "mongodb-memory-server";

const database = `vault_compat_${crypto.randomUUID().replaceAll("-", "")}`;
process.env.NODE_ENV = "test";
process.env.DEFAULT_BUSINESS_ID = "compat-a";
process.env.DEFAULT_BUSINESS_DATABASE = `${database}_a`;
process.env.CONTROL_DATABASE_NAME = `${database}_control`;
process.env.BUSINESS_DATABASES = JSON.stringify(["a", "b"].map((name) => ({ id: `compat-${name}`, databaseName: `${database}_${name}` })));
process.env.CRM_ADMIN_ONE_CODE = "90000001";
process.env.CRM_ADMIN_SESSION_SECRET = crypto.randomBytes(48).toString("hex");
process.env.CRM_SECURITY_CREDENTIAL_VAULT = "true";
delete process.env.CRM_CREDENTIAL_KEY;
process.env.CRM_ATTENDANCE_INTEGRITY = "true";
process.env.CRM_ATTENDANCE_DURATION_MODEL = "true";
process.env.CRM_ATTENDANCE_AUTO_TIMEOUT = "false";
process.env.CRM_ATTENDANCE_RECOVERY_CUTOFF = "false";
process.env.CRM_CALL_DASHBOARD_V2 = "true";
process.env.CRM_DASHBOARD_V2 = "true";

const { createApp } = await import("../app");
const { Employee } = await import("../models/Employee");
const { AttendancePolicy } = await import("../models/AttendanceLedger");
const { runWithBusiness } = await import("../config/tenancy");
const { setBusinessAccessForEmployeeCode } = await import("../models/BusinessUserAccess");
const { securityCredentialVaultEnabled } = await import("../config/rolloutFlags");
let mongo: MongoMemoryReplSet;
let server: http.Server;
let base = "";
const ids: string[] = [];
let adminToken = "";
let employeeToken = "";

before(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri(database));
  for (const business of ["compat-a", "compat-b"]) await runWithBusiness(business, async () => {
    const employee = await Employee.create({ employeeCode: "90000003", name: "Synthetic Compatibility Employee", status: "Active", role: "Sales", team: "Fixture", bankName: "Synthetic Bank", bankAccountNumber: "fake-001", personalAddress: "Synthetic address", salary: 25000, businessAccessIds: ["compat-a", "compat-b"] });
    ids.push(String(employee._id));
  });
  await setBusinessAccessForEmployeeCode("90000003", ["compat-a", "compat-b"]);
  await AttendancePolicy.create({ _id: "global-attendance", revision: 1, graceMinutes: 0, breakMinutes: 15, lunchMinutes: 60, shiftStart: "23:00", shiftEnd: "08:00", recoveryEnabled: false, recoveryTime: "22:59" });
  server = http.createServer(createApp());
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`;
});
after(async () => {
  mock.timers.reset();
  if (server?.listening) await new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); });
  await mongoose.disconnect(); await mongo?.stop();
});
async function request(route: string, role: "admin" | "employee" = "admin", body?: unknown, index = 0) {
  const response = await fetch(`${base}${route}`, { method: body === undefined ? "GET" : "POST", headers: { "Content-Type": "application/json", "X-Business-Id": `compat-${index ? "b" : "a"}`,
    [role === "admin" ? "X-CRM-Admin-Session" : "X-CRM-Attendance-Session"]: role === "admin" ? adminToken : employeeToken }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, data: await response.json() };
}

test("vault rollout defaults on only in development/test with explicit production opt-in", () => {
  const environment = process.env.NODE_ENV;
  const flag = process.env.CRM_SECURITY_CREDENTIAL_VAULT;
  try {
    delete process.env.CRM_SECURITY_CREDENTIAL_VAULT;
    for (const env of ["development", "test", "production"]) {
      process.env.NODE_ENV = env;
      assert.equal(securityCredentialVaultEnabled(), env !== "production");
    }
    process.env.CRM_SECURITY_CREDENTIAL_VAULT = "true";
    assert.equal(securityCredentialVaultEnabled(), true);
    process.env.NODE_ENV = "test"; process.env.CRM_SECURITY_CREDENTIAL_VAULT = "false";
    assert.equal(securityCredentialVaultEnabled(), false);
  } finally { process.env.NODE_ENV = environment; process.env.CRM_SECURITY_CREDENTIAL_VAULT = flag; }
});

test("vault enabled without a development key preserves code login, signed dashboards and admin session", async () => {
  const admin = await request("/auth/login", "admin", { employeeCode: "90000001" });
  assert.equal(admin.status, 200); assert.equal(admin.data.userType, "admin");
  assert.equal(typeof admin.data.sessionToken, "string"); adminToken = admin.data.sessionToken;
  const employee = await request("/auth/login", "employee", { employeeCode: "90000003" });
  assert.equal(employee.status, 200); assert.equal(employee.data.userType, "employee");
  assert.equal(typeof employee.data.attendanceHubSession, "string"); employeeToken = employee.data.attendanceHubSession;
  assert.equal((await request("/call-dashboard")).status, 200);
  assert.equal((await request("/dashboard-workspace/summary?preset=today")).status, 200);
  assert.equal((await request(`/employees/${ids[0]}/attendance/session`, "employee")).status, 200);
});

test("vault rollout leaves manual attendance, cross-business refresh and both dashboard sessions operational", async () => {
  const start = Date.parse("2026-10-19T15:00:00Z");
  mock.timers.enable({ apis: ["Date"], now: start });
  try {
    adminToken = (await request("/auth/login", "admin", { employeeCode: "90000001" })).data.sessionToken;
    employeeToken = (await request("/auth/login", "employee", { employeeCode: "90000003" })).data.attendanceHubSession;
    const steps = [["Time In", 0], ["Break Out", 60], ["Break In", 960], ["Break Out", 961], ["Break In", 1861],
      ["Lunch Break Out", 1900], ["Lunch Break In", 5500], ["Off the Phone Out", 5600], ["Off the Phone In", 5610], ["Time Out", 32400]] as const;
    for (const [source, seconds] of steps) {
      mock.timers.setTime(start + seconds * 1000);
      const current = await request(`/employees/${ids[0]}/attendance/session`, "employee");
      const saved = await request(`/employees/${ids[0]}/attendance/commands`, "employee", { commandId: crypto.randomUUID(), operation: "action", source,
        expectedRevision: current.data.revision, fingerprint: current.data.fingerprint });
      assert.equal(saved.status, 200);
    }
    const first = await request(`/employees/${ids[0]}/attendance/session`, "employee");
    const second = await request(`/employees/${ids[1]}/attendance/session`, "employee", undefined, 1);
    assert.equal(first.data.state, "OFFLINE"); assert.equal(first.data.syncPending, false);
    assert.deepEqual(first.data.records, second.data.records);
    assert.equal(first.data.derived[0].breakSessions.length, 2);
    assert.equal(first.data.derived[0].excessBreakMinutes, 0);
    assert.equal(first.data.derived[0].excessLunchMinutes, 0);
    assert.equal((await request("/call-dashboard")).status, 200);
    assert.equal((await request("/dashboard-workspace/summary?preset=today")).status, 200);
  } finally { mock.timers.reset(); }
});

test("privacy: login and default employee lists omit private fields, including future unknown fields", async () => {
  process.env.CRM_SECURITY_DATA_MINIMIZATION = "true";
  const login = await request("/auth/login", "employee", { employeeCode: "90000003" });
  employeeToken = login.data.attendanceHubSession;
  adminToken = (await request("/auth/login", "admin", { employeeCode: "90000001" })).data.sessionToken;
  const privateKeys = ["bankName", "bankAccountNumber", "bankRoutingNumber", "personalAddress", "personalNotes", "governmentId"];
  function safe(value: Record<string, unknown>) { for (const key of privateKeys) assert.equal(Object.hasOwn(value, key), false, `${key} must never appear in a non-owner response`); }
  safe(login.data.user);
  for (const role of ["admin", "employee"] as const) for (const business of [0, 1]) {
    const listed = await request("/employees", role, undefined, business);
    assert.equal(listed.status, 200); for (const row of listed.data) safe(row);
  }
});

test("privacy: only signed owner or full-admin can read or edit private profile, never spoofed identity headers", async () => {
  const { createAttendanceHubSession } = await import("../config/attendanceHubSession");
  const route = `/employees/${ids[0]}`;
  const owner = await request(route, "employee");
  assert.equal(owner.status, 200); assert.equal(owner.data.bankAccountNumber, "fake-001");
  assert.equal((await request(route)).data.bankAccountNumber, "fake-001");
  for (const token of ["", "forged", createAttendanceHubSession("different-synthetic-employee")!]) {
    for (const suffix of ["", "/profile", "/bank"]) {
      const response = await fetch(`${base}${route}${suffix}`, { method: suffix ? "PATCH" : "GET", headers: {
        "Content-Type": "application/json", "X-Business-Id": "compat-a", "X-CRM-User-Type": "employee", "X-CRM-User-Code": "90000003", "X-CRM-Attendance-Session": token,
      }, ...(suffix ? { body: JSON.stringify({ bankAccountNumber: "forged-change" }) } : {}) });
      assert.equal(response.status, token && token !== "forged" ? 403 : 401); assert.ok(!JSON.stringify(await response.json()).includes("fake-001"));
    }
  }
  assert.equal((await request(route, "employee")).data.bankAccountNumber, "fake-001");
  const summary = await fetch(`${base}${route}?summary=true`, { headers: { "X-Business-Id": "compat-a" } });
  assert.equal(summary.status, 401); assert.equal(Object.hasOwn(await summary.json(), "bankAccountNumber"), false);
  assert.equal((await request("/employees?summary=false")).data[0].bankAccountNumber, "fake-001");
});

test("privacy: flag off preserves the old employee response shape", async () => {
  process.env.CRM_SECURITY_DATA_MINIMIZATION = "false";
  try { assert.equal((await request("/auth/login", "employee", { employeeCode: "90000003" })).data.user.bankAccountNumber, "fake-001"); }
  finally { process.env.CRM_SECURITY_DATA_MINIMIZATION = "true"; }
});

test("hardening: business switch requires the signed owner and returns only safe login metadata", async () => {
  const { createAttendanceHubSession } = await import("../config/attendanceHubSession");
  const body = { employeeCode: "90000003", currentBusinessId: "compat-a", targetBusinessId: "compat-b" };
  for (const token of ["", "forged", createAttendanceHubSession("different-synthetic-employee")!]) {
    const response = await fetch(`${base}/auth/switch-business`, { method: "POST", headers: { "Content-Type": "application/json", "X-Business-Id": "compat-b", "X-CRM-Attendance-Session": token }, body: JSON.stringify(body) });
    assert.equal(response.status, token && token !== "forged" ? 403 : 401);
  }
  const switched = await request("/auth/switch-business", "employee", body, 1);
  assert.equal(switched.status, 200); assert.equal(switched.data.business.id, "compat-b");
  assert.equal(Object.hasOwn(switched.data.user, "bankAccountNumber"), false);
  assert.ok(switched.data.attendanceHubSession);
});
