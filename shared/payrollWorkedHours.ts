import { earnedAllDeductionsVersion, isEarnedPayrollVersion } from "./payrollEarnings";

export function adjustedPayrollHours(source: { scheduledHours: number; excessBreakMinutes: number; excessLunchMinutes: number; nonBillableOffPhoneMinutes?: number; calculationVersion?: string; lateMinutes?: number; earlyTimeOutMinutes?: number; absenceMinutes?: number }, workedMinutes: number) {
    const scheduledMinutes = Math.round(source.scheduledHours * 60);
    if (!Number.isSafeInteger(workedMinutes) || workedMinutes < 0 || !Number.isSafeInteger(scheduledMinutes) || scheduledMinutes < 0 || workedMinutes > scheduledMinutes) {
        throw new Error("Total hours must be between zero and the scheduled cutoff hours, in whole minutes.");
    }
    if (![source.excessBreakMinutes, source.excessLunchMinutes, source.nonBillableOffPhoneMinutes ?? 0].every(value => Number.isSafeInteger(value) && value >= 0)) {
        throw new Error("Saved break or lunch deductions need payroll review.");
    }
    if (isEarnedPayrollVersion(source.calculationVersion)) {
        const restMinutes = source.excessBreakMinutes + source.excessLunchMinutes + (source.nonBillableOffPhoneMinutes ?? 0);
        const shortfalls = source.calculationVersion === earnedAllDeductionsVersion ? [source.lateMinutes ?? 0, source.earlyTimeOutMinutes ?? 0, source.absenceMinutes ?? 0] : [];
        if (!shortfalls.every(value => Number.isSafeInteger(value) && value >= 0)) throw new Error("Attendance shortfall deductions need payroll review.");
        const deductibleMinutes = restMinutes + shortfalls.reduce((sum, value) => sum + value, 0);
        if (workedMinutes + restMinutes > scheduledMinutes) throw new Error("Paid hours plus non-billable and rest deductions exceed the scheduled cutoff hours.");
        return { workedHours: workedMinutes / 60, workedMinutesOverride: workedMinutes, missingHours: deductibleMinutes / 60,
            deductibleMinutes, earnedGrossHours: (workedMinutes + restMinutes) / 60 };
    }
    const shortfall = Math.max(scheduledMinutes - workedMinutes, source.nonBillableOffPhoneMinutes ?? 0);
    return { workedHours: workedMinutes / 60, workedMinutesOverride: workedMinutes, missingHours: shortfall / 60,
        deductibleMinutes: shortfall + source.excessBreakMinutes + source.excessLunchMinutes };
}
