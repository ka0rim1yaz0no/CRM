export type EqualHalfCutoffRateDetails = {
    rateBasis: "equal-half-cutoff-v1";
    cutoffWorkingDays: number;
    cutoffScheduledPaidMinutes: number;
    cutoffEquivalentWorkingDays: number;
    cutoffEquivalentPaidHours: number;
    monthlyReferenceMinuteRate: number;
    monthlyReferenceHourlyRate: number;
};

export function equalHalfCutoffRates(input: {
    cutoffBasePay: number; monthlyWorkingDays: number; cutoffWorkingDays: number;
    paidHoursPerDay: number; monthlyMinuteRate: number;
}): EqualHalfCutoffRateDetails & { hourlyRate: number; minuteRate: number } {
    const { cutoffBasePay, monthlyWorkingDays, cutoffWorkingDays, paidHoursPerDay, monthlyMinuteRate } = input;
    const paidMinutes = Math.round(paidHoursPerDay * 60);
    if (!Number.isFinite(cutoffBasePay) || cutoffBasePay < 0 || !Number.isSafeInteger(Math.round(cutoffBasePay * 100)) ||
        !Number.isSafeInteger(monthlyWorkingDays) || monthlyWorkingDays <= 0 || monthlyWorkingDays > 31 ||
        !Number.isSafeInteger(cutoffWorkingDays) || cutoffWorkingDays <= 0 || cutoffWorkingDays > monthlyWorkingDays ||
        !Number.isFinite(paidHoursPerDay) || paidMinutes <= 0 || paidMinutes > 1440 || Math.abs(paidHoursPerDay * 60 - paidMinutes) > 1e-8 ||
        !Number.isFinite(monthlyMinuteRate) || monthlyMinuteRate < 0) {
        throw new Error("Equal-half accrual requires verified salary, workdays and whole scheduled paid minutes.");
    }
    const cutoffScheduledPaidMinutes = cutoffWorkingDays * paidMinutes;
    const minuteRate = cutoffBasePay / cutoffScheduledPaidMinutes;
    return {
        rateBasis: "equal-half-cutoff-v1", hourlyRate: minuteRate * 60, minuteRate,
        cutoffWorkingDays, cutoffScheduledPaidMinutes,
        cutoffEquivalentWorkingDays: monthlyWorkingDays / 2,
        cutoffEquivalentPaidHours: monthlyWorkingDays / 2 * paidHoursPerDay,
        monthlyReferenceMinuteRate: monthlyMinuteRate, monthlyReferenceHourlyRate: monthlyMinuteRate * 60,
    };
}
