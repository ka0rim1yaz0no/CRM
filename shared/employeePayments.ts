import type { SavedDeductionSource } from "./payrollPresentation";

export type EmployeePayment = SavedDeductionSource & {
    id: string;
    payPeriod: string;
    cutoffStart: string;
    cutoffEnd: string;
    payType: string;
    department: string;
    grossPay: number;
    basicPay: number | null;
    netPay: number;
    monthlySalary: number | null;
    hourlyRate: number | null;
    minuteRate: number | null;
    paidHoursPerDay: number | null;
    workingDays: number | null;
    attendanceDays: number | null;
    absentDays: number | null;
    workedHours: number | null;
    scheduledHours: number | null;
    overtimeHours: number | null;
    overtimeApproved: boolean;
    deductibleMinutes: number | null;
    workedMinutesOverride?: number | null;
    incompleteShiftDays: number | null;
    status: string;
    requiresReview: boolean;
    calculationVersion?: string;
    paidOn: string | null;
    scheduledPayDate: string | null;
    updatedAt: string | null;
};

export type EmployeePayments = {
    business: { id: string; name: string };
    currencyCode: string;
    currentPayPeriod: string;
    historyFrom: string | null;
    initialPayPeriod: string | null;
    setupPending: boolean;
    items: EmployeePayment[];
    total: number;
    page: number;
    view: "current" | "history";
    pageSize: number;
    reviewCount: number;
    asOf: string;
};
