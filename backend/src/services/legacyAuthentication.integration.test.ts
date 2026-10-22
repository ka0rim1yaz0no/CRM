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
const { Lead } = await import("../models/Lead");
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
      await Lead.create({ businessName: `Synthetic ${code}`, assignedAgent: person._id, assignedAgentName: code, status: "Qualified", comments: [{ authorName: code, authorType: "employee", body: "Synthetic scoped dashboard activity", createdAt: new Date() }] });
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

test("employee queues put due scheduled callbacks before NEW leads in each business", async () => {
  const code = "synthetic-new-first";
  await setBusinessAccessForEmployeeCode(code, ["auth-a", "auth-b"]);
  for (const business of ["auth-a", "auth-b"]) await runWithBusiness(business, async () => {
    const employee = await Employee.create({ employeeCode: code, name: code, status: "Active", role: "Sales", businessAccessIds: ["auth-a", "auth-b"] });
    const lead = { assignedAgent: employee._id, assignedAgentName: code, comments: [] };
    const due = await Lead.create({ ...lead, businessName: "Synthetic due schedule", phone: "+12025550121", status: "Follow up", followUpAt: new Date(Date.now() - 60_000) });
    const fresh = await Lead.create({ ...lead, businessName: "Synthetic new lead", phone: "+12025550122", status: "NEW", followUpAt: new Date(Date.now() - 60000) });
    const future = await Lead.create({ ...lead, businessName: "Synthetic future schedule", phone: "+12025550123", status: "Follow up", followUpAt: new Date(Date.now() + 3600000) });
    await Lead.create({ ...lead, businessName: "Synthetic duplicate follow-up", phone: fresh.phone, status: "Follow up" });
    const headers = { "X-CRM-Attendance-Session": createAttendanceHubSession(code)! };
    const path = `/my-leads?employeeId=${employee._id}&tab=my&queue=ALL&limit=1&autoCallEligible=true`;
    for (let refresh = 0; refresh < 2; refresh++) {
      const response = await request(path, "", business, undefined, headers);
      assert.equal(response.status, 200);
      const result = await response.json();
      assert.equal(result.leads[0]._id, String(due._id), "a due scheduled callback outranks an eligible NEW lead");
      assert.equal(result.total, 2, "future scheduled leads remain ineligible");
    }
    const filtered = await request(path.replace("queue=ALL", "queue=Follow%20up"), "", business, undefined, headers);
    assert.equal(filtered.status, 200);
    const filteredLead = (await filtered.json()).leads[0];
    assert.equal(filteredLead.status, "Follow up", "the employee's selected status filter remains authoritative");
    assert.notEqual(filteredLead._id, String(fresh._id));
    await Lead.updateOne({ _id: fresh._id }, { $set: { comments: [{ authorType: "employee", authorName: code, body: "Synthetic completed contact", createdAt: new Date() }] } });
    const next = await request(path, "", business, undefined, headers);
    assert.equal(next.status, 200);
    const remaining = await next.json();
    assert.equal(remaining.leads[0]._id, String(due._id));
    assert.ok(remaining.leads.every((row: { _id: string }) => row._id !== String(future._id)));
  });
});

test("bounded duplicate-phone summaries preserve comment cooldown, formatting and invalid-date blocking", async () => {
  const code = "synthetic-phone-summaries";
  await setBusinessAccessForEmployeeCode(code, ["auth-a", "auth-b"]);
  for (const business of ["auth-a", "auth-b"]) await runWithBusiness(business, async () => {
    const employee = await Employee.create({ employeeCode: code, name: code, status: "Active", role: "Sales" });
    const now = Date.now();
    const cases = [
      { recent: true, allowed: false }, { old: true, allowed: true }, { invalid: true, allowed: false },
      { admin: true, allowed: true }, { due: true, old: true, allowed: true },
      { due: true, recent: true, allowed: false }, { unrelatedPrefix: true, recent: true, allowed: true },
    ];
    const expected: string[] = [];
    for (const [index, scenario] of cases.entries()) {
      const phone = `1202555013${index}`;
      const candidate = await Lead.create({ assignedAgent: employee._id, assignedAgentName: code, phone,
        businessName: `Synthetic phone summary ${index}`, status: scenario.due ? "Follow up" : "NEW",
        ...(scenario.due ? { followUpAt: new Date(now - 60_000) } : {}) });
      const duplicate = await Lead.create({ businessName: `Synthetic phone evidence ${index}`, status: "Qualified",
        phone: scenario.unrelatedPrefix ? `44${phone.slice(1)}` : `+1 (202) 555-013${index}`,
        comments: [{ authorType: scenario.admin ? "admin" : "employee", authorName: "Synthetic actor", body: "Synthetic evidence",
          createdAt: new Date(now - (scenario.old ? 25 * 3600000 : 1000)) }] });
      if (scenario.invalid) await Lead.collection.updateOne({ _id: duplicate._id }, { $set: { "comments.0.createdAt": null } });
      if (scenario.allowed) expected.push(String(candidate._id));
    }
    const path = `/my-leads?employeeId=${employee._id}&tab=my&queue=ALL&limit=50&autoCallEligible=true`;
    const headers = { "X-CRM-Attendance-Session": createAttendanceHubSession(code)! };
    for (let refresh = 0; refresh < 2; refresh++) {
      const response = await request(path, "", business, undefined, headers);
      assert.equal(response.status, 200);
      const result = await response.json();
      assert.deepEqual(result.leads.map((row: { _id: string }) => row._id).sort(), expected.sort());
    }
  });
});

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

