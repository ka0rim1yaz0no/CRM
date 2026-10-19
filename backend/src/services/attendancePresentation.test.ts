import test from "node:test";
import assert from "node:assert/strict";
import { attendanceEventPresentation, attendanceOnlineActionLabel, compareAttendanceRecords, displayedAttendanceSession, formatAttendanceTimePair, mergeAttendanceHistory } from "../../../src/lib/attendancePresentation";

test("live refresh plus a saved action cannot double-count a canonical attendance event", () => {
  const start = { _id: "start", timeIn: "2026-10-20T00:00:00Z", sequence: 1 };
  const end = { _id: "end", timeIn: "2026-10-20T00:00:00Z", sequence: 2 };
  const refreshed = [end, start];
  const saved = mergeAttendanceHistory(refreshed, [end]);
  assert.equal(saved.length, 2);
  assert.deepEqual(saved.map((event) => event._id), ["end", "start"]);
  assert.deepEqual(mergeAttendanceHistory(saved, [start, end]), saved);
});

test("attendance returns retain distinct labels and activity colors without a rollout flag", () => {
  for (const [start, end, label] of [["Break Out", "Break In", "Break ended"], ["Lunch Break Out", "Lunch Break In", "Lunch ended"],
    ["Off the Phone Out", "Off the Phone In", "Off the phone ended"]]) {
    assert.equal(attendanceEventPresentation(end).label, label);
    assert.equal(attendanceEventPresentation(start).kind, attendanceEventPresentation(end).kind);
    assert.notEqual(attendanceEventPresentation(end).kind, "online");
  }
  assert.equal(attendanceEventPresentation("Time In").label, "ONLINE");
  assert.equal(attendanceEventPresentation("Time Out").label, "OFFLINE");
  assert.equal(attendanceEventPresentation().label, "No attendance yet");
});

test("the same manual return action has an explicit context-sensitive button label", () => {
  assert.equal(attendanceOnlineActionLabel("OFFLINE"), "Time in");
  assert.equal(attendanceOnlineActionLabel("BREAK"), "End break");
  assert.equal(attendanceOnlineActionLabel("LUNCH"), "End lunch");
  assert.equal(attendanceOnlineActionLabel("OFF THE PHONE"), "End off the phone");
  assert.equal(attendanceOnlineActionLabel("ONLINE"), "ONLINE");
});

test("manual checkout keeps the latest complete canonical session visible even across shift dates", () => {
    const earlier = { id: "old", startedAt: "2026-10-12T15:00:00Z", endedAt: null };
    const latest = { id: "latest", startedAt: "2026-10-15T15:00:00Z", endedAt: "2026-10-19T20:00:00Z" };
    assert.equal(displayedAttendanceSession([latest, earlier], null), latest);
    assert.equal(displayedAttendanceSession([latest, earlier], "old"), earlier);
    assert.equal(displayedAttendanceSession([], null), undefined);
});

test("simultaneous attendance events keep canonical sequence in forward and newest-first displays", () => {
  const rows = [{ source: "Time Out", timeIn: "2026-10-16T00:00:00Z", sequence: 3 },
    { source: "Off the Phone In", timeIn: "2026-10-16T00:00:00Z", sequence: 2 }];
  assert.deepEqual([...rows].sort(compareAttendanceRecords).map((row) => row.source), ["Off the Phone In", "Time Out"]);
  assert.deepEqual([...rows].sort((a, b) => compareAttendanceRecords(b, a)).map((row) => row.source), ["Time Out", "Off the Phone In"]);
});

test("an absent punch is never presented as a midnight punch", () => {
  assert.equal(formatAttendanceTimePair(undefined, undefined), "Not recorded - Not recorded");
  const open = formatAttendanceTimePair("2026-10-15T15:00:00Z", "");
  assert.match(open, /11:00:00 PM - Not recorded$/);
  assert.equal(formatAttendanceTimePair("invalid", undefined), "Not recorded - Not recorded");
});

test("real midnight and next-morning punches retain their original PH time labels", () => {
  const recorded = formatAttendanceTimePair("2026-10-15T16:00:00Z", "2026-10-16T00:00:00Z");
  assert.match(recorded, /12:00:00 AM - 8:00:00 AM$/);
  assert.doesNotMatch(recorded, /Not recorded/);
});
