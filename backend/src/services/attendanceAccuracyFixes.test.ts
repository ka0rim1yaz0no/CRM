import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { calculateSlotAttendance, clickedSessionIntervals } from "./timeAccounting";
import { accuratePayrollDay, paidHoursPerDay } from "./payrollAccuracy";
import { calculateHubDay } from "./attendanceHubMath";
import { deriveAttendanceDays } from "./attendanceDerived";
import { attendanceDashboardPresentation } from "./attendanceDashboardPresentation";
import { assignAttendanceShift } from "./attendanceShift";
import type { SessionEvent } from "./attendanceSessionState";

const start = new Date("2026-10-15T15:00:00Z"), end = new Date("2026-10-16T00:00:00Z");
const policy = { shiftStart: start, shiftEnd: end, graceMinutes: 0, breakMinutes: 15, lunchMinutes: 60 };
const punch = (source: string, minute: number, second = 0) => ({ source, timeIn: new Date(+start + minute * 60_000 + second * 1000) });
const previous = { ...process.env };
afterEach(() => { for (const key of ["CRM_ATTENDANCE_ACCURACY_FIXES", "CRM_PAYROLL_ACCURACY", "CRM_ATTENDANCE_DURATION_MODEL"]) {
  if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key];
} });
const enable = () => { process.env.CRM_ATTENDANCE_ACCURACY_FIXES = "true"; process.env.CRM_PAYROLL_ACCURACY = "true"; };

for (const [name, source, duration, expected] of [
  ["manual timeout break", "Break Out", 100, 25], ["08:05 automatic timeout break", "Break Out", 545, 470],
  ["manual timeout lunch", "Lunch Break Out", 140, 20],
] as const) test(`accuracy: ${name} charges the unreturned interval`, () => {
  enable();
  const records = [punch("Time In", 0), punch(source, 60), punch("Time Out", duration)];
  const result = calculateSlotAttendance(records, policy, new Date(+end + 600_000));
  const intervals = source === "Break Out" ? result.breakSessions : result.lunchSessions;
  assert.equal(intervals[0].open, false);
  assert.equal(intervals[0].excessMinutes, expected);
  assert.ok(result.restWarnings?.some(message => message.includes(`${expected} min`)), "deduction details must explain the missing return");
  const day = accuratePayrollDay(records, policy, new Date(+end + 600_000), 8, false);
  assert.equal(day.components[source === "Break Out" ? "excessBreakMinutes" : "excessLunchMinutes"], expected);
  assert.equal(day.missingHours * 60, day.components.deductibleMinutes);
});

test("accuracy: new Time In closes only the earlier missing return", () => {
  enable();
  const records = [punch("Time In", 0), punch("Break Out", 60), punch("Time In", 1440), punch("Break Out", 1500), punch("Break In", 1515)];
  const intervals = clickedSessionIntervals(records, "Break Out", "Break In", new Date(+start + 1520 * 60_000));
  assert.equal(intervals[0].open, false);
  assert.equal(intervals[0].end.getTime(), records[2].timeIn.getTime());
  assert.equal(intervals[1].milliseconds, 15 * 60_000);
});

test("accuracy: in-progress rest has overdue information but no final charge", () => {
  enable();
  const result = calculateSlotAttendance([punch("Time In", 0), punch("Break Out", 60)], policy, punch("", 90).timeIn);
  assert.equal(result.breakSessions[0].open, true); assert.equal(result.breakSessions[0].overdueMs, 15 * 60_000);
  assert.equal(result.excessBreakMinutes, 0);
});

test("accuracy: all attendance consumers use the same completed-minute components even without duration mode", () => {
  enable(); process.env.CRM_ATTENDANCE_DURATION_MODEL = "false";
  const records = [punch("Time In", 5, 59), punch("Break Out", 60), punch("Break In", 75, 1),
    punch("Lunch Break Out", 100), punch("Lunch Break In", 160, 1), punch("Time Out", 530, 1)];
  const expected = calculateSlotAttendance(records, policy, end);
  const settings = { officialShiftStartTime: "23:00", officialShiftEndTime: "08:00", lateGraceMinutes: 0, attendanceTimeZone: "Asia/Manila", breakMinutes: 15, lunchMinutes: 60 };
  const events: SessionEvent[] = records.map((item, sequence) => ({ id: `synthetic-${sequence}`, source: item.source as SessionEvent["source"],
    at: item.timeIn.toISOString(), recordedAt: item.timeIn.toISOString(), sequence, commandId: `cmd-${sequence}`,
    ...(sequence === 0 ? { shift: assignAttendanceShift(item.timeIn) } : {}) }));
  const hub = calculateHubDay("2026-10-15", events.map(item => ({ ...item, at: new Date(item.at) })), settings, end);
  const derived = deriveAttendanceDays({ events }, { ...policy, shiftStart: "23:00", shiftEnd: "08:00" }, end)[0];
  const dashboard = attendanceDashboardPresentation({ records: events, sessions: [{ shift: events[0].shift!, events }] },
    { ...policy, shiftStart: "23:00", shiftEnd: "08:00" }, end).dashboardDays[0];
  const payroll = accuratePayrollDay(records, policy, end, paidHoursPerDay(settings, policy), false);
  for (const item of [hub, dashboard]) assert.deepEqual(
    [item.milliseconds.late, item.milliseconds.underTime, item.milliseconds.overBreak, item.milliseconds.overLunch],
    [expected.lateMinutes, expected.earlyTimeOutMinutes, expected.excessBreakMinutes, expected.excessLunchMinutes].map(value => value * 60_000));
  assert.equal(derived.deductibleMinutes, expected.deductibleMinutes);
  assert.equal(payroll.components.deductibleMinutes, expected.deductibleMinutes);
});

