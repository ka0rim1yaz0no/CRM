import assert from "node:assert/strict";
import test from "node:test";
import { attendanceRestReminder } from "../../../src/lib/attendanceRestReminder";
import type { AttendanceSessionSnapshot } from "../../../src/api/attendanceSession";

const clock = Date.parse("2026-10-27T17:00:00Z");
function snapshot(state: "BREAK" | "LUNCH" = "BREAK", elapsed = 15 * 60_000 + 1) {
    return { sessionId: "session", state, stateSince: new Date(clock - elapsed).toISOString(), receivedAt: 1000,
        serverTime: new Date(clock).toISOString(), allowances: { breakMinutes: 15, lunchMinutes: 60 },
        sessions: [{ id: "session", lifecycle: "open", endedAt: null, mode: state }] } as AttendanceSessionSnapshot;
}
test("a rest alert begins only after its own configured allowance, using server time", () => {
    assert.equal(attendanceRestReminder(snapshot("BREAK", 15 * 60_000), "employee", 1000), null);
    assert.equal(attendanceRestReminder(snapshot("BREAK", 15 * 60_000 + 1), "employee", 1000)?.kind, "Break");
    assert.equal(attendanceRestReminder(snapshot("LUNCH", 60 * 60_000), "employee", 1000), null);
    assert.equal(attendanceRestReminder(snapshot("LUNCH", 60 * 60_000 + 1), "employee", 1000)?.kind, "Lunch");
    const custom = snapshot("BREAK", 10 * 60_000 + 5000); custom.allowances!.breakMinutes = 10;
    assert.equal(attendanceRestReminder(custom, "employee", 1000)?.overdueMs, 5000);
    assert.equal(attendanceRestReminder(snapshot(), "employee", 6000)?.overdueMs, 5001);
});
test("returning, timeout, or administrative closure immediately removes the alert without changing records", () => {
    const initial = snapshot(), original = structuredClone(initial);
    assert.ok(attendanceRestReminder(initial, "employee", 1000));
    for (const state of ["ONLINE", "OFFLINE", "OFF THE PHONE"] as const) assert.equal(attendanceRestReminder({ ...initial, state }, "employee", 1000), null);
    assert.equal(attendanceRestReminder({ ...initial, sessionId: null }, "employee", 1000), null);
    for (const lifecycle of ["manually-closed", "system-closed"]) assert.equal(attendanceRestReminder({ ...initial, sessions: [{ ...initial.sessions[0], lifecycle, endedAt: new Date(clock).toISOString() }] }, "employee", 1000), null);
    assert.deepEqual(initial, original);
});
test("stale, incomplete and mismatched session data never produces an overdue ping", () => {
    const initial = snapshot();
    assert.equal(attendanceRestReminder(undefined, "employee", 1000), null);
    assert.equal(attendanceRestReminder(initial, "", 1000), null);
    assert.equal(attendanceRestReminder(initial, "employee", 92_000), null);
    assert.equal(attendanceRestReminder({ ...initial, allowances: undefined }, "employee", 1000), null);
    assert.equal(attendanceRestReminder({ ...initial, stateSince: "invalid" }, "employee", 1000), null);
    assert.equal(attendanceRestReminder({ ...initial, sessions: [{ ...initial.sessions[0], mode: "ONLINE" }] }, "employee", 1000), null);
});
test("six linked business refreshes share one logical alert; the next rest gets a new identity", () => {
    const initial = snapshot(), ids = Array.from({ length: 6 }, () => attendanceRestReminder(structuredClone(initial), "employee", 1000)!.id);
    assert.equal(new Set(ids).size, 1);
    assert.notEqual(attendanceRestReminder(snapshot("BREAK", 16 * 60_000), "employee", 1000)?.id, ids[0]);
    assert.notEqual(attendanceRestReminder(initial, "other-employee", 1000)?.id, ids[0]);
});
