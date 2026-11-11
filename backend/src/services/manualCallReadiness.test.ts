import assert from "node:assert/strict";
import test from "node:test";
import { manualCallEndPending } from "./manualCallReadiness";

const now = new Date("2026-10-31T00:00:00Z"), start = new Date(+now - 60_000);
const schedule = { lastCallStartedAt: start, lastCallEndedAt: null };
const confirming = { state: "active", audioSessionActive: false, nextivaProcessDetected: true, bridgeVersion: "0.5.0",
  lastSeenAt: now, inactiveSince: new Date(+now - 5_000), lastIdleAt: new Date(+start - 10_000) };

test("manual end waiting needs fresh inactive audio proof on every device, not an invented call end", () => {
  assert.equal(manualCallEndPending([confirming], schedule, now), true);
  assert.equal(manualCallEndPending([{ ...confirming, state: "idle", lastIdleAt: now }], schedule, now), true);
  for (const changes of [{ audioSessionActive: true }, { state: "unknown" }, { nextivaProcessDetected: false },
    { inactiveSince: null }, { inactiveSince: new Date(+start - 1) }, { inactiveSince: new Date(+now + 1) },
    { bridgeVersion: "0.4.0" }, { lastSeenAt: new Date(+now - 20_001) }]) {
    assert.equal(manualCallEndPending([{ ...confirming, ...changes }], schedule, now), false);
  }
  assert.equal(manualCallEndPending([confirming, { ...confirming, audioSessionActive: true }], schedule, now), false);
  assert.equal(manualCallEndPending([], schedule, now), false);
  assert.equal(manualCallEndPending([confirming], { ...schedule, lastCallEndedAt: now }, now), false);
  assert.equal(manualCallEndPending([{ ...confirming, state: "idle", lastIdleAt: new Date(+start - 1) }], schedule, now), false);
});
