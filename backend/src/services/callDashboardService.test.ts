import assert from "node:assert/strict";
import test from "node:test";
import { bridgeAvailabilityChangedAt, callDashboardStatus, currentAttendanceShift,
  offPhoneDashboardClock, offPhoneTimeInShift } from "./callDashboardService";
import { accountTime, bucketForAttendanceSource } from "./timeAccounting";

const at = (value: string) => new Date(value);

test("a new early Time In overrides the prior shift's clipped off-phone state without changing its totals", () => {
  const shift = { start: at("2026-10-22T15:00:00Z"), end: at("2026-10-23T00:00:00Z") };
  const now = at("2026-10-23T14:58:00Z");
  const attendance = [
    { source: "Time In" as const, timeIn: shift.start },
    { source: "Off the Phone Out" as const, timeIn: at("2026-10-22T23:52:25Z") },
    { source: "Time In" as const, timeIn: at("2026-10-23T13:31:58Z") },
  ];
  const accounted = accountTime(attendance.map(event => ({ at: event.timeIn, bucket: bucketForAttendanceSource(event.source)! })), shift.start, shift.end, now);
  assert.equal(accounted.state, "offPhone", "the previous shift's accounting window remains unchanged");
  assert.equal(accounted.milliseconds.offPhone, 455000);
  const status = callDashboardStatus({ availabilityStatus: "OFF THE PHONE", devices: [], attendance, shift, now });
  assert.equal(status.status, "ONLINE"); assert.equal(status.statusStartedAt, null); assert.equal(status.transitionUntil, null);
  assert.equal(status.detail, "Outside call shift", "an early Time In must not enable calling outside the call window");
  const clock = offPhoneDashboardClock({ totalMs: accounted.milliseconds.offPhone, state: accounted.state,
    stateSince: accounted.stateSince, shiftEnd: shift.end, now });
  assert.equal(clock.activeStartedAt, null); assert.equal(clock.completedMs, 455000);
});

test("post-shift presence follows the latest real action, not a clipped state or a future action", () => {
  const shift = { start: at("2026-10-22T15:00:00Z"), end: at("2026-10-23T00:00:00Z") };
  const now = at("2026-10-23T14:58:00Z");
  for (const [source, expected] of [["Time In", "ONLINE"], ["Login", "ONLINE"], ["Break In", "ONLINE"],
    ["Lunch Break In", "ONLINE"], ["Off the Phone In", "ONLINE"], ["Break Out", "BREAK"],
    ["Lunch Break Out", "LUNCH"], ["Off the Phone Out", "OFF THE PHONE"], ["Time Out", "OFFLINE"], ["Logout", "OFFLINE"]]) {
    const status = callDashboardStatus({ availabilityStatus: "OFFLINE", devices: [], shift, now,
      attendance: [{ source: "Time In", timeIn: shift.start }, { source, timeIn: at("2026-10-23T13:31:58Z") },
        { source: "Time Out", timeIn: at("2026-10-23T15:05:00Z") }] });
    assert.equal(status.status, expected, source); assert.equal(status.statusStartedAt, null);
  }
});

test("explicit OFFLINE attendance cannot be overridden by lingering bridge audio", () => {
  const shift = { start: at("2026-10-22T15:00:00Z"), end: at("2026-10-23T00:00:00Z") };
  const now = at("2026-10-22T17:00:00Z");
  const status = callDashboardStatus({ availabilityStatus: "OFFLINE", now, shift,
    attendance: [{ source: "Time In", timeIn: shift.start }, { source: "Time Out", timeIn: at("2026-10-22T16:59:00Z") }],
    devices: [{ bridgeVersion: "0.4.2", state: "active", audioSessionActive: true, nextivaProcessDetected: true,
      lastSeenAt: now, lastStateChangedAt: at("2026-10-22T16:58:00Z"), lastIdleAt: at("2026-10-22T16:57:00Z") }] });
  assert.equal(status.status, "OFFLINE");
});

