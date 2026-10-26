import type { Request, Response } from "express";
import { Types } from "mongoose";
import { Employee } from "../models/Employee";
import { Attendance } from "../models/Attendance";
import { AttendanceLedger } from "../models/AttendanceLedger";
import { Lead } from "../models/Lead";
import { LeadCallStat } from "../models/leadCallStat";
import { CallBridgeObservation } from "../models/CallBridgeObservation";
import { getCallBridgeAttemptModel, getCallBridgeDeviceModel } from "../models/CallBridge";
import { getAttendanceBusinessIdentities } from "../models/BusinessUserAccess";
import { getBusinessById, getConfiguredBusinesses, runWithBusiness, type BusinessConfig } from "../config/tenancy";
import { attendancePolicy } from "./attendanceLedgerService";
import { dashboardWorkspaceSummary } from "../controllers/dashboardWorkspaceController";
import { getHubSummary, listHubDays } from "../controllers/attendanceHubController";
import { attendancePayrollDtr } from "../controllers/payrollController";
import { getLeadCallSummary } from "../controllers/leadCallStatController";
import { getCallDashboard } from "../controllers/callDashboardController";
import { countAdminLeads } from "../controllers/leadController";
import { calculateSlotAttendance } from "./timeAccounting";
import { auditAttendance, badCallTimes, checkBounds, compareCheck, percentChangeCheck, punchDays, type AuditPunch, type CheckPolicy } from "./dataCheckMath";
import { withReadSnapshot } from "./readSnapshot";
import { payrollAccuracyEnabled } from "../config/rolloutFlags";
import { dataCheckVerdict, type DataCheckReport, type DataCheckRow, type DataCheckSample, type DataCheckSection } from "../../../shared/dataCheck";

type WorkspaceView = { dashboard: { summary: Record<string, number> }; attendance: Record<string, number>; calls: Array<{ count: number; seconds: number }>; overdueTotal: number; previous: Record<string, number>; deltas: Record<string, number | null> };
type HubRow = { employeeCode: string; employeeName: string; milliseconds: Record<string, number>; nonBillableOffPhoneMinutes?: number; breakSessions: Array<{ durationMs: number }>; excused: boolean; mismatch?: boolean; review?: string[] };
type HubView = { rows: HubRow[]; total: number; totalRows?: number; totalDays?: number; pages?: number; pageCount?: number };
type RawCall = { _id: string; employee: Types.ObjectId; at: Date; seconds: number; outcome: string };
type ScopeSnapshot = { business: string; policy: CheckPolicy; rows: Map<string, AuditPunch[]>; codes: string[] };
const sections: DataCheckSection[] = ["Attendance", "Calls", "Leads", "Consistency"];
const queryMs = 3000;
const maxEvents = 25_000;
const maxPeople = 1000;

async function bounded<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([work, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("Data check timed out")), ms); })]); }
  finally { clearTimeout(timer); }
}
async function screen<T>(handler: (request: Request, response: Response) => unknown, request: Request, business: BusinessConfig, query: Record<string, unknown>) {
  const scoped = Object.create(request) as Request;
  Object.defineProperty(scoped, "query", { value: query });
  scoped.business = business;
  let value: unknown; let status = 200;
  const response = { status(code: number) { status = code; return response; }, set() { return response; }, json(data: unknown) { value = data; return response; } };
  await bounded(Promise.resolve(handler(scoped, response as unknown as Response)), 6000);
  if (status >= 400 || !value) throw new Error("A dashboard source is unavailable");
  return value as T;
}
const sample = (punch: AuditPunch): DataCheckSample => ({ recordId: punch.id, employeeCode: punch.code, timestamp: punch.at });
function ensureBudget(deadline: number) { if (Date.now() >= deadline) throw new Error("Data check budget exhausted"); }
function missing(business: string, section: DataCheckSection, reason: string) {
  return compareCheck(`unavailable-${section}`, section, business, `${section} evidence unavailable`, null, null, reason);
}
function maxCallSeconds() {
  const value = Number(process.env.CRM_DATA_CHECK_MAX_CALL_SECONDS || 7200);
  return Number.isFinite(value) && value >= 60 && value <= 86_400 ? value : 7200;
}
async function rawAttendance(business: string, date: string, policy: CheckPolicy, codes?: string[]) {
  return runWithBusiness(business, async () => {
    const people = await Employee.find({ status: { $ne: "Archived" }, ...(codes ? { employeeCode: { $in: codes } } : {}) })
      .select("_id employeeCode name role businessAccessIds").limit(maxPeople + 1).maxTimeMS(queryMs).lean();
    if (people.length > maxPeople) throw new Error("Employee safety limit reached");
    const { start, end } = checkBounds(date, policy);
    const records = await Attendance.find({ employee: { $in: people.map(person => person._id) }, isArchived: { $ne: true },
      timeIn: { $gte: new Date(+start - 12 * 3_600_000), $lte: new Date(+end + 12 * 3_600_000) } })
      .select("_id employee source timeIn sequence eventId autoTimeOut derived").sort({ employee: 1, sequence: 1, timeIn: 1 }).limit(maxEvents + 1).maxTimeMS(queryMs).lean();
    if (records.length > maxEvents) throw new Error("Attendance safety limit reached");
    const byId = new Map(people.map(person => [String(person._id), person.employeeCode]));
    const events: AuditPunch[] = records.map(record => ({ id: String(record._id), code: byId.get(String(record.employee)) || "", at: record.timeIn.toISOString(), source: record.source,
      eventId: record.eventId, sequence: record.sequence, storedSlotKey: record.derived?.dayKey, autoTimeOut: record.autoTimeOut }));
    const grouped = punchDays(events, policy);
    return { people, records, events, grouped, selected: new Map(people.map(person => [person.employeeCode, grouped.get(`${person.employeeCode}:${date}`) || []])) };
  });
}

