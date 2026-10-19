import type { Request, Response } from "express";
import { verifyAdminDashboardSession } from "../config/adminDashboardSession";
import { verifyAttendanceHubSession } from "../config/attendanceHubSession";
import { attendanceHubEnabled } from "../config/rolloutFlags";
import { getAttendanceBusinessIdentities, getBusinessAccessForEmployeeCode } from "../models/BusinessUserAccess";
import { getBusinessById, runForEachBusiness, runWithBusiness, type BusinessConfig } from "../config/tenancy";
import { defaultSystemSettings } from "./systemSettingsController";
import { Attendance } from "../models/Attendance";
import { AttendanceDayNote } from "../models/AttendanceDayNote";
import { Employee } from "../models/Employee";
import { EmployeeTransaction } from "../models/EmployeeTransaction";
import { LeaveRequest } from "../models/LeaveRequest";
import { SystemSettings } from "../models/SystemSettings";
import { calculateHubDay, hubDayKey, hubShiftBounds, hubTimeZone, type HubEvent, type HubSettings } from "../services/attendanceHubMath";
import { bucketForAttendanceSource } from "../services/timeAccounting";
import { AttendanceLedger } from "../models/AttendanceLedger";
import { attendancePolicy } from "../services/attendanceLedgerService";
import { projectAttendance } from "../services/attendanceSessionState";
import { attendanceViewRange, manilaCalendarDate, type ShiftView } from "../../../shared/attendanceView";

type Actor = { role: "admin" | "employee"; code: string };
type HubDay = ReturnType<typeof calculateHubDay> & {
  employeeCode: string; employeeId: string; employeeName: string; role: string; team: string; scopeKey: string;
  businessId: string; businessName: string; note: string; noteRevisions: unknown[];
  audit: unknown[]; leave: string | null; absent: boolean; mismatch: boolean; graceMinutes: number;
};
const dayPattern = /^\d{4}-\d{2}-\d{2}$/;
const issueTypes = new Set(["worked", "online", "break", "lunch", "off-phone", "late", "over-break", "over-lunch", "over-rest", "under-time", "overtime", "absent", "open-session", "excused", "needs-review", "mismatch", "on-time"]);
const sortFields = new Set(["date", "employee", "shift", "timeIn", "timeOut", "worked", "late", "break", "lunch", "offPhone", "underTime", "overtime", "issues", "review"]);
const maxRangeDays = 92;

