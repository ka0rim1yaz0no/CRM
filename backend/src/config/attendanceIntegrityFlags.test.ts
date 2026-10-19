import assert from "node:assert/strict";
import test from "node:test";
import { attendanceIntegrityEnabled, attendanceHubEnabled, attendanceRecoveryEnvironmentEnabled } from "./rolloutFlags";

test("attendance integrity and hub default on locally, off in production; recovery always defaults off", () => {
  const saved = { ...process.env };
  try {
    delete process.env.CRM_ATTENDANCE_INTEGRITY; delete process.env.CRM_ATTENDANCE_HUB; delete process.env.CRM_ATTENDANCE_RECOVERY_CUTOFF;
    process.env.NODE_ENV = "production";
    assert.equal(attendanceIntegrityEnabled(), false); assert.equal(attendanceHubEnabled(), false); assert.equal(attendanceRecoveryEnvironmentEnabled(), false);
    process.env.NODE_ENV = "development";
    assert.equal(attendanceIntegrityEnabled(), true); assert.equal(attendanceHubEnabled(), true); assert.equal(attendanceRecoveryEnvironmentEnabled(), false);
    process.env.CRM_ATTENDANCE_INTEGRITY = "false"; process.env.CRM_ATTENDANCE_HUB = "false";
    assert.equal(attendanceIntegrityEnabled(), false); assert.equal(attendanceHubEnabled(), false);
  } finally { for (const name of ["NODE_ENV", "CRM_ATTENDANCE_INTEGRITY", "CRM_ATTENDANCE_HUB", "CRM_ATTENDANCE_RECOVERY_CUTOFF"]) {
    if (saved[name] === undefined) delete process.env[name]; else process.env[name] = saved[name];
  } }
});