test("a recorded checkout after the shift boundary overrides an older clipped ONLINE accounting state", () => {
  const shift = { start: at("2026-10-22T15:00:00Z"), end: at("2026-10-23T00:00:00Z") };
  const status = callDashboardStatus({ availabilityStatus: "ONLINE", now: at("2026-10-23T02:00:00Z"), shift, devices: [],
    attendance: [{ source: "Time In", timeIn: shift.start }, { source: "Time Out", timeIn: at("2026-10-23T00:05:00Z") }] });
  assert.equal(status.status, "OFFLINE");
});

test("selects the current overnight PH shift before and after midnight", () => {
  const duringEvening = currentAttendanceShift(at("2026-09-15T14:00:00Z"), "Asia/Manila", "23:00", "08:00");
  assert.equal(duringEvening.start.toISOString(), "2026-09-14T15:00:00.000Z");
  assert.equal(duringEvening.end.toISOString(), "2026-09-15T00:00:00.000Z");

  const duringNight = currentAttendanceShift(at("2026-09-15T17:00:00Z"), "Asia/Manila", "23:00", "08:00");
  assert.equal(duringNight.start.toISOString(), "2026-09-15T15:00:00.000Z");
  assert.equal(duringNight.end.toISOString(), "2026-09-16T00:00:00.000Z");
});

test("v2 uses the observed call start, break precedence, and a stale bridge state", () => {
  const previous = process.env.CRM_CALL_DASHBOARD_V2;
  process.env.CRM_CALL_DASHBOARD_V2 = "true";
  try {
    const shift = { start: at("2026-09-15T15:00:00Z"), end: at("2026-09-16T00:00:00Z") };
    const now = at("2026-09-15T16:10:00Z");
    const startedAt = at("2026-09-15T16:00:00Z");
    const device = { bridgeVersion: "0.4.1", state: "active", audioSessionActive: true,
      nextivaProcessDetected: true, lastSeenAt: at("2026-09-15T16:09:58Z"),
      lastStateChangedAt: at("2026-09-15T16:05:00Z"), lastIdleAt: at("2026-09-15T15:59:00Z") };
    const base = { availabilityStatus: "ONLINE", devices: [device], schedule: { lastCallStartedAt: startedAt },
      attendance: [{ source: "Time In", timeIn: shift.start }], now, shift };
    const active = callDashboardStatus(base);
    assert.equal(active.status, "ON CALL");
    assert.equal(active.statusStartedAt?.toISOString(), startedAt.toISOString());
    assert.equal(callDashboardStatus({ ...base, availabilityStatus: "BREAK" }).status, "BREAK");
    const disconnected = callDashboardStatus({ ...base, devices: [{ ...device, lastSeenAt: at("2026-09-15T16:09:00Z") }] });
    assert.equal(disconnected.status, "ONLINE");
    assert.equal(disconnected.statusStartedAt?.toISOString(), "2026-09-15T16:09:20.000Z");
    assert.equal(callDashboardStatus({ ...base, devices: [] }).status, "ONLINE");
  } finally {
    if (previous === undefined) delete process.env.CRM_CALL_DASHBOARD_V2;
    else process.env.CRM_CALL_DASHBOARD_V2 = previous;
  }
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
    bridgeVersion: "0.4.1",
    state: "idle",
    audioSessionActive: false,
    nextivaProcessDetected: true,
    lastSeenAt: at("2026-09-15T16:01:55Z"),
    lastStateChangedAt: at("2026-09-15T16:01:00Z"),
    lastIdleAt: at("2026-09-15T16:00:55Z"),
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
  assert.equal(launching.status, "ONLINE");
  assert.equal(launching.statusStartedAt?.toISOString(), dialStartedAt.toISOString());
  assert.equal(launching.transitionUntil?.toISOString(), dialIntentUntil.toISOString());

  const confirmedAt = at("2026-09-15T16:01:55Z");
  const confirmed = callDashboardStatus({ ...base, devices: [{ ...device, state: "active", audioSessionActive: true, lastStateChangedAt: confirmedAt }], schedule: { lastCallStartedAt: confirmedAt } });
  assert.equal(confirmed.status, "ON CALL");
  assert.equal(confirmed.statusStartedAt?.toISOString(), confirmedAt.toISOString());
  assert.equal(confirmed.transitionUntil, null);
  const staleSchedule = at("2026-09-15T15:01:00Z");
  const newerDeviceSession = at("2026-09-15T16:01:55Z");
  const activeWithStaleSchedule = callDashboardStatus({
    ...base,
    devices: [{ ...device, state: "active", audioSessionActive: true, lastStateChangedAt: newerDeviceSession }],
    schedule: { lastCallStartedAt: staleSchedule },
  });
  assert.equal(activeWithStaleSchedule.statusStartedAt?.toISOString(), newerDeviceSession.toISOString());
  assert.equal(callDashboardStatus({ ...base, devices: [{ ...device, state: "active", audioSessionActive: true, lastStateChangedAt: at("2026-09-15T16:01:55Z") }], availabilityStatus: "BREAK" }).status, "ON CALL");

  const outside = callDashboardStatus({ ...base, now: at("2026-09-16T01:00:00Z"), devices: [{ ...device, state: "active", lastSeenAt: at("2026-09-16T00:59:55Z") }] });
  assert.equal(outside.status, "ONLINE");
  assert.equal(outside.statusStartedAt, null);
});

