import assert from "node:assert/strict";
import test from "node:test";
import { projectAttendance, sessionTime, type SessionEvent } from "./attendanceSessionState";

const fixture: SessionEvent[] = [
  ["Time In", "2026-10-15T14:53:00Z"], ["Break Out", "2026-10-15T17:03:00Z"], ["Break In", "2026-10-15T17:16:00Z"],
  ["Lunch Break Out", "2026-10-15T19:02:00Z"], ["Lunch Break In", "2026-10-15T20:01:00Z"],
  ["Break Out", "2026-10-15T22:01:00Z"], ["Break In", "2026-10-15T22:15:00Z"],
].map(([source, at], index) => ({ id: `test-${index}`, source: source as SessionEvent["source"], at: new Date(at).toISOString(),
  sequence: index, commandId: `command-${index}`, recordedAt: new Date(at).toISOString() }));

test("an unclosed overnight session remains operational after midnight and 08:01", () => {
  for (const time of ["2026-10-15T16:00:00Z", "2026-10-16T00:00:00Z", "2026-10-16T00:01:00Z", "2026-10-17T00:01:00Z"]) {
    const result = projectAttendance(fixture.filter((event) => event.at <= new Date(time).toISOString()));
    assert.equal(result.active?.id, "test-0");
    assert.equal(result.active?.lifecycle, "open");
  }
  const more = [...fixture, { ...fixture[0], id: "off", source: "Off the Phone Out" as const, at: "2026-10-16T00:01:00.000Z", sequence: 8 }];
  assert.equal(projectAttendance(more).active?.mode, "OFF THE PHONE");
  const checkout = { ...more[0], id: "checkout", source: "Time Out" as const, at: "2026-10-16T01:00:00.000Z", sequence: 9 };
  assert.equal(projectAttendance([...more, checkout]).sessions[0].id, "test-0");
  assert.equal(projectAttendance([...more, checkout]).active, null);
});

test("duplicate Time In and orphan returns are invalid, not a second session", () => {
  const result = projectAttendance([...fixture, { ...fixture[0], id: "duplicate", at: "2026-10-16T01:00:00.000Z", sequence: 9 }]);
  assert.equal(result.sessions.length, 1); assert.equal(result.issues.length, 1);
});

test("undo restores the original interval and preserves evidence", () => {
  const result = projectAttendance(fixture.slice(0, 3), [{ commandId: "undo", targets: ["test-2"], reason: "Accidental return", actor: "test-admin", at: "2026-10-15T17:17:00Z" }]);
  assert.equal(result.active?.mode, "BREAK"); assert.equal(result.active?.modeSince, "2026-10-15T17:03:00.000Z");
  assert.equal(fixture.length, 7); assert.equal(result.reversedIds.length, 1);
});

test("system closure is separate evidence and does not manufacture checkout or worked time", () => {
  const closure = { id: "closure", sessionId: "test-0", effectiveAt: "2026-10-16T14:59:00.000Z", processedAt: "2026-10-16T15:10:00.000Z", commandId: "cutoff" };
  const result = projectAttendance(fixture, [], [closure]);
  assert.equal(result.active, null); assert.equal(result.sessions[0].lifecycle, "system-closed");
  assert.ok(!result.effectiveEvents.some((event) => event.source === "Time Out"));
  const times = sessionTime(result.sessions[0], new Date(closure.processedAt));
  assert.ok(times.scheduled.online <= Date.parse(fixture.at(-1)!.at) - Date.parse(fixture[0].at));
});
