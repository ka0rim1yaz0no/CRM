import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { test } from "node:test";
import { assertAttendanceFlagConfiguration, attendanceFlagState } from "./attendanceFlags";
import * as flags from "./rolloutFlags";

test("prepared production profile enables the local dashboard/attendance/security set with valid strict dependencies", async () => {
  const profile = JSON.parse(await fs.readFile(new URL("../../../release/guarded-profile.json", import.meta.url), "utf8")) as { backend: Record<string, string> };
  const saved = new Map(["NODE_ENV", ...Object.keys(profile.backend)].map(name => [name, process.env[name]]));
  try {
    Object.assign(process.env, profile.backend, { NODE_ENV: "production" });
    assert.doesNotThrow(() => assertAttendanceFlagConfiguration());
    assert.deepEqual(attendanceFlagState(), { INTEGRITY: true, ACTIVE_SESSION: true, DURATION_MODEL: true, AUTO_TIMEOUT: true, BREAK_GAP: false, ACCURACY_FIXES: true, PAYROLL_ACCURACY: true });
    for (const enabled of [flags.attendanceHubEnabled, flags.dashboardWorkspaceEnabled, flags.securityCredentialVaultEnabled, flags.securityDataMinimizationEnabled,
      flags.securityHardeningEnabled, flags.securityUploadsEnabled, flags.securityEnvironmentCodesEnabled, flags.securityLegacyAuthEnabled,
      flags.callTimingV2Enabled, flags.callDashboardV2Enabled, flags.attendanceV2Enabled, flags.timeAccountingV2Enabled]) assert.equal(enabled(), true);
    assert.equal(flags.dataCheckNavigationEnabled(), false); assert.equal(flags.attendanceRecoveryEnvironmentEnabled(), false);
  } finally { for (const [name, value] of saved) { if (value === undefined) delete process.env[name]; else process.env[name] = value; } }
});
