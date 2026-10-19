import assert from "node:assert/strict";
import test from "node:test";
import { createAttendanceHubSession, verifyAttendanceHubSession } from "./attendanceHubSession";

test("attendance hub session binds identity and expires", () => {
  const prior = process.env.NODE_ENV;
  process.env.NODE_ENV = "test";
  try {
  const token = createAttendanceHubSession("fake-employee", 1000);
  assert.ok(token);
  assert.equal(verifyAttendanceHubSession(token, 1001), "fake-employee");
  assert.equal(verifyAttendanceHubSession(`${token}x`, 1001), null);
  assert.equal(verifyAttendanceHubSession(token, 1000 + 12 * 60 * 60_000), null);
  } finally { process.env.NODE_ENV = prior; }
});
