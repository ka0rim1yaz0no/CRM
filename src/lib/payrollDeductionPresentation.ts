import type { SavedDeductionSource } from "../../shared/payrollPresentation";

// Informational amounts already excluded from earned pay are not additional deductions.
export function payrollDeductionDisplayTotal(record: SavedDeductionSource): number | null {
    if (typeof record.deductions !== "number" || !Number.isFinite(record.deductions) || record.deductions < 0) return null;
    const cents = Math.round(record.deductions * 100);
    return Number.isSafeInteger(cents) ? (cents === 0 ? 0 : cents / 100) : null;
}
