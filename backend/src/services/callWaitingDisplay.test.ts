import test from "node:test";
import assert from "node:assert/strict";
import { callWaitingStartedAt, dashboardCallStateAvailable } from "./callDashboardService";

const start = new Date("2026-10-30T15:00:00Z"), end = new Date("2026-10-31T00:00:00Z"), shift = { start, end };
const endedAt = new Date("2026-10-30T17:00:00.237Z");
test("waiting display keeps the confirmed call-end anchor across cooldown, Ready, dialing, reconnect and refresh in six business views", () => {
  const attendance = [{ source: "Time In", timeIn: start }];
  for (let business = 0; business < 6; business++) for (const offset of [0, 29999, 30000, 30001, 45000, 120000]) {
    const now = new Date(+endedAt + offset);
    const schedule = { lastCallEndedAt: endedAt, nextCallAllowedAt: new Date(+endedAt + 30000),
      lastDialStartedAt: offset >= 30000 ? new Date(+endedAt + 30000) : null, dialIntentUntil: new Date(+endedAt + 60000) };
    const before = JSON.stringify({ attendance, schedule });
    assert.equal(callWaitingStartedAt(attendance, schedule, shift, now)?.toISOString(), endedAt.toISOString());
    assert.equal(JSON.stringify({ attendance, schedule }), before);
  }
});
test("Coaching and other rest returns start a new waiting interval without counting away time", () => {
  for (const source of ["Coaching In", "Off the Phone In", "Break In", "Lunch Break In"]) {
    const returned = new Date(+endedAt + 1200000), now = new Date(+returned + 30000);
    const events = [{ source: "Time In", timeIn: start }, { source: "Coaching Out", timeIn: endedAt }, { source, timeIn: returned }];
    assert.equal(callWaitingStartedAt(events, { lastCallEndedAt: endedAt }, shift, now)?.toISOString(), returned.toISOString());
  }
});
test("outside-shift, future and missing evidence cannot invent a waiting timer", () => {
  assert.equal(callWaitingStartedAt([], {}, shift, endedAt), null);
  assert.equal(callWaitingStartedAt([{ source: "Time In", timeIn: new Date(+end + 1) }], { lastCallEndedAt: new Date(+end + 1) }, shift, endedAt), null);
  assert.equal(callWaitingStartedAt([{ source: "Time In", timeIn: start }], {}, shift, end), null);
  assert.equal(callWaitingStartedAt([{ source: "Time In", timeIn: new Date(+start - 60000) }], {}, shift, endedAt)?.toISOString(), start.toISOString());
});
test("unknown, stale, closed or conflicting Bridges keep calling unavailable without changing attendance display", () => {
  const idle = { state: "idle", audioSessionActive: false, nextivaProcessDetected: true, bridgeVersion: "0.5.0", lastSeenAt: endedAt, lastStateChangedAt: endedAt };
  assert.equal(dashboardCallStateAvailable("READY", [idle], endedAt), true);
  for (const device of [{ ...idle, state: "unknown" }, { ...idle, state: "active", audioSessionActive: true },
    { ...idle, nextivaProcessDetected: false }, { ...idle, lastSeenAt: new Date(+endedAt - 20001) }]) {
    assert.equal(dashboardCallStateAvailable("ONLINE", [device], endedAt), false);
  }
  assert.equal(dashboardCallStateAvailable("ONLINE", [], endedAt), false);
  assert.equal(dashboardCallStateAvailable("ONLINE", [idle, { ...idle, state: "active", audioSessionActive: true }], endedAt), false);
});