function scalar(value: unknown) { return typeof value === "string" ? value.trim() : ""; }
function dayDate(value: string) {
  if (!dayPattern.test(value)) return null;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value ? date : null;
}
function dayShift(key: string, days: number) {
  const date = dayDate(key);
  if (!date) return "";
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}
function rangeForQuery(query: Request["query"], now: Date) {
  const today = hubDayKey(now, { officialShiftStartTime: defaultSystemSettings.officialShiftStartTime,
    officialShiftEndTime: defaultSystemSettings.officialShiftEndTime, lateGraceMinutes: 0, attendanceTimeZone: hubTimeZone });
  const shiftView = scalar(query.shiftView);
  if (shiftView) {
    if (!["today", "date", "all"].includes(shiftView)) throw new Error("Invalid shift view.");
    return { ...attendanceViewRange(shiftView as ShiftView, now, today, scalar(query.shiftDate), Number(query.historyPage || 1)), preset: "custom" };
  }
  const preset = scalar(query.preset) || "last-7-days";
  const weekday = dayDate(today)?.getUTCDay() || 0;
  const weekStart = dayShift(today, -(weekday === 0 ? 6 : weekday - 1));
  const monthStart = `${today.slice(0, 7)}-01`;
  const previousMonthEnd = dayShift(monthStart, -1);
  const presets: Record<string, [string, string]> = {
    today: [today, today], yesterday: [dayShift(today, -1), dayShift(today, -1)],
    "this-week": [weekStart, today], "last-week": [dayShift(weekStart, -7), dayShift(weekStart, -1)],
    "this-month": [monthStart, today], "last-month": [`${previousMonthEnd.slice(0, 7)}-01`, previousMonthEnd],
    "last-7-days": [dayShift(today, -6), today], "last-30-days": [dayShift(today, -29), today],
  };
  const pair = preset === "custom" ? [scalar(query.from), scalar(query.to)] : presets[preset];
  if (!pair || !dayDate(pair[0]) || !dayDate(pair[1])) throw new Error("Invalid attendance date range.");
  const length = Math.round((dayDate(pair[1])!.getTime() - dayDate(pair[0])!.getTime()) / 86_400_000) + 1;
  if (length < 1 || length > maxRangeDays) throw new Error("Attendance range must be 1 to 92 shift days.");
  return { from: pair[0], to: pair[1], preset };
}
function pageNumber(value: unknown, fallback: number, max: number) {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > max) throw new Error("Invalid page or page size.");
  return parsed;
}
function assertQuery(query: Request["query"], now: Date) {
  const range = rangeForQuery(query, now);
  const business = scalar(query.business);
  const employee = scalar(query.employee).slice(0, 80);
  const team = scalar(query.team).slice(0, 80);
  const role = scalar(query.role).slice(0, 80);
  const issue = scalar(query.issue);
  const sort = scalar(query.sort) || "date";
  const direction = scalar(query.direction) || "desc";
  if ((issue && !issueTypes.has(issue)) || !sortFields.has(sort) || !["asc", "desc"].includes(direction)) throw new Error("Invalid attendance filter.");
  return { ...range, business, employee, team, role, issue, sort, direction,
    shiftView: scalar(query.shiftView), historyPage: pageNumber(query.historyPage, 1, 1200),
    page: pageNumber(query.page, 1, 100_000), pageSize: pageNumber(query.pageSize, 25, 100) };
}
function getActor(request: Request): Actor | null {
  const admin = verifyAdminDashboardSession(request.header("x-crm-admin-session"));
  if (admin) return { role: "admin", code: admin.employeeCode };
  const code = verifyAttendanceHubSession(request.header("x-crm-attendance-session"));
  return code ? { role: "employee", code } : null;
}
function denyIfDisabled(request: Request, response: Response): Actor | null {
  if (!attendanceHubEnabled()) { response.status(404).json({ message: "Attendance hub is disabled." }); return null; }
  const actor = getActor(request);
  if (!actor) response.status(401).json({ message: "Sign in again to view attendance." });
  if (actor && actor.role !== "admin") { response.status(403).json({ message: "The Attendance hub is restricted to administrators. Use your employee attendance controls." }); return null; }
  return actor;
}
function dayKeys(from: string, to: string) {
  const keys: string[] = [];
  for (let key = from; key <= to; key = dayShift(key, 1)) keys.push(key);
  return keys;
}
function isWorkday(key: string) { const weekday = dayDate(key)!.getUTCDay(); return weekday !== 0 && weekday !== 6; }

