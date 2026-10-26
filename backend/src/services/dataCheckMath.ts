import type { DataCheckRow, DataCheckSample, DataCheckSection } from "../../../shared/dataCheck";
import { attendanceSlotKey } from "./attendanceShift";
import { hubShiftBounds } from "./attendanceHubMath";
import { payrollAccuracyEnabled } from "../config/rolloutFlags";
import { isOffPhoneStart, nonBillableOffPhoneSource } from "../../../shared/attendanceOffPhone";

export type CheckPolicy = { shiftStart: string; shiftEnd: string; graceMinutes: number; breakMinutes: number; lunchMinutes: number; autoTimeOutTime?: string };
export type AuditPunch = { id: string; code: string; source: string; at: string; sequence?: number; eventId?: string; slotKey?: string; storedSlotKey?: string; autoTimeOut?: boolean };
export function checkBounds(date: string, policy: CheckPolicy) {
  return hubShiftBounds(date, { officialShiftStartTime: policy.shiftStart, officialShiftEndTime: policy.shiftEnd, lateGraceMinutes: policy.graceMinutes, attendanceTimeZone: "Asia/Manila" });
}
export function validCheckDate(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
}
export function lastCompletedShift(policy: CheckPolicy, now = new Date()) {
  let day = attendanceSlotKey(now, "Asia/Manila", policy.shiftStart, policy.shiftEnd);
  while (checkBounds(day, policy).end > now) day = new Date(Date.parse(day) - 86_400_000).toISOString().slice(0, 10);
  return day;
}
export function compareCheck(id: string, section: DataCheckSection, business: string, label: string, shown: number | string | null | undefined, calculated: number | string | null, explanation: string, samples: DataCheckSample[] = [], weaker = false, warningOnly = false): DataCheckRow {
  const dashboardValue = shown ?? null;
  const difference = typeof shown === "number" && typeof calculated === "number" ? Number((calculated - shown).toFixed(6)) : null;
  const status = dashboardValue === null || calculated === null ? "cannot-verify" : dashboardValue === calculated || difference === 0 ? "match" : "mismatch";
  return { id: `${business}:${id}`, section, business, label, dashboardValue, recomputedValue: calculated, difference, status, explanation,
    proof: weaker ? "same-code, weaker proof" : "independent", samples: status === "mismatch" ? samples.slice(0, 10) : [], ...(warningOnly ? { warningOnly: true } : {}) };
}
export function percentChangeCheck(business: string, shown: number | null | undefined, current: number, previous: number) {
  const exact = previous ? (current - previous) / Math.abs(previous) * 100 : null;
  const rounded = exact === null ? null : Math.round(exact);
  const row = compareCheck("percent-change", "Consistency", business, "Activity percent change", shown, rounded,
    exact === null ? "Previous raw activity is zero: the expected percentage is explicitly undefined (null), never 0%. An available dashboard returning null agrees with that result." :
      `Independent raw activity ${previous} -> ${current}; unrounded change ${exact.toFixed(6)}%; rounded display ${rounded}%. ${rounded === 0 && exact !== 0 ? "Rounding hides a nonzero change." : "Rounding does not hide the direction."}`);
  if (shown !== undefined) row.status = shown === rounded ? "match" : "mismatch";
  return row;
}
export function punchDays(events: AuditPunch[], policy: CheckPolicy) {
  const result = new Map<string, AuditPunch[]>();
  const active = new Map<string, string>();
  for (const event of [...events].sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || (a.sequence ?? 0) - (b.sequence ?? 0))) {
    if (!Number.isFinite(Date.parse(event.at))) continue;
    const day = event.slotKey || active.get(event.code) || attendanceSlotKey(new Date(event.at), "Asia/Manila", policy.shiftStart, policy.shiftEnd);
    const key = `${event.code}:${day}`;
    const group = result.get(key) || []; group.push(event); result.set(key, group);
    if (["Time In", "Login"].includes(event.source)) active.set(event.code, day);
    if (["Time Out", "Logout"].includes(event.source)) active.delete(event.code);
  }
  return result;
}

