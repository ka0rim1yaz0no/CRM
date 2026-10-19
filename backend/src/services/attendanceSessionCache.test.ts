import assert from "node:assert/strict";
import test from "node:test";
import { attendanceSessionCacheKey, retainAttendanceSnapshot } from "../../../src/lib/attendanceSessionCache";
import { attendanceServerNow } from "../../../src/lib/attendanceHubState";

const snapshot = (revision: number, serverTime: string, state = "ONLINE") => ({
  revision, serverTime, state, receivedAt: 0, records: [], sessions: [], review: [], reviewState: "verified",
});

test("attendance responses retain the request's business and authenticated-session scope", () => {
  const cache = new Map<string, ReturnType<typeof snapshot>>();
  const a = attendanceSessionCacheKey("employee:fake:session-one", "business-a", "fake-id");
  const b = attendanceSessionCacheKey("employee:fake:session-one", "business-b", "fake-id");
  const login = attendanceSessionCacheKey("employee:fake:session-two", "business-a", "fake-id");
  retainAttendanceSnapshot(cache, b, snapshot(2, "2026-10-19T16:00:00Z"), 1000);
  retainAttendanceSnapshot(cache, a, snapshot(1, "2026-10-19T15:00:00Z", "OFFLINE"), 2000);
  assert.equal(cache.get(b)?.revision, 2);
  assert.equal(cache.get(a)?.state, "OFFLINE");
  assert.equal(cache.has(login), false, "a new sign-in must not inherit stale state or commands");
});

test("older attendance snapshots never rewind timers or override newer manual actions", () => {
  const cache = new Map<string, ReturnType<typeof snapshot>>();
  const current = snapshot(4, "2026-10-19T16:00:00Z", "BREAK");
  const accepted = retainAttendanceSnapshot(cache, "fake", current, 1000);
  assert.equal(retainAttendanceSnapshot(cache, "fake", snapshot(3, "2026-10-19T17:00:00Z"), 2000), accepted);
  assert.equal(retainAttendanceSnapshot(cache, "fake", snapshot(4, "2026-10-19T15:59:00Z"), 3000), accepted);
  assert.equal(cache.get("fake")?.receivedAt, 1000);
  const refreshed = retainAttendanceSnapshot(cache, "fake", snapshot(4, "2026-10-19T16:01:00Z", "BREAK"), 61_000);
  assert.equal(attendanceServerNow(refreshed.serverTime, refreshed.receivedAt, 62_000), Date.parse("2026-10-19T16:01:01Z"));
});
