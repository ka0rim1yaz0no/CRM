import { earnedPayrollEnabled } from "../config/payrollEarnings";
import { AttendanceLedger } from "../models/AttendanceLedger";
import { Employee } from "../models/Employee";
import { PayrollRecord } from "../models/Payroll";
import { getCurrentBusinessId, runWithBusiness } from "../config/tenancy";
import { savedPayrollPeriod } from "../../../shared/payrollPeriod";
import type { PayrollEarningsView } from "../../../shared/payrollEarnings";
import { calculatePayrollCandidate } from "./payrollRecomputeService";
import { payrollReadGroups } from "./payrollReadPolicy";
import { PayrollValidationError } from "./payrollAccuracy";
import { serverReadTime, withReadSnapshot } from "./readSnapshot";
import type { ClientSession } from "mongoose";

type EarningsSource = { employeeId: string; payPeriod: string; status: string; grossPay: number; deductions: number; netPay: number;
    requiresReview?: boolean; payrollOwnerBusinessId?: string };

// A current earnings view is never an implicit recompute or permission to settle a saved amount.
export async function currentEarnedPayrollRecords<T extends EarningsSource>(records: T[], currentPayPeriod: string, session?: ClientSession): Promise<Array<T & PayrollEarningsView>> {
    if (!earnedPayrollEnabled(currentPayPeriod)) return records;
    const current = savedPayrollPeriod(currentPayPeriod);
    if (!current) return records;
    return withReadSnapshot(serverReadTime(), async () => {
        const result: Array<T & PayrollEarningsView> = [];
        for (const record of records) {
            const period = savedPayrollPeriod(record.payPeriod);
            if (["Paid", "Completed"].includes(record.status) || !period || !earnedPayrollEnabled(record.payPeriod)) { result.push(record); continue; }
            try {
                if (record.requiresReview) throw new PayrollValidationError("Saved payroll conflicts need review.");
                const ledger = await AttendanceLedger.findOne({ employeeCode: record.employeeId, businessIds: getCurrentBusinessId() }, null, session ? { session } : undefined).select("canonicalBusinessId migrationRequired businessIds").lean();
                if (!ledger || ledger.migrationRequired) throw new PayrollValidationError("Canonical attendance is unavailable.");
                const owner = record.payrollOwnerBusinessId || ledger.canonicalBusinessId;
                if (!ledger.businessIds.includes(owner)) throw new PayrollValidationError("Payroll ownership is outside attendance membership.");
                const candidate = await runWithBusiness(owner, async () => {
                    const employee = await Employee.findOne({ employeeCode: record.employeeId }, null, session ? { session } : undefined).lean();
                    if (!employee) throw new PayrollValidationError("Payroll owner membership needs review.");
                    const saved = await PayrollRecord.find({ employeeId: record.employeeId, isArchived: false }, null, session ? { session } : undefined).lean();
                    const group = payrollReadGroups(saved).groups.find(item => item.period.start === period.start && item.period.end === period.end);
                    if (!group?.record || group.requiresReview) throw new PayrollValidationError("The owning payroll needs review.");
                    if (["Paid", "Completed"].includes(group.record.status)) throw new PayrollValidationError("The paid owning copy must be reconciled before current earnings can be shown.");
                    const monthlySalary = group.record.calculationSnapshot?.monthlySalary;
                    return calculatePayrollCandidate({ ...employee, salary: typeof monthlySalary === "number" && Number.isFinite(monthlySalary) ? monthlySalary : employee.salary }, group.record.payPeriod, undefined, session);
                });
                const value = candidate.value;
                const savedAmounts = { grossPay: record.grossPay, deductions: record.deductions, netPay: record.netPay };
                result.push({ ...record, ...value, payPeriod: record.payPeriod, status: record.status,
                    ...("paidOn" in record ? { paidOn: record.paidOn } : {}),
                    earnedToDate: true, earningsAsOf: serverReadTime().toISOString(), savedAmounts,
                    settlementRequired: value.grossPay !== record.grossPay || value.deductions !== record.deductions || value.netPay !== record.netPay ||
                        !("calculationVersion" in record) || record.calculationVersion !== value.calculationVersion });
            } catch (error) {
                if (!(error instanceof PayrollValidationError)) throw error;
                result.push({ ...record, earningsUnavailable: true });
            }
        }
        return result;
    });
}