async function inspectAttendance(request: Request, business: BusinessConfig, date: string, policy: CheckPolicy, now: Date, workspace: WorkspaceView | null, checks: DataCheckRow[], deadline: number) {
  const raw = await rawAttendance(business.id, date, policy);
  const filters = { business: business.id, preset: "custom", from: date, to: date, pageSize: "100", page: "1" };
  let summary: Record<string, number> | null = null;
  const visible = new Map<string, HubRow>();
  try {
    summary = (await screen<{ summary: Record<string, number> }>(getHubSummary, request, business, filters)).summary;
    const first = await screen<HubView>(listHubDays, request, business, filters);
    for (const row of first.rows) visible.set(row.employeeCode, row);
    const total = first.totalDays ?? first.totalRows ?? first.total ?? first.rows.length;
    if (total > maxPeople) throw new Error("Screen safety limit reached");
    for (let page = 2; (page - 1) * 100 < total; page++) {
      ensureBudget(deadline);
      const next = await screen<HubView>(listHubDays, request, business, { ...filters, page: String(page) });
      for (const row of next.rows) visible.set(row.employeeCode, row);
    }
  } catch { checks.push(missing(business.id, "Attendance", "The attendance hub did not return all selected rows within the safety budget. No missing screen values are treated as zero.")); }
  const totals = { present: 0, late: 0, lateCount: 0, overBreak: 0, overLunch: 0, under: 0, deductible: 0, workedMs: 0 };
  const { start, end } = checkBounds(date, policy);
  let stale = 0; const staleSamples: DataCheckSample[] = [];
  const recordById = new Map(raw.records.map(record => [String(record._id), record]));
  const ledgerRows = await AttendanceLedger.aggregate<{ employeeCode: string; derived: Array<{ dayKey: string; lateMinutes: number; excessBreakMinutes: number; excessLunchMinutes: number; deductibleMinutes: number }> }>([
    { $match: { employeeCode: { $in: raw.people.map(person => person.employeeCode) }, businessIds: business.id } },
    { $project: { _id: 0, employeeCode: 1, derived: { $filter: { input: { $ifNull: ["$derived", []] }, as: "day", cond: { $eq: ["$$day.dayKey", date] } } } } },
  ]).option({ maxTimeMS: queryMs });
  for (const person of raw.people) {
    ensureBudget(deadline);
    const events = raw.selected.get(person.employeeCode) || [];
    if (!events.length) continue;
    const audit = auditAttendance(events, date, policy, now);
    const view = visible.get(person.employeeCode);
    const prefix = `${person.employeeCode} ${person.name}`;
    const add = (id: string, label: string, shown: number | null | undefined, recomputed: number, explanation: string, weak = false) => checks.push(compareCheck(`${person.employeeCode}-${id}`, "Attendance", business.id, `${prefix}: ${label}`, shown, recomputed, explanation, events.map(sample), weak));
    const metrics = { late: audit.late, overBreak: audit.overBreak, overLunch: audit.overLunch, under: audit.under };
    if (audit.present) totals.present++;
    if (!view?.excused) {
      totals.late += audit.late; totals.lateCount += Number(audit.late > 0); totals.overBreak += audit.overBreak;
      totals.overLunch += audit.overLunch; totals.under += audit.under; totals.deductible += audit.deductible;
    }
    totals.workedMs += audit.workedMs;
    for (const [field, actual] of Object.entries(metrics)) add(field, `${field} minutes`, view ? view.milliseconds[field === "under" ? "underTime" : field] / 60_000 : null,
      view?.excused ? 0 : actual, `Independent raw-punch pairing; grace ${policy.graceMinutes}m, each break ${policy.breakMinutes}m, lunch ${policy.lunchMinutes}m. Completed rest durations round to nearest minute. ${view?.excused ? "This business excuses the day, so issue totals are zero; raw events remain visible." : "No excuse is applied."}`);
    for (const index of [0, 1]) add(`break-${index + 1}`, `break ${index + 1} duration (ms)`, audit.intervals.break[index]?.end === null ? null : view ? view.breakSessions?.[index]?.durationMs ?? 0 : null,
      audit.intervals.break[index]?.milliseconds ?? 0, "Paired raw break clicks, never a fixed clock schedule. An open interval is measured to the audit snapshot, without a fabricated return.");
    add("lunch", "lunch duration (ms)", audit.intervals.lunch.some(rest => !rest.end) ? null : view?.milliseconds.lunch, audit.intervals.lunch.reduce((n, rest) => n + rest.milliseconds, 0), "Independent Lunch Out/In pairing; open lunch creates no completed deduction. Live open intervals cannot be compared exactly across separate read timestamps.");
    add("limits", "excess break/lunch attempts", 0, Math.max(0, audit.starts.break - 2) + Math.max(0, audit.starts.lunch - 1), "Expected maximum: two breaks and one lunch per shift day, including repeat sessions.");
    add("open-rest", "unclosed break/lunch records", 0, audit.unclosedRests, "No interval is automatically closed or repaired by this check.");
    const [h, m] = (policy.autoTimeOutTime || "08:05").split(":").map(Number);
    const [eh, em] = policy.shiftEnd.split(":").map(Number);
    const cutoff = new Date(+end + ((h * 60 + m - eh * 60 - em + 1440) % 1440) * 60_000);
    add("open-shift", "open shifts after cutoff", 0, Number(audit.open && now >= cutoff), `Read-only check against ${policy.autoTimeOutTime || "08:05"} Asia/Manila; an in-progress shift before cutoff is not an error.`);
    checks.push(compareCheck(`${person.employeeCode}-integrity`, "Attendance", business.id, `${prefix}: event integrity violations`, 0, new Set(audit.issues.map(event => event.id)).size, "Duplicate IDs/clicks, Time In while already online, unpaired or out-of-order transitions, wrong saved slot keys and out-of-window events. Explicit system returns are permitted through the configured cutoff.", audit.issues.map(sample)));
    for (const event of events) {
      const record = recordById.get(event.id);
      if (!record) continue;
      const derived = record.derived;
      if (!derived || derived.dayKey !== date || derived.lateMinutes !== audit.late || derived.excessBreakMinutes !== audit.overBreak || derived.excessLunchMinutes !== audit.overLunch || (derived.nonBillableOffPhoneMinutes ?? 0) !== audit.nonBillableOffPhoneMinutes) {
        stale++; if (staleSamples.length < 10) staleSamples.push({ recordId: String(record._id), employeeCode: person.employeeCode, timestamp: record.timeIn.toISOString() });
      }
    }
    const stored = ledgerRows.find(row => row.employeeCode === person.employeeCode)?.derived[0];
    checks.push(compareCheck(`${person.employeeCode}-ledger`, "Consistency", business.id, `${prefix}: canonical stored deductible minutes`, stored?.deductibleMinutes, audit.deductible,
      "Stored canonical derivative versus independent raw replica recomputation. A difference may indicate incomplete replication, a stale derivative or policy change; nothing is repaired.", events.map(sample), false, true));
    const sameCode = calculateSlotAttendance(events.map(event => ({ source: event.source, timeIn: new Date(event.at) })), { ...policy, shiftStart: start, shiftEnd: end }, now);
    checks.push(compareCheck(`${person.employeeCode}-employee-insights`, "Consistency", business.id, `${prefix}: shared insights calculation vs independent minutes`, sameCode.deductibleMinutes, audit.deductible,
      "Same-code, weaker proof for the existing shared insights calculation, not a captured employee screen. The independent side uses separate pairing code. Legacy per-punch issue counts are different units and are not treated as minute values.", events.map(sample), true));
    try {
      const [y, mo, d] = date.split("-").map(Number);
      const label = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "short", day: "numeric", year: "numeric" }).format(new Date(Date.UTC(y, mo - 1, d)));
      const dtr = await bounded(attendancePayrollDtr(person._id, `${label} - ${label}`), 4000);
      const day = dtr.rows.find(row => row.dateKey === date);
      const dtrMinutes = day ? day.lateMinutes + day.excessBreakMinutes + day.excessLunchMinutes + day.earlyTimeOutMinutes + (day.nonBillableOffPhoneMinutes ?? 0) : null;
      const reviewExcluded = payrollAccuracyEnabled() && (audit.open || audit.unclosedRests > 0 || audit.starts.break > 2 || audit.starts.lunch > 1 ||
        Boolean(view?.mismatch || view?.review?.length) || Boolean(audit.firstIn && now < end));
      checks.push(compareCheck(`${person.employeeCode}-dtr`, "Consistency", business.id, `${prefix}: DTR vs attendance deductible minutes`, dtrMinutes,
        reviewExcluded ? 0 : view ? (view.milliseconds.late + view.milliseconds.overBreak + view.milliseconds.overLunch + view.milliseconds.underTime) / 60_000 + (view.nonBillableOffPhoneMinutes ?? 0) : null,
        reviewExcluded ? "The independent event audit finds an unresolved/in-progress shift, excess rest attempts, or a hub review/mismatch. Accuracy payroll must finalize zero deductible minutes until resolution; observational hub issue minutes remain visible. No past payroll is changed." :
          "Existing read-only DTR row compared with the attendance hub in identical units. Weekend waivers, excuses, schedules or replica/canonical disagreement can explain a difference; no salary or bank fields are read or returned.", events.map(sample), true));
    } catch { checks.push(compareCheck(`${person.employeeCode}-dtr`, "Consistency", business.id, `${prefix}: DTR`, null, null, "DTR evidence was not available within its read budget.")); }
  }
  const summaryPairs: Array<[string, string, number]> = [["present", "employeesPresent", totals.present], ["late-count", "lateCount", totals.lateCount], ["late-minutes", "late", totals.late * 60_000], ["deductible-minutes", "deductible", totals.deductible]];
  for (const [id, key, actual] of summaryPairs) checks.push(compareCheck(id, "Attendance", business.id, `${id.replaceAll("-", " ")}${key === "late" ? " (ms)" : ""}`,
    key === "deductible" ? summary ? (summary.late + summary.overBreak + summary.overLunch + summary.underTime) / 60_000 + summary.nonBillableOffPhoneMinutes : null : summary?.[key], actual,
    "Attendance hub range totals versus independently counted raw punches. Present requires a Time In inside [shift start, shift end). Cross-business conflicts and excuses may intentionally suppress hub totals.", raw.events.filter(event => ["Time In", "Login"].includes(event.source)).map(sample)));
  checks.push(compareCheck("stale-rows", "Attendance", business.id, "Stored attendance rows with stale or missing minutes", 0, stale, "Each effective replica's saved derived late/break/lunch fields is checked against a fresh independent recomputation. Missing legacy derivatives count as stale, not a repair instruction.", staleSamples, false, true));
  if (summary && workspace) for (const key of ["employeesPresent", "lateCount", "late", "overBreak", "overLunch", "underTime", "online"]) checks.push(compareCheck(`workspace-hub-${key}`, "Consistency", business.id, `Dashboard vs attendance hub: ${key}`, workspace.attendance?.[key], summary[key], "Both screen paths reuse the attendance hub and one internal server-time snapshot, including open sessions. Same-code, weaker proof: parity cannot independently validate the shared calculation. Concurrent attendance edits may still require a rerun.", [], true));
  return { business: business.id, policy, rows: raw.selected, codes: raw.people.map(person => person.employeeCode), people: raw.people, raw };
}

