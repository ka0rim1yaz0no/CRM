import mongoose, { Types, type ClientSession } from "mongoose";
import { createHash } from "node:crypto";
import type { Request } from "express";
import { getBusinessById, getCurrentBusinessId, runWithBusiness } from "../config/tenancy";
import { verifyAdminDashboardSession } from "../config/adminDashboardSession";
import { PayrollRecord } from "../models/Payroll";
import { Employee } from "../models/Employee";
import { AttendanceLedger } from "../models/AttendanceLedger";
import { Attendance } from "../models/Attendance";
import { projectAttendance } from "./attendanceSessionState";
import { getBusinessAccessForEmployeeCode } from "../models/BusinessUserAccess";
import { attendancePayrollDtr, payrollCalculationContext, payrollRatesForCutoff, periodRange, isConfiguredPayrollPeriod, scheduledPayDateForPeriod } from "../controllers/payrollController";
import { roundMoney, PayrollValidationError } from "./payrollAccuracy";
import { serverReadTime, withReadSnapshot } from "./readSnapshot";
import { attendanceIntegrityEnabled } from "../config/rolloutFlags";
import { lockPayrollAttendance, payrollAttendanceFenceKeys } from "./payrollAttendanceFence";
import { payrollReadGroups } from "./payrollReadPolicy";
import { savedPayrollPeriod } from "../../../shared/payrollPeriod";
import { adjustedPayrollHours } from "../../../shared/payrollWorkedHours";
import { payrollDeductionRows, type SavedDeductionSource } from "../../../shared/payrollPresentation";
import { earnedPayrollEnabled, earnedAllDeductionsEnabled, earnedPayrollVersion, earnedUndertimeAbsenceExcluded } from "../config/payrollEarnings";

const fail = (statusCode: number, message: string) => Object.assign(new Error(message), { statusCode });
const fingerprint = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const moneyFields = (value?: { grossPay: number; deductions: number; netPay: number } | null) => ({ grossPay: value?.grossPay ?? 0, deductions: value?.deductions ?? 0, netPay: value?.netPay ?? 0 });