async function loadHub(actor: Actor, filters: ReturnType<typeof assertQuery>, now: Date, preferredBusiness = filters.business) {
  const policy = await attendancePolicy();
  const authorizedBusinessIds = actor.role === "employee" ? await getBusinessAccessForEmployeeCode(actor.code) : [];
  const businesses: BusinessConfig[] = [];
  const rows: HubDay[] = [];
  const settingsByBusiness: Record<string, HubSettings> = {};
  const memberships = new Map<string, Set<string>>();
  const teams = new Set<string>();
  const roles = new Set<string>();
  const roster = new Map<string, { scopeKey: string; employeeCode: string; employeeId: string; employeeName: string; role: string; team: string; businessId: string; businessIds: string[] }>();
  const earliestByBusiness = new Map<string, string>();
  const rememberHistory = (businessId: string, key: string) => {
    if (!earliestByBusiness.has(businessId) || key < earliestByBusiness.get(businessId)!) earliestByBusiness.set(businessId, key);
  };
  await runForEachBusiness(async (business) => {
    if (filters.business && business.id !== filters.business) return;
    if (actor.role === "employee" && authorizedBusinessIds.length && !authorizedBusinessIds.includes(business.id)) return;
    const employees = await Employee.find({
      status: { $ne: "Archived" }, ...(actor.role === "employee" ? { employeeCode: actor.code } : {}),
    }).select("_id employeeCode name role team dateHired businessAccessIds").lean();
    for (const employee of employees) { if (employee.team) teams.add(employee.team); if (employee.role) roles.add(employee.role); }
    const visible = employees.filter((employee) => employee.employeeCode &&
      (actor.role === "admin" || (!authorizedBusinessIds.length || authorizedBusinessIds.includes(business.id))) &&
      (!filters.employee || `${employee.name} ${employee.employeeCode}`.toLowerCase().includes(filters.employee.toLowerCase())) &&
      (!filters.team || employee.team === filters.team) && (!filters.role || employee.role === filters.role));
    if (!visible.length) return;
    const ledgers = await AttendanceLedger.find({ employeeCode: { $in: visible.map((employee) => employee.employeeCode) }, businessIds: business.id })
      .select("employeeCode businessIds events corrections closures jobs").lean();
    const identities = await getAttendanceBusinessIdentities(visible.map((employee) => employee.employeeCode));
    businesses.push(business);
    const settingsRecord = await SystemSettings.findOne({ key: "system" }).lean();
    const settings: HubSettings = {
      officialShiftStartTime: settingsRecord?.officialShiftStartTime || defaultSystemSettings.officialShiftStartTime,
      officialShiftEndTime: settingsRecord?.officialShiftEndTime || defaultSystemSettings.officialShiftEndTime,
      lateGraceMinutes: settingsRecord?.lateGraceMinutes ?? defaultSystemSettings.lateGraceMinutes,
      attendanceTimeZone: hubTimeZone,
      breakMinutes: policy.breakMinutes, lunchMinutes: policy.lunchMinutes,
    };
    settings.officialShiftStartTime = policy.shiftStart;
    settings.officialShiftEndTime = policy.shiftEnd;
    settings.lateGraceMinutes = policy.graceMinutes;
    settingsByBusiness[business.id] = settings;
    const first = hubShiftBounds(filters.from, settings).start;
    const last = hubShiftBounds(filters.to, settings).end;
    const employeeIds = visible.map((employee) => employee._id);
    if (filters.shiftView === "all") {
      const oldest = await Attendance.findOne({ employee: { $in: employeeIds }, isArchived: { $ne: true } }).sort({ timeIn: 1 }).select("timeIn").lean();
      if (oldest) rememberHistory(business.id, hubDayKey(oldest.timeIn, settings));
    }
    const [events, notes, leaves, edits] = await Promise.all([
      Attendance.find({ employee: { $in: employeeIds }, isArchived: { $ne: true }, timeIn: { $gte: new Date(first.getTime() - 12 * 3_600_000), $lte: new Date(last.getTime() + 12 * 3_600_000) } })
        .select("_id employee source timeIn eventId createdAt").sort({ employee: 1, timeIn: 1 }).lean(),
      AttendanceDayNote.find({ employeeCode: { $in: visible.map((employee) => employee.employeeCode) }, dayKey: { $gte: filters.from, $lte: filters.to } }).lean(),
      LeaveRequest.find({ employee: { $in: employeeIds }, status: "Approved", startDate: { $lte: last }, endDate: { $gte: first } })
        .select("employee startDate endDate selectedDates leaveType").lean(),
      EmployeeTransaction.find({ employee: { $in: employeeIds }, category: "Attendance", title: "Attendance edited", occurredAt: { $gte: first, $lte: last } })
        .select("employee occurredAt title description metadata").sort({ occurredAt: -1 }).lean(),
    ]);
    const eventMap = new Map<string, HubEvent[]>();
    for (const event of events) {
      const key = `${event.employee}:${hubDayKey(event.timeIn, settings)}`;
      const group = eventMap.get(key) || [];
      group.push({ id: String(event._id), source: event.source, at: event.timeIn, eventId: event.eventId });
      eventMap.set(key, group);
    }
    const noteMap = new Map(notes.map((note) => [`${note.employeeCode}:${note.dayKey}`, note]));
    for (const employee of visible) {
      const ledger = ledgers.find((item) => item.employeeCode === employee.employeeCode && item.businessIds.includes(business.id));
      const membership = identities.get(employee.employeeCode);
      const scopeKey = membership?.businessIds.includes(business.id) ? `access:${membership.id}` : `tenant:${business.id}:${employee._id}`;
      const scopeMembership = memberships.get(scopeKey) || new Set<string>();
      scopeMembership.add(business.id);
      memberships.set(scopeKey, scopeMembership);
      const businessIds = [...(roster.get(scopeKey)?.businessIds || []), business.id];
      if (!roster.has(scopeKey) || business.id === preferredBusiness) roster.set(scopeKey, { scopeKey, employeeCode: employee.employeeCode,
        employeeId: String(employee._id), employeeName: employee.name, team: employee.team || "", role: employee.role || "", businessId: business.id, businessIds });
      else roster.get(scopeKey)!.businessIds = businessIds;
      const projection = ledger ? projectAttendance(ledger.events, ledger.corrections, ledger.closures) : null;
      if (filters.shiftView === "all" && projection) for (const session of projection.sessions) {
        const key = session.shift?.dayKey;
        if (key) rememberHistory(business.id, key);
      }
      if (projection) {
        for (const key of dayKeys(filters.from, filters.to)) {
          const effective = projection.sessions.filter((item) => item.shift?.dayKey === key).flatMap((session) => session.events);
          eventMap.set(`${employee._id}:${key}`, effective.map((event) => ({ id: event.id, eventId: event.id, source: event.source, at: new Date(event.at), sequence: event.sequence })));
        }
      }
      for (const key of dayKeys(filters.from, filters.to)) {
        const eventsForDay = eventMap.get(`${employee._id}:${key}`) || [];
        const note = noteMap.get(`${employee.employeeCode}:${key}`);
        const leave = leaves.find((item) => String(item.employee) === String(employee._id) &&
          (item.selectedDates?.length ? item.selectedDates.some((date) => date.toISOString().slice(0, 10) === key)
            : item.startDate.toISOString().slice(0, 10) <= key && item.endDate.toISOString().slice(0, 10) >= key));
        const excused = Boolean(note?.excused || leave);
        const session = projection?.sessions.filter((item) => item.shift?.dayKey === key).at(-1);
        const day = calculateHubDay(key, eventsForDay, settings, session?.lifecycle === "system-closed" ? new Date(session.events.at(-1)!.at) : now, excused);
        if (session?.lifecycle === "system-closed") {
          day.status = "System closed - needs review"; day.inProgress = false;
          day.issues = day.issues.filter((issue) => issue !== "OPEN SESSION"); day.issues.push("SYSTEM CLOSED");
          day.review.push("Administrative missing-checkout closure; no Time Out recorded.");
        }
        if (ledger?.jobs.some((job) => !job.done)) day.review.push("Business synchronization pending");
        const hired = employee.dateHired && dayDate(employee.dateHired.slice(0, 10)) ? employee.dateHired.slice(0, 10) : null;
        const absent = !eventsForDay.length && !excused && isWorkday(key) && (!hired || key >= hired) && now >= new Date(day.shiftEnd);
        if (absent) { day.status = "Absent"; day.issues.push("ABSENT"); }
        if (!eventsForDay.length && !absent && !excused) continue;
        const audit = edits.filter((item) => {
          const metadata = item.metadata as { previousTime?: string; updatedTime?: string } | undefined;
          return String(item.employee) === String(employee._id) && [metadata?.previousTime, metadata?.updatedTime]
            .some((value) => value && Number.isFinite(new Date(value).getTime()) && hubDayKey(new Date(value), settings) === key);
        });
        rows.push({ ...day, scopeKey, employeeCode: employee.employeeCode, employeeId: String(employee._id), employeeName: employee.name,
          role: employee.role, team: employee.team, businessId: business.id, businessName: business.name,
          note: note?.reason || "", noteRevisions: note?.revisions || [], audit, leave: leave?.leaveType || null, absent,
          mismatch: false, graceMinutes: settings.lateGraceMinutes });
      }
    }
  });
  const groups = new Map<string, HubDay[]>();
  for (const row of rows) {
    const key = `${row.scopeKey}:${row.dayKey}`;
    const group = groups.get(key) || [];
    group.push(row);
    groups.set(key, group);
  }
  const deduped = Array.from(groups.values()).map((group) => {
    // Free-text notes are business-local context, not conflicting attendance evidence.
    const signatures = group.map((row) => JSON.stringify({ events: row.events.map((event) => [event.eventId || event.source, event.at]),
      absent: row.absent, excused: row.excused, leave: row.leave, grace: row.graceMinutes }));
    const mismatch = new Set(signatures).size > 1 || group.length !== memberships.get(group[0].scopeKey)?.size ||
      new Set(group.map((row) => `${row.shiftStart}:${row.shiftEnd}`)).size > 1;
    const primary = group.find((row) => row.businessId === preferredBusiness) || group.find((row) => row.events.length) || group[0];
    return { ...primary, mismatch, businesses: group.map((row) => ({ businessId: row.businessId, businessName: row.businessName,
      status: row.status, issues: row.issues, milliseconds: row.milliseconds, events: row.events, mismatch })) };
  });
  return { rows: deduped, businesses: businesses.map((business) => ({ id: business.id, name: business.name })),
    roster: Array.from(roster.values()).sort((a, b) => a.employeeName.localeCompare(b.employeeName) || a.scopeKey.localeCompare(b.scopeKey)), earliestDay: Array.from(earliestByBusiness.values()).sort()[0] || null, earliestByBusiness,
    facets: { teams: [...teams].sort(), roles: [...roles].sort() }, settingsByBusiness,
    thresholds: { breakMinutes: policy.breakMinutes, lunchMinutes: policy.lunchMinutes, timezone: hubTimeZone } };
}