async function inspectCalls(request: Request, business: BusinessConfig, date: string, policy: CheckPolicy, now: Date, workspace: WorkspaceView | null, snapshot: Awaited<ReturnType<typeof rawAttendance>> | null, checks: DataCheckRow[]) {
  const { start, end } = checkBounds(date, policy);
  const logs = await LeadCallStat.aggregate<RawCall>([
    { $match: { "callLogs.calledAt": { $gte: start, $lt: end } } }, { $unwind: "$callLogs" },
    { $match: { "callLogs.calledAt": { $gte: start, $lt: end } } },
    { $project: { _id: { $toString: "$callLogs._id" }, employee: "$callLogs.employee", at: "$callLogs.calledAt", seconds: "$callLogs.durationSeconds", outcome: "$callLogs.outcome" } }, { $limit: maxEvents + 1 },
  ]).option({ maxTimeMS: queryMs });
  if (logs.length > maxEvents) throw new Error("Call safety limit reached");
  const people = snapshot?.people || await Employee.find({ status: { $ne: "Archived" } }).select("_id employeeCode role").limit(maxPeople).maxTimeMS(queryMs).lean();
  const codeById = new Map(people.map(person => [String(person._id), person.employeeCode]));
  const salesIds = new Set(people.filter(person => /sales/i.test(person.role)).map(person => String(person._id)));
  const sales = logs.filter(log => salesIds.has(String(log.employee)));
  const samples = logs.map(log => ({ recordId: log._id, employeeCode: codeById.get(String(log.employee)) || "unknown", timestamp: log.at.toISOString() }));
  let logged: Array<{ totalAttempts: number; totalCalls: number }> | null = null;
  try { logged = await screen(getLeadCallSummary as (req: Request, res: Response) => unknown, request, business, { from: start.toISOString(), to: new Date(+end - 1).toISOString() }); }
  catch { checks.push(missing(business.id, "Calls", "Logged call summary is unavailable; raw calls are still checked.")); }
  checks.push(compareCheck("logged-call-total", "Calls", business.id, "Logged total attempts", logged ? logged.reduce((n, row) => n + row.totalAttempts, 0) : null, sales.length, "Current active sales roster only, matching the Log Call Counts table; raw LeadCallStat entries use the exact selected shift window.", samples));
  checks.push(compareCheck("logged-answered", "Calls", business.id, "Logged answered / connected calls", logged ? logged.reduce((n, row) => n + row.totalCalls, 0) : null, sales.filter(log => !log.outcome || log.outcome === "connected").length, "Connected is the stored logged outcome, not proof of a human answering. LeadCallStat does not preserve an end timestamp for every manual call.", samples));
  checks.push(compareCheck("workspace-talk", "Calls", business.id, "Logged talk time (seconds)", workspace ? workspace.calls.reduce((n, row) => n + row.seconds, 0) : null, logs.reduce((n, log) => n + Math.max(0, log.seconds || 0), 0), "Workspace buckets versus independent raw call-log duration sum for the same window. This population is separate from bridge observations.", samples));
  const maxSeconds = maxCallSeconds();
  const malformedLogs = logs.filter(log => log.seconds !== undefined && log.seconds !== null && (!Number.isFinite(log.seconds) || log.seconds < 0 || log.seconds > maxSeconds));
  checks.push(compareCheck("call-log-durations", "Calls", business.id, "Negative or over-limit logged durations", 0, malformedLogs.length, `Duration sanity ceiling ${maxSeconds}s. No missing manual-call end timestamp is invented.`, malformedLogs.map(log => ({ recordId: log._id, employeeCode: codeById.get(String(log.employee)) || "unknown", timestamp: log.at.toISOString() }))));
  const [observations, attempts, devices] = await Promise.all([
    CallBridgeObservation.find({ businessIds: business.id, startedAt: { $gte: start, $lt: end } }).select("_id employeeCode startedAt endedAt durationMs").limit(maxEvents + 1).maxTimeMS(queryMs).lean(),
    getCallBridgeAttemptModel().find({ businessId: business.id, reservedAt: { $gte: start, $lt: end } }).select("_id employeeCode dialStartedAt endedAt durationSeconds").limit(maxEvents + 1).maxTimeMS(queryMs).lean(),
    getCallBridgeDeviceModel().find({ businessIds: business.id }).select("_id employeeCode lastSeenAt bridgeVersion").limit(maxPeople + 1).maxTimeMS(queryMs).lean(),
  ]);
  if (observations.length > maxEvents || attempts.length > maxEvents || devices.length > maxPeople) throw new Error("Bridge safety limit reached");
  const timed = [...observations.map(row => ({ id: String(row._id), code: row.employeeCode, start: row.startedAt.toISOString(), end: row.endedAt?.toISOString(), durationSeconds: row.durationMs / 1000 })),
    ...attempts.filter(row => row.dialStartedAt).map(row => ({ id: String(row._id), code: row.employeeCode, start: row.dialStartedAt!.toISOString(), end: row.endedAt?.toISOString(), durationSeconds: row.durationSeconds }))];
  checks.push(compareCheck("bridge-times", "Calls", business.id, "Reversed, over-limit or overdue unended bridge calls", 0, badCallTimes(timed, now, maxSeconds).length,
    `Raw completed observations and started bridge attempts; ${maxSeconds}s sanity limit. A recent active call is not automatically classified as broken.`, timed.map(row => ({ recordId: row.id, employeeCode: row.code, timestamp: row.start }))));
  const historical = now < start || now >= end;
  const stale = devices.filter(device => +now - +device.lastSeenAt > 20_000);
  checks.push(compareCheck("bridge-freshness", "Calls", business.id, "Bridge devices older than 20 seconds", historical ? null : 0, historical ? null : stale.length,
    historical ? "Cannot verify historical heartbeat health: devices store only the latest heartbeat, not an immutable shift history." : "Current selected shift: lastSeenAt compared with the server snapshot, not the browser clock.", devices.map(device => ({ recordId: String(device._id), employeeCode: device.employeeCode, timestamp: device.lastSeenAt.toISOString() }))));
  const minVersion = process.env.CRM_DATA_CHECK_MIN_BRIDGE_VERSION || "0.4.1";
  const version = (value: string) => /^\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(value) ? value.split(".").reduce((n, item) => n * 1000 + Number(item), 0) : -1;
  const required = version(minVersion) < 0 ? "0.4.1" : minVersion;
  const old = devices.filter(device => version(device.bridgeVersion) < version(required));
  checks.push(compareCheck("bridge-version", "Calls", business.id, "Bridge versions below required minimum", historical ? null : 0, historical ? null : old.length, historical ? "Cannot prove the bridge version installed during a historical shift from the latest device row." : `Required bridge version ${required}; unknown versions fail this check.`, devices.map(device => ({ recordId: String(device._id), employeeCode: device.employeeCode, timestamp: device.lastSeenAt.toISOString() }))));
  checks.push(compareCheck("bridge-disconnect-gaps", "Calls", business.id, "Historical bridge disconnect gaps", null, null, "Cannot verify: no immutable heartbeat/disconnect event stream is stored. A single lastSeenAt cannot reveal a gap count."));
  const completed = await CallBridgeObservation.find({ businessIds: business.id, employeeCode: { $in: people.filter(person => salesIds.has(String(person._id))).map(person => person.employeeCode) }, endedAt: { $gte: start, $lte: new Date(Math.min(+now, +end)) } })
    .select("employeeCode durationMs endedAt").limit(maxEvents + 1).maxTimeMS(queryMs).lean();
  if (completed.length > maxEvents) throw new Error("Completed call safety limit reached");
  let panel: { shift: { start: string; end: string }; employees: Array<{ callsCount?: number; talkTimeMs?: number }> } | null = null;
  if (!historical) try { panel = await screen(getCallDashboard, request, business, {}); } catch { /* A missing live panel cannot prove historical figures. */ }
  const exactPanel = panel && +new Date(panel.shift.start) === +start && +new Date(panel.shift.end) === +end ? panel : null;
  checks.push(compareCheck("bridge-observed-count", "Calls", business.id, "Observed calls vs live call panel", exactPanel ? exactPanel.employees.reduce((n, row) => n + (row.callsCount || 0), 0) : null, completed.length,
    "The existing panel reuses callDashboardService for live state. Only identical live shift windows can be compared; historical panel snapshots are not stored. Independent side counts completed business-scoped raw observations, not manually logged attempts."));
  checks.push(compareCheck("bridge-observed-talk", "Calls", business.id, "Observed talk time vs live call panel (ms)", exactPanel ? exactPanel.employees.reduce((n, row) => n + (row.talkTimeMs || 0), 0) : null, completed.reduce((n, row) => n + row.durationMs, 0),
    "Independent sum of completed business-scoped raw observation durations, separate from LeadCallStat durations. No historical live-panel value is fabricated."));
  if (snapshot) {
    const present = new Set([...snapshot.selected].filter(([, events]) => events.some(event => ["Time In", "Login"].includes(event.source))).map(([code]) => code));
    const called = new Set(logs.map(log => codeById.get(String(log.employee)) || "unknown"));
    checks.push(compareCheck("call-without-attendance", "Calls", business.id, "Call agents without a Time In", 0, [...called].filter(code => !present.has(code)).length, "Distinct call-log employees compared with selected raw Time Ins.", samples));
    const salesCodes = people.filter(person => salesIds.has(String(person._id))).map(person => person.employeeCode);
    checks.push(compareCheck("attendance-without-call", "Calls", business.id, "Present sales agents without logged calls", 0, salesCodes.filter(code => present.has(code) && !called.has(code)).length, "Sales roster only. This is a data-review signal, not proof that the employee failed to work.", [...snapshot.selected.values()].flat().map(sample)));
  } else checks.push(compareCheck("call-attendance", "Calls", business.id, "Calls vs attendance", null, null, "Attendance evidence is unavailable for this comparison."));
}