test("v2 starts a pending-dial online timer when the dial begins", () => {
  const previous = process.env.CRM_CALL_DASHBOARD_V2;
  process.env.CRM_CALL_DASHBOARD_V2 = "true";
  try {
    const shift = { start: at("2026-09-15T15:00:00Z"), end: at("2026-09-16T00:00:00Z") };
    const status = callDashboardStatus({
      availabilityStatus: "ONLINE", attendance: [{ source: "Time In", timeIn: shift.start }],
      devices: [{ bridgeVersion: "0.4.1", state: "idle", audioSessionActive: false,
        nextivaProcessDetected: true, lastSeenAt: at("2026-09-15T16:02:00Z"),
        lastStateChangedAt: at("2026-09-15T16:00:00Z") }],
      schedule: { lastDialStartedAt: at("2026-09-15T16:01:50Z"), dialIntentUntil: at("2026-09-15T16:02:20Z") },
      now: at("2026-09-15T16:02:00Z"), shift,
    });
    assert.equal(status.status, "ONLINE");
    assert.equal(status.statusStartedAt?.toISOString(), "2026-09-15T16:01:50.000Z");
  } finally {
    if (previous === undefined) delete process.env.CRM_CALL_DASHBOARD_V2;
    else process.env.CRM_CALL_DASHBOARD_V2 = previous;
  }
});

test("bridge availability timestamp changes only when readiness or connectivity changes", () => {
  const previous = { state: "idle", nextivaProcessDetected: true,
    lastSeenAt: at("2026-10-15T16:52:10Z"),
    lastBridgeAvailabilityChangedAt: at("2026-10-15T16:50:00Z") };
  const now = at("2026-10-15T16:52:15Z");
  assert.equal(bridgeAvailabilityChangedAt(previous, { state: "idle", nextivaProcessDetected: true }, now),
    previous.lastBridgeAvailabilityChangedAt);
  assert.equal(bridgeAvailabilityChangedAt(previous, { state: "idle", nextivaProcessDetected: false }, now), now);
  assert.equal(bridgeAvailabilityChangedAt({ ...previous, lastSeenAt: at("2026-10-15T16:51:50Z") },
    { state: "idle", nextivaProcessDetected: true }, now), now);
  assert.equal(bridgeAvailabilityChangedAt(previous, { state: "active", nextivaProcessDetected: true }, now), now);
  assert.equal(bridgeAvailabilityChangedAt({ ...previous, lastBridgeAvailabilityChangedAt: null },
    { state: "idle", nextivaProcessDetected: true }, now), now);
});