function totals(rows: Awaited<ReturnType<typeof loadHub>>["rows"]) {
  const total = { daysWorked: 0, employeesPresent: 0, online: 0, break: 0, lunch: 0, offPhone: 0,
    lateCount: 0, late: 0, overBreakCount: 0, overBreak: 0, overLunchCount: 0, overLunch: 0,
    underTimeCount: 0, underTime: 0, overtime: 0, absent: 0, needsReview: 0, onTimeRate: 0 };
  const present = new Set<string>();
  for (const row of rows) {
    if (row.review.length || row.mismatch) total.needsReview += 1;
    if (row.mismatch) continue;
    if (row.timeIn) { total.daysWorked += 1; present.add(row.scopeKey); }
    for (const bucket of ["online", "break", "lunch", "offPhone", "late", "overBreak", "overLunch", "underTime", "overtime"] as const) total[bucket] += row.milliseconds[bucket];
    if (row.milliseconds.late) total.lateCount += 1;
    if (row.milliseconds.overBreak) total.overBreakCount += 1;
    if (row.milliseconds.overLunch) total.overLunchCount += 1;
    if (row.milliseconds.underTime) total.underTimeCount += 1;
    if (row.absent) total.absent += 1;
  }
  total.employeesPresent = present.size;
  total.onTimeRate = total.daysWorked ? Math.round((total.daysWorked - total.lateCount) / total.daysWorked * 100) : 0;
  return total;
}
function matchesIssue(row: Awaited<ReturnType<typeof loadHub>>["rows"][number], issue: string) {
  const selected: Record<string, boolean> = { worked: Boolean(row.timeIn), online: row.milliseconds.online > 0,
    break: row.milliseconds.break > 0, lunch: row.milliseconds.lunch > 0, "off-phone": row.milliseconds.offPhone > 0,
    overtime: row.milliseconds.overtime > 0, "on-time": Boolean(row.timeIn && !row.milliseconds.late),
    late: row.milliseconds.late > 0, "over-break": row.milliseconds.overBreak > 0,
    "over-lunch": row.milliseconds.overLunch > 0, "over-rest": row.milliseconds.overBreak > 0 || row.milliseconds.overLunch > 0, "under-time": row.milliseconds.underTime > 0,
    absent: row.absent, "open-session": row.issues.includes("OPEN SESSION"), excused: row.excused,
    "needs-review": Boolean(row.review.length || row.mismatch), mismatch: row.mismatch };
  return !issue || selected[issue];
}
function sortedRows(rows: Awaited<ReturnType<typeof loadHub>>["rows"], sort: string, direction: string) {
  const measure = (row: typeof rows[number]) => sort === "employee" ? row.employeeName.toLowerCase() :
    sort === "shift" ? row.shiftStart : sort === "timeIn" ? row.timeIn || "" : sort === "timeOut" ? row.timeOut || "" :
    sort === "worked" ? row.milliseconds.online : sort === "late" ? row.milliseconds.late :
    sort === "break" ? row.milliseconds.break : sort === "lunch" ? row.milliseconds.lunch :
    sort === "offPhone" ? row.milliseconds.offPhone : sort === "underTime" ? row.milliseconds.underTime :
    sort === "overtime" ? row.milliseconds.overtime : sort === "review" ? row.review.length :
    sort === "issues" ? row.issues.length : row.dayKey;
  return [...rows].sort((a, b) => {
    const left = measure(a); const right = measure(b);
    const compared = typeof left === "number" && typeof right === "number" ? left - right : String(left).localeCompare(String(right));
    return (direction === "asc" ? compared : -compared) || a.employeeCode.localeCompare(b.employeeCode) || a.dayKey.localeCompare(b.dayKey);
  });
}
async function handleHubRead(request: Request, response: Response, mode: "days" | "summary" | "day" | "export") {
  const actor = denyIfDisabled(request, response);
  if (!actor) return;
  try {
    const now = new Date();
    const filters = assertQuery(request.query, now);
    const loaded = await loadHub(actor, mode === "day" || filters.shiftView ? { ...filters, business: "" } : filters, now, filters.business);
    if (filters.shiftView && filters.business) {
      loaded.earliestDay = loaded.earliestByBusiness.get(filters.business) || null;
      loaded.rows = loaded.rows.filter((row) => row.businesses.some((business) => business.businessId === filters.business));
      loaded.roster = loaded.roster.filter((employee) => employee.businessIds.includes(filters.business));
      loaded.facets = { teams: [...new Set(loaded.roster.map((employee) => employee.team).filter(Boolean))].sort(),
        roles: [...new Set(loaded.roster.map((employee) => employee.role).filter(Boolean))].sort() };
    }
    const summary = totals(loaded.rows);
    const matching = sortedRows(loaded.rows.filter((row) => matchesIssue(row, filters.issue)), filters.sort, filters.direction);
    response.set("Cache-Control", "no-store");
    if (mode === "summary") { response.json({ summary, range: { from: filters.from, to: filters.to }, serverTime: now.toISOString() }); return; }
    if (mode === "day") {
      const key = scalar(request.params.dayKey);
      const code = actor.role === "employee" ? actor.code : scalar(request.query.employeeCode);
      const day = loaded.rows.find((row) => row.dayKey === key && row.employeeCode === code && (!filters.business || row.businesses.some((business) => business.businessId === filters.business)));
      if (!day) { response.status(404).json({ message: "Attendance day not found." }); return; }
      response.json({ day, serverTime: now.toISOString() }); return;
    }
    if (mode === "export") {
      const quoted = (value: unknown) => {
        const raw = String(value ?? "");
        const safe = /^[\s]*[=+\-@]/.test(raw) ? `'${raw}` : raw;
        return `"${safe.replace(/"/g, '""')}"`;
      };
      const settings = `Break allowance: ${loaded.thresholds.breakMinutes} min per break, Lunch allowance: ${loaded.thresholds.lunchMinutes} min; shift and grace are listed per row`;
      const lines = [["Attendance", filters.from, filters.to, hubTimeZone], [settings],
        ["Employee code", "Employee", "Shift day", "Business", "Shift start", "Shift end", "Grace minutes", "Status", "Time In", "Time Out", "Online minutes", "Break minutes", "Lunch minutes", "Off-phone minutes", "Late minutes", "Over break minutes", "Over lunch minutes", "Under time minutes", "Overtime minutes", "Issues", "Needs review", "Note"],
        ...matching.map((row) => [row.employeeCode, row.employeeName, row.dayKey, row.businessName, row.shiftStart, row.shiftEnd, row.graceMinutes, row.status, row.timeIn, row.timeOut,
          ...(["online", "break", "lunch", "offPhone", "late", "overBreak", "overLunch", "underTime", "overtime"] as const).map((field) => Math.round(row.milliseconds[field] / 60_000)),
          row.issues.join("; "), row.review.join("; "), row.note])];
      response.type("text/csv").set("Content-Disposition", `attachment; filename="attendance-${filters.from}-${filters.to}.csv"`)
        .send(`\uFEFF${lines.map((line) => line.map(quoted).join(",")).join("\r\n")}`);
      return;
    }
    const trend = Array.from(new Set(loaded.rows.map((row) => row.dayKey))).sort().map((key) => {
      const days = loaded.rows.filter((row) => row.dayKey === key && !row.mismatch);
      return { dayKey: key, online: days.reduce((sum, day) => sum + day.milliseconds.online, 0),
        late: days.reduce((sum, day) => sum + day.milliseconds.late, 0),
        break: days.reduce((sum, day) => sum + day.milliseconds.break, 0),
        lunch: days.reduce((sum, day) => sum + day.milliseconds.lunch, 0), people: days.filter((day) => Boolean(day.timeIn)).length };
    });
    // Keep an expanded page below 500 day rows even for a 92-day range.
    const rangeDays = dayKeys(filters.from, filters.to).length;
    const pageSize = Math.min(filters.pageSize, Math.max(1, Math.floor(500 / rangeDays)));
    const from = (filters.page - 1) * pageSize;
    const orderedCodes = Array.from(new Set(matching.map((row) => row.scopeKey)));
    const orderedSet = new Set(orderedCodes);
    const rosterByScope = new Map(loaded.roster.map((employee) => [employee.scopeKey, employee]));
    const roster = filters.sort === "employee" ? [...loaded.roster].sort((a, b) => {
      const compared = a.employeeName.toLowerCase().localeCompare(b.employeeName.toLowerCase());
      return (filters.direction === "asc" ? compared : -compared) || a.scopeKey.localeCompare(b.scopeKey);
    }) : loaded.roster;
    const codes = actor.role === "admin" ? (filters.shiftView && !filters.issue
      ? filters.sort === "employee" ? roster.map((employee) => employee.scopeKey)
        : [...orderedCodes, ...roster.filter((employee) => !orderedSet.has(employee.scopeKey)).map((employee) => employee.scopeKey)]
      : orderedCodes) : [];
    const pageRows = actor.role === "admin"
      ? matching.filter((row) => codes.slice(from, from + pageSize).includes(row.scopeKey))
      : matching.slice(from, from + pageSize);
    response.json({ rows: pageRows, total: actor.role === "admin" ? codes.length : matching.length, page: filters.page,
      pageSize, summary, range: { from: filters.from, to: filters.to }, businesses: loaded.businesses,
      ...(filters.shiftView && actor.role === "admin" ? { employees: codes.slice(from, from + pageSize).map((key) => rosterByScope.get(key)),
        history: { page: filters.historyPage, hasOlder: Boolean(loaded.earliestDay && loaded.earliestDay < filters.from),
          hasNewer: filters.historyPage > 1, today: manilaCalendarDate(now) } } : {}),
      trend, facets: loaded.facets, reviewQueue: loaded.rows.filter((row) => row.review.length || row.mismatch).slice(0, 100)
        .map((row) => ({ dayKey: row.dayKey, employeeCode: row.employeeCode, employeeName: row.employeeName,
          reason: row.review[0] || "Business mismatch" })),
      serverTime: now.toISOString(), thresholds: loaded.thresholds });
  } catch (error) {
    if (error instanceof Error && (error.message.startsWith("Invalid") || error.message.startsWith("Attendance range"))) {
      response.status(400).json({ message: error.message }); return;
    }
    response.status(503).json({ message: "Attendance is temporarily unavailable. No data was changed." });
  }
}
export const listHubDays = (request: Request, response: Response) => handleHubRead(request, response, "days");
export const getHubSummary = (request: Request, response: Response) => handleHubRead(request, response, "summary");
// Server-internal reader: callers must already verify the administrator session.
// The hub's UI flag does not disable calculations required by other admin pages.
export async function readDashboardAttendanceSummary(business: string, from: string, to: string, adminCode: string, now: Date, employee = "") {
  const filters = assertQuery({ preset: "custom", from, to, business, employee }, now);
  const loaded = await loadHub({ role: "admin", code: adminCode }, filters, now);
  return totals(loaded.rows);
}
export const getHubDay = (request: Request, response: Response) => handleHubRead(request, response, "day");
export const exportHubDays = (request: Request, response: Response) => handleHubRead(request, response, "export");

