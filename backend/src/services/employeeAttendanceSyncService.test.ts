import assert from "node:assert/strict";
import test from "node:test";
import { mergeAttendanceSnapshots } from "./employeeAttendanceSyncService";

test("merges attendance history from multiple businesses without duplicates", () => {
  const timeIn = new Date("2026-10-07T15:00:00.000Z");
  const timeOut = new Date("2026-10-08T00:00:00.000Z");
  const merged = mergeAttendanceSnapshots([
    [{ timeIn, source: "Time In", attendanceStatus: "On time", isArchived: false }],
    [
      { timeIn, source: "Time In", attendanceStatus: "On time", isArchived: false },
      { timeIn: timeOut, source: "Time Out", attendanceStatus: "", isArchived: false },
    ],
  ]);

  assert.deepEqual(merged.map((record) => record.source), ["Time In", "Time Out"]);
});

test("does not restore archived attendance records", () => {
  const merged = mergeAttendanceSnapshots([[
    { timeIn: new Date("2026-10-07T15:00:00.000Z"), source: "Time In", attendanceStatus: "On time", isArchived: true },
  ]]);

  assert.equal(merged.length, 0);
});
