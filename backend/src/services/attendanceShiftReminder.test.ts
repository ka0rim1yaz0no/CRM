import assert from "node:assert/strict";
import test from "node:test";
import type { AttendanceSessionSnapshot } from "../../../src/api/attendanceSession";
import { attendanceShiftReminder } from "../../../src/lib/attendanceShiftReminder";

const settings = { officialShiftStartTime: "23:00", officialShiftEndTime: "08:00" };
function snapshot(at = "2026-10-27T23:00:00+08:00") {
    return { state: "OFFLINE", sessionId: null, serverTime: at, receivedAt: 1000, sessions: [], records: [], dashboardDays: [] } as unknown as AttendanceSessionSnapshot;
}
const reminder = (at: string) => attendanceShiftReminder(snapshot(at), "employee", settings, 1000);

test("missing Time In alerts start at the PH shift boundary, survive midnight and end at shift end", () => {
    assert.equal(reminder("2026-10-27T22:59:59+08:00"), null);
    assert.equal(reminder("2026-10-27T23:00:00+08:00")?.dayKey, "2026-10-27");
    assert.equal(reminder("2026-10-28T00:00:00+08:00")?.dayKey, "2026-10-27");
    assert.equal(reminder("2026-10-28T07:59:59+08:00")?.dayKey, "2026-10-27");
    assert.equal(reminder("2026-10-28T08:00:00+08:00"), null);
    assert.equal(reminder("2026-10-28T12:00:00+08:00"), null);
});

test("clocking in, rest, off-phone and a completed or administratively closed current shift clear the alert", () => {
    const initial = snapshot(), original = structuredClone(initial);
    for (const state of ["ONLINE", "BREAK", "LUNCH", "OFF THE PHONE"] as const) assert.equal(attendanceShiftReminder({ ...initial, state }, "employee", settings, 1000), null);
    assert.equal(attendanceShiftReminder({ ...initial, sessionId: "open" }, "employee", settings, 1000), null);
    for (const lifecycle of ["open", "manually-closed", "system-closed"]) {
        const session = { id: "session", startedAt: "2026-10-27T22:59:00+08:00", shift: { dayKey: "2026-10-27" }, lifecycle } as AttendanceSessionSnapshot["sessions"][number];
        assert.equal(attendanceShiftReminder({ ...initial, sessions: [session] }, "employee", settings, 1000), null);
    }
    const day = { dayKey: "2026-10-27", timeIn: "2026-10-27T22:59:00+08:00" } as NonNullable<AttendanceSessionSnapshot["dashboardDays"]>[number];
    assert.equal(attendanceShiftReminder({ ...initial, dashboardDays: [day] }, "employee", settings, 1000), null);
    const event = { source: "Time In", at: "2026-10-27T22:59:00+08:00", shiftDayKey: "2026-10-27" } as AttendanceSessionSnapshot["records"][number];
    assert.equal(attendanceShiftReminder({ ...initial, records: [event] }, "employee", settings, 1000), null);
    assert.deepEqual(initial, original);
});

test("previous-day punches do not hide a new shift alert; refresh and all six business views share its sound identity", () => {
    const initial = snapshot(); initial.sessions = [{ startedAt: "2026-10-26T23:00:00+08:00", shift: { dayKey: "2026-10-26" } }] as AttendanceSessionSnapshot["sessions"];
    const ids = Array.from({ length: 6 }, () => attendanceShiftReminder(structuredClone(initial), "employee", settings, 1000)!.id);
    assert.equal(new Set(ids).size, 1);
    assert.notEqual(reminder("2026-10-28T23:00:00+08:00")?.id, ids[0]);
    assert.notEqual(attendanceShiftReminder(initial, "other", settings, 1000)?.id, ids[0]);
});

test("server time drives the alert; stale, failed, missing or invalid data cannot invent a missing punch", () => {
    const initial = snapshot("2026-10-27T22:59:59+08:00");
    assert.ok(attendanceShiftReminder(initial, "employee", settings, 2000));
    for (const data of [undefined, { ...initial, serverTime: "invalid" }, { ...initial, receivedAt: NaN }]) assert.equal(attendanceShiftReminder(data, "employee", settings, 1000), null);
    assert.equal(attendanceShiftReminder(initial, "employee", settings, 92_000), null);
    assert.equal(attendanceShiftReminder(initial, "", settings, 1000), null);
    assert.equal(attendanceShiftReminder(initial, "employee", undefined, 1000), null);
    assert.equal(attendanceShiftReminder(initial, "employee", { ...settings, officialShiftStartTime: "25:00" }, 1000), null);
});

test("custom day and partial-hour shifts use their configured boundaries without an attendance mutation", () => {
    const custom = { officialShiftStartTime: "08:30", officialShiftEndTime: "17:15" };
    const check = (at: string) => attendanceShiftReminder(snapshot(at), "employee", custom, 1000);
    assert.equal(check("2026-10-28T08:29:59+08:00"), null);
    assert.equal(check("2026-10-28T08:30:00+08:00")?.shiftStartLabel, "8:30 AM");
    assert.ok(check("2026-10-28T17:14:59+08:00"));
    assert.equal(check("2026-10-28T17:15:00+08:00"), null);
});