export async function getHubLive(request: Request, response: Response) {
  const actor = denyIfDisabled(request, response);
  if (!actor) return;
  if (actor.role !== "employee") { response.status(403).json({ message: "Employee access required." }); return; }
  try {
    const now = new Date();
    const current = rangeForQuery({ preset: "today" } as Request["query"], now).from;
    const filters = assertQuery({ preset: "custom", from: dayShift(current, -1), to: current,
      business: scalar(request.query.business) }, now);
    const { rows, businesses, settingsByBusiness } = await loadHub(actor, filters, now);
    const latest = rows.flatMap((row) => row.events.map((event) => ({ row, event })))
      .sort((a, b) => b.event.at.localeCompare(a.event.at))[0];
    const active = latest && latest.row.timeIn && (!latest.row.timeOut || latest.row.timeOut < latest.row.timeIn);
    const bucket = active ? bucketForAttendanceSource(latest.event.source) : "offline";
    const status = bucket === "offPhone" ? "OFF THE PHONE" : bucket?.toUpperCase() || "OFFLINE";
    const settings = settingsByBusiness[filters.business || businesses[0]?.id] || {
      officialShiftStartTime: defaultSystemSettings.officialShiftStartTime,
      officialShiftEndTime: defaultSystemSettings.officialShiftEndTime,
      lateGraceMinutes: defaultSystemSettings.lateGraceMinutes, attendanceTimeZone: hubTimeZone,
    };
    const shift = hubShiftBounds(current, settings);
    response.set("Cache-Control", "no-store").json({ status, since: latest?.event.at || null, serverTime: now.toISOString(),
      day: latest?.row || null, shiftStart: shift.start.toISOString(), shiftEnd: shift.end.toISOString(),
      thresholds: { breakMinutes: 15, lunchMinutes: 60, timezone: hubTimeZone, graceMinutes: settings.lateGraceMinutes } });
  } catch { response.status(503).json({ message: "Live attendance is temporarily unavailable." }); }
}