test("v2 online timer starts at a bridge availability change, not an earlier time-in", () => {
  const previous = process.env.CRM_CALL_DASHBOARD_V2;
  process.env.CRM_CALL_DASHBOARD_V2 = "true";
  try {
    const shift = { start: at("2026-10-15T15:00:00Z"), end: at("2026-10-16T00:00:00Z") };
    const timeIn = at("2026-10-15T16:45:00Z");
    const changedAt = at("2026-10-15T16:52:30Z");
    const now = at("2026-10-15T16:52:35Z");
    const status = callDashboardStatus({ availabilityStatus: "ONLINE",
      attendance: [{ source: "Time In", timeIn }],
      devices: [{ bridgeVersion: "0.4.1", state: "idle", audioSessionActive: false,
        nextivaProcessDetected: false, lastSeenAt: now,
        lastStateChangedAt: at("2026-10-15T16:52:02Z"),
        lastBridgeAvailabilityChangedAt: changedAt }],
      schedule: { lastCallEndedAt: at("2026-10-15T16:52:00Z"),
        nextCallAllowedAt: at("2026-10-15T16:52:30Z") },
      now, shift });
    assert.equal(status.status, "ONLINE");
    assert.equal(status.statusStartedAt?.toISOString(), changedAt.toISOString());
  } finally {
    if (previous === undefined) delete process.env.CRM_CALL_DASHBOARD_V2;
    else process.env.CRM_CALL_DASHBOARD_V2 = previous;
  }
});

test("v2 online timer starts at bridge staleness after an active call", () => {
  const previous = process.env.CRM_CALL_DASHBOARD_V2;
  process.env.CRM_CALL_DASHBOARD_V2 = "true";
  try {
    const shift = { start: at("2026-10-15T15:00:00Z"), end: at("2026-10-16T00:00:00Z") };
    const lastSeenAt = at("2026-10-15T16:52:10Z");
    const status = callDashboardStatus({ availabilityStatus: "ONLINE",
      attendance: [{ source: "Time In", timeIn: shift.start }],
      devices: [{ bridgeVersion: "0.4.1", state: "active", audioSessionActive: true,
        nextivaProcessDetected: true, lastSeenAt,
        lastStateChangedAt: at("2026-10-15T16:52:00Z"),
        lastBridgeAvailabilityChangedAt: at("2026-10-15T16:52:00Z") }],
      now: at("2026-10-15T16:52:35Z"), shift });
    assert.equal(status.status, "ONLINE");
    assert.equal(status.statusStartedAt?.toISOString(), "2026-10-15T16:52:30.000Z");
  } finally {
    if (previous === undefined) delete process.env.CRM_CALL_DASHBOARD_V2;
    else process.env.CRM_CALL_DASHBOARD_V2 = previous;
  }
});

test("v2 unavailable-bridge timer starts when call waiting expires", () => {
  const previous = process.env.CRM_CALL_DASHBOARD_V2;
  process.env.CRM_CALL_DASHBOARD_V2 = "true";
  try {
    const shift = { start: at("2026-10-15T15:00:00Z"), end: at("2026-10-16T00:00:00Z") };
    const endedAt = at("2026-10-15T16:52:00Z");
    const waitingUntil = at("2026-10-15T16:52:30Z");
    const status = callDashboardStatus({ availabilityStatus: "ONLINE",
      attendance: [{ source: "Time In", timeIn: shift.start }],
      devices: [], schedule: { lastCallEndedAt: endedAt, nextCallAllowedAt: waitingUntil },
      now: at("2026-10-15T16:52:35Z"), shift });
    assert.equal(status.status, "ONLINE");
    assert.equal(status.statusStartedAt?.toISOString(), waitingUntil.toISOString());
  } finally {
    if (previous === undefined) delete process.env.CRM_CALL_DASHBOARD_V2;
    else process.env.CRM_CALL_DASHBOARD_V2 = previous;
  }
});