test("system settings retain signed access across businesses and classify expiry without changing attendance", async () => {
  const { AttendanceLedger } = await import("../models/AttendanceLedger");
  const { Attendance } = await import("../models/Attendance");
  const fingerprint = async () => JSON.stringify({ ledgers: await AttendanceLedger.find({}).sort({ _id: 1 }).lean(),
    copies: await Promise.all(["auth-a", "auth-b", "auth-c"].map(business => runWithBusiness(business, () => Attendance.find({}).sort({ _id: 1 }).lean()))) });
  const before = await fingerprint();
  for (const business of ["auth-a", "auth-b"]) {
    for (const actor of ["synthetic-full", "synthetic-tracker", "synthetic-owner"]) {
      for (let refresh = 0; refresh < 2; refresh++) assert.equal((await request("/system-settings", actor, business)).status, 200);
    }
    const invalid = await request("/system-settings", "", business, undefined, { "X-CRM-Admin-Session": "expired-synthetic-token" });
    assert.equal(invalid.status, 401); assert.equal((await invalid.json()).code, "CRM_SESSION_REQUIRED");
    const denied = await fetch(base + "/api/system-settings", { method: "PUT", headers: { "Content-Type": "application/json", "X-Business-Id": business,
      "X-CRM-Attendance-Session": tokens["synthetic-owner"].attendanceHubSession! }, body: JSON.stringify({ lateGraceMinutes: 99 }) });
    assert.equal(denied.status, 403, "reading settings never grants employees configuration-write access");
  }
  assert.equal((await request("/system-settings", "synthetic-owner", "auth-c")).status, 403);
  assert.equal(await fingerprint(), before, "settings reads and authentication failures cannot write attendance");
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
test("the real employee dashboard lead endpoints work in both businesses and cannot expose another employee's detailed rows", async () => {
  for (const business of ["auth-a", "auth-b"]) {
    const [own, other] = ids[business];
    const response = await request(`/leads/agent-dashboard?employeeId=${other}`, "synthetic-owner", business);
    assert.equal(response.status, 200); const report = await response.json();
    assert.ok(report.agents.length > 0); assert.ok(report.agents.every((row: { employeeId: string }) => row.employeeId === own));
    assert.ok(report.monthlyAgents.every((row: { employeeId: string }) => row.employeeId === own));
    assert.ok(report.recentActivity.every((row: { employeeId: string }) => row.employeeId === own));
    const adminReport = await (await request("/leads/agent-dashboard", "synthetic-full", business)).json();
    assert.deepEqual(report.agents[0], adminReport.agents.find((row: { employeeId: string }) => row.employeeId === own), "Own calculation stays identical to the unchanged admin calculation");
    const logsResponse = await request("/leads/employee-logs?employee=synthetic-other", "synthetic-owner", business);
    assert.equal(logsResponse.status, 200); const logs = await logsResponse.json();
    assert.ok(logs.length > 0); assert.ok(logs.every((row: { employeeName: string }) => row.employeeName === "synthetic-owner"));
  }
});

test("sales employees can pass only their own selected lead to active sales in the same business", async () => {
  const patch = (business: string, lead: string, agent: string, code = "synthetic-owner") => fetch(`${base}/api/leads/${lead}/assign`, {
    method: "PATCH", headers: { "Content-Type": "application/json", "X-Business-Id": business,
      "X-CRM-Attendance-Session": tokens[code]?.attendanceHubSession || "", "X-CRM-User-Type": "admin" },
    body: JSON.stringify({ assignedAgent: agent, activityActorName: "Forged admin", activityActorType: "admin" }),
  });
  for (const business of ["auth-a", "auth-b"]) {
    const [own, other] = ids[business];
    const leads = await runWithBusiness(business, async () => {
      const ownLead = await Lead.create({ businessName: `Synthetic pass ${business}`, phone: "+12025550110", assignedAgent: own,
        assignedAgentName: "synthetic-owner", status: "NEW", comments: [{ authorName: "synthetic-owner", authorType: "employee", body: "Synthetic handoff" }] });
      const duplicate = await Lead.create({ businessName: `Synthetic other copy ${business}`, phone: "+12025550110", assignedAgent: other,
        assignedAgentName: "synthetic-other", status: "NEW" });
      const archived = await Lead.create({ businessName: `Synthetic archived pass ${business}`, assignedAgent: own, status: "Archived" });
      const inactive = await Employee.create({ employeeCode: `synthetic-inactive-${business}`, name: "Synthetic inactive", status: "Paused", role: "Sales" });
      const nonSales = await Employee.create({ employeeCode: `synthetic-nonsales-${business}`, name: "Synthetic HR", status: "Active", role: "Human Resources" });
      return { own: String(ownLead._id), duplicate: String(duplicate._id), archived: String(archived._id),
        inactive: String(inactive._id), nonSales: String(nonSales._id) };
    });
    assert.equal((await patch(business, leads.duplicate, own)).status, 403, "a spoofed header cannot reassign someone else's lead");
    assert.equal((await patch(business, leads.own, own)).status, 400, "a self-handoff is not a new assignment");
    assert.equal((await patch(business, leads.own, ids[business === "auth-a" ? "auth-b" : "auth-a"][1])).status, 400, "target must exist in the selected business");
    assert.equal((await patch(business, leads.own, leads.inactive)).status, 400, "employee cannot pass to inactive sales");
    assert.equal((await patch(business, leads.own, leads.nonSales)).status, 400, "target must be sales");
    assert.equal((await patch(business, leads.archived, other)).status, 409, "archived leads cannot be passed");
    const response = await patch(business, leads.own, other);
    assert.equal(response.status, 200);
    const updated = await response.json();
    assert.equal(String(updated.assignedAgent._id), other);
    assert.equal(updated.assignedAgentName, "synthetic-other");
    assert.equal(updated.comments.at(-1).body, "Synthetic handoff");
    assert.equal(updated.activity.at(-1).actorType, "employee");
    assert.equal(updated.activity.at(-1).actorName, "synthetic-owner");
    await runWithBusiness(business, async () => {
      const duplicate = await Lead.findById(leads.duplicate).lean();
      assert.equal(String(duplicate!.assignedAgent), other);
      assert.equal(duplicate!.activity.length, 0, "passing a selected lead must not rewrite another employee's duplicate");
      assert.equal(String((await Lead.findById(leads.own).lean())!.assignedAgent), other, "the new assignment survives a fresh read");
    });
    assert.equal((await patch(business, leads.own, own)).status, 403, "the old owner loses write access immediately");
  }
});

test("concurrent employee passes have one winner, preserve history, and do not affect attendance or dashboards", async () => {
  for (const business of ["auth-a", "auth-b"]) {
    const [own, other] = ids[business];
    const lead = await runWithBusiness(business, () => Lead.create({ businessName: `Synthetic race ${business}`,
      assignedAgent: own, assignedAgentName: "synthetic-owner", status: "NEW", comments: [
        { authorName: "synthetic-owner", authorType: "employee", body: "Keep this synthetic comment" },
      ] }));
    const pass = () => fetch(`${base}/api/leads/${lead._id}/assign`, { method: "PATCH", headers: {
      "Content-Type": "application/json", "X-Business-Id": business,
      "X-CRM-Attendance-Session": tokens["synthetic-owner"].attendanceHubSession!,
    }, body: JSON.stringify({ assignedAgent: other }) });
    const responses = await Promise.all([pass(), pass()]);
    assert.equal(responses.filter(response => response.status === 200).length, 1);
    assert.ok(responses.some(response => [403, 409].includes(response.status)));
    await runWithBusiness(business, async () => {
      const saved = await Lead.findById(lead._id).lean();
      assert.equal(String(saved!.assignedAgent), other);
      assert.equal(saved!.activity.filter(item => item.label === "Assigned").length, 1);
      assert.equal(saved!.comments.length, 1);
      assert.equal(saved!.comments[0].body, "Keep this synthetic comment");
      const { Attendance } = await import("../models/Attendance");
      assert.equal(await Attendance.countDocuments(), 0, "lead handoffs never create attendance events");
    });
    for (const route of ["/dashboard-workspace/summary?preset=today", "/call-dashboard"]) {
      assert.equal((await request(route, "synthetic-full", business)).status, 200);
    }
    assert.equal((await request(`/employees/${own}/attendance/session`, "synthetic-owner", business)).status, 200);
  }
});

test("legacy name-owned passes still work, while employee bulk and automatic reassignment remain forbidden", async () => {
  for (const business of ["auth-a", "auth-b"]) {
    const [, other] = ids[business];
    const lead = await runWithBusiness(business, () => Lead.create({ businessName: `Synthetic name-only ${business}`,
      assignedAgent: null, assignedAgentName: "synthetic-owner", status: "NEW" }));
    const headers = { "Content-Type": "application/json", "X-Business-Id": business,
      "X-CRM-Attendance-Session": tokens["synthetic-owner"].attendanceHubSession! };
    const response = await fetch(`${base}/api/leads/${lead._id}/assign`, { method: "PATCH", headers, body: JSON.stringify({ assignedAgent: other }) });
    assert.equal(response.status, 200);
    for (const path of ["/leads/reassign-new", "/leads/bulk/assign", `/leads/${lead._id}/auto-assign`]) {
      assert.equal((await fetch(base + "/api" + path, { method: "PATCH", headers, body: JSON.stringify({ assignedAgent: other }) })).status, 403);
    }
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
