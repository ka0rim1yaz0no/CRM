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
import { currentCutoffLiveFrom } from "../config/payrollEarnings";
import { inheritedCurrentPayrollInputs } from "./payrollCanonicalInputs";
import type { PayrollGenerationPlan } from "../../../shared/payrollGeneration";

const policyId = "missing-current-payroll";
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const fail = (statusCode: number, message: string) => Object.assign(new Error(message), { statusCode });
type GenerationClock = { at: number; expiresAt: number; businessId: string; payPeriod: string };
const generationClocks = new Map<string, GenerationClock>();

function rememberGenerationClock(plan: PayrollGenerationPlan, at: Date) {
    const from = currentCutoffLiveFrom(), period = savedPayrollPeriod(plan.payPeriod);
    if (!from || !period || period.start < from) return;
    const now = Date.now();
    for (const [key, value] of generationClocks) if (value.expiresAt <= now) generationClocks.delete(key);
    generationClocks.delete(plan.token);
    generationClocks.set(plan.token, { at: +at, expiresAt: now + 5 * 60_000, businessId: plan.businessId, payPeriod: plan.payPeriod });
    while (generationClocks.size > 512) { const first = generationClocks.keys().next().value; if (!first) break; generationClocks.delete(first); }
}

function approvedGenerationClock(token: unknown, payPeriod: string) {
    const from = currentCutoffLiveFrom(), period = savedPayrollPeriod(payPeriod);
    if (!from) return undefined;
    if (!period) throw fail(400, "Choose a dated current cutoff before generation.");
    if (period.start < from) return undefined;
    const snapshot = typeof token === "string" ? generationClocks.get(token) : undefined, now = Date.now();
    if (!snapshot || snapshot.businessId !== getCurrentBusinessId() || savedPayrollPeriod(snapshot.payPeriod)?.label !== period.label || snapshot.expiresAt <= now || snapshot.at > now + 2000) {
        throw fail(409, "Current payroll preview expired or changed business. Preview again.");
    }
    return new Date(snapshot.at);
}
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
                    let counterpart = candidate, inheritedPayrollInputs = false;
                    const from = currentCutoffLiveFrom();
                    const inheritedHistory = copies.length > 0 && copies.every(copy => {
                        const earlier = savedPayrollPeriod(copy.payPeriod), snapshot = copy.calculationSnapshot, membership = snapshot?.businessIds;
                        return from && earlier && earlier.start >= from && earlier.end < period.start && copy.payrollOwnerBusinessId === ownerBusinessId &&
                            snapshot?.inheritedPayrollInputs === true && snapshot.payrollInputsBusinessId === ownerBusinessId &&
                            Array.isArray(membership) && membership.includes(mirrorId) && membership.includes(ownerBusinessId);
                    });
                    const canInheritNewCopy = Boolean(from && period.start >= from && (!copies.length || inheritedHistory) && mirrorId !== ownerBusinessId);
                    const readInheritedCandidate = async () => {
                        if (!canInheritNewCopy) throw new PayrollValidationError("Shared current payroll inputs are unavailable.");
                        if (people[0].salary !== candidate.value.calculationSnapshot.monthlySalary) throw new PayrollValidationError("Shared current payroll salaries differ; no record was generated.");
                        const inherited = await inheritedCurrentPayrollInputs({ employeeId: employee.employeeCode, payPeriod, payrollOwnerBusinessId: ownerBusinessId,
                            calculationSnapshot: { inheritedPayrollInputs: true, payrollInputsBusinessId: ownerBusinessId } }, session);
                        if (!inherited) throw new PayrollValidationError("Shared current payroll inputs are unavailable.");
                        return runWithBusiness(ownerBusinessId, async () => {
                            const owner = await Employee.findOne({ employeeCode: employee.employeeCode, status: { $ne: "Archived" } }, null, session ? { session } : undefined).lean();
                            if (!owner) throw new PayrollValidationError("The current payroll owner employee is unavailable.");
                            return calculatePayrollCandidate(owner, payPeriod, undefined, session);
                        });
                    };
                    if (mirrorId !== businessId) {
                        try {
                            if (canInheritNewCopy && !ledger?.businessIds.includes(mirrorId)) { counterpart = await readInheritedCandidate(); inheritedPayrollInputs = true; }
                            else counterpart = await calculatePayrollCandidate(people[0], payPeriod, undefined, session);
                        }
                        catch (error) {
                            if (!(error instanceof PayrollValidationError) || error.message !== "Shift settings are required for payroll" || !canInheritNewCopy) throw error;
                            counterpart = await readInheritedCandidate();
                            inheritedPayrollInputs = true;
                        }
                    }
                    if (counterpart.record || calculationFingerprint(counterpart) !== calculationFingerprint(candidate)) {
                        throw new PayrollValidationError("Payroll inputs differ between connected businesses; no saved record was changed.");
                    }
                    pending.push({ businessId: mirrorId, id: hash([mirrorId, employee.employeeCode, period.start, period.end, "missing-payroll-v1"]).slice(0, 24),
                        value: { ...counterpart.value, payrollOwnerBusinessId: ownerBusinessId,
                            calculationSnapshot: { ...counterpart.value.calculationSnapshot, businessIds,
                                ...(inheritedPayrollInputs ? { inheritedPayrollInputs: true, payrollInputsBusinessId: ownerBusinessId } : {}),
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
    const at = serverReadTime();
    return withReadSnapshot(at, async () => { const plan = (await buildMissingPlan(requestedPeriod)).plan; rememberGenerationClock(plan, at); return plan; });
}

async function insertMissing(plan: PayrollGenerationPlan, actor: string, reason: string, enableFuture: boolean, at?: Date) {
    const session = await mongoose.startSession();
    try {
        const result = await session.withTransaction(async () => {
            const scopes = plan.rows.flatMap(row => row.businessIds.map(businessId => ({ businessId, employeeCode: row.employeeCode })));
            await lockPayrollAttendance(scopes, session);
            // Elapsed hours may advance without an attendance write; only server-issued preview clocks are reusable.
            if (at && +approvedGenerationClock(plan.token, plan.payPeriod)! !== +at) throw fail(409, "Current payroll preview changed. Preview again.");
            const verified = await withReadSnapshot(at || serverReadTime(), () => buildMissingPlan(plan.payPeriod, session));
            if (verified.plan.token !== plan.token) throw fail(409, "Payroll or attendance changed. Preview missing payroll again.");
            for (const target of verified.targets) await runWithBusiness(target.businessId, async () => {
                await PayrollRecord.create([{ _id: new Types.ObjectId(target.id), ...target.value,
                    ...(at ? { calculationSnapshot: { ...target.value.calculationSnapshot, generatedAsOf: at.toISOString() } } : {}),
                    calculationAudit: [{ at: serverReadTime().toISOString(), actor, reason, before: {}, after: target.value }] }], { session });
            });
            if (enableFuture) await PayrollGenerationPolicy.updateOne({ _id: policyId }, {
                $set: { enabled: true, actor, enabledAt: serverReadTime() }, $setOnInsert: { startsAfter: verified.period.end },
            }, { session, upsert: true, runValidators: true });
            return { created: verified.plan.rows.length, mirrors: verified.targets.length, held: verified.plan.held,
                payPeriod: plan.payPeriod, automaticEnabled: enableFuture || verified.plan.automaticEnabled };
        }, { readConcern: { level: "snapshot" }, writeConcern: { w: "majority" } });
        if (at) generationClocks.delete(plan.token);
        return result;
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
    const at = approvedGenerationClock(request.body.token, String(request.body.payPeriod || ""));
    const plan = await withReadSnapshot(at || serverReadTime(), () => previewMissingPayroll(String(request.body.payPeriod || "")));
    if (request.body.token !== plan.token) throw fail(409, "Payroll or attendance changed. Preview again.");
    if (!plan.canApply && !request.body.enableFuture) throw new PayrollValidationError("No missing payroll is safe to generate.");
    return insertMissing(plan, actor.employeeCode, String(request.body.reason).trim().slice(0, 1000), request.body.enableFuture, at);
}

export async function generateFutureMissingPayroll() {
    const policy = await PayrollGenerationPolicy.findById(policyId).lean();
    if (!policy?.enabled) return null;
    const plan = await previewMissingPayroll();
    if (savedPayrollPeriod(plan.payPeriod)!.start <= policy.startsAfter || !plan.canApply) return null;
    return insertMissing(plan, policy.actor, "Automatic current-cutoff generation of missing payroll only", false, approvedGenerationClock(plan.token, plan.payPeriod));
}
