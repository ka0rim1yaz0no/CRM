import { api } from "../lib/api";
import type { Employee } from "./employees";
import type { PayrollDraftPreviews } from "../../shared/payrollDraftPreview";

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
    nonBillableOffPhoneMinutes?: number;
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
    requiresReview?: boolean;
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
    payPeriod?: string;
    recordedEmployees?: number;
    unrecordedEmployees?: number;
    totalEmployees: number;
    totalPayroll: number;
    totalDeductions: number;
    netPayroll: number;
    paidEmployees: number;
};

export type PayrollDtrRow = {
    restWarnings?: string[];
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
    nonBillableOffPhoneMinutes?: number;
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
    currentAttendanceReviewDays?: number | null;
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
        workedMinutesOverride?: number | null;
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
        nonBillableOffPhoneMinutes?: number;
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
        difference: number; potentialOvertimeHours: number; approvedOvertimeHours: number;
        nonBillableOffPhone?: { before: { minutes: number; amount: number }; after: { minutes: number; amount: number }; minuteRate: number } }> };
export async function getPayrollAccuracyConfig() { return (await api.get<{ enabled: boolean; workedHoursEditingEnabled?: boolean; paymentStatusPreviewEnabled?: boolean; cutoffSelectionEnabled?: boolean; employeeRosterEnabled?: boolean; automaticPreviewsEnabled?: boolean; missingGenerationEnabled?: boolean }>("/payroll/accuracy-config")).data; }
export async function previewMissingPayroll(payPeriod: string, businessId: string, signal?: AbortSignal) {
    const result = (await api.post<import("../../shared/payrollGeneration").PayrollGenerationPlan>("/payroll/missing/preview", { payPeriod }, { headers: { "X-Business-Id": businessId }, signal })).data;
    if (result.businessId !== businessId || result.payPeriod !== payPeriod) throw new Error("Payroll context changed. Refresh Payroll.");
    return result;
}
export async function confirmMissingPayroll(preview: import("../../shared/payrollGeneration").PayrollGenerationPlan, reason: string, enableFuture: boolean) {
    return (await api.post<{ created: number; mirrors: number; automaticEnabled: boolean }>("/payroll/missing/confirm", {
        payPeriod: preview.payPeriod, token: preview.token, confirm: true, reason, enableFuture,
    }, { headers: { "X-Business-Id": preview.businessId } })).data;
}
export async function getCurrentPayrollPreviews(payPeriod: string, businessId: string, signal?: AbortSignal) {
    const result = (await api.get<PayrollDraftPreviews>("/payroll/current-previews", { params: { payPeriod }, headers: { "X-Business-Id": businessId }, signal })).data;
    if (result.businessId !== businessId || result.payPeriod !== payPeriod || result.previewOnly !== true) throw new Error("Payroll preview context changed. Refresh Payroll.");
    return result;
}
export type PayrollCutoffs = { currentPayPeriod: string; defaultPayPeriod: string; historyFrom: string | null;
    items: Array<{ payPeriod: string; start: string; end: string; recordedEmployees: number; visibleEmployees?: number }> };
export async function getPayrollCutoffs() { return (await api.get<PayrollCutoffs>("/payroll/cutoffs")).data; }
export type PayrollRosterGap = { employeeId: string; employeeName: string; email: string; department: string; payPeriod: string; state: "not-generated" | "conflict" | "unavailable" };
export async function getPayrollRosterGaps(params: { payPeriod?: string; search?: string; status?: string }, options: { businessId: string; serverRosterEnabled: boolean }) {
    const headers = { "X-Business-Id": options.businessId };
    if (options.serverRosterEnabled) return (await api.get<PayrollRosterGap[]>("/payroll/roster-gaps", { params, headers })).data;
    const [people, records] = await Promise.all([api.get<Employee[]>("/employees", { params: { summary: true }, headers }).then(response => response.data), getPayrollRecords({ payPeriod: params.payPeriod }, options)]);
    if (!Array.isArray(people) || !Array.isArray(records) || !params.payPeriod) throw new Error("Unable to verify the current payroll roster.");
    const saved = new Set(records.map(record => record.employeeId)), term = (params.search || "").trim().toLowerCase();
    return people.filter(person => person.status !== "Archived" && !saved.has(person.employeeCode)).map(person => ({
        employeeId: person.employeeCode, employeeName: person.name, email: person.email || "", department: person.team || "", payPeriod: params.payPeriod!, state: "unavailable" as const,
    })).filter(row => (!params.status || params.status === "Not ready") && (!term || [row.employeeId, row.employeeName, row.email, row.department].some(value => value.toLowerCase().includes(term))));
}
export type PayrollPaymentPreview = { id: string; payPeriod: string; paid: boolean; paidOn: string; token: string; businessIds: string[]; canApply: boolean;
    blockers: string[]; warnings: string[]; rows: Array<{ businessId: string; businessName: string; grossPay: number; deductions: number; netPay: number;
        status: string; paidOn: string; savedCopies: number; currentAttendanceReviewDays: number | null }> };