test("active off-phone time is split so the dashboard can tick it between polls", () => {
  const clock = offPhoneDashboardClock({ totalMs: 5 * 60_000, state: "offPhone",
    stateSince: at("2026-10-15T16:28:00Z"), shiftEnd: at("2026-10-16T00:00:00Z"),
    now: at("2026-10-15T16:30:00Z") });
  assert.equal(clock.completedMs, 3 * 60_000);
  assert.equal(clock.activeStartedAt?.toISOString(), "2026-10-15T16:28:00.000Z");
  assert.deepEqual(offPhoneDashboardClock({ totalMs: 5 * 60_000, state: "online",
    stateSince: at("2026-10-15T16:28:00Z"), shiftEnd: at("2026-10-16T00:00:00Z"),
    now: at("2026-10-15T16:30:00Z") }), { completedMs: 5 * 60_000, activeStartedAt: null });
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
  assert.equal(ended.status, "ONLINE");
  assert.equal(ended.statusStartedAt?.toISOString(), schedule.nextCallAllowedAt.toISOString());
  assert.equal(ended.detail, "Ready to dial");

  const noPreviousCall = callDashboardStatus({ ...base, now: at("2026-09-15T16:02:10Z") });
  assert.equal(noPreviousCall.status, "ONLINE");

  const stale = callDashboardStatus({ ...base, schedule, now: at("2026-09-15T16:02:10Z"), devices: [{ ...device, lastSeenAt: at("2026-09-15T16:01:00Z") }] });
  assert.equal(stale.status, "ONLINE");
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
  }).status, "ONLINE");

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

test("preserves online, break and lunch attendance states without a call bridge", () => {
  const shift = { start: at("2026-09-15T15:00:00Z"), end: at("2026-09-16T00:00:00Z") };
  const base = { attendance: [], devices: [], now: at("2026-09-15T16:00:00Z"), shift };

  assert.equal(callDashboardStatus({ ...base, availabilityStatus: "ONLINE" }).status, "ONLINE");
  assert.equal(callDashboardStatus({ ...base, availabilityStatus: "BREAK" }).status, "BREAK");
  assert.equal(callDashboardStatus({ ...base, availabilityStatus: "LUNCH" }).status, "LUNCH");
});

test("treats a fresh RingCentral device as ready without a Nextiva process", () => {
  const shift = { start: at("2026-09-15T15:00:00Z"), end: at("2026-09-16T00:00:00Z") };
  const now = at("2026-09-15T16:00:00Z");
  const result = callDashboardStatus({
    availabilityStatus: "ONLINE",
    attendance: [{ source: "Time In", timeIn: shift.start }],
    devices: [{
      state: "idle",
      audioSessionActive: false,
      nextivaProcessDetected: false,
      lastSeenAt: now,
      lastStateChangedAt: now,
    }],
    now,
    shift,
    provider: "ringcentral",
  });

  assert.equal(result.status, "ONLINE");
  assert.equal(result.detail, "Ready to dial");
});

test("does not display a pre-shift stale active state as a current call", () => {
  const shift = { start: at("2026-09-15T15:00:00Z"), end: at("2026-09-16T00:00:00Z") };
  const now = at("2026-09-15T16:00:00Z");
  const result = callDashboardStatus({
    availabilityStatus: "ONLINE",
    attendance: [{ source: "Time In", timeIn: shift.start }],
    devices: [{
      state: "active",
      audioSessionActive: true,
      nextivaProcessDetected: true,
      lastSeenAt: now,
      lastStateChangedAt: at("2026-09-15T14:59:00Z"),
    }],
    schedule: { lastCallStartedAt: at("2026-09-15T14:58:00Z") },
    now,
    shift,
    provider: "nextiva",
  });

  assert.equal(result.status, "ONLINE");
  assert.equal(result.detail, "Ready to dial");
});

