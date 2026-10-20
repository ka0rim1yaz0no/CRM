import assert from "node:assert/strict";
import test from "node:test";
import { deriveAttendanceDays } from "./attendanceDerived";
import { assignAttendanceShift } from "./attendanceShift";
import type { SessionEvent } from "./attendanceSessionState";

const policy = { breakMinutes: 15, lunchMinutes: 60, graceMinutes: 5, shiftStart: "23:00", shiftEnd: "08:00", revision: 2 };
const now = new Date("2026-10-16T02:00:00Z");
function events(rows: Array<[SessionEvent["source"], string]>): SessionEvent[] {
  return rows.map(([source, at], sequence) => ({ id: `event-${sequence}`, source, at: new Date(at).toISOString(), sequence,
    commandId: `command-${sequence}`, recordedAt: new Date(at).toISOString(),
    ...(["Time In", "Login"].includes(source) ? { shift: assignAttendanceShift(new Date(at)) } : {}) }));
}

test("canonical days calculate each completed clicked duration with confirmed nearest-minute rounding", () => {
  const ledger = { revision: 7, events: events([
    ["Time In", "2026-10-15T15:10:00Z"], ["Break Out", "2026-10-15T17:00:00Z"], ["Break In", "2026-10-15T17:15:01Z"],
    ["Break Out", "2026-10-15T18:00:00Z"], ["Break In", "2026-10-15T18:15:30Z"],
    ["Lunch Break Out", "2026-10-15T20:00:00Z"], ["Lunch Break In", "2026-10-15T21:01:00Z"], ["Time Out", "2026-10-15T23:00:00Z"],
  ]) };
  const before = structuredClone(ledger);
  const [day] = deriveAttendanceDays(ledger, policy, now);
  assert.equal(day.dayKey, "2026-10-15");
  assert.deepEqual(day.breakSessions.map((interval) => interval.excessMinutes), [0, 1]);
  assert.equal(day.lateMinutes, 5); assert.equal(day.excessLunchMinutes, 1);
  assert.equal(day.earlyTimeOutMinutes, 60); assert.equal(day.deductibleMinutes, 67);
  assert.equal(day.revision, 7); assert.equal(day.policyRevision, 2);
  assert.equal(day.hasOpenSession, false); assert.equal(day.status, "Late");
  assert.deepEqual(ledger, before, "derivation must never mutate canonical evidence");
});

test("corrected return replaces the old event and survives snapshot serialization", () => {
  const ledger = { events: events([["Time In", "2026-10-15T15:00:00Z"], ["Break Out", "2026-10-15T17:00:00Z"],
    ["Break In", "2026-10-15T17:15:00Z"], ["Time Out", "2026-10-16T00:00:00Z"]]), corrections: [] as Array<{ commandId: string; targets: string[]; reason: string; actor: string; at: string }> };
  const [before] = deriveAttendanceDays(ledger, policy, now);
  ledger.events.push({ ...ledger.events[2], id: "replacement", at: "2026-10-15T17:20:00.000Z", sequence: 4, commandId: "edit" });
  ledger.corrections.push({ commandId: "edit", targets: ["event-2"], reason: "Synthetic edit", actor: "fake-admin", at: now.toISOString() });
  const [after] = deriveAttendanceDays(ledger, policy, now);
  assert.equal(before.excessBreakMinutes, 0); assert.equal(after.excessBreakMinutes, 5);
  assert.equal(after.eventIds.includes("event-2"), false); assert.equal(after.eventIds.includes("replacement"), true);
  assert.deepEqual(JSON.parse(JSON.stringify(deriveAttendanceDays(JSON.parse(JSON.stringify(ledger)), policy, now))), JSON.parse(JSON.stringify([after])));
});

test("multiple sessions on one assigned shift day do not duplicate lateness or early checkout", () => {
  const ledger = { events: events([["Time In", "2026-10-15T15:00:00Z"], ["Break Out", "2026-10-15T16:00:00Z"],
    ["Break In", "2026-10-15T16:16:00Z"], ["Time Out", "2026-10-15T18:00:00Z"],
    ["Time In", "2026-10-15T18:30:00Z"], ["Break Out", "2026-10-15T20:00:00Z"],
    ["Break In", "2026-10-15T20:17:00Z"], ["Time Out", "2026-10-16T00:00:00Z"]]) };
  const days = deriveAttendanceDays(ledger, policy, now);
  assert.equal(days.length, 1); assert.equal(days[0].sessionIds.length, 2);
  assert.equal(days[0].lateMinutes, 0); assert.equal(days[0].earlyTimeOutMinutes, 0);
  assert.equal(days[0].excessBreakMinutes, 3); assert.equal(days[0].eventIds.length, 8);
});

test("auto checkout after 08:00 stays assigned to its opening shift and closes its break exactly once", () => {
  const ledger = { events: events([["Time In", "2026-10-15T15:00:00Z"], ["Break Out", "2026-10-15T23:45:00Z"],
    ["Break In", "2026-10-16T00:05:00Z"], ["Time Out", "2026-10-16T00:05:00Z"]]) };
  ledger.events[2].autoTimeOut = true; ledger.events[3].autoTimeOut = true;
  const [day] = deriveAttendanceDays(ledger, policy, now);
  assert.equal(day.dayKey, "2026-10-15"); assert.equal(day.excessBreakMinutes, 5);
  assert.equal(day.earlyTimeOutMinutes, 0); assert.equal(day.hasOpenSession, false);
});

test("early checkout is deducted only after the scheduled shift end; open intervals never deduct", () => {
  const closed = { events: events([["Time In", "2026-10-15T15:00:00Z"], ["Time Out", "2026-10-15T22:00:00Z"]]) };
  assert.equal(deriveAttendanceDays(closed, policy, new Date("2026-10-15T23:59:59Z"))[0].earlyTimeOutMinutes, 0);
  assert.equal(deriveAttendanceDays(closed, policy, new Date("2026-10-16T00:00:00Z"))[0].earlyTimeOutMinutes, 120);
  const open = { events: events([["Time In", "2026-10-15T15:00:00Z"], ["Break Out", "2026-10-15T22:00:00Z"]]) };
  const [day] = deriveAttendanceDays(open, policy, now);
  assert.equal(day.hasOpenSession, true); assert.equal(day.excessBreakMinutes, 0);
  assert.equal(day.breakSessions[0].open, true); assert.ok(day.breakSessions[0].overdueMs > 0);
});

test("administrative missing-checkout closure never fabricates a completed return or an early Time Out", () => {
  const ledger = { events: events([["Time In", "2026-10-15T15:00:00Z"], ["Break Out", "2026-10-15T22:00:00Z"]]),
    closures: [{ id: "closure", sessionId: "event-0", effectiveAt: "2026-10-16T00:05:00.000Z", processedAt: now.toISOString(), commandId: "recover" }] };
  const [day] = deriveAttendanceDays(ledger, policy, now);
  assert.equal(day.hasOpenSession, false); assert.equal(day.earlyTimeOutMinutes, 0); assert.equal(day.excessBreakMinutes, 0);
  assert.equal(day.breakSessions[0].open, true); assert.ok(day.issues.includes("SYSTEM CLOSED"));
});