async function inspectLeads(request: Request, business: BusinessConfig, date: string, policy: CheckPolicy, now: Date, workspace: WorkspaceView | null, checks: DataCheckRow[]) {
  const { start, end } = checkBounds(date, policy);
  const dayBefore = new Date(+start - 86_400_000);
  const previousEnd = new Date(+end - 86_400_000);
  const aggregate = await Lead.aggregate<{ statuses: Array<{ _id: string; count: number }>; missingAgent: Array<{ _id: Types.ObjectId; createdAt: Date }>; missingStatus: Array<{ _id: Types.ObjectId; createdAt: Date }>; future: Array<{ _id: Types.ObjectId; createdAt: Date }>; defects: Array<{ _id: string; count: number }>; activity: Array<{ current: number; previous: number }> }>([
    { $facet: {
      statuses: [{ $group: { _id: "$status", count: { $sum: 1 } } }],
      missingAgent: [{ $match: { assignedAgent: null } }, { $project: { _id: 1, createdAt: 1 } }, { $limit: 10 }],
      missingStatus: [{ $match: { $or: [{ status: { $exists: false } }, { status: "" }, { status: null }] } }, { $project: { _id: 1, createdAt: 1 } }, { $limit: 10 }],
      future: [{ $match: { createdAt: { $gt: now } } }, { $project: { _id: 1, createdAt: 1 } }, { $limit: 10 }],
      defects: [{ $project: { missingAgent: { $cond: [{ $eq: [{ $ifNull: ["$assignedAgent", null] }, null] }, 1, 0] }, missingStatus: { $cond: [{ $in: [{ $ifNull: ["$status", ""] }, [""]] }, 1, 0] }, future: { $cond: [{ $gt: ["$createdAt", now] }, 1, 0] } } }, { $group: { _id: null, missingAgent: { $sum: "$missingAgent" }, missingStatus: { $sum: "$missingStatus" }, future: { $sum: "$future" } } }],
      activity: [{ $match: { $or: [{ "activity.createdAt": { $gte: dayBefore, $lt: end } }, { "comments.createdAt": { $gte: dayBefore, $lt: end } }] } },
        { $project: { events: { $concatArrays: [{ $map: { input: { $filter: { input: { $ifNull: ["$activity", []] }, as: "e", cond: { $eq: ["$$e.actorType", "employee"] } } }, as: "e", in: "$$e.createdAt" } }, { $map: { input: { $filter: { input: { $ifNull: ["$comments", []] }, as: "e", cond: { $eq: ["$$e.authorType", "employee"] } } }, as: "e", in: "$$e.createdAt" } }] } } },
        { $unwind: "$events" }, { $group: { _id: null, current: { $sum: { $cond: [{ $and: [{ $gte: ["$events", start] }, { $lt: ["$events", end] }] }, 1, 0] } }, previous: { $sum: { $cond: [{ $and: [{ $gte: ["$events", dayBefore] }, { $lt: ["$events", previousEnd] }] }, 1, 0] } } } }],
    } },
  ]).option({ maxTimeMS: queryMs });
  const result = aggregate[0]; if (!result) throw new Error("Lead aggregation unavailable");
  const counts = new Map(result.statuses.map(row => [row._id, row.count]));
  const active = result.statuses.filter(row => !["Dead", "Archived"].includes(row._id)).reduce((n, row) => n + row.count, 0);
  for (const [id, key, raw, label] of [["open", "totalOpenLeads", active, "Open leads"], ["qualified", "qualifiedLeads", counts.get("Qualified") || 0, "Qualified leads"], ["negotiation", "negotiationLeads", counts.get("Ongoing Negotiation") || 0, "Negotiation leads"]] as const) checks.push(compareCheck(`leads-${id}`, "Leads", business.id, label, workspace?.dashboard.summary[key], raw, "Current raw Lead status count versus the dashboard card. Dashboard deduplication may intentionally hide duplicate source rows; this check does not deduplicate them or claim a historical status snapshot."));
  let tabCounts: Record<string, number> | null = null;
  try { tabCounts = await screen(countAdminLeads, request, business, {}); } catch { /* An unavailable screen is not a zero count. */ }
  for (const status of ["NEW", "Follow up", "Ongoing comms", "Qualified", "Ongoing Negotiation", "Completed", "Dead", "Archived"]) checks.push(compareCheck(`status-${status}`, "Leads", business.id, `Lead tab status: ${status}`, tabCounts?.[status],
    counts.get(status) || 0, "Existing admin Leads status-tab count versus independent raw Lead aggregation. These are current status snapshots, not historical cards. Intentional UI deduplication can differ from raw rows; differences stay visible and no records are changed."));
  const defects = result.defects[0] as unknown as Record<string, number> | undefined;
  for (const [key, label] of [["missingAgent", "Leads missing assignedAgent"], ["missingStatus", "Leads missing status"], ["future", "Leads with a future createdAt"]] as const) {
    const records = result[key];
    checks.push(compareCheck(`lead-${key}`, "Leads", business.id, label, 0, defects?.[key] || 0, "Raw database validation. Unassigned leads may be an intentional queue; review rather than automatically assign or delete.", records.map(record => ({ recordId: String(record._id), employeeCode: "", timestamp: record.createdAt?.toISOString() || "" }))));
  }
  const settings = await import("../models/DashboardWorkspace");
  const config = await settings.DashboardWorkspace.findOne({ key: "workspace" }).select("newLeadHours followUpHours").maxTimeMS(queryMs).lean();
  const overdue = await Lead.countDocuments({ status: { $nin: ["Archived", "Dead", "Completed"] }, $or: [
    { status: "NEW", createdAt: { $lt: new Date(+now - (config?.newLeadHours ?? 24) * 3_600_000) }, "comments.0": { $exists: false }, "activity.0": { $exists: false } },
    { status: "Follow up", followUpAt: { $lt: new Date(+now - (config?.followUpHours ?? 0) * 3_600_000) } },
  ] }).maxTimeMS(queryMs);
  checks.push(compareCheck("lead-overdue", "Leads", business.id, "SLA overdue total", workspace?.overdueTotal, overdue, "Independent Mongo count at the server snapshot using the saved new-lead/follow-up SLA thresholds; compared with overdueTotal, not just the visible top ten."));
  const activity = result.activity[0] || { current: 0, previous: 0 };
  checks.push(percentChangeCheck(business.id, workspace?.deltas.activityToday, activity.current, activity.previous));
}

