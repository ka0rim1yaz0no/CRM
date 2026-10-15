import assert from "node:assert/strict";
import test from "node:test";
import { createAdminDashboardSession, verifyAdminDashboardSession } from "./adminDashboardSession";

test("dashboard session is signed, expires, and rejects tracker-only access", () => {
  const oldCode = process.env.CRM_ADMIN_ONE_CODE;
  const oldTracker = process.env.CRM_ADMIN_TWO_CODE;
  const oldSecret = process.env.CRM_ADMIN_SESSION_SECRET;
  try {
    process.env.CRM_ADMIN_ONE_CODE = "test-admin-code";
    process.env.CRM_ADMIN_TWO_CODE = "2132123000";
    process.env.CRM_ADMIN_SESSION_SECRET = "test-signing-secret-with-at-least-32-characters";
    const token = createAdminDashboardSession("test-admin-code", 1_000);
    assert.ok(token);
    assert.equal(verifyAdminDashboardSession(token, 1_001)?.employeeCode, "test-admin-code");
    assert.equal(verifyAdminDashboardSession(`${token}x`, 1_001), null);
    assert.equal(verifyAdminDashboardSession(token, 12 * 60 * 60_000 + 1_000), null);
    assert.equal(createAdminDashboardSession("2132123000", 1_000), null);
  } finally {
    if (oldCode === undefined) delete process.env.CRM_ADMIN_ONE_CODE;
    else process.env.CRM_ADMIN_ONE_CODE = oldCode;
    if (oldTracker === undefined) delete process.env.CRM_ADMIN_TWO_CODE;
    else process.env.CRM_ADMIN_TWO_CODE = oldTracker;
    if (oldSecret === undefined) delete process.env.CRM_ADMIN_SESSION_SECRET;
    else process.env.CRM_ADMIN_SESSION_SECRET = oldSecret;
  }
});