test("accuracy rollback: missing returns retain the original open representation", () => {
  process.env.CRM_ATTENDANCE_ACCURACY_FIXES = "false";
  const result = calculateSlotAttendance([punch("Time In", 0), punch("Break Out", 60), punch("Time Out", 100)], policy, end);
  assert.equal(result.breakSessions[0].open, true); assert.equal(result.excessBreakMinutes, 0);
});

test("accuracy: two independent breaks retain separate allowances and deduct only the unreturned excess", () => {
  enable();
  const records = [punch("Time In", 0), punch("Break Out", 60), punch("Break In", 75), punch("Break Out", 520), punch("Time Out", 540)];
  const day = accuratePayrollDay(records, policy, end, 8, false);
  assert.deepEqual(day.calculated.breakSessions.map(item => item.excessMinutes), [0, 5]);
  assert.equal(day.components.deductibleMinutes, 5);
  assert.equal(day.regularHours, 8 - 5 / 60, "excess is removed once, not twice");
  assert.equal(day.missingHours, 5 / 60);
  for (const seconds of [0, 1]) {
    const result = calculateSlotAttendance([punch("Time In", 0), punch("Break Out", 525), punch("Time Out", 540, seconds)], policy, new Date(+end + 60_000));
    assert.equal(result.excessBreakMinutes, seconds);
  }
});

test("accuracy: system closure is an accounting boundary without fabricating a stored return", () => {
  enable();
  const records = [punch("Time In", 0), punch("Break Out", 60)];
  const events: SessionEvent[] = records.map((item, sequence) => ({ id: `closed-${sequence}`, source: item.source as SessionEvent["source"],
    at: item.timeIn.toISOString(), recordedAt: item.timeIn.toISOString(), sequence, commandId: `closed-cmd-${sequence}`,
    ...(sequence === 0 ? { shift: assignAttendanceShift(item.timeIn) } : {}) }));
  const closedAt = new Date(+end - 60 * 60_000);
  const ledger = { events, closures: [{ id: "closure", sessionId: "closed-0", effectiveAt: closedAt.toISOString(), processedAt: end.toISOString(), commandId: "recover" }] };
  const before = structuredClone(ledger);
  const derived = deriveAttendanceDays(ledger, { ...policy, shiftStart: "23:00", shiftEnd: "08:00" }, end)[0];
  assert.equal(derived.excessBreakMinutes, 405);
  assert.equal(derived.breakSessions[0].open, false);
  const closingBoundaries = [closedAt];
  const settings = { officialShiftStartTime: "23:00", officialShiftEndTime: "08:00", lateGraceMinutes: 0, attendanceTimeZone: "Asia/Manila", breakMinutes: 15, lunchMinutes: 60 };
  const hub = calculateHubDay("2026-10-15", events.map(item => ({ ...item, at: new Date(item.at) })), settings, end, false, closingBoundaries);
  assert.equal(hub.milliseconds.overBreak / 60_000, derived.excessBreakMinutes);
  assert.equal(hub.events.length, 2, "a system boundary must never be presented as a clicked return or checkout");
  const dashboard = attendanceDashboardPresentation({ records: events,
    sessions: [{ shift: events[0].shift!, events, lifecycle: "system-closed", endedAt: closedAt.toISOString() }] },
    { ...policy, shiftStart: "23:00", shiftEnd: "08:00" }, end).dashboardDays[0];
  assert.equal(dashboard.milliseconds.overBreak / 60_000, derived.excessBreakMinutes);
  const payroll = accuratePayrollDay(records, { ...policy, closingBoundaries }, end, 8, false, true);
  assert.equal(payroll.calculated.excessBreakMinutes, derived.excessBreakMinutes);
  assert.equal(payroll.components.deductibleMinutes, 0, "administrative closure stays pending review, never silently approves payroll");
  assert.deepEqual(ledger, before);
});

test("accuracy: rounding and clipping are controlled by the new flag independently of the older payroll flag", () => {
  enable(); process.env.CRM_PAYROLL_ACCURACY = "false";
  const rounded = calculateSlotAttendance([punch("Time In", 5, 59), punch("Break Out", 60), punch("Break In", 75, 1), punch("Time Out", 530, 1)], policy, end);
  assert.deepEqual([rounded.lateMinutes, rounded.earlyTimeOutMinutes, rounded.excessBreakMinutes, rounded.deductibleMinutes], [5, 10, 1, 16]);
  for (const [first, last] of [[600, 610], [-60, -30]]) {
    const day = calculateSlotAttendance([punch("Time In", first), punch("Time Out", last)], policy, new Date(+end + 3_600_000));
    assert.ok(day.lateMinutes + day.earlyTimeOutMinutes <= 540, "late and early intervals cannot overlap or exceed the shift");
  }
});
