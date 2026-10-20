import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import crypto from "node:crypto";
import http from "node:http";
import mongoose from "mongoose";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import { io, type Socket } from "socket.io-client";

const root = `auth_guard_${crypto.randomUUID().replaceAll("-", "")}`;
process.env.NODE_ENV = "test";
process.env.CRM_SECURITY_LEGACY_AUTH = "true";
process.env.CRM_ADMIN_ONE_CODE = "synthetic-full";
process.env.CRM_ADMIN_TWO_CODE = "synthetic-tracker";
process.env.CRM_TRACKER_ADMIN_CODES = "synthetic-tracker";
process.env.CRM_ADMIN_SESSION_SECRET = crypto.randomBytes(48).toString("base64");
process.env.DEFAULT_BUSINESS_ID = "auth-a";
process.env.DEFAULT_BUSINESS_DATABASE = `${root}_a`;
process.env.CONTROL_DATABASE_NAME = `${root}_control`;
process.env.BUSINESS_DATABASES = JSON.stringify(["a", "b", "c"].map(id => ({ id: `auth-${id}`, databaseName: `${root}_${id}` })));
const { createApp } = await import("../app");
const { createSocketServer } = await import("../socket");
const { runWithBusiness } = await import("../config/tenancy");
const { Employee } = await import("../models/Employee");
const { Task } = await import("../models/Task");
const { setBusinessAccessForEmployeeCode } = await import("../models/BusinessUserAccess");
const { createAttendanceHubSession } = await import("../config/attendanceHubSession");
let mongo: MongoMemoryReplSet;
let server: http.Server;
let sockets: ReturnType<typeof createSocketServer>;
let base = "";
const ids: Record<string, string[]> = {};
const tokens: Record<string, { sessionToken?: string; attendanceHubSession?: string }> = {};
before(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri(root));
  for (const business of ["auth-a", "auth-b"]) await runWithBusiness(business, async () => {
    ids[business] = [];
    for (const code of ["synthetic-owner", "synthetic-other"]) {
      const person = await Employee.create({ employeeCode: code, name: code, status: "Active", role: "Sales", bankAccountNumber: "synthetic-private-bank", businessAccessIds: ["auth-a", "auth-b"] });
      ids[business].push(String(person._id));
      await Task.create({ title: code, assignedTo: person._id });
    }
  });
  for (const code of ["synthetic-owner", "synthetic-other"]) await setBusinessAccessForEmployeeCode(code, ["auth-a", "auth-b"]);
  server = http.createServer(createApp()); sockets = createSocketServer(server);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  for (const code of ["synthetic-full", "synthetic-tracker", "synthetic-owner"]) tokens[code] = await (await request("/auth/login", "", "auth-a", { employeeCode: code })).json();
});
after(async () => { sockets?.close(); server?.closeAllConnections(); await mongoose.disconnect(); await mongo?.stop(); });
function request(path: string, code = "synthetic-full", business = "auth-a", body?: unknown, extra: Record<string, string> = {}) {
  const token = tokens[code];
  return fetch(base + "/api" + path, { method: body === undefined ? "GET" : "POST", headers: { "Content-Type": "application/json", "X-Business-Id": business,
    ...(token?.sessionToken ? { "X-CRM-Admin-Session": token.sessionToken } : {}), ...(token?.attendanceHubSession ? { "X-CRM-Attendance-Session": token.attendanceHubSession } : {}), ...extra }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}

test("legacy guard denies missing, forged and expired credentials for every private route family", async () => {
  for (const path of ["/employees", "/roles", "/teams", "/tasks", "/leads", "/admin-leads", "/my-leads", "/knowledge-base", "/media", "/features", "/system-settings", "/notices", "/leave-requests", "/evaluations", "/reports/agent-productivity", "/messages/conversations", "/attendance", "/attendance-hub/days", "/call-dashboard", "/dashboard-workspace/summary", "/log/call-stats", "/call-bridge/status"]) {
    const attempts: Record<string, string>[] = [{}, { "X-CRM-User-Type": "admin", "X-CRM-User-Code": "synthetic-full", "X-CRM-Admin-Session": "forged" }];
    for (const forged of attempts) assert.equal((await request(path, "", "auth-a", undefined, forged)).status, 401, path);
  }
});
test("full admin remains allowed and employee/tracker cannot elevate, including cross-business requests", async () => {
  for (const business of ["auth-a", "auth-b"]) {
    assert.equal((await request("/dashboard-workspace/summary?preset=today", "synthetic-full", business)).status, 200);
    assert.equal((await request("/call-dashboard", "synthetic-full", business)).status, 200);
    assert.equal((await request("/employees", "synthetic-owner", business)).status, 200);
    assert.equal((await request("/hr/applicants", "synthetic-owner", business, undefined, { "X-CRM-User-Type": "admin", "X-CRM-User-Code": "synthetic-full" })).status, 403);
    assert.equal((await request("/employees", "synthetic-tracker", business)).status, 200);
    assert.equal((await request("/dashboard-workspace/summary", "synthetic-tracker", business)).status, 403);
  }
  assert.equal((await request("/employees", "synthetic-owner", "auth-c")).status, 403);
});
test("owner scope defeats spoofed employee ids, filters and task population never exposes bank fields", async () => {
  for (const business of ["auth-a", "auth-b"]) {
    const [own, other] = ids[business];
    assert.equal((await request(`/employees/${own}/attendance/session`, "synthetic-owner", business)).status, 200);
    assert.equal((await request("/attendance-hub/live?employeeCode=synthetic-other", "synthetic-owner", business)).status, 200);
    assert.equal((await request(`/employees/${other}/attendance/session`, "synthetic-owner", business)).status, 403);
    assert.equal((await request(`/employees/${other}/notices`, "synthetic-owner", business)).status, 403);
    assert.equal((await request(`/auth/businesses?employeeCode=synthetic-other`, "synthetic-owner", business)).status, 403);
    const tasks = await (await request(`/tasks?assignedTo=${other}`, "synthetic-owner", business)).json();
    assert.equal(tasks.length, 1); assert.equal(String(tasks[0].assignedTo._id), own);
    assert.equal(JSON.stringify(tasks).includes("synthetic-private-bank"), false);
  }
});
test("independent transports fail closed without their actual credentials, and the known development extension key is rejected", async () => {
  for (const [path, body] of [["/call-bridge/heartbeat", {}], ["/call-bridge/claim", {}], ["/integrations/customer-registration-leads", {}], ["/browser-activity/events/bulk", { employeeCode: "synthetic-owner", events: [] }]] as const) {
    const response = await request(path, "", "auth-a", body, { "X-CRM-Extension-Key": "dev-crm-extension-key" });
    assert.ok([400, 401, 403, 503].includes(response.status), path);
  }
});
async function connection(auth: Record<string, unknown>) {
  const socket: Socket = io(base, { auth, transports: ["websocket"], forceNew: true, reconnection: false, timeout: 1500 });
  try { return await new Promise<boolean>(resolve => { socket.once("connect", () => resolve(true)); socket.once("connect_error", () => resolve(false)); }); }
  finally { socket.disconnect(); }
}
test("socket authentication rejects forged headers and unassigned business while signed sessions still connect", async () => {
  assert.equal(await connection({ businessId: "auth-a", userType: "admin", userCode: "synthetic-full" }), false);
  assert.equal(await connection({ businessId: "auth-a", adminSession: tokens["synthetic-full"].sessionToken }), true);
  assert.equal(await connection({ businessId: "auth-b", attendanceSession: tokens["synthetic-owner"].attendanceHubSession }), true);
  assert.equal(await connection({ businessId: "auth-c", attendanceSession: tokens["synthetic-owner"].attendanceHubSession }), false);
});
test("an idle socket expires without another client packet, and a revoked business cannot send packets", async () => {
  const expiresSoon = createAttendanceHubSession("synthetic-owner", Date.now() - 12 * 3600_000 + 800);
  const socket = io(base, { auth: { businessId: "auth-a", attendanceSession: expiresSoon }, transports: ["websocket"], reconnection: false });
  try {
    await new Promise<void>((resolve, reject) => { socket.once("connect", resolve); socket.once("connect_error", reject); });
    await new Promise<void>((resolve, reject) => { const timer = setTimeout(() => reject(new Error("Idle expired socket stayed connected")), 2500); socket.once("disconnect", () => { clearTimeout(timer); resolve(); }); });
    assert.equal(socket.connected, false);
  } finally { socket.disconnect(); }
  const revoked = io(base, { auth: { businessId: "auth-a", attendanceSession: tokens["synthetic-owner"].attendanceHubSession }, transports: ["websocket"], reconnection: false });
  try {
    await new Promise<void>((resolve, reject) => { revoked.once("connect", resolve); revoked.once("connect_error", reject); });
    await setBusinessAccessForEmployeeCode("synthetic-owner", ["auth-b"]);
    const disconnected = new Promise<void>((resolve, reject) => { const timer = setTimeout(() => reject(new Error("Revoked socket stayed connected")), 2500); revoked.once("disconnect", () => { clearTimeout(timer); resolve(); }); });
    revoked.emit("presence:register"); await disconnected;
  } finally { revoked.disconnect(); await setBusinessAccessForEmployeeCode("synthetic-owner", ["auth-a", "auth-b"]); }
});