test("does not display an idle audio session as an active call", () => {
  const shift = { start: at("2026-09-15T15:00:00Z"), end: at("2026-09-16T00:00:00Z") };
  const now = at("2026-09-15T16:00:00Z");
  const result = callDashboardStatus({
    availabilityStatus: "ONLINE",
    attendance: [{ source: "Time In", timeIn: shift.start }],
    devices: [{
      state: "active",
      audioSessionActive: false,
      nextivaProcessDetected: true,
      lastSeenAt: now,
      lastStateChangedAt: now,
    }],
    now,
    shift,
    provider: "nextiva",
  });

  assert.equal(result.status, "ONLINE");
  assert.notEqual(result.detail, "Nextiva call active");
});

test("does not trust an active audio session until this device observed idle", () => {
  const shift = { start: at("2026-09-15T15:00:00Z"), end: at("2026-09-16T00:00:00Z") };
  const now = at("2026-09-15T16:00:00Z");
  const result = callDashboardStatus({
    availabilityStatus: "ONLINE",
    attendance: [{ source: "Time In", timeIn: shift.start }],
    devices: [{
      state: "active",
      audioSessionActive: true,
      nextivaProcessDetected: true,
      lastSeenAt: now,
      lastStateChangedAt: now,
      lastIdleAt: null,
    }],
    now,
    shift,
    provider: "nextiva",
  });

  assert.equal(result.status, "ONLINE");
  assert.equal(result.detail, "Ready to dial");
});

test("uses the newest bridge device instead of a duplicate active device", () => {
  const shift = { start: at("2026-09-15T15:00:00Z"), end: at("2026-09-16T00:00:00Z") };
  const now = at("2026-09-15T16:00:00Z");
  const result = callDashboardStatus({
    availabilityStatus: "ONLINE",
    attendance: [{ source: "Time In", timeIn: shift.start }],
    devices: [
      {
        state: "active",
        audioSessionActive: true,
        nextivaProcessDetected: true,
        lastSeenAt: at("2026-09-15T15:59:55Z"),
        lastStateChangedAt: at("2026-09-15T15:50:00Z"),
      },
      {
        state: "idle",
        audioSessionActive: false,
        nextivaProcessDetected: true,
        lastSeenAt: at("2026-09-15T15:59:59Z"),
        lastStateChangedAt: at("2026-09-15T15:59:58Z"),
      },
    ],
    schedule: { lastCallStartedAt: at("2026-09-15T15:50:00Z") },
    now,
    shift,
    provider: "nextiva",
  });

  assert.equal(result.status, "ONLINE");
  assert.equal(result.detail, "Ready to dial");
});

test("expires an active audio signal that never reports the call ending", () => {
  const shift = { start: at("2026-09-15T15:00:00Z"), end: at("2026-09-16T00:00:00Z") };
  const now = at("2026-09-15T17:30:00Z");
  const result = callDashboardStatus({
    availabilityStatus: "ONLINE",
    attendance: [{ source: "Time In", timeIn: shift.start }],
    devices: [{
      bridgeVersion: "0.4.1",
      state: "active",
      audioSessionActive: true,
      nextivaProcessDetected: true,
      lastSeenAt: at("2026-09-15T17:29:59Z"),
      lastStateChangedAt: at("2026-09-15T15:15:00Z"),
    }],
    schedule: { lastCallStartedAt: at("2026-09-15T15:15:00Z") },
    now,
    shift,
    provider: "nextiva",
  });

  assert.equal(result.status, "ONLINE");
  assert.equal(result.detail, "Ready to dial");
});

test("expires a stuck active signal after thirty minutes", () => {
  const shift = { start: at("2026-09-15T15:00:00Z"), end: at("2026-09-16T00:00:00Z") };
  const startedAt = at("2026-09-15T16:00:00Z");
  const result = callDashboardStatus({
    availabilityStatus: "ONLINE",
    attendance: [{ source: "Time In", timeIn: shift.start }],
    devices: [{
      bridgeVersion: "0.4.1",
      state: "active",
      audioSessionActive: true,
      nextivaProcessDetected: true,
      lastSeenAt: at("2026-09-15T16:30:01Z"),
      lastStateChangedAt: startedAt,
      lastIdleAt: at("2026-09-15T15:59:00Z"),
    }],
    schedule: { lastCallStartedAt: startedAt },
    now: at("2026-09-15T16:30:01Z"),
    shift,
    provider: "nextiva",
  });

  assert.equal(result.status, "ONLINE");
  assert.equal(result.detail, "Ready to dial");
});

