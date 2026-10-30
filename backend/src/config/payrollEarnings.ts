import type { OffPhoneLimitPolicy } from "../../../shared/attendanceOffPhone";
import { savedPayrollPeriod } from "../../../shared/payrollPeriod";
import { earnedAllDeductionsVersion, earnedLateRestVersion } from "../../../shared/payrollEarnings";

export function offPhoneLimitPolicy(): OffPhoneLimitPolicy | undefined {
    const effectiveFrom = process.env.CRM_OFF_PHONE_PAID_LIMIT_FROM;
    if (!effectiveFrom) return undefined;
    if (!/^\d{4}-\d{2}-\d{2}T/.test(effectiveFrom) || !Number.isFinite(Date.parse(effectiveFrom))) throw new Error("Invalid Off the Phone policy activation time");
    return { paidMinutes: 20, effectiveFrom };
}

export function earnedPayrollEnabled(payPeriod: string) {
    const from = process.env.CRM_EARNED_PAYROLL_FROM;
    if (!from) return false;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !Number.isFinite(Date.parse(from))) throw new Error("Invalid earned payroll activation cutoff");
    const period = savedPayrollPeriod(payPeriod);
    return Boolean(period && period.start >= from);
}

export function earnedAllDeductionsEnabled(payPeriod: string) {
    const from = process.env.CRM_EARNED_ALL_DEDUCTIONS_FROM;
    if (!from || !earnedPayrollEnabled(payPeriod)) return false;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !Number.isFinite(Date.parse(from))) throw new Error("Invalid all-deductions activation cutoff");
    const period = savedPayrollPeriod(payPeriod);
    return Boolean(period && period.start >= from);
}

export function earnedPayrollVersion(payPeriod: string) {
    if (earnedUndertimeAbsenceExcluded(payPeriod)) return earnedLateRestVersion;
    return earnedAllDeductionsEnabled(payPeriod) ? earnedAllDeductionsVersion : "earned-hours-v1";
}

export function earnedUndertimeAbsenceExcluded(payPeriod: string) {
    const from = process.env.CRM_EARNED_EXCLUDE_UNDERTIME_ABSENCE_FROM;
    if (!from || !earnedAllDeductionsEnabled(payPeriod)) return false;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !Number.isFinite(Date.parse(from))) throw new Error("Invalid earned undertime/absence exclusion cutoff");
    const period = savedPayrollPeriod(payPeriod);
    return Boolean(period && period.start >= from);
}
