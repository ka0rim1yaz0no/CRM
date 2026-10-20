import assert from "node:assert/strict";
import test from "node:test";
import { calculateSlotAttendance } from "./timeAccounting";
import { calculateHubDay } from "./attendanceHubMath";
import { attendanceDashboardPresentation } from "./attendanceDashboardPresentation";
import { assignAttendanceShift } from "./attendanceShift";
import { projectAttendance, type SessionEvent } from "./attendanceSessionState";

const start = new Date("2026-10-15T15:00:00Z");
const end = new Date("2026-10-16T00:00:00Z");
const policy = { breakMinutes: 15, lunchMinutes: 60, graceMinutes: 0, shiftStart: start, shiftEnd: end };
const record = (source: string, minute: number, second = 0) => ({ source, timeIn: new Date(start.getTime() + minute * 60_000 + second * 1000) });
test("clicked intervals use confirmed nearest-minute rounding, not clock windows or pooled allowances", () => {
  for (const [seconds, expected] of [[0, 0], [1, 0], [29, 0], [30, 1], [59, 1]]) {
    const result = calculateSlotAttendance([record("Time In", 0), record("Break Out", 73), record("Break In", 88, seconds), record("Time Out", 540)], policy, end);
    assert.equal(result.excessBreakMinutes, expected, `15:${seconds}`);
  }
  const result = calculateSlotAttendance([record("Time In", 5), record("Break Out", 75), record("Break In", 93),
    record("Lunch Break Out", 160), record("Lunch Break In", 221), record("Break Out", 300), record("Break In", 320), record("Time Out", 530)], policy, end);
  assert.deepEqual([result.lateMinutes, result.excessBreakMinutes, result.excessLunchMinutes, result.earlyTimeOutMinutes, result.deductibleMinutes], [5, 8, 1, 10, 24]);
  assert.deepEqual(result.breakSessions.map((interval) => interval.excessMinutes), [3, 5]);
});
test("open intervals expose a live overdue timer without finalized deductions or invented returns", () => {
  const result = calculateSlotAttendance([record("Time In", 0), record("Break Out", 60)], policy, record("", 90).timeIn);
  assert.equal(result.excessBreakMinutes, 0);
  assert.equal(result.breakSessions[0].open, true);
  assert.equal(result.breakSessions[0].overdueMs, 15 * 60_000);
  assert.equal(result.earlyTimeOutMinutes, 0);
});

test("an explicitly marked cutoff return and checkout are not mistaken for out-of-shift manual events", () => {
  const events = [record("Time In", 0), record("Break Out", 525), record("Break In", 545), record("Time Out", 545)]
    .map((item, sequence) => ({ id: String(sequence), source: item.source as SessionEvent["source"], at: item.timeIn, sequence, autoTimeOut: sequence >= 2 }));
  const day = calculateHubDay("2026-10-15", events, { officialShiftStartTime: "23:00", officialShiftEndTime: "08:00", lateGraceMinutes: 0, attendanceTimeZone: "Asia/Manila" }, new Date(end.getTime() + 600_000));
  assert.equal(day.autoTimeOut, true);
  assert.ok(!day.review.includes("Event outside shift"));
  assert.equal(day.timeOut, "2026-10-16T00:05:00.000Z");
});
test("duration model parity: hub, employee dashboard and shared derivation agree exactly", () => {
  process.env.CRM_ATTENDANCE_DURATION_MODEL = "true";
  try {
    const records = [record("Time In", 5, 29), record("Break Out", 60), record("Break In", 75, 30), record("Break Out", 120), record("Break In", 140),
      record("Lunch Break Out", 180), record("Lunch Break In", 241), record("Time Out", 525)];
    const events: SessionEvent[] = records.map((record, sequence) => ({ id: String(sequence), commandId: String(sequence), sequence,
      source: record.source as SessionEvent["source"], at: record.timeIn.toISOString(), recordedAt: record.timeIn.toISOString(),
      ...(sequence === 0 ? { shift: assignAttendanceShift(record.timeIn) } : {}) }));
    const shared = calculateSlotAttendance(records, policy, end);
    const settings = { officialShiftStartTime: "23:00", officialShiftEndTime: "08:00", lateGraceMinutes: 0, attendanceTimeZone: "Asia/Manila", breakMinutes: 15, lunchMinutes: 60 };
    const hub = calculateHubDay("2026-10-15", events.map((event) => ({ ...event, at: new Date(event.at) })), settings, end);
    const dashboard = attendanceDashboardPresentation({ records: events, sessions: projectAttendance(events).sessions }, { ...policy, shiftStart: "23:00", shiftEnd: "08:00" }, end).dashboardDays[0];
    for (const [metric, expected] of [["late", shared.lateMinutes], ["overBreak", shared.excessBreakMinutes], ["overLunch", shared.excessLunchMinutes], ["underTime", shared.earlyTimeOutMinutes]] as const) {
      assert.equal(hub.milliseconds[metric] / 60_000, expected);
      assert.equal(dashboard.milliseconds[metric] / 60_000, expected);
    }
    assert.equal(dashboard.overBreakRows.reduce((sum, row) => sum + row.overMs, 0), (shared.excessBreakMinutes + shared.excessLunchMinutes) * 60_000);
  } finally { delete process.env.CRM_ATTENDANCE_DURATION_MODEL; }
});
test("API projection enforces two breaks per shift even after a second time-in, with gap independently flagged", () => {
  process.env.CRM_ATTENDANCE_DURATION_MODEL = "true";
  process.env.CRM_ATTENDANCE_BREAK_GAP = "false";
  try {
    const records = [record("Time In", 0), record("Break Out", 1), record("Break In", 2), record("Break Out", 3), record("Break In", 4),
      record("Time Out", 5), record("Time In", 6), record("Break Out", 7)];
    const events: SessionEvent[] = records.map((record, sequence) => ({ id: String(sequence), commandId: String(sequence), sequence,
      source: record.source as SessionEvent["source"], at: record.timeIn.toISOString(), recordedAt: record.timeIn.toISOString(),
      ...(record.source === "Time In" ? { shift: assignAttendanceShift(record.timeIn) } : {}) }));
    assert.ok(projectAttendance(events).blockingIssues.some((issue) => issue.message.startsWith("Only two breaks")));
  } finally { delete process.env.CRM_ATTENDANCE_DURATION_MODEL; delete process.env.CRM_ATTENDANCE_BREAK_GAP; }
});
