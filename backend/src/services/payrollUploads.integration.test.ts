import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import crypto from "node:crypto";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import mongoose from "mongoose";
import { MongoMemoryReplSet } from "mongodb-memory-server";

const prefix = `pay_upload_test_${crypto.randomUUID().replaceAll("-", "")}`;
const uploadDirectory = await mkdtemp(path.join(os.tmpdir(), "assistly-upload-test-"));
process.env.CRM_UPLOAD_ROOT = uploadDirectory;
process.env.NODE_ENV = "test";
process.env.BUSINESS_DATABASES = JSON.stringify(["a", "b"].map((id) => ({ id: `test-${id}`, name: `Synthetic ${id}`, databaseName: `${prefix}_${id}` })));
process.env.DEFAULT_BUSINESS_ID = "test-a";
process.env.DEFAULT_BUSINESS_DATABASE = `${prefix}_a`;
process.env.CONTROL_DATABASE_NAME = `${prefix}_control`;
process.env.CRM_ADMIN_ONE_CODE = "90000001";
process.env.CRM_ADMIN_SESSION_SECRET = crypto.randomBytes(48).toString("hex");
process.env.CRM_ATTENDANCE_INTEGRITY = "true";
process.env.CRM_ATTENDANCE_RECOVERY_CUTOFF = "false";
const { createApp } = await import("../app");
const { createAdminDashboardSession } = await import("../config/adminDashboardSession");
const { runWithBusiness } = await import("../config/tenancy");
const { Employee } = await import("../models/Employee");
const { Attendance } = await import("../models/Attendance");
const { PayrollRecord } = await import("../models/Payroll");
const { setBusinessAccessForEmployeeCode } = await import("../models/BusinessUserAccess");
let mongo: MongoMemoryReplSet;
let server: http.Server;
let base = "";
let token = "";
const employees: Record<string, string> = {};
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jMNsAAAAASUVORK5CYII=";
before(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri(prefix));
  await writeFile(path.join(uploadDirectory, "empty-database-before-seed.json"), JSON.stringify({ database: prefix, collections: [] }));
  for (const business of ["test-a", "test-b"]) await runWithBusiness(business, async () => {
    const employee = await Employee.create({ name: "Synthetic Payroll Employee", employeeCode: "90000002", role: "Designer", team: "Studio", salary: 30_000, dateHired: "2026-10-01", businessAccessIds: ["test-a", "test-b"] });
    employees[business] = String(employee._id);
    await Attendance.create([{ employee: employee._id, source: "Time In", timeIn: new Date("2026-10-15T15:00:00Z") }, { employee: employee._id, source: "Time Out", timeIn: new Date("2026-10-16T00:00:00Z") }]);
  });
  await setBusinessAccessForEmployeeCode("90000002", ["test-a", "test-b"]);
  token = createAdminDashboardSession("90000001")!;
  server = http.createServer(createApp());
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`;
});
after(async () => {
  await new Promise<void>((resolve) => server?.close(() => resolve()));
  await mongoose.disconnect(); await mongo?.stop();
  assert.equal(path.dirname(uploadDirectory), path.resolve(os.tmpdir()));
  assert.ok(path.basename(uploadDirectory).startsWith("assistly-upload-test-"));
  await rm(uploadDirectory, { recursive: true, force: true });
});
async function request(url: string, method = "GET", body?: unknown, business = "test-a", actor = "admin") {
  return fetch(`${base}${url}`, { method, headers: { "Content-Type": "application/json", "X-Business-Id": business,
    "X-CRM-User-Type": actor, "X-CRM-User-Code": actor === "admin" ? "90000001" : "90000002",
    ...(actor === "admin" ? { "X-CRM-Admin-Session": token } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
async function json(url: string, method = "GET", body?: unknown, business = "test-a") {
  const response = await request(url, method, body, business);
  assert.ok(response.ok, `${method} ${url}: ${response.status} ${await response.clone().text()}`);
  return response.json();
}

test("real API: local origins accept signed headers and payroll rejects employee/forged admin access", async () => {
  const preflight = await fetch(`${base}/payroll/records`, { method: "OPTIONS", headers: { Origin: "http://localhost:5174", "Access-Control-Request-Method": "GET", "Access-Control-Request-Headers": "x-crm-admin-session,x-crm-attendance-session" } });
  const allowed = preflight.headers.get("Access-Control-Allow-Headers")?.toLowerCase() || "";
  assert.ok(allowed.includes("x-crm-admin-session")); assert.ok(allowed.includes("x-crm-attendance-session"));
  assert.equal((await request("/payroll/records", "GET", undefined, "test-a", "employee")).status, 403);
  const forged = await fetch(`${base}/payroll/run`, { method: "POST", headers: { "Content-Type": "application/json", "X-Business-Id": "test-a", "X-CRM-User-Type": "admin", "X-CRM-User-Code": "90000001" }, body: "{}" });
  assert.equal(forged.status, 403);
});

test("real API: payroll controls recalculate minutes, basic pay, overtime and paid status across assigned businesses", async () => {
  const payPeriod = "Oct 6, 2026 - Oct 20, 2026";
  const records = await json(`/payroll/records?payPeriod=${encodeURIComponent(payPeriod)}`);
  const first = records.find((record: { employeeId: string }) => record.employeeId === "90000002");
  assert.ok(first);
  await json(`/payroll/records?payPeriod=${encodeURIComponent(payPeriod)}`, "GET", undefined, "test-b");
  const minutes = Math.max(0, Math.round(first.scheduledHours * 60) - 60);
  const adjusted = await json(`/payroll/records/${first._id}/worked-minutes`, "PATCH", { workedMinutes: minutes });
  assert.equal(adjusted.workedHours, minutes / 60);
  assert.equal(adjusted.netPay, Math.max(0, adjusted.grossPay - adjusted.deductions));
  for (const business of ["test-a", "test-b"]) await runWithBusiness(business, async () => {
    const saved = await PayrollRecord.findOne({ employeeId: "90000002", payPeriod }).lean();
    assert.equal(saved?.workedMinutesOverride, minutes); assert.equal(saved?.netPay, adjusted.netPay);
  });
  assert.equal((await request(`/payroll/records/${first._id}/worked-minutes`, "PATCH", { workedMinutes: -1 })).status, 400);
  const overtime = await json(`/payroll/records/${first._id}/overtime`, "PATCH", { overtimeHours: 1 });
  assert.ok(overtime.grossPay > adjusted.grossPay); assert.equal(overtime.overtimeApproved, true);
  const cleared = await json(`/payroll/records/${first._id}/overtime`, "PATCH", { overtimeHours: 0 });
  assert.equal(cleared.grossPay, adjusted.grossPay);
  await json("/payroll/employees/90000002/basic-pay", "PATCH", { basicPay: 32_000 });
  for (const business of ["test-a", "test-b"]) await runWithBusiness(business, async () => assert.equal((await Employee.findOne({ employeeCode: "90000002" }).lean())?.salary, 32_000));
  const dtr = await json(`/payroll/dtr/${employees["test-a"]}?payPeriod=${encodeURIComponent(payPeriod)}`);
  assert.equal(dtr.employee.employeeCode, "90000002");
  for (const status of ["paid", "unpaid"]) {
    await json(`/payroll/records/${first._id}/${status}`, "PATCH");
    for (const business of ["test-a", "test-b"]) await runWithBusiness(business, async () => assert.equal((await PayrollRecord.findOne({ employeeId: "90000002", payPeriod }).lean())?.status, status === "paid" ? "Paid" : "Pending"));
  }
  const item = await json("/payroll/items", "POST", { category: "Deductions", name: "Synthetic benefit", second: "10", third: "Fixed" });
  assert.equal((await json(`/payroll/items/${item._id}/archive`, "PATCH")).isArchived, true);
  assert.equal((await json(`/payroll/items/${item._id}/restore`, "PATCH")).isArchived, false);
  assert.equal((await json(`/payroll/records/${first._id}/archive`, "PATCH")).isArchived, true);
  assert.equal((await json(`/payroll/records/${first._id}/restore`, "PATCH")).isArchived, false);
  const run = await json("/payroll/run", "POST", { payPeriod });
  assert.ok(Array.isArray(run.records));
});

test("real API: simultaneous payroll requests create only one record per employee and cutoff", async () => {
  const payPeriod = "Nov 6, 2026 - Nov 20, 2026";
  await Promise.all(Array.from({ length: 8 }, () => json(`/payroll/records?payPeriod=${encodeURIComponent(payPeriod)}`)));
  await runWithBusiness("test-a", async () => {
    assert.equal(await PayrollRecord.countDocuments({ employeeId: "90000002", payPeriod }), 1,
      "parallel first-use reads must not insert duplicate rows, including hidden archived duplicates");
  });
});

test("real API: media, message attachment and profile uploads work with fake files and preserve business scope", async () => {
  const asset = await json("/media", "POST", { dataUrl: `data:image/png;base64,${png}`, fileName: "synthetic.png", role: "Designer" });
  assert.equal((await request(asset.url.replace(/^\/api/, ""))).status, 200);
  assert.equal((await json("/media", "GET", undefined, "test-b")).length, 0);
  assert.equal((await request(asset.url.replace(/^\/api/, ""), "GET", undefined, "test-b")).status, 404,
    "a file on disk must not bypass the selected business's media records");
  const assetB = await json("/media", "POST", { dataUrl: `data:image/png;base64,${png}`, fileName: "synthetic-b.png", role: "Designer" }, "test-b");
  assert.equal((await fetch(`${base}${assetB.url.replace(/^\/api/, "")}?businessId=test-b`)).status, 200,
    "image elements cannot set business headers, so their URLs must carry the selected business");
  assert.equal((await request("/media", "POST", { dataUrl: "data:image/png;base64,====", fileName: "bad.png", role: "Designer" })).status, 400);
  assert.equal((await request("/media", "POST", { dataUrl: `data:image/png;base64,${png}`, fileName: "bad-role.png", role: "Unknown" })).status, 400);
  const conversation = await json("/messages/conversations/direct", "POST", { participants: [employees["test-a"]], includeAdmin: true });
  const attachment = await json(`/messages/conversations/${conversation._id}/attachments`, "POST", { dataUrl: `data:image/png;base64,${png}`, fileName: "synthetic-payslip.png" });
  await json(`/messages/conversations/${conversation._id}/messages`, "POST", { body: "Synthetic payslip attachment", attachments: [attachment] });
  const downloaded = await request(attachment.url.replace(/^\/api/, ""));
  assert.equal(downloaded.status, 200); assert.equal(Buffer.from(await downloaded.arrayBuffer()).toString("base64"), png);
  // Message replication is asynchronous; assert its result, not the HTTP response timing.
  const deadline = Date.now() + 5000;
  let mirrored = await json("/messages/conversations", "GET", undefined, "test-b");
  let messages = mirrored.length ? await json(`/messages/conversations/${mirrored[0]._id}/messages`, "GET", undefined, "test-b") : [];
  while ((!mirrored.length || !messages.some((message: { attachments?: Array<{ url: string }> }) => message.attachments?.some((item) => item.url === attachment.url))) && Date.now() < deadline) {
    await delay(50);
    mirrored = await json("/messages/conversations", "GET", undefined, "test-b");
    messages = mirrored.length ? await json(`/messages/conversations/${mirrored[0]._id}/messages`, "GET", undefined, "test-b") : [];
  }
  assert.equal(mirrored.length, 1);
  assert.equal(messages[0].attachments[0].url, attachment.url);
  assert.equal((await request(attachment.url.replace(/^\/api/, ""), "GET", undefined, "test-b", "employee")).status, 200);
  assert.equal((await request(`/messages/conversations/${conversation._id}/attachments`, "POST", { dataUrl: "data:text/html;base64,SGVsbG8=", fileName: "bad.html" })).status, 400);
  await json(`/employees/${employees["test-a"]}/profile`, "PATCH", { profileImage: `data:image/png;base64,${png}` });
  for (const business of ["test-a", "test-b"]) await runWithBusiness(business, async () => assert.equal((await Employee.findOne({ employeeCode: "90000002" }).lean())?.profileImage, `data:image/png;base64,${png}`));
});