// Audit-only independent path: never used to save attendance or calculate payroll.
export function auditAttendance(events: AuditPunch[], date: string, policy: CheckPolicy, now: Date) {
  const { start, end } = checkBounds(date, policy);
  const first = [...events].sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || (a.sequence ?? 0) - (b.sequence ?? 0));
  const intervals: Record<"break" | "lunch", Array<{ start: string; end: string | null; milliseconds: number; excess: number }>> = { break: [], lunch: [] };
  const open: Partial<Record<"break" | "lunch", AuditPunch>> = {};
  const issues: AuditPunch[] = [];
  const seen = new Set<string>();
  let online = false; let firstIn: AuditPunch | undefined; let lastOut: AuditPunch | undefined;
  let mode: "online" | "break" | "lunch" | "offPhone" | "offline" = "offline";
  let lastAt = start.getTime(); let workedMs = 0; let offPhoneMs = 0;
  let nonBillable = false, nonBillableMs = 0, nonBillableOffPhoneMinutes = 0;
  const starts = { break: 0, lunch: 0 };
  let forgottenRests = 0;
  const sequence = events.filter(event => event.sequence !== undefined).sort((a, b) => a.sequence! - b.sequence!);
  for (let i = 1; i < sequence.length; i++) {
    if (Date.parse(sequence[i].at) < Date.parse(sequence[i - 1].at)) issues.push(sequence[i]);
  }
  for (const event of first) {
    const at = Date.parse(event.at);
    const clipped = Math.max(start.getTime(), Math.min(at, end.getTime(), now.getTime()));
    if (mode === "online") workedMs += Math.max(0, clipped - lastAt);
    if (mode === "offPhone") offPhoneMs += Math.max(0, clipped - lastAt);
    if (mode === "offPhone" && nonBillable) nonBillableMs += Math.max(0, clipped - lastAt);
    lastAt = clipped;
    if (["Time In", "Login", "Time Out", "Logout", "Off the Phone In"].includes(event.source)) {
      nonBillableOffPhoneMinutes += Math.ceil(nonBillableMs / 60_000); nonBillableMs = 0; nonBillable = false;
    }
    const duplicate = event.eventId || `${event.source}:${event.at}`;
    if (seen.has(duplicate)) issues.push(event); seen.add(duplicate);
    const clockMinutes = (clock: string) => { const [hour, minute] = clock.split(":").map(Number); return hour * 60 + minute; };
    const cutoff = +end + ((clockMinutes(policy.autoTimeOutTime || "08:05") - clockMinutes(policy.shiftEnd) + 1440) % 1440) * 60_000;
    const automaticCutoff = event.autoTimeOut && at <= cutoff && ["Time Out", "Break In", "Lunch Break In", "Off the Phone In"].includes(event.source);
    if (!Number.isFinite(at) || at > +now || at < start.getTime() || (at > end.getTime() && !automaticCutoff) || (event.slotKey && event.slotKey !== date) || (event.storedSlotKey && event.storedSlotKey !== date)) issues.push(event);
    if (["Time In", "Login"].includes(event.source)) {
      for (const rest of ["break", "lunch"] as const) if (open[rest]) {
        intervals[rest].push({ start: open[rest]!.at, end: null, milliseconds: Math.max(0, at - Date.parse(open[rest]!.at)), excess: 0 });
        forgottenRests++; delete open[rest]; issues.push(event);
      }
      if (online) issues.push(event);
      online = true; firstIn ??= event; mode = "online";
    } else if (["Time Out", "Logout"].includes(event.source)) {
      for (const rest of ["break", "lunch"] as const) if (open[rest]) {
        intervals[rest].push({ start: open[rest]!.at, end: null, milliseconds: Math.max(0, at - Date.parse(open[rest]!.at)), excess: 0 });
        forgottenRests++; delete open[rest]; issues.push(event);
      }
      if (!online) issues.push(event);
      online = false; lastOut = event; mode = "offline";
    } else if (isOffPhoneStart(event.source)) {
      if (!online || mode !== "online") issues.push(event);
      nonBillableOffPhoneMinutes += Math.ceil(nonBillableMs / 60_000); nonBillableMs = 0;
      nonBillable = event.source === nonBillableOffPhoneSource; mode = "offPhone";
    }
    else if (event.source === "Off the Phone In") { if (mode !== "offPhone") issues.push(event); mode = "online"; }
    else {
      const rest = event.source.startsWith("Lunch") ? "lunch" : event.source.startsWith("Break") ? "break" : null;
      if (!rest) continue;
      if (event.source.endsWith(" Out")) {
        starts[rest]++;
        if (!online || mode !== "online" || open[rest]) issues.push(event);
        if (!open[rest]) open[rest] = event;
        mode = rest;
      } else if (event.source.endsWith(" In")) {
        const outgoing = open[rest];
        if (!outgoing || mode !== rest) { issues.push(event); continue; }
        const duration = Math.max(0, at - Date.parse(outgoing.at));
        intervals[rest].push({ start: outgoing.at, end: event.at, milliseconds: duration, excess: Math.max(0, (payrollAccuracyEnabled() ? Math.ceil(duration / 60_000) : Math.round(duration / 60_000)) - (rest === "break" ? policy.breakMinutes : policy.lunchMinutes)) });
        delete open[rest]; mode = "online";
      }
    }
  }
  const tail = Math.max(start.getTime(), Math.min(now.getTime(), end.getTime()));
  if (mode === "online") workedMs += Math.max(0, tail - lastAt);
  if (mode === "offPhone") offPhoneMs += Math.max(0, tail - lastAt);
  if (mode === "offPhone" && nonBillable) nonBillableMs += Math.max(0, tail - lastAt);
  nonBillableOffPhoneMinutes += Math.ceil(nonBillableMs / 60_000);
  for (const rest of ["break", "lunch"] as const) if (open[rest]) intervals[rest].push({ start: open[rest]!.at, end: null, milliseconds: Math.max(0, tail - Date.parse(open[rest]!.at)), excess: 0 });
  const late = firstIn ? Math.max(0, Math.floor((Date.parse(firstIn.at) - start.getTime()) / 60_000) - policy.graceMinutes) : 0;
  const under = firstIn && lastOut && !online && now >= end ? Math.max(0, Math.ceil((end.getTime() - Date.parse(lastOut.at)) / 60_000)) : 0;
  const overBreak = intervals.break.reduce((sum, rest) => sum + rest.excess, 0);
  const overLunch = intervals.lunch.reduce((sum, rest) => sum + rest.excess, 0);
  return { present: Boolean(firstIn && Date.parse(firstIn.at) >= start.getTime() && Date.parse(firstIn.at) < end.getTime()), late, under,
    overBreak, overLunch, nonBillableOffPhoneMinutes, deductible: late + under + overBreak + overLunch + nonBillableOffPhoneMinutes, workedMs, offPhoneMs, intervals, starts,
    open: online, unclosedRests: forgottenRests + Object.keys(open).length, issues, firstIn, lastOut };
}
export function badCallTimes(calls: Array<{ start: string; end?: string | null; durationSeconds?: number }>, now: Date, maxSeconds: number) {
  return calls.filter(call => !Number.isFinite(Date.parse(call.start)) || (call.end ? !Number.isFinite(Date.parse(call.end)) || Date.parse(call.end) < Date.parse(call.start) || Date.parse(call.end) - Date.parse(call.start) > maxSeconds * 1000 : Date.parse(call.start) < now.getTime() - maxSeconds * 1000) || (call.durationSeconds !== undefined && (call.durationSeconds < 0 || call.durationSeconds > maxSeconds || !Number.isFinite(call.durationSeconds))));
}
