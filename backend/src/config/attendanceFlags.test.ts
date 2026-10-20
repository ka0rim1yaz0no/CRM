import assert from "node:assert/strict";
import { afterEach, mock, test } from "node:test";
import { logAttendanceFlags, assertAttendanceFlagConfiguration } from "./attendanceFlags";
const saved = { ...process.env };
afterEach(() => { mock.restoreAll(); for (const key of ["NODE_ENV", "CRM_ATTENDANCE_STRICT_FLAGS", "CRM_ATTENDANCE_ACCURACY_FIXES", "CRM_PAYROLL_ACCURACY", "CRM_ATTENDANCE_AUTO_TIMEOUT", "CRM_ATTENDANCE_INTEGRITY", "CRM_ATTENDANCE_DURATION_MODEL"]) {
  if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
} });
test("startup reports attendance flags and warns about incompatible automatic timeout configuration", () => {
  process.env.CRM_ATTENDANCE_AUTO_TIMEOUT = "true"; process.env.CRM_ATTENDANCE_INTEGRITY = "false"; process.env.CRM_ATTENDANCE_DURATION_MODEL = "false";
  const lines: unknown[][] = []; const warnings: unknown[][] = [];
  mock.method(console, "info", (...args: unknown[]) => { lines.push(args); });
  mock.method(console, "warn", (...args: unknown[]) => { warnings.push(args); });
  logAttendanceFlags();
  assert.equal(lines.length, 1); assert.ok(warnings.length > 0);
  for (const key of ["INTEGRITY", "ACTIVE_SESSION", "DURATION_MODEL", "AUTO_TIMEOUT", "BREAK_GAP", "ACCURACY_FIXES"]) assert.ok(JSON.stringify(lines).includes(key));
});

test("strict flags fail fast only in production, and accept valid accuracy/automatic-timeout combinations", () => {
  process.env.NODE_ENV = "production"; process.env.CRM_ATTENDANCE_STRICT_FLAGS = "true";
  process.env.CRM_ATTENDANCE_AUTO_TIMEOUT = "true"; process.env.CRM_ATTENDANCE_INTEGRITY = "false";
  process.env.CRM_ATTENDANCE_DURATION_MODEL = "false"; process.env.CRM_ATTENDANCE_ACCURACY_FIXES = "false";
  assert.throws(() => assertAttendanceFlagConfiguration(), /Invalid attendance flag configuration/);
  process.env.CRM_ATTENDANCE_STRICT_FLAGS = "false"; assert.doesNotThrow(() => assertAttendanceFlagConfiguration());
  process.env.CRM_ATTENDANCE_STRICT_FLAGS = "true"; process.env.NODE_ENV = "development";
  assert.doesNotThrow(() => assertAttendanceFlagConfiguration());
  process.env.NODE_ENV = "production"; process.env.CRM_ATTENDANCE_INTEGRITY = "true"; process.env.CRM_ATTENDANCE_DURATION_MODEL = "true";
  process.env.CRM_ATTENDANCE_ACCURACY_FIXES = "true"; process.env.CRM_PAYROLL_ACCURACY = "true";
  assert.doesNotThrow(() => assertAttendanceFlagConfiguration());
  process.env.CRM_PAYROLL_ACCURACY = "false";
  assert.throws(() => assertAttendanceFlagConfiguration(), /PAYROLL_ACCURACY/);
});
