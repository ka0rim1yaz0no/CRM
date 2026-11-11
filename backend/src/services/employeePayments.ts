import { currentPeriod, periodRange, scheduledPayDateForPeriod } from "../controllers/payrollController";
import { getSystemSettings } from "../controllers/systemSettingsController";
import { getBusinessById, getCurrentBusiness, runForEachBusiness, runWithBusiness } from "../config/tenancy";
import { EmployeePaymentHistoryPolicy } from "../models/EmployeePaymentHistoryPolicy";
import { PayrollRecord, type PayrollRecordDocument } from "../models/Payroll";
import type { EmployeePayment, EmployeePayments } from "../../../shared/employeePayments";
import { savedPayrollPeriod, isConfiguredSavedPayrollPeriod } from "../../../shared/payrollPeriod";
import { payrollReadGroups } from "./payrollReadPolicy";
import { payrollPaymentReadRecords, type PayrollAmountReadBasis } from "./payrollPaymentRead";
import type { PayrollEarningsView } from "../../../shared/payrollEarnings";
import { AttendanceLedger } from "../models/AttendanceLedger";
import { getAttendanceBusinessIdentity } from "../models/BusinessUserAccess";

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

function paymentDto(record: PayrollRecordDocument & PayrollEarningsView & { _id: unknown }, settings: Awaited<ReturnType<typeof getSystemSettings>>): EmployeePayment | null {
    const range = savedPayrollPeriod(record.payPeriod);
    const required = [record.grossPay, record.deductions, record.netPay];
    if (!range || required.some(value => savedNumber(value) === null) ||
        Math.round(record.grossPay * 100) - Math.round(record.deductions * 100) !== Math.round(record.netPay * 100)) return null;
    const scheduled = scheduledPayDateForPeriod(range.label, settings);
    const minuteKeys = ["lateMinutes", "excessLunchMinutes", "excessBreakMinutes", "nonBillableOffPhoneMinutes", "earlyTimeOutMinutes", "absenceMinutes"] as const;
    if (minuteKeys.some(key => record[key] !== undefined && savedNumber(record[key]) === null)) return null;
    return {
        currentCutoffDraft: record.currentCutoffDraft,
        earnedToDate: record.earnedToDate, cutoffEstimate: record.cutoffEstimate, earningsAsOf: record.earningsAsOf, earningsUnavailable: record.earningsUnavailable,
        earningsUnavailableReason: record.earningsUnavailableReason,
        settlementRequired: record.settlementRequired, savedAmounts: record.savedAmounts,
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

async function businessEmployeePayments(employeeCode: string, page: number, view: "current" | "history", basis: PayrollAmountReadBasis): Promise<EmployeePayments> {
    const settings = await getSystemSettings();
    const policy = await EmployeePaymentHistoryPolicy.findById(policyId).lean();
    const business = getCurrentBusiness();
    const result: EmployeePayments = { business: { id: business.id, name: business.name }, currencyCode: settings.currencyCode,
        currentPayPeriod: currentPeriod(settings.payrollBillingCycle, settings), historyFrom: policy?.fromDate || null,
        initialPayPeriod: policy?.initialPayPeriod || null, setupPending: !policy, items: [], total: 0, page, view, pageSize: 20, reviewCount: 0, asOf: new Date().toISOString() };
    if (!policy) return result;
    const records = await PayrollRecord.find({ employeeId: employeeCode, isArchived: false }).select(
        "employeeId payPeriod payType department grossPay basicPay deductions netPay calculationVersion payrollOwnerBusinessId " +
        "calculationSnapshot.monthlySalary calculationSnapshot.inheritedPayrollInputs calculationSnapshot.payrollInputsBusinessId hourlyRate minuteRate paidHoursPerDay " +
        "workingDays attendanceDays absentDays workedHours workedMinutesOverride scheduledHours overtimeHours overtimeApproved deductibleMinutes incompleteShiftDays " +
        "lateMinutes lateHours excessLunchMinutes excessBreakMinutes nonBillableOffPhoneMinutes earlyTimeOutMinutes absenceMinutes status paidOn updatedAt"
    ).maxTimeMS(5000).lean();
    const { groups } = payrollReadGroups(records);
    const current = savedPayrollPeriod(result.currentPayPeriod);
    const items: EmployeePayment[] = [];
    for (const group of groups) {
        if (group.period.start < policy.fromDate || !isConfiguredSavedPayrollPeriod(group.period, settings)) continue;
        if (view === "current" && (!current || group.period.start !== current.start || group.period.end !== current.end)) continue;
        const source = group.record ? { ...group.record, requiresReview: group.requiresReview } : null;
        const projected = source ? (await payrollPaymentReadRecords([source], result.currentPayPeriod, basis))[0] : null;
        const item = projected ? paymentDto(projected, settings) : null;
        if (group.requiresReview || !item) result.reviewCount++;
        if (item) items.push({ ...item, requiresReview: group.requiresReview });
    }
    items.sort((a, b) => b.cutoffStart.localeCompare(a.cutoffStart) || b.cutoffEnd.localeCompare(a.cutoffEnd));
    result.total = items.length;
    result.items = items.slice((page - 1) * result.pageSize, page * result.pageSize);
    return result;
}

export async function employeePayments(employeeCode: string, page = 1, view: "current" | "history" = "current", basis: PayrollAmountReadBasis = "payment"): Promise<EmployeePayments> {
    const business = getCurrentBusiness(), mapping = await getAttendanceBusinessIdentity(employeeCode);
    if (!mapping?.businessIds.includes(business.id)) return businessEmployeePayments(employeeCode, page, view, basis);
    const ledger = await AttendanceLedger.findById(`access:${mapping.id}`)
        .select("employeeCode canonicalBusinessId businessIds migrationRequired").lean();
    const source = ledger && ledger.employeeCode === employeeCode && !ledger.migrationRequired &&
        ledger.businessIds.includes(ledger.canonicalBusinessId) &&
        mapping.businessIds.includes(ledger.canonicalBusinessId) ? getBusinessById(ledger.canonicalBusinessId) : null;
    if (!source || source.id === business.id) return businessEmployeePayments(employeeCode, page, view, basis);
    const payments = await runWithBusiness(source.id, () => businessEmployeePayments(employeeCode, page, view, basis));
    // Keep the selected-business binding while reading the employee's one shared payroll history.
    return { ...payments, business: { id: business.id, name: business.name } };
}
