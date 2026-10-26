export function adjustedPayrollHours(source: { scheduledHours: number; excessBreakMinutes: number; excessLunchMinutes: number }, workedMinutes: number) {
    const scheduledMinutes = Math.round(source.scheduledHours * 60);
    if (!Number.isSafeInteger(workedMinutes) || workedMinutes < 0 || !Number.isSafeInteger(scheduledMinutes) || scheduledMinutes < 0 || workedMinutes > scheduledMinutes) {
        throw new Error("Total hours must be between zero and the scheduled cutoff hours, in whole minutes.");
    }
    if (![source.excessBreakMinutes, source.excessLunchMinutes].every(value => Number.isSafeInteger(value) && value >= 0)) {
        throw new Error("Saved break or lunch deductions need payroll review.");
    }
    const shortfall = scheduledMinutes - workedMinutes;
    return { workedHours: workedMinutes / 60, workedMinutesOverride: workedMinutes, missingHours: shortfall / 60,
        deductibleMinutes: shortfall + source.excessBreakMinutes + source.excessLunchMinutes };
}
