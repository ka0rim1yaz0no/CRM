import assert from "node:assert/strict";
import test from "node:test";
import { mergeAttendanceSnapshots } from "./employeeAttendanceSyncService";

function record(source: "Time In" | "Break Out", milliseconds: number) {
  return {
    source,
    timeIn: new Date(Date.UTC(2026, 9, 9, 14, 52, 0, milliseconds)),
    attendanceStatus: "" as const,
    isArchived: false,
  };
}

test("deduplicates the same attendance action copied within five seconds", () => {
  const merged = mergeAttendanceSnapshots([
    [record("Time In", 0)],
    [record("Time In", 472)],
  ]);

  assert.equal(merged.length, 1);
  assert.equal(merged[0].timeIn.toISOString(), "2026-10-09T14:52:00.000Z");
});

test("keeps distinct attendance actions and actions outside the duplicate window", () => {
  const merged = mergeAttendanceSnapshots([[
    record("Time In", 0),
    record("Break Out", 472),
    record("Time In", 6_000),
  ]]);

  assert.equal(merged.length, 3);
});
