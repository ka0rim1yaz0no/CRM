import mongoose, { type ClientSession } from "mongoose";
import { createHash } from "node:crypto";
import type { Request } from "express";
import { getBusinessById, getCurrentBusinessId, runWithBusiness } from "../config/tenancy";
import { verifyAdminDashboardSession } from "../config/adminDashboardSession";
import { attendanceIntegrityEnabled } from "../config/rolloutFlags";
import { PayrollRecord } from "../models/Payroll";
import { Employee } from "../models/Employee";
import { AttendanceLedger } from "../models/AttendanceLedger";
import { EmployeePaymentHistoryPolicy } from "../models/EmployeePaymentHistoryPolicy";
import { getBusinessAccessForEmployeeCode } from "../models/BusinessUserAccess";
import { payrollReadGroups } from "./payrollReadPolicy";
import { lockPayrollAttendance, payrollAttendanceFenceKeys } from "./payrollAttendanceFence";
import { serverReadTime, withReadSnapshot } from "./readSnapshot";
import { PayrollValidationError, roundMoney } from "./payrollAccuracy";
import { attendancePayrollDtr } from "../controllers/payrollController";
import { savedPayrollPeriod } from "../../../shared/payrollPeriod";
import { adjustedPayrollHours } from "../../../shared/payrollWorkedHours";

const fail = (statusCode: number, message: string) => Object.assign(new Error(message), { statusCode });
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
type RecordValue = NonNullable<Awaited<ReturnType<typeof loadRecord>>>;
const loadRecord = (id: string, session?: ClientSession) => PayrollRecord.findById(id, null, session ? { session } : undefined).lean();
const totals = (value: RecordValue) => ({ workedHours: value.workedHours, grossPay: value.grossPay, deductions: value.deductions, netPay: value.netPay,
    deductibleMinutes: value.deductibleMinutes, status: value.status, paidOn: value.paidOn });
function mirrorSignature(record: RecordValue) {
    return hash([record.employeeId, record.payPeriod, record.payType, totals(record), record.basicPay, record.minuteRate, record.hourlyRate,
        record.paidHoursPerDay, record.workingDays, record.scheduledHours, record.workedMinutesOverride, record.incompleteShiftDays,
        record.excessBreakMinutes, record.excessLunchMinutes, record.lateMinutes, record.earlyTimeOutMinutes, record.absenceMinutes,
        record.attendanceDays, record.absentDays, record.lateDays, record.absentHours, record.lateHours, record.overtimeHours, record.overtimeApproved,
        record.payrollOwnerBusinessId, record.calculationSnapshot?.businessIds]);
}

async function buildHoursPlan(id: string, workedMinutes: unknown, session?: ClientSession) {
    if (typeof workedMinutes !== "number" || !Number.isSafeInteger(workedMinutes) || workedMinutes < 0) throw fail(400, "Total hours must resolve to whole minutes of zero or greater.");
    if (!mongoose.isValidObjectId(id)) throw fail(404, "Payroll record not found");
    const source = await loadRecord(id, session);
    if (!source || source.isArchived) throw fail(404, "Payroll record not found");
    if (["Paid", "Completed"].includes(source.status)) throw new PayrollValidationError("Paid or completed payroll is locked. No hours were changed.");
    if (source.payrollOwnerBusinessId && source.payrollOwnerBusinessId !== getCurrentBusinessId()) throw new PayrollValidationError("Edit total hours in the cutoff's owning business.");
    const period = savedPayrollPeriod(source.payPeriod);
    if (!period) throw new PayrollValidationError("Choose a dated cutoff before editing total hours.");
    const access = await getBusinessAccessForEmployeeCode(source.employeeId, session);
    const ledger = await AttendanceLedger.findOne({ employeeCode: source.employeeId, businessIds: getCurrentBusinessId() }, null, session ? { session } : undefined).lean();
    const frozen = source.calculationSnapshot?.businessIds;
    if (frozen !== undefined && (!Array.isArray(frozen) || !frozen.length || frozen.some(id => typeof id !== "string"))) throw new PayrollValidationError("Invalid cutoff business snapshot. No hours were changed.");
    const businessIds = [...new Set<string>(frozen === undefined ? [...access, ...(ledger?.businessIds || []), getCurrentBusinessId()] : frozen as string[])].sort();
    if (!businessIds.includes(getCurrentBusinessId()) || businessIds.some(id => !getBusinessById(id))) throw new PayrollValidationError("Cutoff business membership needs review.");
    const targets = [];
    for (const businessId of businessIds) {
        targets.push(await runWithBusiness(businessId, async () => {
            const records = await PayrollRecord.find({ employeeId: source.employeeId, isArchived: false }, null, session ? { session } : undefined).lean();
            const groups = payrollReadGroups(records);
            const group = groups.groups.find(item => item.period.start === period.start && item.period.end === period.end);
            if (!group || group.records.length !== 1 || group.requiresReview || groups.unknown.length ||
                groups.groups.some(item => item !== group && item.period.start <= period.end && item.period.end >= period.start)) {
                throw new PayrollValidationError("Conflicting or overlapping saved cutoffs need review before editing total hours. No records were changed.");
            }
            const record = group.records[0];
            if (mirrorSignature(record) !== mirrorSignature(source)) throw new PayrollValidationError("Saved payroll differs across businesses. Review the mismatch before editing total hours.");
            const employee = await Employee.findOne({ employeeCode: source.employeeId }, null, session ? { session } : undefined).lean();
            if (!employee) throw new PayrollValidationError("Employee is missing from a saved cutoff business.");
            const history = await EmployeePaymentHistoryPolicy.findById("employee-payment-history", null, session ? { session } : undefined).lean();
            if (history && period.start < history.fromDate) throw new PayrollValidationError("This cutoff is before the enabled payment history boundary.");
            const attendance = await attendancePayrollDtr(employee._id, source.payPeriod, session);
            const currentLedger = await AttendanceLedger.findOne({ employeeCode: source.employeeId, businessIds: businessId }, null, session ? { session } : undefined).lean();
            if (currentLedger?.migrationRequired) throw new PayrollValidationError("Attendance synchronization needs review before editing payroll.");
            const rate = record.minuteRate;
            if (!Number.isFinite(rate) || rate <= 0) throw new PayrollValidationError("A saved minute rate is required. No rate was guessed.");
            let adjusted;
            try { adjusted = adjustedPayrollHours(record, workedMinutes); }
            catch (error) { throw new PayrollValidationError((error as Error).message); }
            const deductions = Math.min(record.grossPay, roundMoney(adjusted.deductibleMinutes * rate));
            const value = { ...adjusted, deductions, netPay: roundMoney(record.grossPay - deductions),
                calculationSnapshot: { ...record.calculationSnapshot, workedHoursAdjustment: {
                    workedMinutes, scheduledMinutes: Math.round(record.scheduledHours * 60), minuteRate: rate,
                    formula: "Scheduled minutes minus total worked minutes, plus saved excess break and lunch once; gross pay and payment status unchanged.",
                } } };
            return { businessId, id: String(record._id), beforeHash: hash(record), value,
                attendanceHash: hash({ summary: attendance.summary, rows: attendance.rows, ledger: currentLedger }) };
        }));
    }
    return { id, employeeCode: source.employeeId, payPeriod: source.payPeriod, workedMinutes, businessIds, targets,
        before: totals(source), after: { ...totals(source), ...targets[0].value }, token: hash({ id, workedMinutes, targets, businessIds }) };
}

