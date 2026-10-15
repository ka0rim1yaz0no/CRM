import assert from "node:assert/strict";
import test from "node:test";
import { attendanceSlotKey, canEditWorkedMinutes, isTimeInLate, shouldAutomaticallyCloseAttendanceSlot, workedMinutesToTimeOut } from "./attendanceController";

const now = new Date("2026-10-07T00:30:00.000Z");

test("treats the full configured start minute as on time", () => {
  const shiftStart = new Date("2026-10-06T15:00:00.000Z");
  assert.equal(isTimeInLate(new Date("2026-10-06T15:00:00.000Z"), shiftStart), false);
  assert.equal(isTimeInLate(new Date("2026-10-06T15:00:59.999Z"), shiftStart), false);
  assert.equal(isTimeInLate(new Date("2026-10-06T15:01:00.000Z"), shiftStart), true);
});

test("an overnight Manila shift keeps time-in and the next morning on one slot", () => {
  const slot = (value: string) => attendanceSlotKey(new Date(value), "Asia/Manila", "23:00", "08:00");
  assert.equal(slot("2026-10-14T15:00:00Z"), "2026-10-14");
  assert.equal(slot("2026-10-14T23:59:00Z"), "2026-10-14");
  assert.equal(slot("2026-10-15T00:00:00Z"), "2026-10-14");
  assert.equal(slot("2026-10-15T00:01:00Z"), "2026-10-15");
});

test("converts edited worked minutes into a time-out while preserving the payroll lunch", () => {
  const timeIn = new Date("2026-10-09T15:00:00.000Z");
  assert.equal(
    workedMinutesToTimeOut(timeIn, 420, 60).toISOString(),
    "2026-10-09T23:00:00.000Z"
  );
});

test("keeps minute edits exact instead of rounding to hour buckets", () => {
  const timeIn = new Date("2026-10-09T15:00:00.000Z");
  assert.equal(
    workedMinutesToTimeOut(timeIn, 455, 60).toISOString(),
    "2026-10-09T23:35:00.000Z"
  );
});

test("never creates a time-out while editing minutes on an open shift", () => {
  assert.equal(canEditWorkedMinutes(false), false);
  assert.equal(canEditWorkedMinutes(true), true);
});

test("does not force an employee offline when another business lacks the active-shift attendance copy", () => {
  assert.equal(shouldAutomaticallyCloseAttendanceSlot({
    isInsideShift: true,
    hasCurrentOpenSlot: false,
    recoveryTimeOut: null,
    now,
  }), false);
});

test("keeps a current open attendance slot active during the shift", () => {
  assert.equal(shouldAutomaticallyCloseAttendanceSlot({
    isInsideShift: true,
    hasCurrentOpenSlot: true,
    recoveryTimeOut: null,
    now,
  }), false);
});

test("never closes an expired prior shift automatically", () => {
  assert.equal(shouldAutomaticallyCloseAttendanceSlot({
    isInsideShift: true,
    hasCurrentOpenSlot: false,
    recoveryTimeOut: new Date("2026-10-06T00:00:00.000Z"),
    now,
  }), false);
});

test("keeps a prior shift open until its configured recovery timeout", () => {
  assert.equal(shouldAutomaticallyCloseAttendanceSlot({
    isInsideShift: true,
    hasCurrentOpenSlot: false,
    recoveryTimeOut: new Date("2026-10-07T01:00:00.000Z"),
    now,
  }), false);
});

test("does not force an employee offline when no verified open attendance slot exists", () => {
  assert.equal(shouldAutomaticallyCloseAttendanceSlot({
    isInsideShift: false,
    hasCurrentOpenSlot: false,
    recoveryTimeOut: null,
    now,
  }), false);
});

test("does not force a current-slot employee offline solely because the clock is outside shift hours", () => {
  assert.equal(shouldAutomaticallyCloseAttendanceSlot({
    isInsideShift: false,
    hasCurrentOpenSlot: true,
    recoveryTimeOut: null,
    now,
  }), false);
});