export async function previewPayrollPaymentStatus(id: string, paid: boolean, businessId: string, signal?: AbortSignal) {
    return (await api.post<PayrollPaymentPreview>(`/payroll/records/${encodeURIComponent(id)}/payment-status/preview`, { paid }, { headers: { "X-Business-Id": businessId }, signal })).data;
}
export async function confirmPayrollPaymentStatus(preview: PayrollPaymentPreview, reason: string, acknowledgeAttendance: boolean, businessId: string) {
    return (await api.post<{ applied: boolean }>(`/payroll/records/${encodeURIComponent(preview.id)}/payment-status/confirm`,
        { token: preview.token, paid: preview.paid, reason, acknowledgeAttendance, confirm: true }, { headers: { "X-Business-Id": businessId } })).data;
}
export type PayrollHoursPreview = { id: string; payPeriod: string; workedMinutes: number; businessIds: string[]; token: string;
    before: { workedHours: number; grossPay: number; deductions: number; netPay: number; deductibleMinutes: number; status: PayrollStatus; paidOn: string };
    after: PayrollHoursPreview["before"] };
export async function previewPayrollWorkedHours(id: string, workedMinutes: number, businessId: string, signal?: AbortSignal) {
    return (await api.post<PayrollHoursPreview>(`/payroll/records/${encodeURIComponent(id)}/worked-minutes/preview`, { workedMinutes },
        { headers: { "X-Business-Id": businessId }, signal })).data;
}
export async function confirmPayrollWorkedHours(preview: PayrollHoursPreview, reason: string, businessId: string) {
    return (await api.post<{ applied: boolean; mirrors: number }>(`/payroll/records/${encodeURIComponent(preview.id)}/worked-minutes/confirm`,
        { token: preview.token, workedMinutes: preview.workedMinutes, confirm: true, reason }, { headers: { "X-Business-Id": businessId } })).data;
}
export async function previewPayrollCutoff(payPeriod: string, overtimeApprovals: Record<string, number>) {
    return (await api.post<PayrollPreview>("/payroll/recompute/preview", { payPeriod, overtimeApprovals })).data;
}
export async function confirmPayrollCutoff(preview: PayrollPreview, reason: string, overtimeApprovals: Record<string, number>) {
    return (await api.post<{ applied: number; mirrors: number }>("/payroll/recompute/confirm", { payPeriod: preview.payPeriod, token: preview.token, reason, overtimeApprovals, confirm: true })).data;
}

export type PayrollRecordInput = Omit<PayrollRecord, "_id" | "netPay" | "createdAt" | "updatedAt">;
export type PayrollItemInput = Omit<PayrollListItem, "_id">;

export async function getPayrollStats(payPeriod?: string) {
    const response = await api.get<PayrollStats>("/payroll/stats", { params: { payPeriod } });
    return response.data;
}

export async function getPayrollRecords(params?: {
    search?: string;
    status?: string;
    payPeriod?: string;
    sortBy?: string;
    sortDir?: "asc" | "desc";
    archived?: boolean;
}, options: { businessId?: string } = {}) {
    const response = await api.get<PayrollRecord[]>("/payroll/records", { params, headers: options.businessId ? { "X-Business-Id": options.businessId } : undefined });
    return response.data;
}

export async function getPayrollDtr(employeeId: string, payPeriod?: string, options: { businessId?: string; signal?: AbortSignal } = {}) {
    const response = await api.get<PayrollDtr>(`/payroll/dtr/${encodeURIComponent(employeeId)}`, {
        params: { payPeriod }, signal: options.signal,
        ...(options.businessId ? { headers: { "X-Business-Id": options.businessId } } : {}),
    });
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