export async function runDataCheck(request: Request, date: string, businessId: string, now = new Date()): Promise<DataCheckReport> {
  return withReadSnapshot(now, () => inspectDataCheck(request, date, businessId, now));
}
async function inspectDataCheck(request: Request, date: string, businessId: string, now: Date): Promise<DataCheckReport> {
  const checks: DataCheckRow[] = [];
  const snapshots: ScopeSnapshot[] = [];
  const unavailable = new Set<string>();
  const selected = getConfiguredBusinesses().filter(business => businessId === "all" || business.id === businessId);
  const deadline = Date.now() + 22_000;
  for (const business of selected) {
    if (Date.now() > deadline) { for (const section of sections) checks.push(missing(business.id, section, "The total run time budget was reached before this business could be read.")); continue; }
    await runWithBusiness(business.id, async () => {
      const policy = await bounded(attendancePolicy(business.id), queryMs);
      let workspace: WorkspaceView | null = null;
      try { workspace = await screen(dashboardWorkspaceSummary, request, business, { preset: "custom", from: date, to: date }); }
      catch { checks.push(missing(business.id, "Consistency", "The existing dashboard source failed or timed out. Independent raw checks are not presented as a dashboard match.")); }
      let raw: Awaited<ReturnType<typeof rawAttendance>> | null = null;
      try {
        const rows: DataCheckRow[] = [];
        const value = await bounded(inspectAttendance(request, business, date, policy, now, workspace, rows, deadline), Math.max(1000, deadline - Date.now()));
        checks.push(...rows);
        snapshots.push(value); raw = value.raw;
      } catch { checks.push(missing(business.id, "Attendance", "Attendance could not be completely checked within the read/query safety limits.")); }
      try { ensureBudget(deadline); const rows: DataCheckRow[] = []; await bounded(inspectCalls(request, business, date, policy, now, workspace, raw, rows), Math.max(1000, deadline - Date.now())); checks.push(...rows); }
      catch { checks.push(missing(business.id, "Calls", "Call evidence failed, exceeded the safety limit, or timed out.")); }
      try { ensureBudget(deadline); const rows: DataCheckRow[] = []; await bounded(inspectLeads(request, business, date, policy, now, workspace, rows), Math.max(1000, deadline - Date.now())); checks.push(...rows); }
      catch { checks.push(missing(business.id, "Leads", "Lead counts could not be completely checked within the read budget.")); }
    }).catch(() => { unavailable.add(business.id); for (const section of sections) checks.push(missing(business.id, section, "This business is unavailable. Other business results are retained.")); });
  }
  const codes = [...new Set(snapshots.flatMap(snapshot => snapshot.codes))];
  let identities: Awaited<ReturnType<typeof getAttendanceBusinessIdentities>> | null = null;
  try { identities = await bounded(getAttendanceBusinessIdentities(codes), queryMs); }
  catch { checks.push(compareCheck("cross-membership", "Consistency", businessId, "Cross-business membership evidence", null, null, "Authoritative business membership could not be read; cross-business checks are not claimed as matches.")); }
  for (const snapshot of [...snapshots]) for (const other of getConfiguredBusinesses()) {
    if (snapshots.some(item => item.business === other.id)) continue;
    const shared = snapshot.codes.filter(code => identities?.get(code)?.businessIds.includes(other.id));
    if (!shared.length) continue;
    try {
      ensureBudget(deadline);
      const policy = await bounded(runWithBusiness(other.id, () => attendancePolicy(other.id)), Math.min(queryMs, Math.max(1, deadline - Date.now())));
      const data = await bounded(rawAttendance(other.id, date, policy, shared), 4000);
      snapshots.push({ business: other.id, policy, rows: data.selected, codes: data.people.map(person => person.employeeCode) });
    } catch { unavailable.add(other.id); checks.push(compareCheck(`cross-${other.id}`, "Consistency", other.id, "Cross-business evidence", null, null, "An assigned business could not be read. No missing replica is silently treated as matching.")); }
  }
  for (const code of codes) {
    if (!identities) continue;
    const expected = identities.get(code)?.businessIds || snapshots.filter(item => item.codes.includes(code)).map(item => item.business);
    if (expected.some(id => unavailable.has(id))) {
      checks.push(compareCheck(`cross-business-${code}`, "Consistency", businessId, `${code}: attendance across assigned businesses`, null, null, "An assigned business was unavailable. A failed read is not evidence of missing attendance.")); continue;
    }
    const relevant = snapshots.filter(item => expected.includes(item.business));
    const signatures = relevant.map(item => JSON.stringify({ policy: [item.policy.shiftStart, item.policy.shiftEnd, item.policy.graceMinutes, item.policy.breakMinutes, item.policy.lunchMinutes], events: (item.rows.get(code) || []).map(event => [event.source, event.at, event.autoTimeOut || false]) }));
    const missingScope = expected.some(id => !getBusinessById(id) || !relevant.some(item => item.business === id && item.codes.includes(code)));
    checks.push(compareCheck(`cross-business-${code}`, "Consistency", businessId, `${code}: attendance across assigned businesses`, 0, missingScope || new Set(signatures).size > 1 ? 1 : 0,
      `Raw event source/timestamp/cutoff signatures and policy are compared, not merged. Expected businesses: ${expected.join(", ")}. Missing employees or replicas are differences.`, relevant.flatMap(item => item.rows.get(code) || []).map(sample)));
  }
  const counts = { match: 0, mismatch: 0, "cannot-verify": 0 };
  for (const check of checks) counts[check.status]++;
  return { date, business: businessId, generatedAt: now.toISOString(), expiresAt: new Date(+now + 60_000).toISOString(), cached: false, verdict: dataCheckVerdict(checks), counts, checks,
    businesses: selected.map(business => ({ id: business.id, name: business.name })), boundaryProof: "Shift boundaries and slot keys reuse hubShiftBounds/attendanceSlotKey (same-code, weaker proof for boundaries). Duration pairing, deductions and raw anomaly counts use a separate audit-only path. No repair/write is performed." };
}
