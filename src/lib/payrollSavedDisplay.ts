import type { PayrollRecord } from "../api/payroll";
import { payrollPaymentAmountsValid } from "../../shared/payrollPaymentStatus";

export function payrollSavedTableRows(records: readonly PayrollRecord[], sortBy: string, sortDir: "asc" | "desc") {
    const rows = records.map(record => {
        if (record.currentCutoffDraft) return !record.earningsUnavailable && payrollPaymentAmountsValid(record) ? record : {
            ...record, earningsUnavailable: true, earningsUnavailableReason: record.earningsUnavailableReason || "Current payroll amounts need review.",
        };
        const projected = record.earnedToDate || record.cutoffEstimate;
        const saved = record.savedAmounts ?? (!projected || record.earningsUnavailable ? record : undefined);
        if (!saved || !payrollPaymentAmountsValid(saved)) return { ...record, earningsUnavailable: true,
            earningsUnavailableReason: "Saved payroll amounts need review." };
        return { ...record, grossPay: saved.grossPay, deductions: saved.deductions, netPay: saved.netPay,
            savedAmounts: projected ? {
                grossPay: saved.grossPay, deductions: saved.deductions, netPay: saved.netPay,
            } : record.savedAmounts,
            earningsUnavailable: undefined, earningsUnavailableReason: undefined };
    });
    if (["grossPay", "deductions", "netPay"].includes(sortBy)) {
        const key = sortBy as "grossPay" | "deductions" | "netPay";
        rows.sort((first, second) => (first[key] - second[key]) * (sortDir === "desc" ? -1 : 1) || first._id.localeCompare(second._id));
    }
    return rows;
}
