import assert from "node:assert/strict";
import test from "node:test";
import { callDashboardStatus, currentAttendanceShift, offPhoneTimeInShift } from "./callDashboardService";

const at = (value: string) => new Date(value);

test("selects the current overnight PH shift before and after midnight", () => {
  const duringEvening = currentAttendanceShift(at("2026-09-15T14:00:00Z"), "Asia/Manila", "23:00", "08:00");
  assert.equal(duringEvening.start.toISOString(), "2026-09-14T15:00:00.000Z");
  assert.equal(duringEvening.end.toISOString(), "2026-09-15T00:00:00.000Z");

  const duringNight = currentAttendanceShift(at("2026-09-15T17:00:00Z"), "Asia/Manila", "23:00", "08:00");
  assert.equal(duringNight.start.toISOString(), "2026-09-15T15:00:00.000Z");
  assert.equal(duringNight.end.toISOString(), "2026-09-16T00:00:00.000Z");
});

test("adds completed and active off-phone sessions without crossing shift boundaries", () => {
  const start = at("2026-09-15T15:00:00Z");
  const end = at("2026-09-16T00:00:00Z");
  const events = [
    { source: "Off the Phone Out", timeIn: at("2026-09-15T14:50:00Z") },
    { source: "Off the Phone In", timeIn: at("2026-09-15T15:10:00Z") },
    { source: "Off the Phone Out", timeIn: at("2026-09-15T16:00:00Z") },
  ];
  const live = offPhoneTimeInShift(events, start, end, at("2026-09-15T16:05:00Z"));
  assert.equal(live.completedMs, 10 * 60_000);
  assert.equal(live.totalMs, 15 * 60_000);
  assert.equal(live.activeStartedAt?.toISOString(), "2026-09-15T16:00:00.000Z");

  const finished = offPhoneTimeInShift(events, start, end, at("2026-09-16T01:00:00Z"));
  assert.equal(finished.totalMs, (10 + 8 * 60) * 60_000);
  assert.equal(finished.activeStartedAt, null);
});

test("closes an off-phone session at time out", () => {
  const result = offPhoneTimeInShift([
    { source: "Off the Phone Out", timeIn: at("2026-09-15T16:00:00Z") },
    { source: "Time Out", timeIn: at("2026-09-15T16:12:00Z") },
  ], at("2026-09-15T15:00:00Z"), at("2026-09-16T00:00:00Z"), at("2026-09-15T17:00:00Z"));
  assert.equal(result.totalMs, 12 * 60_000);
});

test("dial launch is provisional until Nextiva activity, and call status stays inside the shift", () => {
  const shift = { start: at("2026-09-15T15:00:00Z"), end: at("2026-09-16T00:00:00Z") };
  const device = {
    state: "idle",
    audioSessionActive: false,
    nextivaProcessDetected: true,
    lastSeenAt: at("2026-09-15T16:01:55Z"),
    lastStateChangedAt: at("2026-09-15T16:01:00Z"),
  };
  const base = {
    availabilityStatus: "ONLINE",
    attendance: [{ source: "Time In", timeIn: at("2026-09-15T15:00:00Z") }],
    devices: [device],
    now: at("2026-09-15T16:02:00Z"),
    shift,
  };
  const dialStartedAt = at("2026-09-15T16:01:50Z");
  const dialIntentUntil = at("2026-09-15T16:02:20Z");
  const launching = callDashboardStatus({ ...base, schedule: { lastDialStartedAt: dialStartedAt, dialIntentUntil } });
  assert.equal(launching.status, "OFFLINE");
  assert.equal(launching.statusStartedAt?.toISOString(), dialStartedAt.toISOString());
  assert.equal(launching.transitionUntil?.toISOString(), dialIntentUntil.toISOString());

  const confirmedAt = at("2026-09-15T16:01:55Z");
  const confirmed = callDashboardStatus({ ...base, devices: [{ ...device, state: "active", lastStateChangedAt: confirmedAt }], schedule: { lastCallStartedAt: confirmedAt } });
  assert.equal(confirmed.status, "ON CALL");
  assert.equal(confirmed.statusStartedAt?.toISOString(), confirmedAt.toISOString());
  assert.equal(confirmed.transitionUntil, null);
  assert.equal(callDashboardStatus({ ...base, devices: [{ ...device, state: "active", lastStateChangedAt: at("2026-09-15T16:01:55Z") }], availabilityStatus: "BREAK" }).status, "ON CALL");

  const outside = callDashboardStatus({ ...base, now: at("2026-09-16T01:00:00Z"), devices: [{ ...device, state: "active", lastSeenAt: at("2026-09-16T00:59:55Z") }] });
  assert.equal(outside.status, "OFFLINE");
  assert.equal(outside.statusStartedAt, null);
});