export async function calculatePayrollCandidate(employee: { _id: Types.ObjectId; employeeCode: string; name: string; email?: string; team?: string; role?: string; salary: number }, payPeriod: string, overtimeOverride?: number, session?: ClientSession) {
  const { settings, policy } = await payrollCalculationContext(session);
  const rates = payrollRatesForCutoff(employee.salary, payPeriod, settings, policy);
  const dtr = await attendancePayrollDtr(employee._id, payPeriod, session);
  const earned = earnedPayrollEnabled(payPeriod);
  const calculationVersion = earned ? earnedPayrollVersion(payPeriod) : "duration-payroll-v1";
  const record = await PayrollRecord.findOne({ employeeId: employee.employeeCode, payPeriod, isArchived: false }, null, session ? { session } : undefined).lean();
  let hoursAdjustment = {};
  if (record?.workedMinutesOverride !== null && record?.workedMinutesOverride !== undefined) {
    try { hoursAdjustment = adjustedPayrollHours({ ...dtr.summary, calculationVersion }, record.workedMinutesOverride); }
    catch (error) { throw new PayrollValidationError((error as Error).message); }
  }
  const summary = { ...dtr.summary, ...hoursAdjustment };
  const approvedOvertimeHours = overtimeOverride ?? (record?.overtimeApproved ? record.overtimeHours : 0);
  if (!Number.isFinite(approvedOvertimeHours) || approvedOvertimeHours < 0 || approvedOvertimeHours > dtr.summary.overtimeHours) {
    throw new PayrollValidationError("Approved overtime exceeds verified completed weekend work; review the cutoff");
  }
  const grossPay = roundMoney((earned ? summary.earnedGrossHours! * rates.hourlyRate : rates.cutoffBasePay) + approvedOvertimeHours * rates.hourlyRate);
  const deductions = Math.min(grossPay, roundMoney(summary.deductibleMinutes * rates.minuteRate));
  const payDate = scheduledPayDateForPeriod(payPeriod, settings);
  const ledger = await AttendanceLedger.findOne({ employeeCode: employee.employeeCode, businessIds: getCurrentBusinessId() }, null, session ? { session } : undefined).select("revision events corrections closures businessIds migrationRequired").lean();
  const evidence = ledger && !ledger.migrationRequired ? projectAttendance(ledger.events, ledger.corrections, ledger.closures).sessions.flatMap(item => item.events)
    .map(item => ({ id: item.id, source: item.source, at: item.at, shift: item.shift })) :
    (await Attendance.find({ employee: employee._id, isArchived: false }, null, session ? { session } : undefined).select("source timeIn").lean())
      .map(item => ({ id: String(item._id), source: item.source, at: item.timeIn.toISOString() }));
  const firstDay = dtr.rows[0]!.dateKey, lastDay = dtr.rows.at(-1)!.dateKey;
  const evidenceStart = Date.parse(firstDay) - 86_400_000, evidenceEnd = Date.parse(lastDay) + 2 * 86_400_000;
  const value = { employeeName: employee.name, email: employee.email || "", employeeId: employee.employeeCode,
    department: employee.team || employee.role || "General", payType: "Semi-monthly" as const,
    ...summary, basicPay: rates.cutoffBasePay, workingDays: rates.monthlyWorkingDays,
    paidHoursPerDay: rates.paidHoursPerDay, hourlyRate: rates.hourlyRate, minuteRate: rates.minuteRate,
    grossPay, deductions, netPay: roundMoney(Math.max(0, grossPay - deductions)),
    overtimeHours: approvedOvertimeHours, overtimeApproved: approvedOvertimeHours > 0, workedMinutesOverride: record?.workedMinutesOverride ?? null,
    calculationVersion, status: dtr.summary.incompleteShiftDays ? "Review" as const : "Pending" as const,
    paidOn: record?.paidOn || payDate?.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) || "-", payPeriod, isArchived: false,
    calculationSnapshot: { settings: { officialShiftStartTime: settings.officialShiftStartTime, officialShiftEndTime: settings.officialShiftEndTime },
      policy: { breakMinutes: policy.breakMinutes, lunchMinutes: policy.lunchMinutes, graceMinutes: policy.graceMinutes, revision: policy.revision },
      ...rates,
      workedMinutesOverride: record?.workedMinutesOverride ?? null, attendanceRevision: ledger?.revision ?? null,
      attendanceFingerprint: fingerprint(ledger ? { events: ledger.events, corrections: ledger.corrections, closures: ledger.closures } : dtr.rows),
      evidence: evidence.filter(item => Date.parse(item.at) >= evidenceStart && Date.parse(item.at) < evidenceEnd),
      days: dtr.rows.map(item => ({ dayKey: item.dateKey, status: item.status, lateMinutes: item.lateMinutes, earlyTimeOutMinutes: item.earlyTimeOutMinutes,
        nonBillableOffPhoneMinutes: item.nonBillableOffPhoneMinutes ?? 0,
        excessBreakMinutes: item.excessBreakMinutes, excessLunchMinutes: item.excessLunchMinutes, absenceMinutes: item.absenceMinutes, deductibleMinutes: item.deductibleMinutes })),
      rounding: earnedUndertimeAbsenceExcluded(payPeriod) ? "Earned-to-date gross less Late, excess Break/Lunch and non-billable Off the Phone. Undertime and Absence remain attendance information only; unworked hours are already excluded from earned gross. Money rounds once per total; net floors at zero." : earnedAllDeductionsEnabled(payPeriod) ? "Earned-to-date gross less all verified attendance deductions: Late, Undertime, completed-shift Absence, excess Break/Lunch and non-billable Off the Phone. Shortfalls are additional charges under the approved policy. No future-shift absence; money rounds once per total; net floors at zero." : earned ? "Earned in-shift presence less the taken lunch allowance; excess rest and non-billable minutes round up and are deducted once. No future hours, late/early shortfall or absence is deducted again. Money rounds once per total." : "Each completed break/lunch excess rounds up; lateness uses minute boundaries after grace; early-out rounds up; money rounds once per total." } };
  return { record, value, dtr, rates };
}

