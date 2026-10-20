import { api } from "../lib/api";

export type PayrollStatus = "Paid" | "Pending" | "Failed" | "Completed" | "Review" | "Applied" | "Enabled";
export type PayrollItemCategory = "Payroll Runs" | "Payouts" | "Deductions" | "Tax Settings";
export type PayrollPayType = "Monthly" | "Semi-monthly" | "Weekly" | "Hourly" | "Contract";

export type PayrollRecord = {
    _id: string;
    employeeName: string;
    email: string;
    employeeId: string;
    department: string;
    payType: PayrollPayType;
    grossPay: number;
    basicPay?: number;
    workingDays?: number;
    minuteRate?: number;
    paidHoursPerDay?: number | null;
    hourlyRate?: number;
    calculationVersion?: string;
    payrollOwnerBusinessId?: string;
    calculationSnapshot?: { monthlySalary?: number };
    lateMinutes?: number;
    excessLunchMinutes?: number;
    excessBreakMinutes?: number;
    absenceMinutes?: number;
    earlyTimeOutMinutes?: number;
    deductibleMinutes?: number;
    incompleteShiftDays?: number;
    deductions: number;
    netPay: number;
    attendanceDays?: number;
    absentDays?: number;
    absentHours?: number;
    lateDays?: number;
    lateHours?: number;
    workedHours?: number;
    workedMinutesOverride?: number | null;
    overtimeHours?: number;
    overtimeApproved?: boolean;
    scheduledHours?: number;
    status: PayrollStatus;
    paidOn: string;
    payPeriod: string;
    isArchived?: boolean;
    createdAt?: string;
    updatedAt?: string;
};

export type PayrollListItem = {
    _id: string;
    category: PayrollItemCategory;
    name: string;
    second: string;
    third: string;
    fourth: string;
    status: PayrollStatus;
    isArchived?: boolean;
};

export type PayrollStats = {
    totalEmployees: number;
    totalPayroll: number;
    totalDeductions: number;
    netPayroll: number;
    paidEmployees: number;
};

export type PayrollDtrRow = {
    dateKey: string;
    date: string;
    day: string;
    status: "Present" | "Late" | "Overtime" | "Absent" | "Weekend" | "Scheduled" | "In Progress" | "Needs Review";
    isWeekend: boolean;
    timeIn: string;
    timeOut: string;
    lunchHours: number;
    lateMinutes: number;
    excessLunchMinutes: number;
    excessBreakMinutes: number;
    absenceMinutes: number;
    earlyTimeOutMinutes: number;
    grossHours: number;
    lateHours: number;
    regularHours: number;
    overtimeHours: number;
    missingHours: number;
    scheduledHours: number;
    recordCount: number;
};

export type PayrollDtr = {
    storedCutoff?: boolean;
    currentAttendanceWarning?: string;
    potentialOvertimeHours?: number;
    employee: {
        _id: string;
        name: string;
        employeeCode: string;
        department: string;
    };
    payPeriod: string;
    payDate: string;
    payType: PayrollPayType;
    summary: {
        attendanceDays: number;
        absentDays: number;
        absentHours: number;
        lateDays: number;
        lateHours: number;
        workingDays: number | null;
        monthlyWorkingDays: number;
        workedHours: number;
        overtimeHours: number;
        missingHours: number;
        scheduledHours: number;
        grossPay: number;
        basicPay: number;
        hourlyRate: number;
        minuteRate: number;
        paidHoursPerDay?: number | null;
        lateMinutes: number;
        excessLunchMinutes: number;
        excessBreakMinutes: number;
        absenceMinutes: number;
        earlyTimeOutMinutes: number;
        deductibleMinutes: number;
        incompleteShiftDays: number;
        deductions: number;
        netPay: number;
    };
    rows: PayrollDtrRow[];
};

export type PayrollPreview = { payPeriod: string; token: string; totalDifference: number; canApply: boolean;
    rows: Array<{ employeeCode: string; employeeName: string; ownerBusinessId: string; businessIds: string[]; reviewDays: number;
        before: { grossPay: number; deductions: number; netPay: number }; after: { grossPay: number; deductions: number; netPay: number };
        difference: number; potentialOvertimeHours: number; approvedOvertimeHours: number }> };
