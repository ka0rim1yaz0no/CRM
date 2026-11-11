const money = (value: number) => Math.round((value + Number.EPSILON) * 100) / 100;

export function fixedHalfSalaryBase(monthlySalary: number, firstCutoff: boolean) {
    if (!Number.isFinite(monthlySalary) || monthlySalary < 0 || !Number.isSafeInteger(Math.round(monthlySalary * 100))) {
        throw new Error("Monthly salary must be a valid non-negative amount.");
    }
    const cents = Math.round(monthlySalary * 100), first = Math.floor(cents / 2);
    return (firstCutoff ? first : cents - first) / 100;
}

export function fixedHalfSalaryAmounts(basicPay: number, minuteRate: number, deductibleMinutes: number, approvedOvertimeHours = 0) {
    if (!Number.isFinite(basicPay) || basicPay < 0 || !Number.isSafeInteger(Math.round(basicPay * 100)) ||
        !Number.isFinite(minuteRate) || minuteRate < 0 || !Number.isSafeInteger(deductibleMinutes) || deductibleMinutes < 0) {
        throw new Error("Fixed-salary payroll requires valid saved rates and whole verified deduction minutes.");
    }
    if (approvedOvertimeHours !== 0) throw new Error("Overtime is not payable under the fixed half-month salary policy. Review the saved approval.");
    const grossPay = money(basicPay), deductions = Math.min(grossPay, money(deductibleMinutes * minuteRate));
    return { grossPay, deductions, netPay: money(Math.max(0, grossPay - deductions)) };
}
