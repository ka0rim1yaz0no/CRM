export type PayrollGenerationPlan = {
    businessId: string;
    payPeriod: string;
    token: string;
    canApply: boolean;
    automaticEnabled: boolean;
    rows: Array<{ employeeCode: string; employeeName: string; businessIds: string[]; grossPay: number; deductions: number; netPay: number;
        nonBillableOffPhoneMinutes: number; nonBillableOffPhoneDeduction: number; incompleteShiftDays: number; scheduledDays: number }>;
    held: Array<{ employeeCode: string; employeeName: string; reason: string }>;
};
