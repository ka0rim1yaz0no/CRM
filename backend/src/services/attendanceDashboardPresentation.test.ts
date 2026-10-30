import assert from "node:assert/strict";
import test from "node:test";
import { attendanceDashboardPresentation, groupAttendanceByShiftDay } from "./attendanceDashboardPresentation";
import { assignAttendanceShift } from "./attendanceShift";
import { projectAttendance, type SessionEvent } from "./attendanceSessionState";
import { calculateHubDay } from "./attendanceHubMath";

const policy = { shiftStart: "23:00", shiftEnd: "08:00", graceMinutes: 0, breakMinutes: 15, lunchMinutes: 60 };
function present(rows: Array<[SessionEvent["source"], string]>, now: string, settings = policy) {
  const records: SessionEvent[] = rows.map(([source, at], sequence) => ({ id: `fake-${sequence}`, source, at: new Date(at).toISOString(),
    sequence, commandId: `fake-command-${sequence}`, recordedAt: at,
    ...(["Time In", "Login"].includes(source) ? { shift: assignAttendanceShift(new Date(at)) } : {}) }));
  const snapshot = { records, sessions: projectAttendance(records).sessions };
  const before = JSON.stringify(snapshot);
  const result = attendanceDashboardPresentation(snapshot, settings, new Date(now));
  assert.equal(JSON.stringify(snapshot), before);
  return result;
}

test("dashboard reuses hub totals across an overnight month boundary without counting early time", () => {
  const rows: Array<[SessionEvent["source"], string]> = [
    ["Time In", "2026-09-30T14:50:00Z"], ["Break Out", "2026-09-30T17:00:00Z"], ["Break In", "2026-09-30T17:13:00Z"],
    ["Lunch Break Out", "2026-09-30T19:00:00Z"], ["Lunch Break In", "2026-09-30T19:59:00Z"], ["Time Out", "2026-10-01T00:00:00Z"],
  ];
  const now = "2026-10-01T01:00:00Z";
  const day = present(rows, now).dashboardDays[0];
  assert.equal(day.dayKey, "2026-09-30");
  assert.equal(day.milliseconds.online, 468 * 60_000);
  assert.equal(day.milliseconds.overBreak, 0); assert.equal(day.milliseconds.overLunch, 0);
  const hub = calculateHubDay(day.dayKey, rows.map(([source, at], i) => ({ id: `fake-${i}`, source, at: new Date(at) })),
    { officialShiftStartTime: "23:00", officialShiftEndTime: "08:00", lateGraceMinutes: 0, attendanceTimeZone: "Asia/Manila" }, new Date(now));
  assert.deepEqual(day.milliseconds, hub.milliseconds);
});

test("dashboard break details use configured clicked allowances, not fixed scheduled times", () => {
  const result = present([["Time In", "2026-10-15T15:00:00Z"], ["Break Out", "2026-10-15T18:03:00Z"],
    ["Break In", "2026-10-15T18:20:00Z"], ["Lunch Break Out", "2026-10-15T20:17:00Z"],
    ["Lunch Break In", "2026-10-15T20:39:00Z"], ["Time Out", "2026-10-16T00:00:00Z"]], "2026-10-16T01:00:00Z",
  { ...policy, breakMinutes: 10, lunchMinutes: 20 });
  const day = result.dashboardDays[0];
  assert.equal(day.milliseconds.overBreak, 7 * 60_000);
  assert.equal(day.milliseconds.overLunch, 2 * 60_000);
  assert.equal(day.overBreakRows.reduce((sum, row) => sum + row.overMs, 0), 9 * 60_000);
  assert.equal(day.overBreakRows[0].allowedMs, 10 * 60_000);
  assert.equal(day.overBreakRows[1].allowedMs, 20 * 60_000);
});

test("dashboard open breaks remain open with no fabricated checkout or undertime", () => {
  const result = present([["Time In", "2026-10-15T15:00:00Z"], ["Break Out", "2026-10-15T17:00:00Z"]], "2026-10-15T17:20:00Z");
  const day = result.dashboardDays[0];
  assert.equal(day.timeOut, null); assert.equal(day.milliseconds.underTime, 0);
  assert.equal(day.overBreakRows[0].endedAt, null); assert.equal(day.overBreakRows[0].isOpen, true);
  assert.equal(day.milliseconds.overBreak, 5 * 60_000);
});