export function calculationFingerprint(candidate: Awaited<ReturnType<typeof calculatePayrollCandidate>>) {
  const { value, dtr, rates } = candidate;
  const snapshot = value.calculationSnapshot;
  // Replica ObjectIds and business-specific labels are not payroll inputs.
  return fingerprint({ summary: dtr.summary, rows: dtr.rows, rates, ...moneyFields(value),
    approvedOvertimeHours: value.overtimeHours, workedMinutesOverride: value.workedMinutesOverride, payType: value.payType, payPeriod: value.payPeriod, paidOn: value.paidOn,
    settings: snapshot.settings, policy: snapshot.policy, rounding: snapshot.rounding,
    evidence: snapshot.evidence.map(event => ({ source: event.source, at: event.at, shift: "shift" in event ? event.shift ?? null : null })) });
}

export async function getAccuratePayrollDtr(employee: Parameters<typeof calculatePayrollCandidate>[0], payPeriod: string) {
  const saved = await PayrollRecord.findOne({ employeeId: employee.employeeCode, payPeriod, isArchived: false }).lean();
  // Viewing an existing cutoff must not depend on approval of a new calculation.
  if (saved) {
    const { getSystemSettings } = await import("../controllers/systemSettingsController");
    const { currentPeriod } = await import("../controllers/payrollController");
    const { currentEarnedPayrollRecords } = await import("./payrollEarningsRead");
    const settings = await getSystemSettings();
    const shown = (await currentEarnedPayrollRecords([saved], currentPeriod(settings.payrollBillingCycle, settings)))[0];
    let current: Awaited<ReturnType<typeof attendancePayrollDtr>> | undefined;
    let currentAttendanceWarning: string | undefined;
    try { current = await attendancePayrollDtr(employee._id, payPeriod); }
    catch (error) {
      if (!(error instanceof PayrollValidationError)) throw error;
      currentAttendanceWarning = error.message;
    }
    return { employee: { _id: employee._id, name: saved.employeeName, employeeCode: saved.employeeId, department: saved.department },
      payPeriod, payDate: saved.paidOn, payType: saved.payType, storedCutoff: true, currentAttendanceWarning,
      currentAttendanceReviewDays: current?.summary.incompleteShiftDays ?? null,
      potentialOvertimeHours: current?.summary.overtimeHours ?? 0,
      summary: { ...shown, paidHoursPerDay: shown.paidHoursPerDay ?? null, hourlyRate: shown.hourlyRate ?? shown.minuteRate * 60,
        workingDays: current?.summary.workingDays ?? null, monthlyWorkingDays: shown.workingDays, missingHours: shown.missingHours ?? shown.deductibleMinutes / 60 },
      rows: current?.rows.filter(row => row.status !== "Scheduled") || [] };
  }
  const candidate = await calculatePayrollCandidate(employee, payPeriod);
  return { employee: { _id: employee._id, name: employee.name, employeeCode: employee.employeeCode, department: employee.team || employee.role || "General" },
    payPeriod, payDate: candidate.value.paidOn, payType: candidate.value.payType,
    storedCutoff: false, currentAttendanceReviewDays: candidate.dtr.summary.incompleteShiftDays, potentialOvertimeHours: candidate.dtr.summary.overtimeHours,
    summary: { ...candidate.dtr.summary, ...candidate.rates, ...candidate.value, workingDays: candidate.dtr.summary.workingDays },
    rows: candidate.dtr.rows.filter(row => row.status !== "Scheduled") };
}