test("call waiting is only the 30 seconds after a call ends", () => {
  const shift = { start: at("2026-09-15T15:00:00Z"), end: at("2026-09-16T00:00:00Z") };
  const endedAt = at("2026-09-15T16:02:00Z");
  const device = {
    state: "idle",
    audioSessionActive: false,
    nextivaProcessDetected: true,
    lastSeenAt: at("2026-09-15T16:02:10Z"),
    lastStateChangedAt: endedAt,
  };
  const base = {
    availabilityStatus: "ONLINE",
    attendance: [{ source: "Time In", timeIn: shift.start }],
    devices: [device],
    shift,
  };
  const schedule = { lastCallEndedAt: endedAt, nextCallAllowedAt: at("2026-09-15T16:02:30Z") };
  const waiting = callDashboardStatus({ ...base, schedule, now: at("2026-09-15T16:02:10Z") });
  assert.equal(waiting.status, "CALL WAITING");
  assert.equal(waiting.statusStartedAt?.toISOString(), endedAt.toISOString());
  assert.equal(waiting.transitionUntil?.toISOString(), schedule.nextCallAllowedAt.toISOString());

  const ended = callDashboardStatus({ ...base, schedule, now: at("2026-09-15T16:02:30Z"), devices: [{ ...device, lastSeenAt: at("2026-09-15T16:02:30Z") }] });
  assert.equal(ended.status, "OFFLINE");
  assert.equal(ended.statusStartedAt?.toISOString(), schedule.nextCallAllowedAt.toISOString());
  assert.equal(ended.detail, "Ready to dial");

  const noPreviousCall = callDashboardStatus({ ...base, now: at("2026-09-15T16:02:10Z") });
  assert.equal(noPreviousCall.status, "OFFLINE");

  const stale = callDashboardStatus({ ...base, schedule, now: at("2026-09-15T16:02:10Z"), devices: [{ ...device, lastSeenAt: at("2026-09-15T16:01:00Z") }] });
  assert.equal(stale.status, "OFFLINE");
});

test("off-the-phone availability is its own status and uses the open attendance punch", () => {
  const shift = { start: at("2026-09-15T15:00:00Z"), end: at("2026-09-16T00:00:00Z") };
  const outAt = at("2026-09-15T16:00:00Z");
  const attendance = [
    { source: "Time In", timeIn: shift.start },
    { source: "Off the Phone Out", timeIn: outAt },
  ];
  const now = at("2026-09-15T16:05:00Z");
  const offPhone = offPhoneTimeInShift(attendance, shift.start, shift.end, now);
  const status = callDashboardStatus({
    availabilityStatus: "OFF THE PHONE",
    attendance,
    offPhoneStartedAt: offPhone.activeStartedAt,
    devices: [],
    now,
    shift,
  });
  assert.equal(status.status, "OFF THE PHONE");
  assert.equal(status.statusStartedAt?.toISOString(), outAt.toISOString());
  assert.equal(offPhone.totalMs, 5 * 60_000);

  const endedAttendance = [...attendance, { source: "Off the Phone In", timeIn: at("2026-09-15T16:06:00Z") }];
  const endedOffPhone = offPhoneTimeInShift(endedAttendance, shift.start, shift.end, at("2026-09-15T16:07:00Z"));
  assert.equal(endedOffPhone.activeStartedAt, null);
  assert.equal(callDashboardStatus({
    availabilityStatus: "ONLINE",
    attendance: endedAttendance,
    offPhoneStartedAt: endedOffPhone.activeStartedAt,
    devices: [],
    now: at("2026-09-15T16:07:00Z"),
    shift,
  }).status, "OFFLINE");

  const outside = callDashboardStatus({
    availabilityStatus: "OFF THE PHONE",
    attendance,
    devices: [],
    now: at("2026-09-16T01:00:00Z"),
    shift,
  });
  assert.equal(outside.status, "OFF THE PHONE");
  assert.equal(outside.statusStartedAt, null);
});
