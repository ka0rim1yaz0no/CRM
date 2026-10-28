import assert from "node:assert/strict";
import test from "node:test";
import { attendanceInputValue, buildAttendanceDraftChanges, validateAttendanceEventTime } from "../../../src/lib/attendanceCommandDraft";
import { timeOutBeforeTimeInMessage, attendanceTimeOutPlan } from "../../../shared/attendanceTimeOut";

test("HR draft preserves unchanged milliseconds and legacy sources; blank checkout stays absent", () => {
  const original = { id: "legacy", source: "Login", at: "2026-10-15T14:53:12.345Z" };
  assert.equal(attendanceInputValue(original.at), "2026-10-15T22:53:12");
  assert.deepEqual(buildAttendanceDraftChanges([{ value: attendanceInputValue(original.at), original, source: "Time In" },
    { value: "", source: "Time Out" }]), []);
  assert.deepEqual(buildAttendanceDraftChanges([{ value: "2026-10-15T22:54:12.345", original, source: "Time In" }]),
    [{ targetId: "legacy", source: "Login", at: "2026-10-15T14:54:12.345Z" }]);
  assert.deepEqual(buildAttendanceDraftChanges([{ value: "", original, source: "Time In" }]), [{ targetId: "legacy", remove: true }]);
  assert.deepEqual(buildAttendanceDraftChanges([{ value: "2026-10-16T01:54:12", original, source: "Time In" }]),
    [{ targetId: "legacy", source: "Login", at: "2026-10-15T17:54:12.000Z" }]);
});

test("HR draft explains a same-day AM checkout before a PM check-in without altering the entered values", () => {
  const fields = [{ source: "Time In", value: "2026-10-26T22:59:37" }, { source: "Time Out", value: "2026-10-26T11:38:00" }];
  const original = structuredClone(fields);
  assert.throws(() => buildAttendanceDraftChanges(fields), { message: timeOutBeforeTimeInMessage });
  assert.deepEqual(fields, original);
  for (const value of ["2026-10-26T23:38:00", "2026-10-27T08:00:00", "2026-10-27T11:38:00"]) {
    const changes = buildAttendanceDraftChanges([fields[0], { ...fields[1], value }]);
    assert.equal(changes[1].at, new Date(`${value}+08:00`).toISOString());
  }
});

test("time-order validation preserves exact original milliseconds and allows explicit deletion or paired movement", () => {
  const start = { id: "start", source: "Login", at: "2026-10-26T14:59:37.800Z" };
  const end = { id: "end", source: "Logout", at: "2026-10-26T14:59:37.900Z" };
  const fields = [start, end].map(original => ({ original, source: original.source, value: attendanceInputValue(original.at) }));
  assert.deepEqual(buildAttendanceDraftChanges(fields), []);
  assert.throws(() => buildAttendanceDraftChanges([fields[0], { ...fields[1], value: "2026-10-26T22:59:37.799" }]), { message: timeOutBeforeTimeInMessage });
  assert.deepEqual(buildAttendanceDraftChanges([fields[0], { ...fields[1], value: "" }]), [{ targetId: "end", remove: true }]);
  assert.equal(buildAttendanceDraftChanges([{ ...fields[0], value: "2026-10-27T23:00:00" }, { ...fields[1], value: "2026-10-28T08:00:00" }]).length, 2);
});

test("single-event correction validates only the selected session and never modifies the snapshot", () => {
  const sessions = [{ startedAt: "2026-10-26T14:59:37Z", events: [{ id: "start", source: "Time In", at: "2026-10-26T14:59:37Z" }, { id: "end", source: "Time Out", at: "2026-10-27T00:00:00Z" }] },
    { startedAt: "2026-10-27T15:00:00Z", events: [{ id: "new-start", source: "Time In", at: "2026-10-27T15:00:00Z" }] }];
  const original = structuredClone(sessions);
  assert.throws(() => validateAttendanceEventTime(sessions, "end", "Time Out", "2026-10-26T03:38:00Z"), { message: timeOutBeforeTimeInMessage });
  assert.throws(() => validateAttendanceEventTime(sessions, "start", "Time In", "2026-10-27T01:00:00Z"), { message: timeOutBeforeTimeInMessage });
  assert.doesNotThrow(() => validateAttendanceEventTime(sessions, "end", "Time Out", "2026-10-26T15:38:00Z"));
  assert.doesNotThrow(() => validateAttendanceEventTime(sessions, "new-start", "Time In", "2026-10-27T15:01:00Z"));
  assert.deepEqual(sessions, original);
});

test("Add Time Out returns the same date/AM-PM guidance while retaining its other guards", () => {
  const sessions = [{ id: "session", startedAt: "2026-10-26T14:59:37Z", events: [{ id: "start", source: "Time In", at: "2026-10-26T14:59:37Z" }] }];
  assert.throws(() => attendanceTimeOutPlan(sessions, "session", "2026-10-26T03:38:00Z", "2026-10-27T01:00:00Z"), { message: timeOutBeforeTimeInMessage });
  assert.throws(() => attendanceTimeOutPlan(sessions, "session", "2026-10-27T02:00:00Z", "2026-10-27T01:00:00Z"), /future/);
  assert.equal(attendanceTimeOutPlan(sessions, "session", "2026-10-26T15:38:00Z", "2026-10-27T01:00:00Z").at, "2026-10-26T15:38:00.000Z");
});
