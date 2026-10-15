import assert from "node:assert/strict";
import test from "node:test";
import {
  hasReliableTwoWayAudioDetection,
  hasTrackedActiveCall,
  isTrustedBridgeActiveSignal,
  shouldStartNewObservedCall,
} from "./callBridgeActiveSignal";

const at = (value: string) => new Date(value);
const activeDevice = {
  state: "active",
  audioSessionActive: true,
  lastIdleAt: at("2026-10-13T16:30:00Z"),
  lastStateChangedAt: at("2026-10-13T16:31:55Z"),
};

test("recognizes bridge 0.4.1 and newer as reliable two-way detectors", () => {
  assert.equal(hasReliableTwoWayAudioDetection("0.4.0"), false);
  assert.equal(hasReliableTwoWayAudioDetection("0.4.1"), true);
  assert.equal(hasReliableTwoWayAudioDetection("1.0.0"), true);
});

test("rejects legacy audio that appears after the confirmed call ended", () => {
  assert.equal(isTrustedBridgeActiveSignal(
    { ...activeDevice, bridgeVersion: "0.4.0" },
    {
      lastDialStartedAt: at("2026-10-13T16:30:20Z"),
      lastCallEndedAt: at("2026-10-13T16:31:18Z"),
    }
  ), false);
});

test("accepts legacy audio only for a fresh unended dial", () => {
  assert.equal(isTrustedBridgeActiveSignal(
    { ...activeDevice, bridgeVersion: "0.4.0" },
    {
      lastDialStartedAt: at("2026-10-13T16:31:50Z"),
      lastCallEndedAt: at("2026-10-13T16:30:00Z"),
    }
  ), true);
});

test("tracks a started call until a matching later end", () => {
  assert.equal(hasTrackedActiveCall({
    lastDialStartedAt: at("2026-10-13T16:31:50Z"),
    lastCallStartedAt: at("2026-10-13T16:31:55Z"),
    lastCallEndedAt: at("2026-10-13T16:31:18Z"),
  }), true);
  assert.equal(hasTrackedActiveCall({
    lastDialStartedAt: at("2026-10-13T16:31:50Z"),
    lastCallStartedAt: at("2026-10-13T16:31:55Z"),
    lastCallEndedAt: at("2026-10-13T16:32:10Z"),
  }), false);
  assert.equal(hasTrackedActiveCall({
    lastCallStartedAt: at("2026-10-13T16:31:55Z"),
    lastCallEndedAt: at("2026-10-13T16:31:18Z"),
  }), false);
});

test("a fresh idle-to-active call replaces a stale unended timer", () => {
  const stale = { lastCallStartedAt: at("2026-10-13T15:00:00Z"), lastCallEndedAt: null };
  assert.equal(shouldStartNewObservedCall("idle", stale), true);
  assert.equal(shouldStartNewObservedCall("active", stale), false);
  assert.equal(shouldStartNewObservedCall("unknown", stale), false);
});
