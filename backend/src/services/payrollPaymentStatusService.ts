import mongoose, { type ClientSession } from "mongoose";
import { createHash } from "node:crypto";
import type { Request } from "express";
import { PayrollRecord } from "../models/Payroll";
import { Employee } from "../models/Employee";
import { AttendanceLedger } from "../models/AttendanceLedger";
import { getBusinessAccessForEmployeeCode } from "../models/BusinessUserAccess";
import { getBusinessById, getCurrentBusinessId, runWithBusiness } from "../config/tenancy";
import { verifyAdminDashboardSession } from "../config/adminDashboardSession";
import { attendanceIntegrityEnabled } from "../config/rolloutFlags";
import { attendancePayrollDtr } from "../controllers/payrollController";
import { savedPayrollPeriod } from "../../../shared/payrollPeriod";
import { payrollPaymentAliasBlocker, payrollPaymentStatus, payrollPaymentAmountsValid } from "../../../shared/payrollPaymentStatus";
import { payrollReadGroups } from "./payrollReadPolicy";
import { PayrollValidationError } from "./payrollAccuracy";
import { lockPayrollAttendance, payrollAttendanceFenceKeys } from "./payrollAttendanceFence";
import { withReadSnapshot, serverReadTime } from "./readSnapshot";

const fail = (statusCode: number, message: string) => Object.assign(new Error(message), { statusCode });
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const amounts = (record: { grossPay: number; deductions: number; netPay: number }) => ({ grossPay: record.grossPay, deductions: record.deductions, netPay: record.netPay });
type PaymentRow = { businessId: string; businessName: string; grossPay: number; deductions: number; netPay: number; status: string; paidOn: string; savedCopies: number; currentAttendanceReviewDays: number | null };
type PaymentTarget = { businessId: string; attendanceHash: string; records: Array<{ id: string; beforeHash: string }> };