function nonBillableDeduction(record: SavedDeductionSource | null) {
  const row = record && payrollDeductionRows(record).find(item => item.label === "Non-billable Off the Phone");
  return { minutes: row?.minutes ?? 0, amount: row?.amount ?? 0 };
}
type PlanRow = { employeeCode: string; employeeName: string; ownerBusinessId: string; businessIds: string[];
  before: ReturnType<typeof moneyFields>; after: ReturnType<typeof moneyFields>; difference: number; reviewDays: number; potentialOvertimeHours: number; approvedOvertimeHours: number;
  nonBillableOffPhone: { before: ReturnType<typeof nonBillableDeduction>; after: ReturnType<typeof nonBillableDeduction>; minuteRate: number } };
type Target = { businessId: string; id: string; beforeHash: string; before: Record<string, unknown> | null; value: Record<string, unknown> };
export async function previewPayrollCutoff(payPeriod: string, overtimeApprovals: unknown = {}) {
  return withReadSnapshot(serverReadTime(), () => buildPayrollCutoff(payPeriod, overtimeApprovals));
}

async function buildPayrollCutoff(payPeriod: string, overtimeApprovals: unknown, session?: ClientSession) {
  if (!/^[A-Za-z]+ \d{1,2}, \d{4} - [A-Za-z]+ \d{1,2}, \d{4}$/.test(payPeriod)) throw new PayrollValidationError("Choose an explicit cutoff date range");
  const context = await payrollCalculationContext(session);
  if (context.settings.payrollBillingCycle !== "Semi-monthly" || !isConfiguredPayrollPeriod(payPeriod, context.settings)) {
    throw new PayrollValidationError("Choose a complete configured semi-monthly cutoff; partial or unsupported payroll cycles require HR review");
  }
  const business = getCurrentBusinessId();
  if (!overtimeApprovals || typeof overtimeApprovals !== "object" || Array.isArray(overtimeApprovals)) throw new PayrollValidationError("Overtime approvals must be employee-code keyed hours");
  const approvals = overtimeApprovals as Record<string, unknown>;
  const employees = await Employee.find({ status: { $ne: "Archived" } }, null, session ? { session } : undefined).select("employeeCode name email role team salary").sort({ employeeCode: 1 }).lean();
  for (const [code, hours] of Object.entries(approvals)) {
    if (!employees.some(employee => employee.employeeCode === code) || typeof hours !== "number" || !Number.isFinite(hours) || hours < 0) {
      throw new PayrollValidationError("Overtime approvals require a listed employee code and non-negative numeric hours");
    }
  }
  const seen = new Set<string>();
  const rows: PlanRow[] = [], targets: Target[] = [];
  for (const employee of employees) {
    if (seen.has(employee.employeeCode)) throw new PayrollValidationError("Duplicate employee code requires review before payroll");
    seen.add(employee.employeeCode);
    const access = await getBusinessAccessForEmployeeCode(employee.employeeCode, session);
    const ledger = await AttendanceLedger.findOne({ employeeCode: employee.employeeCode, businessIds: business }, null, session ? { session } : undefined).select("canonicalBusinessId businessIds").lean();
    const businessIds = [...new Set([...(access.length ? access : ledger?.businessIds || []), business])].sort();
    const ownerBusinessId = ledger?.canonicalBusinessId || businessIds[0];
    if (!businessIds.includes(ownerBusinessId)) throw new PayrollValidationError("Payroll owner is outside the employee's businesses; review membership before recomputing");
    const override = Object.hasOwn(approvals, employee.employeeCode) ? approvals[employee.employeeCode] as number : undefined;
    const candidate = await calculatePayrollCandidate(employee, payPeriod, override, session);
    let reviewDays = candidate.dtr.summary.incompleteShiftDays;
    for (const businessId of businessIds) {
      if (!getBusinessById(businessId)) throw new PayrollValidationError("A payroll business is unavailable; no changes applied");
      await runWithBusiness(businessId, async () => {
        const other = await Employee.findOne({ employeeCode: employee.employeeCode, status: { $ne: "Archived" } }, null, session ? { session } : undefined).select("employeeCode name email role team salary").lean();
        if (!other) throw new PayrollValidationError("Employee membership mismatch across businesses; no changes applied");
        const counterpart = businessId === business ? candidate : await calculatePayrollCandidate(other, payPeriod, override, session);
        if (calculationFingerprint(counterpart) !== calculationFingerprint(candidate)) throw new PayrollValidationError("Payroll settings, salary or attendance differ across businesses; resolve the mismatch before recomputing");
        const old = counterpart.record;
        const otherPeriods = await PayrollRecord.find({ employeeId: employee.employeeCode,
          ...(old ? { _id: { $ne: old._id } } : {}), $or: [{ isArchived: false }, { status: { $in: ["Paid", "Completed"] } }] }, null, session ? { session } : undefined).select("payPeriod").lean();
        const selectedRange = periodRange(payPeriod);
        if (otherPeriods.some(item => { const range = periodRange(item.payPeriod); return range.start < selectedRange.end && range.end > selectedRange.start; })) {
          throw new PayrollValidationError("An existing cutoff overlaps these shift days. Review it instead of generating duplicate pay");
        }
        const duplicates = await PayrollRecord.countDocuments({ employeeId: employee.employeeCode, payPeriod, isArchived: false }).session(session || null);
        if (duplicates > 1) throw new PayrollValidationError("Duplicate cutoff records require review; no records were removed");
        if (old && ["Paid", "Completed"].includes(old.status)) throw new PayrollValidationError("Paid or completed payroll is locked; no changes applied");
        reviewDays = Math.max(reviewDays, counterpart.dtr.summary.incompleteShiftDays);
        const archived = old ? null : await PayrollRecord.findOne({ employeeId: employee.employeeCode, payPeriod, isArchived: true }, null, session ? { session } : undefined).sort({ updatedAt: -1 }).select("_id").lean();
        const id = old?._id.toString() || createHash("sha256").update(`${businessId}:${employee.employeeCode}:${payPeriod}:duration-payroll-v1:${archived?._id || "initial"}`).digest("hex").slice(0, 24);
        targets.push({ businessId, id, beforeHash: fingerprint(old || null), before: old as Record<string, unknown> | null,
          value: { ...counterpart.value, payrollOwnerBusinessId: ownerBusinessId,
            calculationSnapshot: { ...counterpart.value.calculationSnapshot, businessIds } } });
      });
    }
    rows.push({ employeeCode: employee.employeeCode, employeeName: employee.name, ownerBusinessId, businessIds,
      before: moneyFields(candidate.record), after: moneyFields(candidate.value), difference: roundMoney(candidate.value.netPay - (candidate.record?.netPay || 0)), reviewDays,
      potentialOvertimeHours: candidate.dtr.summary.overtimeHours, approvedOvertimeHours: candidate.value.overtimeHours,
      nonBillableOffPhone: { before: nonBillableDeduction(candidate.record), after: nonBillableDeduction(candidate.value), minuteRate: candidate.value.minuteRate } });
  }
  const token = fingerprint({ payPeriod, targets });
  return { payPeriod, token, rows, totalDifference: roundMoney(rows.reduce((sum, row) => sum + row.difference, 0)),
    canApply: rows.length > 0 && rows.every(row => row.reviewDays === 0), targets };
}
export async function applyPayrollCutoff(request: Request) {
  const actor = verifyAdminDashboardSession(request.header("x-crm-admin-session"));
  if (!actor) throw fail(403, "A verified administrator session is required");
  if (request.body.confirm !== true || !String(request.body.reason || "").trim()) throw fail(400, "Explicit confirmation and a reason are required");
  if (!attendanceIntegrityEnabled()) throw fail(503, "Payroll approval requires revision-checked attendance. No payroll was changed.");
  const plan = await previewPayrollCutoff(String(request.body.payPeriod || ""), request.body.overtimeApprovals);
  if (!plan.canApply) throw new PayrollValidationError("Cutoff contains Needs Review rows. Resolve open or inconsistent attendance before generating payroll.");
  if (request.body.token !== plan.token) throw fail(409, "Payroll or attendance changed. Preview the cutoff again before confirming.");
  // One Mongo transaction covers all business mirrors and their before/after audit entries.
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      const scopes = plan.targets.map(target => ({ businessId: target.businessId, employeeCode: String(target.value.employeeId) }));
      await lockPayrollAttendance(scopes, session);
      const verified = await withReadSnapshot(serverReadTime(), () => buildPayrollCutoff(plan.payPeriod, request.body.overtimeApprovals ?? {}, session));
      const verifiedScopes = verified.targets.map(target => ({ businessId: target.businessId, employeeCode: String(target.value.employeeId) }));
      if (verified.token !== request.body.token || fingerprint(payrollAttendanceFenceKeys(scopes)) !== fingerprint(payrollAttendanceFenceKeys(verifiedScopes))) {
        throw fail(409, "Payroll or attendance changed during approval. Preview the cutoff again.");
      }
      if (!verified.canApply) throw new PayrollValidationError("Cutoff contains Needs Review rows. No payroll was changed.");
      for (const target of verified.targets) await runWithBusiness(target.businessId, async () => {
        const current = await PayrollRecord.findById(target.id).session(session).lean();
        if (fingerprint(current || null) !== target.beforeHash) throw fail(409, "Payroll changed during confirmation. Preview again.");
        const audit = { at: new Date().toISOString(), actor: actor.employeeCode, reason: String(request.body.reason).trim().slice(0, 1000),
          before: current ? { ...current, calculationAudit: undefined } : {}, after: target.value };
        await PayrollRecord.updateOne({ _id: new Types.ObjectId(target.id) }, { $set: target.value, $push: { calculationAudit: audit } },
          { session, upsert: !current, runValidators: true, setDefaultsOnInsert: true });
      });
    }, { readConcern: { level: "snapshot" }, writeConcern: { w: "majority" } });
  } catch (error) {
    if ((error as { code?: number }).code === 11000) throw fail(409, "Another attendance save or payroll approval completed first. Preview again.");
    throw error;
  } finally { await session.endSession(); }
  return { applied: plan.rows.length, mirrors: plan.targets.length, payPeriod: plan.payPeriod };
}

