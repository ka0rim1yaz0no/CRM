const money = (value: number) => Math.round((value + Number.EPSILON) * 100) / 100;

export function minuteAccrualAmounts(cap: number, minuteRate: number, earnedGrossHours: number, restMinutes: number, overtimeHours = 0) {
    if (![cap, minuteRate, earnedGrossHours].every(value => Number.isFinite(value) && value >= 0) ||
        !Number.isSafeInteger(Math.round(cap * 100)) || !Number.isSafeInteger(restMinutes) || restMinutes < 0) {
        throw new Error("Minute accrual requires valid rates, earned time and verified whole rest minutes.");
    }
    if (overtimeHours !== 0) throw new Error("Overtime is not payable under capped minute accrual.");
    const earned = earnedGrossHours * 60 * minuteRate, restDeduction = restMinutes * minuteRate;
    if (!Number.isFinite(earned) || !Number.isFinite(restDeduction)) throw new Error("Earned pay exceeds the supported calculation range.");
    const grossPay = Math.min(money(cap), money(earned)), deductions = Math.min(grossPay, money(restDeduction));
    return { grossPay, deductions, netPay: money(Math.max(0, grossPay - deductions)) };
}
