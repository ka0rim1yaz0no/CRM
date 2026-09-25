import assert from "node:assert/strict";
import test from "node:test";
import {
  browserSessionFreshnessMs,
  latestDate,
  normalizeBrowserSessionStartedAt,
  shouldRejectOlderBrowserSession,
} from "./callBridgeSession";

test("a fresh newer browser session blocks an older tab", () => {
  const now = new Date("2026-09-25T12:00:00.000Z");

  assert.equal(
    shouldRejectOlderBrowserSession(
      {
        browserSessionId: "new-session",
        browserSessionStartedAt: new Date(now.getTime() - 1_000),
        browserSessionLastSeenAt: now,
      },
      "old-session",
      new Date(now.getTime() - 10_000),
      now
    ),
    true
  );
});

test("a newer login can replace a fresh older browser session", () => {
  const now = new Date("2026-09-25T12:00:00.000Z");

  assert.equal(
    shouldRejectOlderBrowserSession(
      {
        browserSessionId: "old-session",
        browserSessionStartedAt: new Date(now.getTime() - 10_000),
        browserSessionLastSeenAt: now,
      },
      "new-session",
      new Date(now.getTime() - 1_000),
      now
    ),
    false
  );
});

test("a stale tab cannot permanently keep the computer", () => {
  const now = new Date("2026-09-25T12:00:00.000Z");

  assert.equal(
    shouldRejectOlderBrowserSession(
      {
        browserSessionId: "old-session",
        browserSessionStartedAt: new Date(now.getTime() + 1_000),
        browserSessionLastSeenAt: new Date(now.getTime() - browserSessionFreshnessMs - 1),
      },
      "replacement-session",
      new Date(now.getTime() - 10_000),
      now
    ),
    false
  );
});

test("session times are validated and cooldown dates keep the latest value", () => {
  const now = new Date("2026-09-25T12:00:00.000Z");

  assert.equal(normalizeBrowserSessionStartedAt("invalid", now), null);
  assert.equal(
    normalizeBrowserSessionStartedAt(now.getTime() + 60 * 60 * 1000, now)?.getTime(),
    now.getTime() + 5 * 60 * 1000
  );
  assert.equal(
    latestDate(new Date(now.getTime() - 1_000), new Date(now.getTime() + 1_000))?.getTime(),
    now.getTime() + 1_000
  );
});
