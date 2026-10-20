import assert from "node:assert/strict";
import test from "node:test";
import { attendanceNoteDraft, mergeConfirmedAttendanceNote } from "../../../src/lib/attendanceNoteState";
import type { AttendanceHubNoteResponse, HubDay } from "../../../src/api/attendanceHub";

const day = { businessId: "synthetic-a", employeeCode: "fake", dayKey: "2026-10-15", note: "Old", noteRevision: 2,
  attendanceRevision: 5, noteExcused: false, excused: false, leave: null } as HubDay;
const saved: AttendanceHubNoteResponse = { employeeCode: "fake", businessId: "synthetic-a", dayKey: day.dayKey, reason: "Confirmed",
  excused: true, noteRevision: 3, attendanceRevision: 6, syncPending: true };
test("note editing retains its original revisions and draft despite background refreshes", () => {
  const draft = attendanceNoteDraft(day, null, { reason: "My retained draft", excused: true });
  const edited = attendanceNoteDraft({ ...day, noteRevision: 10, attendanceRevision: 20 }, draft, { reason: "Still my draft", excused: false });
  assert.equal(edited.expectedRevision, 5); assert.equal(edited.expectedNoteRevision, 2); assert.equal(edited.reason, "Still my draft");
});
test("confirmed notes never overwrite a different business or employee cache", () => {
  assert.equal(mergeConfirmedAttendanceNote(day, { ...saved, businessId: "synthetic-b" }), day);
  assert.equal(mergeConfirmedAttendanceNote(day, { ...saved, employeeCode: "someone-else" }), day);
});
test("older idempotent note replays cannot rewind newer note or attendance revisions", () => {
  assert.equal(mergeConfirmedAttendanceNote({ ...day, noteRevision: 5 }, saved)?.note, "Old");
  assert.equal(mergeConfirmedAttendanceNote({ ...day, attendanceRevision: 50 }, saved)?.attendanceRevision, 50);
});
test("confirmed local excuse and pending state update without replacing approved leave", () => {
  const merged = mergeConfirmedAttendanceNote({ ...day, leave: "Approved synthetic leave" }, { ...saved, excused: false });
  assert.equal(merged?.note, "Confirmed"); assert.equal(merged?.noteExcused, false); assert.equal(merged?.excused, true);
  assert.equal(merged?.syncPending, true); assert.equal(merged?.noteRevision, 3);
});