test("v2 starts a manual call timer at the fresh bridge transition, not a stale schedule", () => {
  const previous = process.env.CRM_CALL_DASHBOARD_V2;
  process.env.CRM_CALL_DASHBOARD_V2 = "true";
  try {
    const startedAt = at("2026-10-13T16:31:55Z");
    const result = callDashboardStatus({
      availabilityStatus: "ONLINE",
      attendance: [{ source: "Time In", timeIn: at("2026-10-13T15:00:00Z") }],
      devices: [{ bridgeVersion: "0.4.1", state: "active", audioSessionActive: true,
        nextivaProcessDetected: true, lastSeenAt: at("2026-10-13T16:32:00Z"),
        lastStateChangedAt: startedAt, lastIdleAt: at("2026-10-13T16:31:40Z") }],
      schedule: { lastCallStartedAt: at("2026-10-13T15:05:00Z") },
      now: at("2026-10-13T16:32:01Z"),
      shift: { start: at("2026-10-13T15:00:00Z"), end: at("2026-10-14T00:00:00Z") },
      provider: "nextiva",
    });
    assert.equal(result.status, "ON CALL");
    assert.equal(result.statusStartedAt?.toISOString(), startedAt.toISOString());

    const laterReservation = callDashboardStatus({
      availabilityStatus: "ONLINE",
      attendance: [{ source: "Time In", timeIn: at("2026-10-13T15:00:00Z") }],
      devices: [{ bridgeVersion: "0.4.1", state: "active", audioSessionActive: true,
        nextivaProcessDetected: true, lastSeenAt: at("2026-10-13T16:32:00Z"),
        lastStateChangedAt: startedAt, lastIdleAt: at("2026-10-13T16:31:40Z") }],
      schedule: { lastCallStartedAt: at("2026-10-13T16:31:58Z") },
      now: at("2026-10-13T16:32:01Z"),
      shift: { start: at("2026-10-13T15:00:00Z"), end: at("2026-10-14T00:00:00Z") },
      provider: "nextiva",
    });
    assert.equal(laterReservation.statusStartedAt?.toISOString(), startedAt.toISOString());
  } finally {
    if (previous === undefined) delete process.env.CRM_CALL_DASHBOARD_V2;
    else process.env.CRM_CALL_DASHBOARD_V2 = previous;
  }
});

test("rejects a legacy audio signal that starts after the confirmed call ended", () => {
  const shift = { start: at("2026-10-13T15:00:00Z"), end: at("2026-10-14T00:00:00Z") };
  const result = callDashboardStatus({
    availabilityStatus: "ONLINE",
    attendance: [{ source: "Time In", timeIn: shift.start }],
    devices: [{
      bridgeVersion: "0.4.0",
      state: "active",
      audioSessionActive: true,
      nextivaProcessDetected: true,
      lastSeenAt: at("2026-10-13T16:50:12Z"),
      lastStateChangedAt: at("2026-10-13T16:31:55Z"),
      lastIdleAt: at("2026-10-13T16:31:20Z"),
    }],
    schedule: {
      lastDialStartedAt: at("2026-10-13T16:30:30Z"),
      lastCallStartedAt: at("2026-10-13T16:30:35Z"),
      lastCallEndedAt: at("2026-10-13T16:31:18Z"),
    },
    now: at("2026-10-13T16:50:14Z"),
    shift,
    provider: "nextiva",
  });

  assert.equal(result.status, "ONLINE");
  assert.equal(result.detail, "Ready to dial");
});