export async function saveHubDayNote(request: Request, response: Response) {
  const actor = denyIfDisabled(request, response);
  if (!actor) return;
  if (actor.role !== "admin") { response.status(403).json({ message: "Admin access required." }); return; }
  const code = scalar(request.body?.employeeCode);
  const dayKey = scalar(request.params.dayKey);
  const businessId = scalar(request.body?.businessId);
  const reason = scalar(request.body?.reason);
  const excused = request.body?.excused;
  if (!code || code.length > 80 || !dayDate(dayKey) || !getBusinessById(businessId) || reason.length > 1000 || typeof excused !== "boolean" || (excused && !reason)) {
    response.status(400).json({ message: "Valid employee, shift day, business, and reason are required." }); return;
  }
  try {
    const note = await runWithBusiness(businessId, async () => {
      const employee = await Employee.findOne({ employeeCode: code, status: { $ne: "Archived" } }).select("_id").lean();
      if (!employee) return null;
      return AttendanceDayNote.findOneAndUpdate({ employeeCode: code, dayKey },
        { $set: { reason, excused }, $push: { revisions: { reason, excused, by: actor.code, at: new Date() } } },
        { upsert: true, returnDocument: "after", runValidators: true });
    });
    if (!note) { response.status(404).json({ message: "Employee not found in this business." }); return; }
    response.json(note);
  } catch { response.status(503).json({ message: "Could not save the attendance note." }); }
}
