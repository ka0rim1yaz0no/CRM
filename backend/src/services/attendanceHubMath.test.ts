import assert from "node:assert/strict";
import test from "node:test";
import { calculateHubDay, hubDayKey, hubShiftBounds, type HubEvent, type HubSettings } from "./attendanceHubMath";

const settings: HubSettings = { officialShiftStartTime: "23:00", officialShiftEndTime: "08:00", lateGraceMinutes: 0, attendanceTimeZone: "Asia/Manila" };
const start = "2026-10-31";
const time = (minutes: number) => new Date(hubShiftBounds(start, settings).start.getTime() + minutes * 60_000);
const event = (source: HubEvent["source"], minutes: number, id = `${source}-${minutes}`): HubEvent => ({ source, at: time(minutes), id });
const minutes = (value: number) => value / 60_000;

test("overnight shift belongs to starting day across a month boundary", () => {
  assert.equal(hubDayKey(time(60), settings), start);
  assert.equal(hubDayKey(time(530), settings), start);
  assert.equal(hubShiftBounds(start, settings).end.toISOString(), "2026-11-01T00:00:00.000Z");
});

test("online excludes break and lunch and reports each excess separately", () => {
  const day = calculateHubDay(start, [event("Time In", 0), event("Break Out", 120), event("Break In", 140),
    event("Lunch Break Out", 240), event("Lunch Break In", 305), event("Time Out", 540)], settings, time(600));
  assert.equal(minutes(day.milliseconds.online), 455);
  assert.equal(minutes(day.milliseconds.break), 20);
  assert.equal(minutes(day.milliseconds.lunch), 65);
  assert.equal(minutes(day.milliseconds.overBreak), 5);
  assert.equal(minutes(day.milliseconds.overLunch), 5);
  assert.equal(day.status, "Present");
});

test("late, early-out and overtime are measured against the shift window", () => {
  const late = calculateHubDay(start, [event("Time In", 12), event("Time Out", 510)], settings, time(600));
  assert.equal(minutes(late.milliseconds.late), 12);
  assert.equal(minutes(late.milliseconds.underTime), 30);
  assert.ok(late.issues.includes("UNDER TIME"));
  const overtime = calculateHubDay(start, [event("Time In", -10), event("Time Out", 570)], settings, time(600));
  assert.equal(minutes(overtime.milliseconds.online), 540);
  assert.equal(minutes(overtime.milliseconds.overtime), 30);
});

test("two separate breaks each receive their allowance without sharing unused minutes", () => {
  const regular = calculateHubDay(start, [event("Time In", 0), event("Break Out", 120), event("Break In", 135),
    event("Break Out", 420), event("Break In", 435), event("Time Out", 540)], settings, time(600));
  assert.equal(minutes(regular.milliseconds.break), 30);
  assert.equal(regular.milliseconds.overBreak, 0);
  assert.ok(!regular.issues.includes("OVER BREAK"));
  const excess = calculateHubDay(start, [event("Time In", 0), event("Break Out", 120), event("Break In", 140),
    event("Break Out", 420), event("Break In", 430), event("Time Out", 510)], settings, time(600));
  assert.equal(minutes(excess.milliseconds.break), 30);
  assert.equal(minutes(excess.milliseconds.overBreak), 5);
  assert.ok(excess.issues.includes("OVER BREAK"));
  assert.ok(excess.issues.includes("UNDER TIME"));
});

test("a missing manual checkout stays open after shift end without an undertime verdict", () => {
  const open = calculateHubDay(start, [event("Time In", 500)], settings, time(600));
  assert.equal(open.timeOut, null);
  assert.equal(open.milliseconds.underTime, 0);
  assert.ok(open.issues.includes("OPEN SESSION"));
  assert.ok(!open.issues.includes("UNDER TIME"));
  const excused = calculateHubDay(start, [event("Time In", 0), event("Time Out", 510)], settings, time(600), true);
  assert.equal(excused.milliseconds.underTime, 0);
  assert.ok(!excused.issues.includes("UNDER TIME"));
});

test("open shift is not prematurely under time and unclosed break stays in break", () => {
  const day = calculateHubDay(start, [event("Time In", 0), event("Break Out", 120)], settings, time(160));
  assert.equal(day.inProgress, true);
  assert.equal(day.milliseconds.underTime, 0);
  assert.equal(minutes(day.milliseconds.online), 120);
  assert.equal(minutes(day.milliseconds.break), 40);
  assert.equal(minutes(day.milliseconds.overBreak), 25);
  assert.ok(!day.review.includes("Unclosed break"));
  assert.ok(calculateHubDay(start, [event("Time In", 0), event("Break Out", 120)], settings, time(600)).review.includes("Unclosed break"));
});

test("second lunch and duplicate events need review; excuse suppresses issue totals", () => {
  const source = [event("Time In", 20), event("Lunch Break Out", 100), event("Lunch Break In", 170),
    event("Lunch Break Out", 180), event("Lunch Break Out", 181)];
  const day = calculateHubDay(start, source, settings, time(200), true);
  assert.ok(day.review.includes("Second lunch attempt"));
  assert.ok(day.review.includes("Duplicate Lunch Break Out"));
  assert.equal(day.milliseconds.late, 0);
  assert.equal(day.milliseconds.overLunch, 0);
  assert.ok(day.issues.includes("EXCUSED"));
});
test("separate sessions on one shift day retain their offline gap and an open latest session", () => {
  const settings = { officialShiftStartTime: "23:00", officialShiftEndTime: "08:00", attendanceTimeZone: "Asia/Manila", lateGraceMinutes: 0 };
  const events = [["Time In", "2026-10-15T15:00:00Z"], ["Time Out", "2026-10-15T16:00:00Z"], ["Time In", "2026-10-15T17:00:00Z"]]
    .map(([source, at], index) => ({ id: String(index), source: source as import("../models/Attendance").AttendanceSource, at: new Date(at) }));
  const day = calculateHubDay("2026-10-15", events, settings, new Date("2026-10-15T18:00:00Z"));
  assert.equal(day.inProgress, true); assert.equal(day.timeOut, null); assert.equal(day.milliseconds.online, 2 * 3_600_000);
  assert.equal(day.milliseconds.offline, 3_600_000); assert.equal(day.milliseconds.underTime, 0);
});

test("canonical sequence, not random event IDs, orders a simultaneous off-phone return and checkout", () => {
  const events: Array<HubEvent & { sequence: number }> = [
    { ...event("Time In", 0, "start"), sequence: 1 },
    { ...event("Off the Phone Out", 60, "off-phone"), sequence: 2 },
    { ...event("Off the Phone In", 120, "z-return"), sequence: 3 },
    { ...event("Time Out", 120, "a-checkout"), sequence: 4 },
  ];
  const day = calculateHubDay(start, [...events].reverse(), settings, time(600));
  assert.deepEqual(day.review, []);
  assert.equal(day.status, "Present");
  assert.equal(day.timeOut, time(120).toISOString());
  assert.equal(minutes(day.milliseconds.online), 60);
  assert.equal(minutes(day.milliseconds.offPhone), 60);
  assert.equal(minutes(day.milliseconds.offline), 420);
  assert.equal(minutes(day.milliseconds.underTime), 420);
  assert.ok(!day.issues.includes("OPEN SESSION"));
});