test("shiftless legacy sessions retain every original event in the HR and Profile day group", () => {
  const records: SessionEvent[] = [
    ["Time In", "2026-10-12T15:00:00Z"], ["Break Out", "2026-10-12T17:00:00Z"],
    ["Break In", "2026-10-12T17:15:00Z"], ["Off the Phone Out", "2026-10-12T18:00:00Z"],
  ].map(([source, at], sequence) => ({ id: `legacy-${sequence}`, source: source as SessionEvent["source"],
    at: new Date(at).toISOString(), sequence, commandId: "legacy", recordedAt: at, legacyReviewed: true }));
  const projection = projectAttendance(records);
  assert.equal(projection.sessions[0].shift, null);
  const snapshot = { records: projection.effectiveEvents, sessions: projection.sessions }, before = JSON.stringify(snapshot);
  const settings = { officialShiftStartTime: "23:00", officialShiftEndTime: "08:00", lateGraceMinutes: 0, attendanceTimeZone: "Asia/Manila" };
  const groups = groupAttendanceByShiftDay(snapshot, settings);
  const profile = attendanceDashboardPresentation(snapshot, policy, new Date("2026-10-13T01:00:00Z"));
  assert.deepEqual(groups.get("2026-10-12")?.map(event => event.id), profile.dashboardDays[0].eventIds);
  assert.equal(groups.get("2026-10-12")?.length, 4);
  assert.equal(profile.dashboardDays[0].timeIn, records[0].at);
  assert.equal(JSON.stringify(snapshot), before);
});

test("canonical overnight assignment wins over the checkout timestamp day", () => {
  const shift = assignAttendanceShift(new Date("2026-10-13T15:00:00Z"));
  const records: SessionEvent[] = [
    { id: "assigned-in", source: "Time In", at: "2026-10-13T15:00:00.000Z", sequence: 1, commandId: "assigned", recordedAt: "2026-10-13T15:00:00.000Z", shift },
    { id: "assigned-out", source: "Time Out", at: "2026-10-14T00:05:00.000Z", sequence: 2, commandId: "assigned", recordedAt: "2026-10-14T00:05:00.000Z", autoTimeOut: true },
  ];
  const projection = projectAttendance(records), before = JSON.stringify(projection);
  const groups = groupAttendanceByShiftDay({ records: projection.effectiveEvents, sessions: projection.sessions },
    { officialShiftStartTime: "23:00", officialShiftEndTime: "08:00", lateGraceMinutes: 0, attendanceTimeZone: "Asia/Manila" });
  assert.deepEqual([...groups.keys()], ["2026-10-13"]);
  assert.deepEqual(groups.get("2026-10-13")?.map(event => event.id), ["assigned-in", "assigned-out"]);
  assert.equal(JSON.stringify(projection), before);
});

test("unpaired effective events remain visible but reversed events do not return", () => {
  const records: SessionEvent[] = [
    { id: "unpaired", source: "Break In", at: "2026-10-14T17:00:00.000Z", sequence: 1, commandId: "unpaired", recordedAt: "2026-10-14T17:00:00.000Z", legacyReviewed: true },
    { id: "reversed", source: "Time In", at: "2026-10-15T15:00:00.000Z", sequence: 2, commandId: "reversed", recordedAt: "2026-10-15T15:00:00.000Z" },
  ];
  const projection = projectAttendance(records, [{ commandId: "undo", targets: ["reversed"], reason: "Synthetic", actor: "test", at: "2026-10-16T01:00:00.000Z" }]);
  const groups = groupAttendanceByShiftDay({ records: projection.effectiveEvents, sessions: projection.sessions },
    { officialShiftStartTime: "23:00", officialShiftEndTime: "08:00", lateGraceMinutes: 0, attendanceTimeZone: "Asia/Manila" });
  assert.deepEqual([...groups.keys()], ["2026-10-14"]);
  assert.deepEqual(groups.get("2026-10-14")?.map(event => event.id), ["unpaired"]);
});
