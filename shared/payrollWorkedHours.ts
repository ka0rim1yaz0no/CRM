export function adjustedPayrollHours(source: { scheduledHours: number; excessBreakMinutes: number; excessLunchMinutes: number; nonBillableOffPhoneMinutes?: number }, workedMinutes: number) {
    const scheduledMinutes = Math.round(source.scheduledHours * 60);
    if (!Number.isSafeInteger(workedMinutes) || workedMinutes < 0 || !Number.isSafeInteger(scheduledMinutes) || scheduledMinutes < 0 || workedMinutes > scheduledMinutes) {
        throw new Error("Total hours must be between zero and the scheduled cutoff hours, in whole minutes.");
    }
    if (![source.excessBreakMinutes, source.excessLunchMinutes, source.nonBillableOffPhoneMinutes ?? 0].every(value => Number.isSafeInteger(value) && value >= 0)) {
        throw new Error("Saved break or lunch deductions need payroll review.");
    }
    const shortfall = Math.max(scheduledMinutes - workedMinutes, source.nonBillableOffPhoneMinutes ?? 0);
    return { workedHours: workedMinutes / 60, workedMinutesOverride: workedMinutes, missingHours: shortfall / 60,
        deductibleMinutes: shortfall + source.excessBreakMinutes + source.excessLunchMinutes };
}
