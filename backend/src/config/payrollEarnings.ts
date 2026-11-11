import type { OffPhoneLimitPolicy } from "../../../shared/attendanceOffPhone";
import { savedPayrollPeriod } from "../../../shared/payrollPeriod";
import { earnedAllDeductionsVersion, earnedLateRestVersion, fixedHalfSalaryVersion, earnedMinuteCappedVersion } from "../../../shared/payrollEarnings";

export function equalHalfCutoffAccrualEnabled(payPeriod: string) {
    const from = process.env.CRM_EQUAL_HALF_CUTOFF_FROM;
    if (!from) return false;
    const time = Date.parse(`${from}T00:00:00.000Z`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !Number.isFinite(time) || new Date(time).toISOString().slice(0, 10) !== from || from < "2026-11-21") {
        throw new Error("Equal-half accrual cannot include existing cutoffs or an invalid activation date");
    }
    const period = savedPayrollPeriod(payPeriod);
    if (period && period.start >= from && !minuteAccrualEnabled(payPeriod)) throw new Error("Equal-half accrual requires verified minute accrual.");
    return Boolean(period && period.start >= from);
}

export function minuteAccrualEnabled(payPeriod: string) {
    const from = process.env.CRM_MINUTE_ACCRUAL_FROM;
    if (!from) return false;
    const time = Date.parse(`${from}T00:00:00.000Z`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !Number.isFinite(time) || new Date(time).toISOString().slice(0, 10) !== from || from < "2026-11-06") {
        throw new Error("Minute accrual cannot include restored cutoffs or an invalid activation date");
    }
    const period = savedPayrollPeriod(payPeriod);
    if (period && period.start >= from && !earnedPayrollEnabled(payPeriod)) throw new Error("Minute accrual requires verified earned payroll.");
    return Boolean(period && period.start >= from);
}

export function currentCutoffLiveFrom() {
    const from = process.env.CRM_CURRENT_CUTOFF_LIVE_FROM;
    if (!from) return undefined;
    const time = Date.parse(`${from}T00:00:00.000Z`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !Number.isFinite(time) || new Date(time).toISOString().slice(0, 10) !== from || from < "2026-11-06") {
        throw new Error("Live current payroll cannot include restored cutoffs or an invalid activation date");
    }
    return from;
}

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
    if (minuteAccrualEnabled(payPeriod)) return earnedMinuteCappedVersion;
    if (fixedHalfSalaryEnabled(payPeriod)) return fixedHalfSalaryVersion;
    if (earnedUndertimeAbsenceExcluded(payPeriod)) return earnedLateRestVersion;
    return earnedAllDeductionsEnabled(payPeriod) ? earnedAllDeductionsVersion : "earned-hours-v1";
}

export function fixedHalfSalaryEnabled(payPeriod: string) {
    if (minuteAccrualEnabled(payPeriod)) return false;
    const from = process.env.CRM_FIXED_HALF_SALARY_FROM;
    if (!from || !earnedPayrollEnabled(payPeriod)) return false;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !Number.isFinite(Date.parse(from))) throw new Error("Invalid fixed salary activation cutoff");
    const period = savedPayrollPeriod(payPeriod);
    return Boolean(period && period.start >= from);
}

export function earnedUndertimeAbsenceExcluded(payPeriod: string) {
    const from = process.env.CRM_EARNED_EXCLUDE_UNDERTIME_ABSENCE_FROM;
    if (!from || !earnedAllDeductionsEnabled(payPeriod)) return false;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !Number.isFinite(Date.parse(from))) throw new Error("Invalid earned undertime/absence exclusion cutoff");
    const period = savedPayrollPeriod(payPeriod);
    return Boolean(period && period.start >= from);
}
