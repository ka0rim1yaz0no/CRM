import type { ClientSession } from "mongoose";
import type { PayrollEarningsView } from "../../../shared/payrollEarnings";
import { savedPayrollPeriod } from "../../../shared/payrollPeriod";
import { currentCutoffLiveFrom } from "../config/payrollEarnings";
import { currentEarnedPayrollRecords } from "./payrollEarningsRead";
import { savedPayrollPaymentRecord } from "./payrollReadPolicy";

type PaymentSource = { _id: unknown; employeeId: string; payPeriod: string; status: string; grossPay: number; deductions: number; netPay: number;
    requiresReview?: boolean; payrollOwnerBusinessId?: string };
export type PayrollAmountReadBasis = "saved" | "estimate" | "payment";

export function liveCurrentPayrollRecord(record: Pick<PaymentSource, "payPeriod" | "status">, currentPayPeriod: string) {
    const from = currentCutoffLiveFrom(), period = savedPayrollPeriod(record.payPeriod), current = savedPayrollPeriod(currentPayPeriod);
    return Boolean(from && period && current && period.start >= from && period.start <= current.start && !["Paid", "Completed"].includes(record.status));
}

export async function payrollPaymentReadRecords<T extends PaymentSource>(records: T[], currentPayPeriod: string, basis: PayrollAmountReadBasis = "payment", session?: ClientSession): Promise<Array<Omit<T, keyof PayrollEarningsView> & PayrollEarningsView>> {
    if (basis === "estimate") return currentEarnedPayrollRecords(records, currentPayPeriod, session);
    if (basis === "saved") return records.map(savedPayrollPaymentRecord);
    const result: Array<Omit<T, keyof PayrollEarningsView> & PayrollEarningsView> = [];
    for (const record of records) {
        if (!liveCurrentPayrollRecord(record, currentPayPeriod)) { result.push(savedPayrollPaymentRecord(record)); continue; }
        const value = (await currentEarnedPayrollRecords([record], currentPayPeriod, session))[0];
        result.push({ ...value, currentCutoffDraft: true });
    }
    return result;
}
