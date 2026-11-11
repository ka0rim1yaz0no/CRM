import assert from "node:assert/strict";
import { test } from "node:test";
import { attendanceReadPolicyFingerprint } from "./attendanceReadPolicy";

const policy = { revision: 0, shiftStart: "23:00", shiftEnd: "08:00", graceMinutes: 0, breakMinutes: 15, lunchMinutes: 60,
  recoveryEnabled: false, recoveryTime: "22:59", autoTimeOutTime: "08:05" };

test("read policy fingerprints are deterministic for all policy inputs regardless of property order", () => {
  const fingerprint = attendanceReadPolicyFingerprint(policy);
  assert.match(fingerprint, /^[a-f0-9]{64}$/);
  assert.equal(attendanceReadPolicyFingerprint({ ...policy }), fingerprint);
  assert.equal(attendanceReadPolicyFingerprint(Object.fromEntries(Object.entries(policy).reverse()) as typeof policy), fingerprint);
  for (const change of [{ revision: 1 }, { shiftStart: "22:00" }, { shiftEnd: "07:00" }, { graceMinutes: 1 },
    { breakMinutes: 20 }, { lunchMinutes: 45 }, { recoveryEnabled: true }, { recoveryTime: "22:58" }, { autoTimeOutTime: "08:06" }])
    assert.notEqual(attendanceReadPolicyFingerprint({ ...policy, ...change }), fingerprint);
});

test("read-math rollouts and Off the Phone policy changes cannot reuse a stale policy fingerprint", () => {
  for (const name of ["CRM_ATTENDANCE_DURATION_MODEL", "CRM_ATTENDANCE_ACCURACY_FIXES", "CRM_ATTENDANCE_BREAK_GAP",
    "CRM_ATTENDANCE_INTEGRITY", "CRM_ATTENDANCE_AUTO_TIMEOUT", "CRM_ATTENDANCE_RECOVERY_CUTOFF", "CRM_PAYROLL_ACCURACY"]) {
    const before = process.env[name];
    try {
      process.env[name] = "true"; const enabled = attendanceReadPolicyFingerprint(policy);
      process.env[name] = "false"; assert.notEqual(attendanceReadPolicyFingerprint(policy), enabled, name);
    } finally { if (before === undefined) delete process.env[name]; else process.env[name] = before; }
  }
  const before = process.env.CRM_OFF_PHONE_PAID_LIMIT_FROM;
  try {
    process.env.CRM_OFF_PHONE_PAID_LIMIT_FROM = "2026-10-01T00:00:00Z"; const first = attendanceReadPolicyFingerprint(policy);
    process.env.CRM_OFF_PHONE_PAID_LIMIT_FROM = "2026-10-02T00:00:00Z"; assert.notEqual(attendanceReadPolicyFingerprint(policy), first);
  } finally { if (before === undefined) delete process.env.CRM_OFF_PHONE_PAID_LIMIT_FROM; else process.env.CRM_OFF_PHONE_PAID_LIMIT_FROM = before; }
});
