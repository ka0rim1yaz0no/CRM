import http from "node:http";

const allowedOrigins = new Set(["http://localhost:5173", "http://127.0.0.1:5173", "http://127.0.0.1:5174"]);
const admin = { userType: "admin", user: { id: "admin", name: "Fixture Admin", role: "Admin", employeeCode: "90000001" },
  access: "full", sessionToken: "fixture-admin-session" };
const employee = { userType: "employee", user: { _id: "000000000000000000000001", name: "Alex Sample", employeeCode: "90000002",
  role: "Designer", team: "Studio", status: "Active", availabilityStatus: "BREAK" }, attendanceHubSession: "fixture-employee-session" };
const businesses = [{ id: "fixture-a", name: "Sample Studio" }, { id: "fixture-b", name: "Sample Operations" }];
const start = "2026-10-15T15:00:00.000Z";
const end = "2026-10-16T00:00:00.000Z";
const event = (id, source, at) => ({ id, source, at, eventId: id });
const milliseconds = { online: 25_200_000, break: 1_200_000, lunch: 3_600_000, offPhone: 600_000,
  offline: 1_800_000, late: 300_000, underTime: 0, overBreak: 300_000, overLunch: 0, overtime: 0 };
const sourceEvents = [event("e1", "Time In", "2026-10-15T15:05:00.000Z"), event("e2", "Break Out", "2026-10-15T17:00:00.000Z"),
  event("e3", "Break In", "2026-10-15T17:20:00.000Z"), event("e4", "Lunch Break Out", "2026-10-15T19:00:00.000Z"),
  event("e5", "Lunch Break In", "2026-10-15T20:00:00.000Z"), event("e6", "Time Out", "2026-10-16T00:00:00.000Z")];
const rows = [
  { dayKey: "2026-10-15", shiftStart: start, shiftEnd: end, timeIn: sourceEvents[0].at, timeOut: sourceEvents[5].at,
    employeeCode: "90000002", employeeId: "000000000000000000000001", employeeName: "Alex Sample", role: "Designer", team: "Studio",
    businessId: "fixture-a", businessName: "Sample Studio", status: "Present", inProgress: false, excused: false,
    absent: false, mismatch: false, issues: ["LATE", "OVER BREAK"], review: [], note: "", leave: null, graceMinutes: 0,
    noteRevisions: [], audit: [], milliseconds, events: sourceEvents, businesses: [] },
  { dayKey: "2026-10-15", shiftStart: start, shiftEnd: end, timeIn: sourceEvents[0].at, timeOut: sourceEvents[5].at,
    employeeCode: "90000003", employeeId: "000000000000000000000002", employeeName: "Blair Sample", role: "Sales", team: "Outreach",
    businessId: "fixture-a", businessName: "Sample Studio", status: "Needs review", inProgress: false, excused: false,
    absent: false, mismatch: true, issues: ["OPEN SESSION"], review: ["Business mismatch"], note: "Check mirrored events", leave: null,
    graceMinutes: 0, noteRevisions: [], audit: [], milliseconds: { ...milliseconds, online: 9_000_000, late: 0, overBreak: 0 },
    events: sourceEvents.slice(0, 2), businesses: [] },
];
for (const row of rows) row.businesses = [{ businessId: row.businessId, businessName: row.businessName, status: row.status,
  issues: row.issues, milliseconds: row.milliseconds, events: row.events, mismatch: row.mismatch }];

