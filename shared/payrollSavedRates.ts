type SavedRates = { payType: string; grossPay?: number | null; monthlySalary?: number | null; basicPay?: number | null; workingDays?: number | null;
    hourlyRate?: number | null; minuteRate?: number | null; paidHoursPerDay?: number | null; calculationVersion?: string };
const nonnegative = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;
const positive = (value: unknown): value is number => nonnegative(value) && value > 0;

export function savedPayrollDisplayRates(record: SavedRates) {
    const calculated: string[] = [];
    let monthlyBasicPay = nonnegative(record.monthlySalary) ? record.monthlySalary : null;
    if (monthlyBasicPay === null && record.payType === "Semi-monthly" && nonnegative(record.basicPay)) {
        monthlyBasicPay = Math.round(record.basicPay * 2 * 100) / 100; calculated.push("monthlyBasicPay");
    }
    let hourlyRate = nonnegative(record.hourlyRate) ? record.hourlyRate : null;
    const zeroPayRate = record.minuteRate === 0 && monthlyBasicPay === 0 && record.grossPay === 0;
    if (hourlyRate === null && (positive(record.minuteRate) || zeroPayRate)) { hourlyRate = record.minuteRate! * 60; calculated.push("hourlyRate"); }
    let paidHoursPerDay = positive(record.paidHoursPerDay) ? record.paidHoursPerDay : null;
    if (paidHoursPerDay === null && positive(monthlyBasicPay) && positive(record.workingDays) && positive(hourlyRate)) {
        const implied = monthlyBasicPay / record.workingDays / hourlyRate;
        // The legacy 8-hour policy rounded some saved minute rates to cents.
        const legacyEight = !record.calculationVersion && positive(record.minuteRate) &&
            Math.abs(monthlyBasicPay / record.workingDays / 8 / 60 - record.minuteRate) <= 0.005;
        const hours = legacyEight ? 8 : Math.round(implied * 100) / 100;
        if (hours > 0 && hours <= 24) { paidHoursPerDay = hours; calculated.push("paidHoursPerDay"); }
    }
    if (hourlyRate === null && positive(monthlyBasicPay) && positive(record.workingDays) && positive(paidHoursPerDay)) {
        hourlyRate = monthlyBasicPay / record.workingDays / paidHoursPerDay; calculated.push("hourlyRate");
    }
    return { monthlyBasicPay, hourlyRate, paidHoursPerDay, calculated };
}
