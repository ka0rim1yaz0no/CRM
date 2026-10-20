import crypto from "node:crypto";
import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import mongoose from "mongoose";
import { MongoMemoryReplSet } from "mongodb-memory-server";

process.env.NODE_ENV = "development";
process.env.CRM_UPLOAD_ROOT = await fs.mkdtemp(path.join(os.tmpdir(), "assistly-fixture-uploads-"));
const suffix = crypto.randomUUID().replaceAll("-", "");
const database = `crm_attendance_dev_${suffix}`;
process.env.DEFAULT_BUSINESS_ID = "fixture-a";
process.env.DEFAULT_BUSINESS_DATABASE = `${database}_a`;
process.env.CONTROL_DATABASE_NAME = `${database}_control`;
process.env.BUSINESS_DATABASES = JSON.stringify([{ id: "fixture-a", name: "Sample Studio", databaseName: `${database}_a` },
  { id: "fixture-b", name: "Sample Operations", databaseName: `${database}_b` }]);
process.env.CRM_ADMIN_ONE_CODE = "90000001";
process.env.CRM_ADMIN_TWO_CODE = "";
process.env.CRM_ADMIN_THREE_CODE = "";
process.env.CRM_ADMIN_SESSION_SECRET = crypto.randomBytes(48).toString("hex");
// This launcher always creates a fresh disposable database, never a persistent vault.
process.env.CRM_CREDENTIAL_KEY = crypto.randomBytes(48).toString("base64");
process.env.CRM_ATTENDANCE_INTEGRITY = "true";
process.env.CRM_ATTENDANCE_ACTIVE_SESSION = "true";
process.env.CRM_ATTENDANCE_HUB = "true";
process.env.CRM_ATTENDANCE_RECOVERY_CUTOFF = "false";
process.env.CLIENT_ORIGIN = "http://localhost:5173,http://127.0.0.1:5173,http://127.0.0.1:5174";
const mongo = await MongoMemoryReplSet.create({ binary: { downloadDir: path.resolve(process.cwd(), "node_modules/.cache/mongodb-memory-server") }, replSet: { count: 1 }, instanceOpts: [{ port: 27099 }] });
await mongoose.connect(mongo.getUri(database));
const output = path.resolve(process.cwd(), "../outputs");
await fs.mkdir(output, { recursive: true });
// This fresh isolated database is empty; record its backup before seeding it.
await fs.writeFile(path.join(output, `attendance-dev-backup-${suffix}.json`), JSON.stringify({ database, createdAt: new Date().toISOString(), collections: [] }, null, 2));
const { Employee } = await import("./models/Employee");
const { setBusinessAccessForEmployeeCode } = await import("./models/BusinessUserAccess");
const { runWithBusiness } = await import("./config/tenancy");
const { executeAttendanceCommand, resolveAttendanceIdentity } = await import("./services/attendanceLedgerService");
const { deliverAttendanceLedger } = await import("./services/attendanceLedgerOutbox");
const { AttendancePolicy } = await import("./models/AttendanceLedger");
const { Lead } = await import("./models/Lead");
const { LeadCallStat } = await import("./models/leadCallStat");
const { Notice } = await import("./models/Notice");
const { LeaveRequest } = await import("./models/LeaveRequest");
for (const businessId of ["fixture-a", "fixture-b"]) {
  await runWithBusiness(businessId, async () => {
    await Employee.create([{ name: "Alex Sample", employeeCode: "90000002", role: "Designer", team: "Studio", dateHired: "2024-07-19", salary: 30000,
      personalEmail: "alex@example.invalid", personalPhone: "+12025550123", personalAddress: "Synthetic test address", emergencyContact: "Sample Emergency Contact", emergencyContactNumber: "+12025550124", contactRelationship: "Friend", personalNotes: "Synthetic fixture only", bankName: "Test Bank", bankAccountName: "Alex Sample", bankAccountNumber: "000000001234",
      businessAccessIds: ["fixture-a", "fixture-b"] }, { name: "Blair Sample", employeeCode: "90000003", role: "Sales", team: "Outreach", dateHired: "2026-10-10", salary: 25000,
      businessAccessIds: ["fixture-a", "fixture-b"] }]);
    const sales = await Employee.findOne({ employeeCode: "90000003" }).lean();
    for (const code of ["90000002", "90000003"]) {
      const person = await Employee.findOne({ employeeCode: code }).lean();
      await Notice.create([{ employee: person!._id, title: "Synthetic shift briefing", message: "Test notice for acknowledge, read and reply checks.", severity: "Info", issuedBy: "Sample Admin" },
        { employee: person!._id, title: "Synthetic reminder", message: "This warning is fake test data.", severity: "Warning", issuedBy: "Sample Admin", isRead: true }]);
      await LeaveRequest.create({ employee: person!._id, leaveType: "Personal", startDate: new Date("2026-11-02T00:00:00+08:00"), endDate: new Date("2026-11-02T00:00:00+08:00"), selectedDates: [new Date("2026-11-02T00:00:00+08:00")], reason: "Synthetic leave request", status: "Pending", comments: [{ authorType: "Admin", authorName: "Sample Admin", message: "Synthetic thread message" }] });
    }
    const leads = await Lead.create([
      { businessName: "Synthetic Office North", leadName: "Sample Contact A", status: "NEW", createdAt: new Date("2026-10-13T10:00:00Z") },
      { businessName: "Synthetic Office South", leadName: "Sample Contact B", status: "Follow up", assignedAgent: sales!._id, followUpAt: new Date("2026-10-15T16:00:00Z") },
      { businessName: "Synthetic Workshop", leadName: "Sample Contact C", status: "Qualified", assignedAgent: sales!._id,
        activity: [{ label: "Status changed", detail: "Synthetic qualification", status: "Qualified", actorName: "Blair Sample", actorType: "employee", createdAt: new Date("2026-10-15T17:00:00Z") }] },
    ]);
    await LeadCallStat.create({ lead: leads[1]._id, businessName: leads[1].businessName, leadName: leads[1].leadName, callCount: 2,
      callLogs: [{ employee: sales!._id, employeeName: "Blair Sample", employeeRole: "Sales", employeeTeam: "Outreach", outcome: "connected", calledAt: new Date("2026-10-15T16:00:00Z"), durationSeconds: 90 },
        { employee: sales!._id, employeeName: "Blair Sample", employeeRole: "Sales", employeeTeam: "Outreach", outcome: "connected", calledAt: new Date("2026-10-15T20:00:00Z"), durationSeconds: 120 }] });
  });
}
for (const code of ["90000002", "90000003"]) await setBusinessAccessForEmployeeCode(code, ["fixture-a", "fixture-b"]);
await AttendancePolicy.create({ _id: "global-attendance", graceMinutes: 0, breakMinutes: 15, lunchMinutes: 60,
  shiftStart: "23:00", shiftEnd: "08:00", recoveryEnabled: false, recoveryTime: "22:59", revision: 1 });