function json(response, status, value) {
  response.writeHead(status, { "Content-Type": "application/json",
    "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "GET,POST,OPTIONS", "Cache-Control": "no-store" });
  response.end(JSON.stringify(value));
}
const server = http.createServer(async (request, response) => {
  const requestOrigin = request.headers.origin;
  if (requestOrigin && !allowedOrigins.has(requestOrigin)) { json(response, 403, { message: "Local preview origin required." }); return; }
  if (requestOrigin) response.setHeader("Access-Control-Allow-Origin", requestOrigin);
  if (request.method === "OPTIONS") { json(response, 200, {}); return; }
  const url = new URL(request.url || "/", "http://127.0.0.1:4100");
  let body = {};
  if (request.method === "POST") {
    let text = "";
    for await (const chunk of request) text += chunk;
    try { body = JSON.parse(text); } catch { body = {}; }
  }
  if (url.pathname === "/api/businesses") { json(response, 200, businesses); return; }
  if (url.pathname === "/api/auth/login") {
    if (!["90000001", "90000002"].includes(body.employeeCode)) {
      json(response, 401, { message: "Use a local fixture account." }); return;
    }
    const identity = body.employeeCode === "90000001" ? admin : employee;
    json(response, 200, { ...identity, business: businesses[0], allowedBusinesses: businesses }); return;
  }
  if (url.pathname === "/api/auth/switch-business") {
    json(response, 200, { ...employee, business: businesses.find((item) => item.id === body.targetBusinessId) || businesses[0], allowedBusinesses: businesses }); return;
  }
  if (url.pathname === "/api/auth/logout" && request.method === "POST") { json(response, 200, { success: true }); return; }
  if (request.method !== "GET") { json(response, 405, { message: "Visual preview only. Changes are not saved." }); return; }
  if (url.pathname === "/api/auth/businesses") { json(response, 200, businesses); return; }
  if (url.pathname === "/api/features") { json(response, 200, []); return; }
  if (url.pathname === "/api/system-settings") {
    json(response, 200, { officialShiftStartTime: "23:00", officialShiftEndTime: "08:00", attendanceTimeZone: "Asia/Manila", lateGraceMinutes: 0 }); return;
  }
  if (url.pathname.startsWith("/api/employees/") && url.pathname.endsWith("/attendance")) { json(response, 200, []); return; }
  if (url.pathname.startsWith("/api/employees/") && url.pathname.endsWith("/notices")) { json(response, 200, []); return; }
  if (url.pathname.startsWith("/api/employees/")) { json(response, 200, employee.user); return; }
  if (url.pathname === "/api/attendance-hub/live") {
    json(response, 200, { status: "BREAK", since: new Date(Date.now() - 8 * 60_000).toISOString(), serverTime: new Date().toISOString(),
      day: rows[0], shiftStart: start, shiftEnd: end, thresholds: { breakMinutes: 15, lunchMinutes: 60, graceMinutes: 0, timezone: "Asia/Manila" } }); return;
  }
  if (url.pathname === "/api/attendance-hub/days") {
    const issue = url.searchParams.get("issue");
    const adminRequest = request.headers["x-crm-user-type"] === "admin";
    const base = adminRequest ? rows : rows.filter((row) => row.employeeCode === "90000002");
    const selected = base.filter((row) => !issue || issue === "worked" || issue === "online" || issue === "late" && row.milliseconds.late ||
      issue === "over-break" && row.milliseconds.overBreak || issue === "needs-review" && row.review.length || issue === "mismatch" && row.mismatch);
    const summary = { daysWorked: base.length, employeesPresent: base.length, online: 25_200_000, break: 1_200_000,
      lunch: 3_600_000, offPhone: 600_000, lateCount: 1, late: 300_000, overBreakCount: 1, overBreak: 300_000,
      overLunchCount: 0, overLunch: 0, underTimeCount: 0, underTime: 0, overtime: 0, absent: 0,
      needsReview: adminRequest ? 1 : 0, onTimeRate: 50 };
    json(response, 200, { rows: selected, total: selected.length, page: 1, pageSize: 25,
      range: { from: "2026-10-15", to: "2026-10-16" }, summary, businesses, facets: { teams: ["Outreach", "Studio"], roles: ["Designer", "Sales"] },
      reviewQueue: adminRequest ? [{ dayKey: "2026-10-15", employeeCode: "90000003", employeeName: "Blair Sample", reason: "Business mismatch" }] : [],
      trend: [{ dayKey: "2026-10-15", online: 25_200_000, late: 300_000, break: 1_200_000, lunch: 3_600_000, people: 1 }],
      serverTime: new Date().toISOString(), thresholds: { breakMinutes: 15, lunchMinutes: 60, timezone: "Asia/Manila" } }); return;
  }
  if (url.pathname.startsWith("/api/attendance-hub/day/")) {
    if (request.method === "POST") { json(response, 405, { message: "Visual preview only. Attendance changes are not saved." }); return; }
    const row = rows.find((item) => item.employeeCode === url.searchParams.get("employeeCode")) || rows[0];
    json(response, 200, { day: row, serverTime: new Date().toISOString() }); return;
  }
  if (url.pathname === "/api/attendance-hub/export") {
    response.writeHead(200, { "Content-Type": "text/csv" }); response.end("Employee,Shift day\nAlex Sample,2026-10-15\n"); return;
  }
  json(response, 200, []);
});
server.listen(4100, "127.0.0.1", () => process.stdout.write("Fake attendance API on http://127.0.0.1:4100\n"));
