export type PayrollDraftPreviewRow = {
    employeeCode: string;
    employeeName: string;
    department: string;
    warnings: string[];
    calculation: null | {
        basicPay: number; monthlySalary: number; grossPay: number; deductions: number; netPay: number;
        hourlyRate: number; minuteRate: number; paidHoursPerDay: number; attendanceDays: number; workedHours: number;
        nonBillableOffPhoneMinutes: number; nonBillableOffPhoneDeduction: number; incompleteShiftDays: number;
        scheduledDays: number; deductionDetails: Array<{ label: string; minutes: number; amount: number }>;
    };
};
export type PayrollDraftPreviews = {
    previewOnly: true;
    businessId: string;
    payPeriod: string;
    asOf: string;
    rows: PayrollDraftPreviewRow[];
};