export async function updateAccurateOvertime(request: Request) {
  const hours = Number(request.body.overtimeHours);
  if (!Number.isFinite(hours) || hours < 0) throw new PayrollValidationError("Overtime hours must be zero or greater");
  const record = await PayrollRecord.findById(request.params.id).lean();
  if (!record) throw fail(404, "Payroll record not found");
  // Approval is an input to a recompute preview, not permission to silently rewrite generated pay.
  throw new PayrollValidationError("Approve verified overtime through the cutoff preview; existing pay is locked until explicit recompute confirmation");
}

export async function setAccuratePayrollPaid(request: Request, paid: boolean) {
  const actor = verifyAdminDashboardSession(request.header("x-crm-admin-session"));
  if (!actor) throw fail(403, "A verified administrator session is required");
  const source = await PayrollRecord.findById(request.params.id).lean();
  if (!source || source.isArchived) throw fail(404, "Payroll record not found");
  if (earnedPayrollEnabled(source.payPeriod)) throw new PayrollValidationError("Use the payment-status preview and confirmation for earned payroll. No payment status was changed.");
  if (source.payrollOwnerBusinessId && source.payrollOwnerBusinessId !== getCurrentBusinessId()) throw new PayrollValidationError("Change payment status in the cutoff's owning business");
  if (paid && (source.incompleteShiftDays || source.status === "Review")) throw new PayrollValidationError("Resolve attendance review before marking payroll paid");
  const access = await getBusinessAccessForEmployeeCode(source.employeeId);
  const ledger = await AttendanceLedger.findOne({ employeeCode: source.employeeId, businessIds: getCurrentBusinessId() }).select("businessIds").lean();
  const frozenBusinessIds = source.calculationSnapshot?.businessIds;
  if (frozenBusinessIds !== undefined && (!Array.isArray(frozenBusinessIds) || !frozenBusinessIds.length ||
    frozenBusinessIds.some(id => typeof id !== "string" || !getBusinessById(id)))) {
    throw new PayrollValidationError("Invalid cutoff business snapshot; payment status was not changed");
  }
  // Existing cutoffs retain their original mirrors even after staff move businesses.
  const businessIds = [...new Set<string>(frozenBusinessIds === undefined ? [...access, ...(ledger?.businessIds || []), getCurrentBusinessId()] : frozenBusinessIds as string[])].sort();
  if (!businessIds.includes(getCurrentBusinessId()) || (source.payrollOwnerBusinessId && !businessIds.includes(source.payrollOwnerBusinessId)) || businessIds.some(id => !getBusinessById(id))) {
    throw new PayrollValidationError("Payroll business membership mismatch; payment status was not changed");
  }
  const session = await mongoose.startSession();
  const paidOn = paid ? new Date().toLocaleDateString("en-US", { timeZone: "Asia/Manila", month: "short", day: "numeric", year: "numeric" }) : "-";
  try {
    await session.withTransaction(async () => {
      const currentSource = await PayrollRecord.findById(source._id).session(session).lean();
      if (fingerprint(currentSource) !== fingerprint(source)) throw fail(409, "Payroll changed during payment confirmation. Refresh and try again.");
      for (const businessId of businessIds) await runWithBusiness(businessId, async () => {
        const selectedPeriod = savedPayrollPeriod(source.payPeriod);
        const savedCutoffs = await PayrollRecord.find({ employeeId: source.employeeId, isArchived: false }).session(session).lean();
        const group = payrollReadGroups(savedCutoffs).groups.find(item => item.period.start === selectedPeriod?.start && item.period.end === selectedPeriod?.end);
        if (!selectedPeriod || !group || group.records.length !== 1 || group.requiresReview) {
          throw new PayrollValidationError("Saved cutoff aliases require payroll review; payment status was not changed.");
        }
        const records = await PayrollRecord.find({ employeeId: source.employeeId, payPeriod: source.payPeriod, isArchived: false }).session(session).lean();
        if (records.length !== 1 || fingerprint(moneyFields(records[0])) !== fingerprint(moneyFields(source))) throw new PayrollValidationError("Payroll mirror mismatch; payment status was not changed");
        if (records[0].payrollOwnerBusinessId !== source.payrollOwnerBusinessId || fingerprint(records[0].calculationSnapshot?.businessIds ?? null) !== fingerprint(frozenBusinessIds ?? null)) {
          throw new PayrollValidationError("Payroll mirror ownership or business snapshot differs; payment status was not changed");
        }
        if (paid && (records[0].incompleteShiftDays || records[0].status === "Review")) throw new PayrollValidationError("A business has unresolved payroll review");
        if (records[0].status === (paid ? "Paid" : "Pending")) return;
        await PayrollRecord.updateOne({ _id: records[0]._id }, { $set: { status: paid ? "Paid" : "Pending", paidOn }, $push: { calculationAudit: {
          at: new Date().toISOString(), actor: actor.employeeCode,
          reason: paid ? "Administrator marked shared cutoff paid" : "Administrator marked shared cutoff unpaid",
          before: { status: records[0].status, paidOn: records[0].paidOn }, after: { status: paid ? "Paid" : "Pending", paidOn } } } }, { session, runValidators: true });
      });
    });
  } finally { await session.endSession(); }
  return PayrollRecord.findById(source._id);
}
