export function payrollPaymentStatus<T extends string>(status: T): T | "Pending" {
    return status === "Review" ? "Pending" : status;
}

export function payrollPaymentAmountsValid(record: { grossPay: number; deductions: number; netPay: number }) {
    return [record.grossPay, record.deductions, record.netPay].every(value => Number.isFinite(value) && value >= 0 && Number.isSafeInteger(Math.round(value * 100))) &&
        Math.round(record.grossPay * 100) - Math.round(record.deductions * 100) === Math.round(record.netPay * 100);
}

export function payrollPaymentAliasBlocker(records: Array<{ grossPay: number; deductions: number; netPay: number; status: string; paidOn: string }>) {
    if (!records.length || records.some(record => !payrollPaymentAmountsValid(record))) return "Saved payroll amounts are missing or inconsistent.";
    if (new Set(records.map(record => JSON.stringify([record.grossPay, record.deductions, record.netPay]))).size !== 1) return "Saved cutoff copies have different payroll amounts. Confirm the correct amounts before payment.";
    if (records.some(record => record.status === "Completed")) return "Completed payroll is locked.";
    const paid = records.filter(record => record.status === "Paid");
    if (paid.length && (paid.length !== records.length || new Set(paid.map(record => record.paidOn)).size !== 1)) return "Saved payment statuses or paid dates conflict. Resolve the payment history first.";
    if (paid.some(record => !record.paidOn || record.paidOn === "-")) return "Saved Paid payroll is missing its payment date. Resolve the payment history first.";
    return null;
}