export async function previewPayrollWorkedHours(id: string, workedMinutes: unknown) {
    const plan = await withReadSnapshot(serverReadTime(), () => buildHoursPlan(id, workedMinutes));
    return { id: plan.id, payPeriod: plan.payPeriod, workedMinutes: plan.workedMinutes, businessIds: plan.businessIds, before: plan.before,
        after: { workedHours: plan.after.workedHours, grossPay: plan.after.grossPay, deductions: plan.after.deductions, netPay: plan.after.netPay,
            deductibleMinutes: plan.after.deductibleMinutes, status: plan.after.status, paidOn: plan.after.paidOn }, token: plan.token };
}

export async function applyPayrollWorkedHours(request: Request) {
    const actor = verifyAdminDashboardSession(request.header("x-crm-admin-session"));
    if (!actor) throw fail(403, "A verified administrator session is required");
    const reason = typeof request.body.reason === "string" ? request.body.reason.trim() : "";
    if (request.body.confirm !== true || !reason || reason.length > 1000) throw fail(400, "Confirmation and a reason of 1 to 1000 characters are required.");
    if (!attendanceIntegrityEnabled()) throw fail(503, "Revision-checked attendance is required. No hours were changed.");
    const id = String(request.params.id);
    let plan;
    try { plan = await withReadSnapshot(serverReadTime(), () => buildHoursPlan(id, request.body.workedMinutes)); }
    catch (error) {
        if (error instanceof PayrollValidationError) throw fail(409, "Payroll or attendance changed or needs review. Preview total hours again.");
        throw error;
    }
    if (request.body.token !== plan.token) throw fail(409, "Payroll or attendance changed. Preview total hours again.");
    const scopes = plan.businessIds.map(businessId => ({ businessId, employeeCode: plan.employeeCode }));
    const session = await mongoose.startSession();
    try {
        await session.withTransaction(async () => {
            await lockPayrollAttendance(scopes, session);
            const verified = await withReadSnapshot(serverReadTime(), () => buildHoursPlan(id, request.body.workedMinutes, session));
            if (verified.token !== request.body.token || hash(payrollAttendanceFenceKeys(scopes)) !== hash(payrollAttendanceFenceKeys(verified.businessIds.map(businessId => ({ businessId, employeeCode: verified.employeeCode }))))) {
                throw fail(409, "Payroll or attendance changed during confirmation. Preview total hours again.");
            }
            for (const target of verified.targets) await runWithBusiness(target.businessId, async () => {
                const current = await loadRecord(target.id, session);
                if (!current || hash(current) !== target.beforeHash) throw fail(409, "Payroll changed. Preview total hours again.");
                await PayrollRecord.updateOne({ _id: current._id }, { $set: target.value, $push: { calculationAudit: {
                    at: new Date().toISOString(), actor: actor.employeeCode, reason,
                    before: { ...totals(current), workedMinutesOverride: current.workedMinutesOverride }, after: target.value,
                } } }, { session, runValidators: true });
            });
        }, { readConcern: { level: "snapshot" }, writeConcern: { w: "majority" } });
    } catch (error) {
        if (error instanceof PayrollValidationError || (error as { code?: number }).code === 11000) throw fail(409, "Another save completed first or payroll needs review. Preview total hours again.");
        throw error;
    } finally { await session.endSession(); }
    return { applied: true, mirrors: plan.targets.length, payPeriod: plan.payPeriod };
}