export async function getPayrollAccuracyConfig() { return (await api.get<{ enabled: boolean }>("/payroll/accuracy-config")).data; }
export async function previewPayrollCutoff(payPeriod: string, overtimeApprovals: Record<string, number>) {
    return (await api.post<PayrollPreview>("/payroll/recompute/preview", { payPeriod, overtimeApprovals })).data;
}
export async function confirmPayrollCutoff(preview: PayrollPreview, reason: string, overtimeApprovals: Record<string, number>) {
    return (await api.post<{ applied: number; mirrors: number }>("/payroll/recompute/confirm", { payPeriod: preview.payPeriod, token: preview.token, reason, overtimeApprovals, confirm: true })).data;
}

export type PayrollRecordInput = Omit<PayrollRecord, "_id" | "netPay" | "createdAt" | "updatedAt">;
export type PayrollItemInput = Omit<PayrollListItem, "_id">;

export async function getPayrollStats() {
    const response = await api.get<PayrollStats>("/payroll/stats");
    return response.data;
}

export async function getPayrollRecords(params?: {
    search?: string;
    status?: string;
    payPeriod?: string;
    sortBy?: string;
    sortDir?: "asc" | "desc";
    archived?: boolean;
}) {
    const response = await api.get<PayrollRecord[]>("/payroll/records", { params });
    return response.data;
}

export async function getPayrollDtr(employeeId: string, payPeriod?: string) {
    const response = await api.get<PayrollDtr>(`/payroll/dtr/${encodeURIComponent(employeeId)}`, { params: { payPeriod } });
    return response.data;
}

export async function getPayrollItems(category?: PayrollItemCategory, params: { archived?: boolean } = {}) {
    const response = await api.get<PayrollListItem[]>("/payroll/items", { params: { category, ...params } });
    return response.data;
}

export async function createPayrollRecord(record: PayrollRecordInput) {
    const response = await api.post<PayrollRecord>("/payroll/records", record);
    return response.data;
}

export async function updatePayrollRecord(id: string, record: PayrollRecordInput) {
    const response = await api.put<PayrollRecord>(`/payroll/records/${id}`, record);
    return response.data;
}

export async function updatePayrollOvertime(id: string, overtimeHours: number) {
    const response = await api.patch<PayrollRecord>(`/payroll/records/${id}/overtime`, { overtimeHours });
    return response.data;
}

export async function updateEmployeeBasicPay(employeeId: string, basicPay: number) {
    const response = await api.patch<PayrollRecord>(`/payroll/employees/${encodeURIComponent(employeeId)}/basic-pay`, { basicPay });
    return response.data;
}

export async function updatePayrollWorkedMinutes(id: string, workedMinutes: number) {
    const response = await api.patch<PayrollRecord>(`/payroll/records/${encodeURIComponent(id)}/worked-minutes`, { workedMinutes });
    return response.data;
}

export async function markPayrollRecordPaid(id: string) {
    const response = await api.patch<PayrollRecord>(`/payroll/records/${id}/paid`);
    return response.data;
}

export async function markPayrollRecordUnpaid(id: string) {
    const response = await api.patch<PayrollRecord>(`/payroll/records/${id}/unpaid`);
    return response.data;
}

export async function archivePayrollRecord(id: string) {
    const response = await api.patch<PayrollRecord>(`/payroll/records/${id}/archive`);
    return response.data;
}

export async function restorePayrollRecord(id: string) {
    const response = await api.patch<PayrollRecord>(`/payroll/records/${id}/restore`);
    return response.data;
}

export async function runPayroll(options?: { payPeriod?: string; payDate?: string }) {
    const response = await api.post<{ created: number; records: PayrollRecord[] }>("/payroll/run", options || {});
    return response.data;
}

export async function createPayrollItem(item: PayrollItemInput) {
    const response = await api.post<PayrollListItem>("/payroll/items", item);
    return response.data;
}

export async function archivePayrollItem(id: string) {
    const response = await api.patch<PayrollListItem>(`/payroll/items/${id}/archive`);
    return response.data;
}

export async function restorePayrollItem(id: string) {
    const response = await api.patch<PayrollListItem>(`/payroll/items/${id}/restore`);
    return response.data;
}
