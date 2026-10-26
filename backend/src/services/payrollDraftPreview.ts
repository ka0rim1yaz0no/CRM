import { getCurrentBusinessId } from "../config/tenancy";
import { Employee } from "../models/Employee";
import { PayrollRecord } from "../models/Payroll";
import { EmployeePaymentHistoryPolicy } from "../models/EmployeePaymentHistoryPolicy";
import { currentPeriod, payrollCalculationContext } from "../controllers/payrollController";
import { calculatePayrollCandidate } from "./payrollRecomputeService";
import { PayrollValidationError } from "./payrollAccuracy";
import { serverReadTime, withReadSnapshot } from "./readSnapshot";
import { savedPayrollPeriod } from "../../../shared/payrollPeriod";
import { payrollDeductionRows } from "../../../shared/payrollPresentation";
import type { PayrollDraftPreviews } from "../../../shared/payrollDraftPreview";

// Derived on read for the configured current cutoff; no draft records or approval tokens are created.
export async function currentPayrollDraftPreviews(requestedPeriod = ""): Promise<PayrollDraftPreviews> {
    return withReadSnapshot(serverReadTime(), async () => {
        const { settings } = await payrollCalculationContext();
        if (settings.payrollBillingCycle !== "Semi-monthly") throw new PayrollValidationError("Automatic previews require a configured semi-monthly cutoff.");
        const payPeriod = currentPeriod(settings.payrollBillingCycle, settings), range = savedPayrollPeriod(payPeriod);
        const requested = requestedPeriod ? savedPayrollPeriod(requestedPeriod) : range;
        if (!range || !requested || requested.start !== range.start || requested.end !== range.end) {
            throw new PayrollValidationError("The current cutoff changed. Refresh Payroll before preparing previews.");
        }
        const history = await EmployeePaymentHistoryPolicy.findById("employee-payment-history").lean();
        if (history && range.start < history.fromDate) throw new PayrollValidationError("This cutoff is before the enabled payroll history boundary.");
        const employees = await Employee.find({ status: { $ne: "Archived" } }).select("employeeCode name email role team salary").sort({ employeeCode: 1 }).lean();
        const records = await PayrollRecord.find({ employeeId: { $in: employees.map(employee => employee.employeeCode) },
            $or: [{ isArchived: false }, { status: { $in: ["Paid", "Completed"] } }] }).maxTimeMS(5000).lean();
        const result: PayrollDraftPreviews = { previewOnly: true, businessId: getCurrentBusinessId(), payPeriod, asOf: serverReadTime().toISOString(), rows: [] };
        const seen = new Set<string>();
        for (const employee of employees) {
            if (seen.has(employee.employeeCode)) continue;
            seen.add(employee.employeeCode);
            const saved = records.filter(record => record.employeeId === employee.employeeCode);
            // Every saved alias, including an archived paid cutoff, excludes this employee from automatic preparation.
            if (saved.some(record => { const period = savedPayrollPeriod(record.payPeriod); return period?.start === range.start && period.end === range.end; })) continue;
            const warnings: string[] = [];
            if (employees.some(other => other.employeeCode === employee.employeeCode && String(other._id) !== String(employee._id))) {
                result.rows.push({ employeeCode: employee.employeeCode, employeeName: employee.name, department: employee.team || employee.role || "General",
                    calculation: null, warnings: ["Duplicate employee identity requires review."] });
                continue;
            }
            if (saved.some(record => { const period = savedPayrollPeriod(record.payPeriod);
                return !period || (period.start <= range.end && period.end >= range.start &&
                    (record.grossPay !== 0 || record.netPay !== 0 || record.deductions !== 0 || ["Paid", "Completed"].includes(record.status))); })) {
                warnings.push("An overlapping or undated saved payroll needs review before any generation.");
            }
            try {
                const candidate = await calculatePayrollCandidate(employee, payPeriod);
                if (candidate.record) continue; // A concurrently generated record is never treated as a new draft.
                const value = candidate.value, deductionDetails = payrollDeductionRows(value);
                const nonBillable = deductionDetails.find(row => row.label === "Non-billable Off the Phone");
                const scheduledDays = candidate.dtr.rows.filter(row => row.status === "Scheduled").length;
                if (scheduledDays) warnings.push("Cutoff in progress: future shift days are not final deductions.");
                if (value.incompleteShiftDays) warnings.push(`${value.incompleteShiftDays} incomplete or unverified shift(s); their deductions are not finalized.`);
                result.rows.push({ employeeCode: employee.employeeCode, employeeName: employee.name, department: value.department, warnings,
                    calculation: { basicPay: value.basicPay, monthlySalary: candidate.rates.monthlySalary, grossPay: value.grossPay,
                        deductions: value.deductions, netPay: value.netPay, hourlyRate: value.hourlyRate, minuteRate: value.minuteRate,
                        paidHoursPerDay: value.paidHoursPerDay, attendanceDays: value.attendanceDays, workedHours: value.workedHours,
                        nonBillableOffPhoneMinutes: value.nonBillableOffPhoneMinutes ?? 0, nonBillableOffPhoneDeduction: nonBillable?.amount ?? 0,
                        incompleteShiftDays: value.incompleteShiftDays, scheduledDays, deductionDetails } });
            } catch (error) {
                if (!(error instanceof PayrollValidationError)) throw error;
                result.rows.push({ employeeCode: employee.employeeCode, employeeName: employee.name, department: employee.team || employee.role || "General",
                    calculation: null, warnings: [...warnings, error.message] });
            }
        }
        return result;
    });
}
