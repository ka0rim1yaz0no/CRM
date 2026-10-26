import mongoose, { Types, type ClientSession } from "mongoose";
import { createHash } from "node:crypto";
import type { Request } from "express";
import { getBusinessById, getCurrentBusinessId, runWithBusiness } from "../config/tenancy";
import { verifyAdminDashboardSession } from "../config/adminDashboardSession";
import { attendanceIntegrityEnabled, payrollAccuracyEnabled } from "../config/rolloutFlags";
import { Employee } from "../models/Employee";
import { PayrollRecord } from "../models/Payroll";
import { AttendanceLedger } from "../models/AttendanceLedger";
import { EmployeePaymentHistoryPolicy } from "../models/EmployeePaymentHistoryPolicy";
import { PayrollGenerationPolicy } from "../models/PayrollGenerationPolicy";
import { getBusinessAccessForEmployeeCode } from "../models/BusinessUserAccess";
import { currentPeriod, payrollCalculationContext } from "../controllers/payrollController";
import { calculatePayrollCandidate, calculationFingerprint } from "./payrollRecomputeService";
import { PayrollValidationError } from "./payrollAccuracy";
import { serverReadTime, withReadSnapshot } from "./readSnapshot";
import { lockPayrollAttendance } from "./payrollAttendanceFence";
import { savedPayrollPeriod } from "../../../shared/payrollPeriod";
import { payrollDeductionRows } from "../../../shared/payrollPresentation";
import type { PayrollGenerationPlan } from "../../../shared/payrollGeneration";

const policyId = "missing-current-payroll";
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const fail = (statusCode: number, message: string) => Object.assign(new Error(message), { statusCode });
type Candidate = Awaited<ReturnType<typeof calculatePayrollCandidate>>;
type GenerationValue = Omit<Candidate["value"], "calculationSnapshot"> & { payrollOwnerBusinessId: string;
    calculationSnapshot: Candidate["value"]["calculationSnapshot"] & { businessIds: string[]; generatedInProgress: boolean } };
type Target = { businessId: string; id: string; value: GenerationValue };

async function buildMissingPlan(requestedPeriod = "", session?: ClientSession) {
    if (!payrollAccuracyEnabled() || !attendanceIntegrityEnabled()) throw fail(503, "Generation requires revision-checked payroll and attendance.");
    const { settings } = await payrollCalculationContext(session);
    if (settings.payrollBillingCycle !== "Semi-monthly") throw new PayrollValidationError("Automatic generation requires semi-monthly payroll.");
    const businessId = getCurrentBusinessId(), payPeriod = currentPeriod(settings.payrollBillingCycle, settings), period = savedPayrollPeriod(payPeriod)!;
    if (requestedPeriod && savedPayrollPeriod(requestedPeriod)?.label !== period.label) throw fail(409, "The current cutoff changed. Preview again.");
    const history = await EmployeePaymentHistoryPolicy.findById("employee-payment-history", null, session ? { session } : undefined).lean();
    if (!history || period.start < history.fromDate) throw new PayrollValidationError("The cutoff is outside enabled employee payment history.");
    const policy = await PayrollGenerationPolicy.findById(policyId, null, session ? { session } : undefined).lean();
    const employees = await Employee.find({ status: { $ne: "Archived" } }, null, session ? { session } : undefined)
        .select("employeeCode name email role team salary").sort({ employeeCode: 1, _id: 1 }).lean();
    const rows: PayrollGenerationPlan["rows"] = [], held: PayrollGenerationPlan["held"] = [], targets: Target[] = [];
    const seen = new Set<string>();
    for (const employee of employees) {
        if (seen.has(employee.employeeCode)) continue;
        seen.add(employee.employeeCode);
        const saved = await PayrollRecord.find({ employeeId: employee.employeeCode }, null, session ? { session } : undefined).lean();
        if (saved.some(record => { const range = savedPayrollPeriod(record.payPeriod); return range?.start === period.start && range.end === period.end; })) continue;
        try {
            if (employees.filter(person => person.employeeCode === employee.employeeCode).length !== 1) throw new PayrollValidationError("Duplicate employee identity requires review.");
            const access = await getBusinessAccessForEmployeeCode(employee.employeeCode, session);
            const ledger = await AttendanceLedger.findOne({ employeeCode: employee.employeeCode, businessIds: businessId }, null, session ? { session } : undefined)
                .select("canonicalBusinessId businessIds").lean();
            const businessIds = [...new Set([...(access.length ? access : ledger?.businessIds || []), businessId])].sort();
            const ownerBusinessId = ledger?.canonicalBusinessId || businessIds[0];
            if (!businessIds.includes(ownerBusinessId)) throw new PayrollValidationError("Saved payroll owner is outside current employee membership.");
            const candidate = await calculatePayrollCandidate(employee, payPeriod, undefined, session), pending: Target[] = [];
            for (const mirrorId of businessIds) {
                if (!getBusinessById(mirrorId)) throw new PayrollValidationError("A connected business is unavailable.");
                await runWithBusiness(mirrorId, async () => {
                    const people = await Employee.find({ employeeCode: employee.employeeCode, status: { $ne: "Archived" } }, null, session ? { session } : undefined)
                        .select("employeeCode name email role team salary").lean();
                    if (people.length !== 1) throw new PayrollValidationError("Employee membership differs between connected businesses.");
                    const copies = await PayrollRecord.find({ employeeId: employee.employeeCode }, null, session ? { session } : undefined).lean();
                    for (const copy of copies) {
                        const range = savedPayrollPeriod(copy.payPeriod);
                        if (range?.start === period.start && range.end === period.end) throw new PayrollValidationError("A connected business already has this cutoff; no saved record was changed.");
                        if (copy.isArchived && !["Paid", "Completed"].includes(copy.status)) continue;
                        if ((!range || range.start <= period.end && range.end >= period.start) &&
                            (copy.grossPay !== 0 || copy.deductions !== 0 || copy.netPay !== 0 || ["Paid", "Completed"].includes(copy.status))) {
                            throw new PayrollValidationError("An overlapping or undated saved payroll needs review before generation.");
                        }
                    }
                    const counterpart = mirrorId === businessId ? candidate : await calculatePayrollCandidate(people[0], payPeriod, undefined, session);
                    if (counterpart.record || calculationFingerprint(counterpart) !== calculationFingerprint(candidate)) {
                        throw new PayrollValidationError("Payroll inputs differ between connected businesses; no saved record was changed.");
                    }
                    pending.push({ businessId: mirrorId, id: hash([mirrorId, employee.employeeCode, period.start, period.end, "missing-payroll-v1"]).slice(0, 24),
                        value: { ...counterpart.value, payrollOwnerBusinessId: ownerBusinessId,
                            calculationSnapshot: { ...counterpart.value.calculationSnapshot, businessIds,
                                generatedInProgress: counterpart.dtr.rows.some(row => row.status === "Scheduled") || counterpart.value.incompleteShiftDays > 0 } } });
                });
            }
            const nonBillable = payrollDeductionRows(candidate.value).find(row => row.label === "Non-billable Off the Phone");
            rows.push({ employeeCode: employee.employeeCode, employeeName: employee.name, businessIds,
                grossPay: candidate.value.grossPay, deductions: candidate.value.deductions, netPay: candidate.value.netPay,
                nonBillableOffPhoneMinutes: candidate.value.nonBillableOffPhoneMinutes ?? 0, nonBillableOffPhoneDeduction: nonBillable?.amount ?? 0,
                incompleteShiftDays: candidate.value.incompleteShiftDays, scheduledDays: candidate.dtr.rows.filter(row => row.status === "Scheduled").length });
            targets.push(...pending);
        } catch (error) {
            if (!(error instanceof PayrollValidationError)) throw error;
            held.push({ employeeCode: employee.employeeCode, employeeName: employee.name, reason: error.message });
        }
    }
    const plan: PayrollGenerationPlan = { businessId, payPeriod, token: hash({ businessId, payPeriod, targets, held, policy }),
        rows, held, canApply: rows.length > 0, automaticEnabled: policy?.enabled === true };
    return { plan, targets, period };
}

