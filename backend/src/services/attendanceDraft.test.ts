import assert from "node:assert/strict";
import test from "node:test";
import { attendanceInputValue, buildAttendanceDraftChanges } from "../../../src/lib/attendanceCommandDraft";

test("HR draft preserves unchanged milliseconds and legacy sources; blank checkout stays absent", () => {
  const original = { id: "legacy", source: "Login", at: "2026-10-15T14:53:12.345Z" };
  assert.deepEqual(buildAttendanceDraftChanges([{ value: attendanceInputValue(original.at), original, source: "Time In" },
    { value: "", source: "Time Out" }]), []);
  assert.deepEqual(buildAttendanceDraftChanges([{ value: "2026-10-15T22:54:12.345", original, source: "Time In" }]),
    [{ targetId: "legacy", source: "Login", at: "2026-10-15T14:54:12.345Z" }]);
  assert.deepEqual(buildAttendanceDraftChanges([{ value: "", original, source: "Time In" }]), [{ targetId: "legacy", remove: true }]);
});
