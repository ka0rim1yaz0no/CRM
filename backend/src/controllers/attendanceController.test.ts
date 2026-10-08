import assert from "node:assert/strict";
import test from "node:test";
import { shouldAutomaticallyCloseAttendanceSlot } from "./attendanceController";

const now = new Date("2026-10-07T00:30:00.000Z");

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
