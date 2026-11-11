import type { PayrollDtr } from "../api/payroll";
import { savedPayrollPeriod } from "../../shared/payrollPeriod";

export function payrollDtrPresentation(dtr: PayrollDtr) {
    const period = savedPayrollPeriod(dtr.payPeriod), comparison = dtr.attendanceComparison;
    const datedReference = dtr.storedCutoff === true && period?.start === "2026-10-21" && period.end === "2026-11-05" &&
        comparison?.referenceOnly === true && comparison.basis === "dated-earned-minutes" &&
        comparison.fromDate === period.start && comparison.toDate === period.end &&
        comparison.summary.calculationVersion === "earned-minute-capped-v1" &&
        [comparison.summary.workedHours, comparison.summary.grossPay, comparison.summary.deductions,
            comparison.summary.netPay, comparison.summary.deductibleMinutes].every(value => Number.isFinite(value) && value >= 0);
    return { datedReference, summary: datedReference ? comparison!.summary : dtr.summary, paymentSummary: dtr.summary };
}
