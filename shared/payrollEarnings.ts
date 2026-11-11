export type PayrollEarningsView = {
    currentCutoffDraft?: boolean;
    earnedToDate?: boolean;
    cutoffEstimate?: boolean;
    earningsAsOf?: string;
    earningsUnavailable?: boolean;
    earningsUnavailableReason?: string;
    settlementRequired?: boolean;
    savedAmounts?: { grossPay: number; deductions: number; netPay: number };
};

export const earnedAllDeductionsVersion = "earned-hours-all-deductions-v1";
export const earnedLateRestVersion = "earned-hours-late-rest-v1";
export const fixedHalfSalaryVersion = "fixed-half-month-salary-v1";
export const earnedMinuteCappedVersion = "earned-minute-capped-v1";
export const isFixedHalfSalaryVersion = (version?: string) => version === fixedHalfSalaryVersion;
export function isEarnedPayrollVersion(version?: string) {
    return version === "earned-hours-v1" || version === earnedAllDeductionsVersion || version === earnedLateRestVersion || version === earnedMinuteCappedVersion;
}