export async function previewMissingPayroll(requestedPeriod = "") {
    return withReadSnapshot(serverReadTime(), async () => (await buildMissingPlan(requestedPeriod)).plan);
}

async function insertMissing(plan: PayrollGenerationPlan, actor: string, reason: string, enableFuture: boolean) {
    const session = await mongoose.startSession();
    try {
        return await session.withTransaction(async () => {
            const scopes = plan.rows.flatMap(row => row.businessIds.map(businessId => ({ businessId, employeeCode: row.employeeCode })));
            await lockPayrollAttendance(scopes, session);
            const verified = await withReadSnapshot(serverReadTime(), () => buildMissingPlan(plan.payPeriod, session));
            if (verified.plan.token !== plan.token) throw fail(409, "Payroll or attendance changed. Preview missing payroll again.");
            for (const target of verified.targets) await runWithBusiness(target.businessId, async () => {
                await PayrollRecord.create([{ _id: new Types.ObjectId(target.id), ...target.value,
                    calculationAudit: [{ at: serverReadTime().toISOString(), actor, reason, before: {}, after: target.value }] }], { session });
            });
            if (enableFuture) await PayrollGenerationPolicy.updateOne({ _id: policyId }, {
                $set: { enabled: true, actor, enabledAt: serverReadTime() }, $setOnInsert: { startsAfter: verified.period.end },
            }, { session, upsert: true, runValidators: true });
            return { created: verified.plan.rows.length, mirrors: verified.targets.length, held: verified.plan.held,
                payPeriod: plan.payPeriod, automaticEnabled: enableFuture || verified.plan.automaticEnabled };
        }, { readConcern: { level: "snapshot" }, writeConcern: { w: "majority" } });
    } catch (error) {
        if ((error as { code?: number }).code === 11000) throw fail(409, "Another payroll save completed first. Refresh before generating again.");
        throw error;
    } finally { await session.endSession(); }
}

export async function confirmMissingPayroll(request: Request) {
    const actor = verifyAdminDashboardSession(request.header("x-crm-admin-session"));
    if (!actor) throw fail(403, "A verified administrator session is required.");
    if (request.body.confirm !== true || !String(request.body.reason || "").trim() || typeof request.body.enableFuture !== "boolean") {
        throw fail(400, "Explicit confirmation, a reason and a future-generation choice are required.");
    }
    const plan = await previewMissingPayroll(String(request.body.payPeriod || ""));
    if (request.body.token !== plan.token) throw fail(409, "Payroll or attendance changed. Preview again.");
    if (!plan.canApply && !request.body.enableFuture) throw new PayrollValidationError("No missing payroll is safe to generate.");
    return insertMissing(plan, actor.employeeCode, String(request.body.reason).trim().slice(0, 1000), request.body.enableFuture);
}

export async function generateFutureMissingPayroll() {
    const policy = await PayrollGenerationPolicy.findById(policyId).lean();
    if (!policy?.enabled) return null;
    const plan = await previewMissingPayroll();
    if (savedPayrollPeriod(plan.payPeriod)!.start <= policy.startsAfter || !plan.canApply) return null;
    return insertMissing(plan, policy.actor, "Automatic current-cutoff generation of missing payroll only", false);
}
