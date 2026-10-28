export type PayrollEarningsView = {
    earnedToDate?: boolean;
    earningsAsOf?: string;
    earningsUnavailable?: boolean;
    settlementRequired?: boolean;
    savedAmounts?: { grossPay: number; deductions: number; netPay: number };
};

export const earnedAllDeductionsVersion = "earned-hours-all-deductions-v1";
export function isEarnedPayrollVersion(version?: string) {
    return version === "earned-hours-v1" || version === earnedAllDeductionsVersion;
}
