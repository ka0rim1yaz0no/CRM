import assert from "node:assert/strict";
import test from "node:test";
import { canReserveCall, confirmedCallEnd, HEARTBEAT_INTERVAL_MS, IDLE_CONFIRMATION_MS, unconfirmedDialRetryAt } from "./callTiming";

const at = (milliseconds: number) => new Date(milliseconds);

test("first observed idle anchors exactly 30 seconds regardless of confirmation poll", () => {
  for (const confirmationDelay of [8_000, 9_000, 10_000, 12_000]) {
    const result = confirmedCallEnd(at(1_000), at(1_000 + confirmationDelay));
    assert.ok(result);
    assert.equal(result.nextCallAllowedAt.getTime() - result.endedAt.getTime(), 30_000);
    assert.equal(result?.endedAt.getTime(), 1_000);
  }
  assert.equal(confirmedCallEnd(at(1_000), at(1_000 + IDLE_CONFIRMATION_MS - 1)), null);
  assert.equal(HEARTBEAT_INTERVAL_MS, 5_000);
});

test("early dial and a second tab are rejected by the server clock", () => {
  const schedule = { nextCallAllowedAt: at(30_000), callLeaseUntil: null };
  assert.equal(canReserveCall(at(29_999), schedule), false);
  assert.equal(canReserveCall(at(30_000), schedule), true);
  assert.equal(canReserveCall(at(30_000), { ...schedule, callLeaseUntil: at(75_000) }), false);
});

test("sleep and wake use the current server time instead of a browser timer", () => {
  const schedule = { nextCallAllowedAt: at(30_000) };
  assert.equal(canReserveCall(at(10_000), schedule), false);
  assert.equal(canReserveCall(at(65_000), schedule), true);
});

test("unknown, stale, and active bridge states never permit a dial", () => {
  const schedule = { nextCallAllowedAt: at(30_000) };
  for (const bridge of [
    { state: "unknown", nextivaProcessDetected: true, fresh: true },
    { state: "active", nextivaProcessDetected: true, fresh: true },
    { state: "idle", nextivaProcessDetected: true, fresh: false },
    { state: "idle", nextivaProcessDetected: false, fresh: true },
  ]) assert.equal(canReserveCall(at(30_000), schedule, bridge), false);
  assert.equal(canReserveCall(at(30_000), schedule,
    { state: "idle", nextivaProcessDetected: true, fresh: true }), true);
});

test("a prior call without a confirmed end blocks a new reservation", () => {
  const bridge = { state: "idle", nextivaProcessDetected: true, fresh: true };
  assert.equal(canReserveCall(at(60_000), {
    nextCallAllowedAt: at(30_000), lastCallStartedAt: at(10_000), lastCallEndedAt: null,
  }, bridge), false);
  assert.equal(canReserveCall(at(60_000), {
    nextCallAllowedAt: at(30_000), lastCallStartedAt: at(10_000), lastCallEndedAt: at(20_000),
  }, bridge), true);
});

test("unconfirmed dial has one defined retry deadline", () => {
  assert.equal(unconfirmedDialRetryAt(at(1_000)).getTime(), 31_000);
});
