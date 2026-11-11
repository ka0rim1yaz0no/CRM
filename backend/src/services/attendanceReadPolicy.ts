import { createHash } from "node:crypto";
import { attendanceAccuracyFixesEnabled, attendanceAutoTimeOutEnabled, attendanceBreakGapEnabled,
  attendanceDurationModelEnabled, attendanceIntegrityEnabled, attendanceRecoveryEnvironmentEnabled, payrollAccuracyEnabled } from "../config/rolloutFlags";
import { offPhoneLimitPolicy } from "../config/payrollEarnings";

type ReadPolicy = { revision: number; shiftStart: string; shiftEnd: string; graceMinutes: number; breakMinutes: number; lunchMinutes: number;
  autoTimeOutTime?: string; recoveryEnabled?: boolean; recoveryTime?: string };

// Revision zero can come from legacy system settings. Pin their actual read
// inputs instead of treating an unchanged numeric revision as sufficient proof.
export function attendanceReadPolicyFingerprint(policy: ReadPolicy) {
  return createHash("sha256").update(JSON.stringify({ version: 1, revision: policy.revision, shiftStart: policy.shiftStart,
    shiftEnd: policy.shiftEnd, graceMinutes: policy.graceMinutes, breakMinutes: policy.breakMinutes, lunchMinutes: policy.lunchMinutes,
    autoTimeOutTime: policy.autoTimeOutTime, recoveryEnabled: policy.recoveryEnabled, recoveryTime: policy.recoveryTime,
    durationModel: attendanceDurationModelEnabled(), accuracyFixes: attendanceAccuracyFixesEnabled(), breakGap: attendanceBreakGapEnabled(),
    integrity: attendanceIntegrityEnabled(), autoTimeOut: attendanceAutoTimeOutEnabled(), recoveryEnvironment: attendanceRecoveryEnvironmentEnabled(),
    accurateRestRounding: payrollAccuracyEnabled(), offPhoneLimit: offPhoneLimitPolicy() })).digest("hex");
}
