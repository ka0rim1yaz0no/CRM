import { currentPeriod, periodRange, scheduledPayDateForPeriod } from "../controllers/payrollController";
import { getSystemSettings } from "../controllers/systemSettingsController";
import { getCurrentBusiness, runForEachBusiness } from "../config/tenancy";
import { EmployeePaymentHistoryPolicy } from "../models/EmployeePaymentHistoryPolicy";
import { PayrollRecord, type PayrollRecordDocument } from "../models/Payroll";
import type { EmployeePayment, EmployeePayments } from "../../../shared/employeePayments";
import { savedPayrollPeriod, isConfiguredSavedPayrollPeriod } from "../../../shared/payrollPeriod";
import { payrollReadGroups } from "./payrollReadPolicy";

const policyId = "employee-payment-history";
export function payrollDateKey(date: Date) {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

// The activation boundary is stored once per tenant, never moved by a page refresh.
export async function initializeEmployeePaymentHistory(apply = false) {
    const results: Array<{ businessId: string; fromDate: string; initialPayPeriod: string; existing: boolean }> = [];
    await runForEachBusiness(async business => {
        const existing = await EmployeePaymentHistoryPolicy.findById(policyId).lean();
        const settings = await getSystemSettings();
        const payPeriod = currentPeriod(settings.payrollBillingCycle, settings);
        const candidate = { fromDate: payrollDateKey(periodRange(payPeriod).start), initialPayPeriod: payPeriod, activatedAt: new Date() };
        const policy = existing || (apply ? await EmployeePaymentHistoryPolicy.findOneAndUpdate({ _id: policyId }, { $setOnInsert: candidate },
            { upsert: true, returnDocument: "after", runValidators: true }).lean() : candidate);
        results.push({ businessId: business.id, fromDate: policy!.fromDate, initialPayPeriod: policy!.initialPayPeriod, existing: Boolean(existing) });
    });
    return { dryRun: !apply, businesses: results };
}

function savedNumber(value: unknown) { return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null; }

function paymentDto(record: PayrollRecordDocument & { _id: unknown }, settings: Awaited<ReturnType<typeof getSystemSettings>>): EmployeePayment | null {
    const range = savedPayrollPeriod(record.payPeriod);
    const required = [record.grossPay, record.deductions, record.netPay];
    if (!range || required.some(value => savedNumber(value) === null) ||
        Math.round(record.grossPay * 100) - Math.round(record.deductions * 100) !== Math.round(record.netPay * 100)) return null;
    const scheduled = scheduledPayDateForPeriod(range.label, settings);
    const minuteKeys = ["lateMinutes", "excessLunchMinutes", "excessBreakMinutes", "nonBillableOffPhoneMinutes", "earlyTimeOutMinutes", "absenceMinutes"] as const;
    if (minuteKeys.some(key => record[key] !== undefined && savedNumber(record[key]) === null)) return null;
    return {
        id: String(record._id), payPeriod: record.payPeriod, cutoffStart: range.start, cutoffEnd: range.end,
        payType: record.payType, department: record.department, grossPay: record.grossPay, deductions: record.deductions, netPay: record.netPay,
        basicPay: savedNumber(record.basicPay), monthlySalary: savedNumber(record.calculationSnapshot?.monthlySalary),
        hourlyRate: savedNumber(record.hourlyRate), minuteRate: savedNumber(record.minuteRate), paidHoursPerDay: savedNumber(record.paidHoursPerDay),
        workingDays: savedNumber(record.workingDays), attendanceDays: savedNumber(record.attendanceDays), absentDays: savedNumber(record.absentDays),
        workedHours: savedNumber(record.workedHours), scheduledHours: savedNumber(record.scheduledHours), overtimeHours: savedNumber(record.overtimeHours),
        overtimeApproved: record.overtimeApproved === true, deductibleMinutes: savedNumber(record.deductibleMinutes), incompleteShiftDays: savedNumber(record.incompleteShiftDays),
        workedMinutesOverride: record.workedMinutesOverride ?? null,
        lateMinutes: record.lateMinutes, lateHours: savedNumber(record.lateHours) ?? undefined,
        excessLunchMinutes: record.excessLunchMinutes, excessBreakMinutes: record.excessBreakMinutes,
        nonBillableOffPhoneMinutes: record.nonBillableOffPhoneMinutes,
        earlyTimeOutMinutes: record.earlyTimeOutMinutes, absenceMinutes: record.absenceMinutes,
        status: record.status, paidOn: record.status === "Paid" && record.paidOn && record.paidOn !== "-" ? record.paidOn : null,
        requiresReview: false,
        calculationVersion: record.calculationVersion,
        scheduledPayDate: scheduled ? payrollDateKey(scheduled) : null,
        updatedAt: record.updatedAt && Number.isFinite(+new Date(record.updatedAt)) ? new Date(record.updatedAt).toISOString() : null,
    };
}

export async function employeePayments(employeeCode: string, page = 1, view: "current" | "history" = "current"): Promise<EmployeePayments> {
    const settings = await getSystemSettings();
    const policy = await EmployeePaymentHistoryPolicy.findById(policyId).lean();
    const business = getCurrentBusiness();
    const result: EmployeePayments = { business: { id: business.id, name: business.name }, currencyCode: settings.currencyCode,
        currentPayPeriod: currentPeriod(settings.payrollBillingCycle, settings), historyFrom: policy?.fromDate || null,
        initialPayPeriod: policy?.initialPayPeriod || null, setupPending: !policy, items: [], total: 0, page, view, pageSize: 20, reviewCount: 0, asOf: new Date().toISOString() };
    if (!policy) return result;
    const records = await PayrollRecord.find({ employeeId: employeeCode, isArchived: false }).select(
        "employeeId payPeriod payType department grossPay basicPay deductions netPay calculationVersion calculationSnapshot.monthlySalary hourlyRate minuteRate paidHoursPerDay " +
        "workingDays attendanceDays absentDays workedHours workedMinutesOverride scheduledHours overtimeHours overtimeApproved deductibleMinutes incompleteShiftDays " +
        "lateMinutes lateHours excessLunchMinutes excessBreakMinutes nonBillableOffPhoneMinutes earlyTimeOutMinutes absenceMinutes status paidOn updatedAt"
    ).maxTimeMS(5000).lean();
    const { groups } = payrollReadGroups(records);
    const current = savedPayrollPeriod(result.currentPayPeriod);
    const items: EmployeePayment[] = [];
    for (const group of groups) {
        if (group.period.start < policy.fromDate || !isConfiguredSavedPayrollPeriod(group.period, settings)) continue;
        if (view === "current" && (!current || group.period.start !== current.start || group.period.end !== current.end)) continue;
        const item = group.record ? paymentDto(group.record, settings) : null;
        if (group.requiresReview || !item) result.reviewCount++;
        if (item) items.push({ ...item, requiresReview: group.requiresReview });
    }
    items.sort((a, b) => b.cutoffStart.localeCompare(a.cutoffStart) || b.cutoffEnd.localeCompare(a.cutoffEnd));
    result.total = items.length;
    result.items = items.slice((page - 1) * result.pageSize, page * result.pageSize);
    return result;
}