async function buildPaymentPlan(id: string, paid: unknown, session?: ClientSession) {
    const sourceBusiness = getCurrentBusinessId();
    if (typeof paid !== "boolean") throw fail(400, "Choose Paid or Unpaid explicitly.");
    if (!mongoose.isValidObjectId(id)) throw fail(404, "Payroll record not found.");
    const source = await PayrollRecord.findById(id, null, session ? { session } : undefined).lean();
    if (!source || source.isArchived) throw fail(404, "Payroll record not found.");
    if (source.payrollOwnerBusinessId && source.payrollOwnerBusinessId !== getCurrentBusinessId()) throw new PayrollValidationError("Change payment status in the cutoff's owning business.");
    const period = savedPayrollPeriod(source.payPeriod);
    if (!period) throw new PayrollValidationError("Choose a dated saved cutoff.");
    const ledger = await AttendanceLedger.findOne({ employeeCode: source.employeeId, businessIds: getCurrentBusinessId() }, null, session ? { session } : undefined).select("businessIds").lean();
    const access = await getBusinessAccessForEmployeeCode(source.employeeId, session);
    const frozen = source.calculationSnapshot?.businessIds;
    if (frozen !== undefined && (!Array.isArray(frozen) || !frozen.length || frozen.some(id => typeof id !== "string" || !getBusinessById(id)))) throw new PayrollValidationError("Invalid saved business membership.");
    const businessIds = [...new Set<string>(frozen === undefined ? [...access, ...(ledger?.businessIds || []), getCurrentBusinessId()] : frozen as string[])].sort();
    if (!businessIds.includes(getCurrentBusinessId()) || businessIds.some(id => !getBusinessById(id))) throw new PayrollValidationError("Cutoff business membership needs review.");
    const blockers: string[] = [], warnings: string[] = [];
    const rows: PaymentRow[] = [], targets: PaymentTarget[] = [];
    const paidOn = paid ? serverReadTime().toLocaleDateString("en-US", { timeZone: "Asia/Manila", month: "short", day: "numeric", year: "numeric" }) : "-";
    for (const businessId of businessIds) await runWithBusiness(businessId, async () => {
        const all = await PayrollRecord.find({ employeeId: source.employeeId, isArchived: false }, null, session ? { session } : undefined).sort({ _id: 1 }).lean();
        const groups = payrollReadGroups(all);
        const group = groups.groups.find(item => item.period.start === period.start && item.period.end === period.end);
        const selected = group?.record;
        if (!group || !selected) { blockers.push("A saved business copy has no unambiguous valid cutoff."); return; }
        if (businessId === sourceBusiness && String(selected._id) !== id) blockers.push("This is not the cutoff currently selected by Admin Payroll. Refresh before continuing.");
        const issue = payrollPaymentAliasBlocker(group.records);
        if (issue) blockers.push(issue);
        if (hash(amounts(selected)) !== hash(amounts(source))) blockers.push("Saved payroll amounts differ between businesses. Confirm the correct amounts before payment.");
        if ((selected.status === "Paid") !== (source.status === "Paid") || (selected.status === "Paid" && selected.paidOn !== source.paidOn)) blockers.push("Payment status or paid date differs between businesses. Resolve the payment history first.");
        if (selected.payrollOwnerBusinessId !== source.payrollOwnerBusinessId || hash(selected.calculationSnapshot?.businessIds ?? null) !== hash(frozen ?? null)) blockers.push("Saved cutoff ownership or business membership differs.");
        if (groups.unknown.some(record => ["Paid", "Completed"].includes(record.status))) blockers.push("Undated payment history needs review before settling this cutoff.");
        else if (groups.unknown.length) warnings.push("Undated legacy drafts remain untouched. This confirmation settles only the displayed dated cutoff.");
        const overlapping = groups.groups.filter(item => item !== group && item.period.start <= period.end && item.period.end >= period.start);
        for (const overlap of overlapping) {
            const zeroDraft = overlap.records.every(record => payrollPaymentAmountsValid(record) && record.grossPay === 0 && record.deductions === 0 && record.netPay === 0 && !["Paid", "Completed"].includes(record.status));
            if (zeroDraft) warnings.push("An overlapping zero-value draft remains untouched; it is not a second payment.");
            else blockers.push("Other payable saved payroll overlaps this cutoff. Resolve the payment history first.");
        }
        if (group.records.some(record => record.status === "Review" || record.incompleteShiftDays > 0)) warnings.push("Saved attendance review history is retained; this action changes payment status only.");
        if (group.records.length > 1) warnings.push("Equivalent payment copies will share the payment status; their attendance history and amounts stay unchanged.");
        const employee = await Employee.findOne({ employeeCode: source.employeeId }, null, session ? { session } : undefined).select("_id").lean();
        if (!employee) { blockers.push("Employee is missing from a saved cutoff business."); return; }
        let currentReviewDays: number | null = null, attendanceHash = "unavailable";
        try {
            const attendance = await attendancePayrollDtr(employee._id, source.payPeriod, session);
            currentReviewDays = attendance.summary.incompleteShiftDays;
            attendanceHash = hash({ rows: attendance.rows, summary: attendance.summary });
            if (currentReviewDays) warnings.push("Attendance still needs attention. Saved payroll will not be recalculated or cleared by this payment confirmation.");
        } catch (error) {
            if (!(error instanceof PayrollValidationError)) throw error;
            warnings.push("Current attendance cannot be verified. Only the saved payroll amount can be confirmed.");
        }
        const currentLedger = await AttendanceLedger.findOne({ employeeCode: source.employeeId, businessIds: businessId }, null, session ? { session } : undefined).select("revision events corrections closures migrationRequired").lean();
        if (currentLedger?.migrationRequired) warnings.push("Attendance synchronization still needs attention; no attendance records will be changed.");
        rows.push({ businessId, businessName: getBusinessById(businessId)!.name, ...amounts(selected), status: payrollPaymentStatus(selected.status),
            paidOn: selected.paidOn, savedCopies: group.records.length, currentAttendanceReviewDays: currentReviewDays });
        targets.push({ businessId, attendanceHash: hash([attendanceHash, currentLedger]), records: group.records.map(record => ({ id: String(record._id), beforeHash: hash(record) })) });
    });
    if (paid && source.status === "Paid") blockers.push("This cutoff is already marked Paid.");
    if (!paid && payrollPaymentStatus(source.status) === "Pending") blockers.push("This cutoff is already unpaid.");
    const uniqueBlockers = [...new Set(blockers)], uniqueWarnings = [...new Set(warnings)];
    return { id, employeeCode: source.employeeId, payPeriod: source.payPeriod, paid, paidOn, businessIds, targets, rows,
        warnings: uniqueWarnings, blockers: uniqueBlockers, canApply: rows.length === businessIds.length && !uniqueBlockers.length,
        token: hash({ id, business: sourceBusiness, paid, paidOn, targets, rows, warnings: uniqueWarnings, blockers: uniqueBlockers }) };
}