await runWithBusiness("fixture-a", async () => {
  const employee = await Employee.findOne({ employeeCode: "90000002" }).lean();
  const actor = { role: "admin" as const, code: "90000001" };
  const identity = await resolveAttendanceIdentity(String(employee!._id), actor);
  const fixture = [["Time In", "2026-10-15T14:53:00Z"], ["Break Out", "2026-10-15T17:03:00Z"],
    ["Break In", "2026-10-15T17:16:00Z"], ["Lunch Break Out", "2026-10-15T19:02:00Z"],
    ["Lunch Break In", "2026-10-15T20:01:00Z"], ["Break Out", "2026-10-15T22:01:00Z"], ["Break In", "2026-10-15T22:15:00Z"]] as const;
  await executeAttendanceCommand(identity, { commandId: crypto.randomUUID(), expectedRevision: 0, operation: "correct", reason: "Seeded synthetic overnight fixture",
    changes: fixture.map(([source, at]) => ({ source, at })) }, actor);
  await deliverAttendanceLedger(identity.key);
});
if (process.argv.includes("--history-review-demo")) {
  const { AttendanceLedger } = await import("./models/AttendanceLedger");
  await runWithBusiness("fixture-a", async () => {
    const employee = await Employee.findOne({ employeeCode: "90000002" }).select("_id").lean();
    const identity = await resolveAttendanceIdentity(String(employee!._id), { role: "admin", code: "90000001" });
    const ledger = await AttendanceLedger.findById(identity.key).lean();
    const orphan = { id: crypto.randomUUID(), commandId: "synthetic-history-review", source: "Break In", at: "2026-10-12T17:00:00.000Z",
      recordedAt: "2026-10-12T17:00:00.000Z", sequence: 0, legacyReviewed: true };
    const events = [orphan, ...ledger!.events.map((event, index) => ({ ...event, sequence: index + 1, legacyReviewed: true,
      ...(index === 0 ? { legacyBoundary: true } : {}) }))];
    await AttendanceLedger.updateOne({ _id: identity.key }, { $set: { events,
      jobs: identity.businessIds.map((businessId) => ({ businessId, revision: ledger!.revision, done: false })) } });
    await deliverAttendanceLedger(identity.key);
  });
}
const { createApp } = await import("./app");
const { createSocketServer } = await import("./socket");
const { startAttendanceIntegrityWorker } = await import("./services/attendanceRecoveryWorker");
const app = createApp();
const requestCounts = new Map<string, number>();
const measurementStartedAt = Date.now();
const server = http.createServer((request, response) => {
  const pathname = new URL(request.url || "/", "http://127.0.0.1").pathname;
  // Fixture-only aggregate instrumentation: never retain identities, query values or bodies.
  if (pathname === "/__local/request-counts") {
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ elapsedMs: Date.now() - measurementStartedAt, counts: Object.fromEntries(requestCounts) }));
    return;
  }
  if (pathname.startsWith("/api/")) {
    let source = "other";
    try { source = new URL(String(request.headers.referer || "")).port; } catch { /* Non-browser test request. */ }
    const category = pathname.includes("call-dashboard") ? "call-panel" : pathname.includes("dashboard-workspace") ? "workspace" :
      pathname.includes("agent-dashboard") ? "legacy-dashboard" : pathname.includes("call-summary") ? "call-summary" :
      pathname.includes("attendance") ? "attendance" : pathname.includes("/employees") ? "employees" : "shell-other";
    const key = `${source}:${category}`;
    requestCounts.set(key, (requestCounts.get(key) || 0) + 1);
  }
  app(request, response);
});
createSocketServer(server);
startAttendanceIntegrityWorker();
const port = Number(process.env.CRM_LOCAL_PORT || 4101);
server.listen(port, "127.0.0.1", () => process.stdout.write(`Isolated attendance backend ready on http://127.0.0.1:${port}. Synthetic admin 90000001; employees 90000002 and 90000003.\n`));
async function stop() { server.close(); await mongoose.disconnect(); await mongo.stop(); process.exit(0); }
process.on("SIGINT", () => { void stop(); });
process.on("SIGTERM", () => { void stop(); });
