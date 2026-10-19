import type { Request, Response } from "express";
import { Types } from "mongoose";
import { verifyAdminDashboardSession } from "../config/adminDashboardSession";
import { dashboardWorkspaceEnabled } from "../config/rolloutFlags";
import { DashboardWorkspace, DashboardHandover } from "../models/DashboardWorkspace";
import { Lead } from "../models/Lead";
import { LeadCallStat } from "../models/leadCallStat";
import { Employee } from "../models/Employee";
import { getCallBridgeDeviceModel } from "../models/CallBridge";
import { AttendanceLedger } from "../models/AttendanceLedger";
import { projectAttendance } from "../services/attendanceSessionState";
import { attendancePolicy } from "../services/attendanceLedgerService";
import { dashboardRange, leadOverdueHours, changedSentences, metricDelta, activityTrend } from "../services/dashboardWorkspaceMath";
import { hubShiftBounds } from "../services/attendanceHubMath";
import { attendanceSlotKey, zonedParts } from "../services/attendanceShift";
import { withDashboardReadWindow } from "../services/dashboardReadWindow";
import { readAgentLeadDashboard } from "./leadController";
import { readDashboardAttendanceSummary } from "./attendanceHubController";

function authorize(req: Request, res: Response) {
  if (!dashboardWorkspaceEnabled()) { res.status(404).json({ message: "Dashboard upgrade is disabled." }); return null; }
  const actor = verifyAdminDashboardSession(req.header("x-crm-admin-session"));
  if (!actor) res.status(403).json({ message: "A verified administrator session is required." });
  return actor;
}
// Reuse existing read handlers without changing their public contracts or calculations.
async function read<T>(handler: (req: Request, res: Response) => Promise<unknown>, req: Request, query: Record<string, unknown>, window?: Parameters<typeof withDashboardReadWindow>[1]): Promise<T> {
  const scoped = Object.create(req) as Request;
  Object.defineProperty(scoped, "query", { value: query });
  let result: unknown;
  let status = 200;
  const sink = { set() { return sink; }, status(value: number) { status = value; return sink; }, json(value: unknown) { result = value; return sink; } };
  const action = () => handler(scoped, sink as unknown as Response);
  if (window) await withDashboardReadWindow(scoped, window, action); else await action();
  if (status >= 400) throw new Error("Dashboard source is temporarily unavailable.");
  return result as T;
}
type DashboardData = { summary: Record<string, number>; agents: Array<{ employeeId: string; employeeCode: string; employeeName: string; team: string; [key: string]: unknown }>; monthlyAgents: Array<Record<string, unknown>>; recentActivity: unknown[]; [key: string]: unknown };
const defaults = { revision: 0, targets: [], newLeadHours: 24, followUpHours: 0 };
export async function dashboardWorkspaceSummary(req: Request, res: Response) {
  const actor = authorize(req, res); if (!actor) return;
  try {
    const now = new Date();
    const range = dashboardRange(req.query, now);
    const business = String(req.business?.id || "");
    const shiftSettings = { officialShiftStartTime: "23:00", officialShiftEndTime: "08:00", lateGraceMinutes: 0, attendanceTimeZone: "Asia/Manila" };
    const fromTime = hubShiftBounds(range.from, shiftSettings).start;
    const toTime = hubShiftBounds(range.to, shiftSettings).end;
    const activityEvents: Array<{ employeeId: string; leadId: string; at: Date | string; comment: boolean }> = [];
    const query = (from: string, to: string) => ({ month: from.slice(0, 7), dateFrom: from, dateTo: to, callDate: to });
    const [dashboard, config, notes, leads, calls, devices, ledgers, policy] = await Promise.all([
      read<DashboardData>(readAgentLeadDashboard, req, query(range.from, range.to), { start: fromTime, end: toTime, dateFrom: range.from, dateTo: range.to,
        recordActivity: (employeeId, leadId, at, comment) => activityEvents.push({ employeeId, leadId, at, comment }) }),
      DashboardWorkspace.findOne({ key: "workspace" }).lean(), DashboardHandover.find({ deletedAt: null }).sort({ pinned: -1, createdAt: -1 }).limit(10).lean(),
      Lead.find({}).select("leadName businessName status assignedAgent followUpAt createdAt comments.authorType comments.createdAt activity.actorType activity.createdAt").lean(),
      LeadCallStat.aggregate<{ calledAt: Date; employee: string; seconds: number }>([
        { $match: { "callLogs.calledAt": { $gte: fromTime, $lte: toTime } } },
        { $unwind: "$callLogs" }, { $match: { "callLogs.calledAt": { $gte: fromTime, $lte: toTime } } },
        { $project: { _id: 0, calledAt: "$callLogs.calledAt", employee: { $toString: "$callLogs.employee" }, seconds: "$callLogs.durationSeconds" } } ]),
      getCallBridgeDeviceModel().find({}).select("employeeCode lastSeenAt").lean(), AttendanceLedger.find({ businessIds: business }).lean(), attendancePolicy(),
    ]);
    const attendance = { summary: await readDashboardAttendanceSummary(business, range.from, range.to, actor.employeeCode, now) };
    const settings = config || defaults;
    const agentIds = new Set(dashboard.agents.map((agent) => agent.employeeId));
    const trend = activityTrend(activityEvents.filter((event) => agentIds.has(event.employeeId)).map((event) => ({ _id: event.leadId,
      activity: event.comment ? [] : [{ actorType: "employee", createdAt: event.at }], comments: event.comment ? [{ authorType: "employee", createdAt: event.at }] : [] })), range.previousFrom, range.to);
    const currentTrend = trend.filter((row) => row.day >= range.from);
    const previousTrend = trend.filter((row) => row.day < range.from);
    const previous = { summary: { activityToday: previousTrend.reduce((sum, row) => sum + row.count, 0) } };
    const callBuckets = new Map<string, { _id: { day: string; hour: number; employee: string }; count: number; seconds: number }>();
    for (const call of calls) {
      const at = new Date(call.calledAt); const day = attendanceSlotKey(at, "Asia/Manila", policy.shiftStart, policy.shiftEnd); const hour = zonedParts(at).hour;
      const key = `${day}:${hour}:${call.employee}`;
      const row = callBuckets.get(key) || { _id: { day, hour, employee: call.employee }, count: 0, seconds: 0 };
      row.count++; row.seconds += Math.max(0, call.seconds || 0); callBuckets.set(key, row);
    }
    const overdue = leads.filter((lead) => !["Archived", "Dead", "Completed"].includes(lead.status)).map((lead) => ({ id: String(lead._id), name: lead.businessName || lead.leadName, employeeId: String(lead.assignedAgent || ""), hours: leadOverdueHours(lead, now, settings.newLeadHours, settings.followUpHours) }))
      .filter((lead) => lead.hours > 0).sort((a, b) => b.hours - a.hours);
    const open = new Set(ledgers.filter((ledger) => projectAttendance(ledger.events, ledger.corrections, ledger.closures).active).map((ledger) => ledger.employeeCode)).size;
    const codes = new Set(dashboard.agents.map((agent) => agent.employeeCode));
    const bridgeStale = [...codes].filter((code) => !devices.some((device) => device.employeeCode === code && now.getTime() - new Date(device.lastSeenAt).getTime() < 45_000)).length;
    const over = Number(attendance.summary.overBreakCount || 0) + Number(attendance.summary.overLunchCount || 0);
    const attention = [
      { key: "follow-up", label: "Due follow-ups", count: dashboard.summary.dueFollowUps, href: "/admin/leads?scope=Follow%20up", severity: "warning" },
      { key: "unassigned", label: "Unassigned leads", count: dashboard.summary.unassignedLeads, href: "/admin/leads?scope=Unassigned", severity: "info" },
      { key: "sla", label: "Past SLA", count: overdue.length, href: "#lead-aging", severity: "danger" },
      { key: "over", label: "Break / lunch issues", count: over, href: `/admin/attendance?business=${encodeURIComponent(business)}&preset=custom&from=${range.from}&to=${range.to}&issue=over-rest`, severity: "warning" },
      { key: "open", label: "Open sessions", count: open, href: `/admin/attendance?business=${encodeURIComponent(business)}&preset=last-30-days&issue=open-session`, severity: "info" },
      { key: "bridge", label: "Bridge stale / offline", count: bridgeStale, href: "#call-dashboard-title", severity: "warning" },
    ];
    const monthStart = hubShiftBounds(`${range.from.slice(0, 7)}-01`, shiftSettings).start;
    const nextMonth = new Date(`${range.from.slice(0, 7)}-01T00:00:00Z`); nextMonth.setUTCMonth(nextMonth.getUTCMonth() + 1);
    const monthEnd = hubShiftBounds(nextMonth.toISOString().slice(0, 10), shiftSettings).start;
    res.set("Cache-Control", "no-store").json({ dashboard, pace: { daily: Math.max(0, Math.min(1, (now.getTime() - fromTime.getTime()) / (toTime.getTime() - fromTime.getTime()))), monthly: Math.max(0, Math.min(1, (now.getTime() - monthStart.getTime()) / (monthEnd.getTime() - monthStart.getTime()))) }, range: { ...range, fromTime: fromTime.toISOString(), toTime: toTime.toISOString() }, serverTime: now.toISOString(), attention, config: settings, notes, attendance: attendance.summary,
      previous: previous.summary, trend: currentTrend, deltas: Object.fromEntries(Object.keys(dashboard.summary).map((key) => [key, key === "activityToday" ? metricDelta(dashboard.summary[key], previous.summary[key]) : null])),
      overdue: overdue.slice(0, 10), overdueTotal: overdue.length, calls: [...callBuckets.values()], policy: { shiftStart: policy.shiftStart, shiftEnd: policy.shiftEnd },
      changes: changedSentences(dashboard.summary, previous.summary, over).map((item) => item.href.startsWith("/admin/attendance") ? { ...item, href: attention[3].href } : item) });
  } catch (error) { res.status(error instanceof Error && /range/i.test(error.message) ? 400 : 503).json({ message: error instanceof Error ? error.message : "Dashboard unavailable." }); }
}
export async function dashboardEmployeeQuickView(req: Request, res: Response) {
  const actor = authorize(req, res); if (!actor) return;
  const code = String(req.params.code || "");
  if (!/^[a-zA-Z0-9_-]{1,40}$/.test(code)) { res.status(400).json({ message: "Invalid employee code." }); return; }
  const employee = await Employee.findOne({ employeeCode: code, status: { $ne: "Archived" } }).select("_id name employeeCode team role availabilityStatus").lean();
  if (!employee) { res.status(404).json({ message: "Employee not found in this business." }); return; }
  let range: ReturnType<typeof dashboardRange>;
  try { range = dashboardRange(req.query); } catch { res.status(400).json({ message: "Invalid dashboard range." }); return; }
  const attendance = { summary: await readDashboardAttendanceSummary(String(req.business?.id || ""), range.from, range.to, actor.employeeCode, new Date(), code) };
  const ledger = await AttendanceLedger.findOne({ employeeCode: code, businessIds: req.business?.id }).lean();
  if (ledger) employee.availabilityStatus = projectAttendance(ledger.events, ledger.corrections, ledger.closures).active?.mode || "OFFLINE";
  res.json({ employee, attendance });
}
export async function saveDashboardWorkspace(req: Request, res: Response) {
  const actor = authorize(req, res); if (!actor) return;
  const { targets, newLeadHours, followUpHours, revision } = req.body || {};
  if (!Number.isInteger(revision) || revision < 0 || !Array.isArray(targets) || targets.length > 30 || ![newLeadHours, followUpHours].every((n) => Number.isFinite(n) && n >= 0 && n <= 8760) ||
    targets.some((target) => !["calls", "talkMinutes", "qualified"].includes(target.metric) || !["daily", "monthly"].includes(target.period) || typeof target.team !== "string" || target.team.length > 80 || !Number.isInteger(target.amount) || target.amount < 1 || target.amount > 10_000_000)) {
    res.status(400).json({ message: "Check the targets and SLA thresholds." }); return;
  }
  const before = await DashboardWorkspace.findOne({ key: "workspace" }).lean();
  if ((before?.revision || 0) !== revision) { res.status(409).json({ message: "Settings changed. Refresh before saving." }); return; }
  const after = { targets, newLeadHours, followUpHours };
  try {
    const saved = await DashboardWorkspace.findOneAndUpdate({ key: "workspace", revision: before ? revision : { $exists: false } },
      { $set: after, $inc: { revision: 1 }, $push: { audit: { actor: actor.employeeCode, at: new Date(), before: before ? { targets: before.targets, newLeadHours: before.newLeadHours, followUpHours: before.followUpHours } : defaults, after } } }, { returnDocument: "after", upsert: !before });
    if (!saved) { res.status(409).json({ message: "Settings changed. Refresh before saving." }); return; } res.json(saved);
  } catch { res.status(409).json({ message: "Settings changed. Refresh before saving." }); }
}
export async function saveDashboardNote(req: Request, res: Response) {
  const actor = authorize(req, res); if (!actor) return;
  const text = String(req.body?.text || "").trim();
  if ((!text && req.method !== "DELETE") || text.length > 2000 || (req.body?.pinned !== undefined && typeof req.body.pinned !== "boolean")) { res.status(400).json({ message: "A note must contain 1 to 2000 characters." }); return; }
  if (req.params.id) {
    if (!Types.ObjectId.isValid(String(req.params.id))) { res.status(400).json({ message: "Invalid note." }); return; }
    const note = await DashboardHandover.findOneAndUpdate({ _id: req.params.id, author: actor.employeeCode, deletedAt: null },
      { $set: req.method === "DELETE" ? { deletedAt: new Date() } : { text, pinned: req.body.pinned === true }, $push: { edits: { text, at: new Date(), actor: actor.employeeCode } } }, { returnDocument: "after" });
    if (!note) { res.status(403).json({ message: "Only the note author can change this note." }); return; } res.json(note); return;
  }
  res.status(201).json(await DashboardHandover.create({ text, pinned: req.body.pinned === true, author: actor.employeeCode, authorName: actor.name }));
}