export async function previewPayrollPaymentStatus(id: string, paid: unknown) {
    const { targets, employeeCode, ...preview } = await withReadSnapshot(serverReadTime(), () => buildPaymentPlan(id, paid));
    void [targets, employeeCode]; return preview;
}

export async function confirmPayrollPaymentStatus(request: Request) {
    const actor = verifyAdminDashboardSession(request.header("x-crm-admin-session"));
    if (!actor) throw fail(403, "A verified administrator session is required.");
    const reason = typeof request.body.reason === "string" ? request.body.reason.trim() : "";
    if (request.body.confirm !== true || !reason || reason.length > 1000) throw fail(400, "Confirmation and a reason of 1 to 1000 characters are required.");
    if (!attendanceIntegrityEnabled()) throw fail(503, "Revision-checked attendance is required. No payment status was changed.");
    const plan = await withReadSnapshot(serverReadTime(), () => buildPaymentPlan(String(request.params.id), request.body.paid));
    if (request.body.token !== plan.token) throw fail(409, "Payroll or attendance changed. Refresh the payment preview.");
    if (!plan.canApply) throw new PayrollValidationError(plan.blockers.join(" "));
    if (plan.warnings.length && request.body.acknowledgeAttendance !== true) throw fail(400, "Acknowledge the attendance history before confirming the saved payment.");
    const scopes = plan.businessIds.map(businessId => ({ businessId, employeeCode: plan.employeeCode }));
    const session = await mongoose.startSession();
    try {
        await session.withTransaction(async () => {
            await lockPayrollAttendance(scopes, session);
            const verified = await withReadSnapshot(serverReadTime(), () => buildPaymentPlan(plan.id, plan.paid, session));
            if (verified.token !== request.body.token || hash(payrollAttendanceFenceKeys(scopes)) !== hash(payrollAttendanceFenceKeys(verified.businessIds.map(businessId => ({ businessId, employeeCode: verified.employeeCode }))))) throw fail(409, "Payroll or attendance changed during confirmation. Refresh the payment preview.");
            if (!verified.canApply) throw new PayrollValidationError("Payment copies need review. No changes were applied.");
            for (const target of verified.targets) await runWithBusiness(target.businessId, async () => {
                for (const record of target.records) {
                    const current = await PayrollRecord.findById(record.id).session(session).lean();
                    if (!current || hash(current) !== record.beforeHash) throw fail(409, "Payroll changed. Refresh the payment preview.");
                    const after = { status: verified.paid ? "Paid" : "Pending", paidOn: verified.paidOn };
                    await PayrollRecord.updateOne({ _id: current._id }, { $set: after, $push: { calculationAudit: { at: new Date().toISOString(), actor: actor.employeeCode, reason,
                        before: { status: current.status, paidOn: current.paidOn }, after: { ...after, attendanceAcknowledged: request.body.acknowledgeAttendance === true, savedAmountsUnchanged: true } } } }, { session, runValidators: true });
                }
            });
        }, { readConcern: { level: "snapshot" }, writeConcern: { w: "majority" } });
    } catch (error) {
        if ((error as { code?: number }).code === 11000) throw fail(409, "Another save completed first. Refresh the payment preview.");
        throw error;
    } finally { await session.endSession(); }
    return { applied: true, businesses: plan.businessIds.length, records: plan.targets.reduce((sum, target) => sum + target.records.length, 0) };
}
