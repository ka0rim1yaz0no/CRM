import mongoose, { Types } from "mongoose";
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

const fail = (statusCode: number, message: string) => Object.assign(new Error(message), { statusCode });
const fingerprint = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const moneyFields = (value?: { grossPay: number; deductions: number; netPay: number } | null) => ({ grossPay: value?.grossPay ?? 0, deductions: value?.deductions ?? 0, netPay: value?.netPay ?? 0 });

export async function calculatePayrollCandidate(employee: { _id: Types.ObjectId; employeeCode: string; name: string; email?: string; team?: string; role?: string; salary: number }, payPeriod: string, overtimeOverride?: number) {
  const { settings, policy } = await payrollCalculationContext();
  const rates = payrollRatesForCutoff(employee.salary, payPeriod, settings, policy);
  const dtr = await attendancePayrollDtr(employee._id, payPeriod);
  const record = await PayrollRecord.findOne({ employeeId: employee.employeeCode, payPeriod, isArchived: false }).lean();
  const approvedOvertimeHours = overtimeOverride ?? (record?.overtimeApproved ? record.overtimeHours : 0);
  if (!Number.isFinite(approvedOvertimeHours) || approvedOvertimeHours < 0 || approvedOvertimeHours > dtr.summary.overtimeHours) {
    throw new PayrollValidationError("Approved overtime exceeds verified completed weekend work; review the cutoff");
  }
  const grossPay = roundMoney(rates.cutoffBasePay + approvedOvertimeHours * rates.hourlyRate);
  const deductions = Math.min(grossPay, roundMoney(dtr.summary.deductibleMinutes * rates.minuteRate));
  const payDate = scheduledPayDateForPeriod(payPeriod, settings);
  const ledger = await AttendanceLedger.findOne({ employeeCode: employee.employeeCode, businessIds: getCurrentBusinessId() }).select("revision events corrections closures businessIds migrationRequired").lean();
  const evidence = ledger && !ledger.migrationRequired ? projectAttendance(ledger.events, ledger.corrections, ledger.closures).sessions.flatMap(item => item.events)
    .map(item => ({ id: item.id, source: item.source, at: item.at, shift: item.shift })) :
    (await Attendance.find({ employee: employee._id, isArchived: false }).select("source timeIn").lean())
      .map(item => ({ id: String(item._id), source: item.source, at: item.timeIn.toISOString() }));
  const firstDay = dtr.rows[0]!.dateKey, lastDay = dtr.rows.at(-1)!.dateKey;
  const evidenceStart = Date.parse(firstDay) - 86_400_000, evidenceEnd = Date.parse(lastDay) + 2 * 86_400_000;
  const value = { employeeName: employee.name, email: employee.email || "", employeeId: employee.employeeCode,
    department: employee.team || employee.role || "General", payType: "Semi-monthly" as const,
    ...dtr.summary, basicPay: rates.cutoffBasePay, workingDays: rates.monthlyWorkingDays,
    paidHoursPerDay: rates.paidHoursPerDay, hourlyRate: rates.hourlyRate, minuteRate: rates.minuteRate,
    grossPay, deductions, netPay: roundMoney(Math.max(0, grossPay - deductions)),
    overtimeHours: approvedOvertimeHours, overtimeApproved: approvedOvertimeHours > 0, workedMinutesOverride: null,
    calculationVersion: "duration-payroll-v1", status: dtr.summary.incompleteShiftDays ? "Review" as const : "Pending" as const,
    paidOn: record?.paidOn || payDate?.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) || "-", payPeriod, isArchived: false,
    calculationSnapshot: { settings: { officialShiftStartTime: settings.officialShiftStartTime, officialShiftEndTime: settings.officialShiftEndTime },
      policy: { breakMinutes: policy.breakMinutes, lunchMinutes: policy.lunchMinutes, graceMinutes: policy.graceMinutes, revision: policy.revision },
      ...rates, attendanceRevision: ledger?.revision ?? null,
      attendanceFingerprint: fingerprint(ledger ? { events: ledger.events, corrections: ledger.corrections, closures: ledger.closures } : dtr.rows),
      evidence: evidence.filter(item => Date.parse(item.at) >= evidenceStart && Date.parse(item.at) < evidenceEnd),
      days: dtr.rows.map(item => ({ dayKey: item.dateKey, status: item.status, lateMinutes: item.lateMinutes, earlyTimeOutMinutes: item.earlyTimeOutMinutes,
        excessBreakMinutes: item.excessBreakMinutes, excessLunchMinutes: item.excessLunchMinutes, absenceMinutes: item.absenceMinutes, deductibleMinutes: item.deductibleMinutes })),
      rounding: "Each completed break/lunch excess rounds up; lateness uses minute boundaries after grace; early-out rounds up; money rounds once per total." } };
  return { record, value, dtr, rates };
}

export async function getAccuratePayrollDtr(employee: Parameters<typeof calculatePayrollCandidate>[0], payPeriod: string) {
  const candidate = await calculatePayrollCandidate(employee, payPeriod);
  const saved = candidate.record;
  return { employee: { _id: employee._id, name: employee.name, employeeCode: employee.employeeCode, department: employee.team || employee.role || "General" },
    payPeriod, payDate: saved?.paidOn || "-", payType: saved?.payType || "Semi-monthly",
    storedCutoff: Boolean(saved), potentialOvertimeHours: candidate.dtr.summary.overtimeHours,
    summary: { ...candidate.dtr.summary, ...candidate.rates,
      ...candidate.value, ...(saved ? saved : {}),
      // Old records have no paid-day snapshot; do not invent one from today's settings.
      ...(saved ? { paidHoursPerDay: saved.paidHoursPerDay ?? null, hourlyRate: saved.hourlyRate ?? saved.minuteRate * 60,
        monthlyWorkingDays: saved.workingDays, missingHours: saved.missingHours ?? saved.deductibleMinutes / 60 } : {}) },
    rows: candidate.dtr.rows.filter(row => row.status !== "Scheduled") };
}

type PlanRow = { employeeCode: string; employeeName: string; ownerBusinessId: string; businessIds: string[];
  before: ReturnType<typeof moneyFields>; after: ReturnType<typeof moneyFields>; difference: number; reviewDays: number; potentialOvertimeHours: number; approvedOvertimeHours: number };
type Target = { businessId: string; id: string; beforeHash: string; before: Record<string, unknown> | null; value: Record<string, unknown> };
export async function previewPayrollCutoff(payPeriod: string, overtimeApprovals: unknown = {}) {
  if (!/^[A-Za-z]+ \d{1,2}, \d{4} - [A-Za-z]+ \d{1,2}, \d{4}$/.test(payPeriod)) throw new PayrollValidationError("Choose an explicit cutoff date range");
  const context = await payrollCalculationContext();
  if (context.settings.payrollBillingCycle !== "Semi-monthly" || !isConfiguredPayrollPeriod(payPeriod, context.settings)) {
    throw new PayrollValidationError("Choose a complete configured semi-monthly cutoff; partial or unsupported payroll cycles require HR review");
  }
  const business = getCurrentBusinessId();
  if (!overtimeApprovals || typeof overtimeApprovals !== "object" || Array.isArray(overtimeApprovals)) throw new PayrollValidationError("Overtime approvals must be employee-code keyed hours");
  const approvals = overtimeApprovals as Record<string, unknown>;
  const employees = await Employee.find({ status: { $ne: "Archived" } }).select("employeeCode name email role team salary").sort({ employeeCode: 1 }).lean();
  const seen = new Set<string>();
  const rows: PlanRow[] = [], targets: Target[] = [];
  for (const employee of employees) {
    if (seen.has(employee.employeeCode)) throw new PayrollValidationError("Duplicate employee code requires review before payroll");
    seen.add(employee.employeeCode);
    const access = await getBusinessAccessForEmployeeCode(employee.employeeCode);
    const ledger = await AttendanceLedger.findOne({ employeeCode: employee.employeeCode, businessIds: business }).select("canonicalBusinessId businessIds").lean();
    const businessIds = [...new Set([...(access.length ? access : ledger?.businessIds || []), business])].sort();
    const ownerBusinessId = ledger?.canonicalBusinessId || businessIds[0];
    const override = Object.hasOwn(approvals, employee.employeeCode) ? Number(approvals[employee.employeeCode]) : undefined;
    const candidate = await calculatePayrollCandidate(employee, payPeriod, override);
    let reviewDays = candidate.dtr.summary.incompleteShiftDays;
    for (const businessId of businessIds) {
      if (!getBusinessById(businessId)) throw new PayrollValidationError("A payroll business is unavailable; no changes applied");
      await runWithBusiness(businessId, async () => {
        const other = await Employee.findOne({ employeeCode: employee.employeeCode, status: { $ne: "Archived" } }).select("employeeCode name email role team salary").lean();
        if (!other) throw new PayrollValidationError("Employee membership mismatch across businesses; no changes applied");
        const counterpart = businessId === business ? candidate : await calculatePayrollCandidate(other, payPeriod, override);
        if (fingerprint(counterpart.value) !== fingerprint(candidate.value)) throw new PayrollValidationError("Payroll settings, salary or attendance differ across businesses; resolve the mismatch before recomputing");
        const old = counterpart.record;
        const otherPeriods = await PayrollRecord.find({ employeeId: employee.employeeCode,
          ...(old ? { _id: { $ne: old._id } } : {}), $or: [{ isArchived: false }, { status: { $in: ["Paid", "Completed"] } }] }).select("payPeriod").lean();
        const selectedRange = periodRange(payPeriod);
        if (otherPeriods.some(item => { const range = periodRange(item.payPeriod); return range.start < selectedRange.end && range.end > selectedRange.start; })) {
          throw new PayrollValidationError("An existing cutoff overlaps these shift days. Review it instead of generating duplicate pay");
        }
        const duplicates = await PayrollRecord.countDocuments({ employeeId: employee.employeeCode, payPeriod, isArchived: false });
        if (duplicates > 1) throw new PayrollValidationError("Duplicate cutoff records require review; no records were removed");
        if (old && ["Paid", "Completed"].includes(old.status)) throw new PayrollValidationError("Paid or completed payroll is locked; no changes applied");
        reviewDays = Math.max(reviewDays, counterpart.dtr.summary.incompleteShiftDays);
        const archived = old ? null : await PayrollRecord.findOne({ employeeId: employee.employeeCode, payPeriod, isArchived: true }).sort({ updatedAt: -1 }).select("_id").lean();
        const id = old?._id.toString() || createHash("sha256").update(`${businessId}:${employee.employeeCode}:${payPeriod}:duration-payroll-v1:${archived?._id || "initial"}`).digest("hex").slice(0, 24);
        targets.push({ businessId, id, beforeHash: fingerprint(old || null), before: old as Record<string, unknown> | null,
          value: { ...candidate.value, payrollOwnerBusinessId: ownerBusinessId } });
      });
    }
    rows.push({ employeeCode: employee.employeeCode, employeeName: employee.name, ownerBusinessId, businessIds,
      before: moneyFields(candidate.record), after: moneyFields(candidate.value), difference: roundMoney(candidate.value.netPay - (candidate.record?.netPay || 0)), reviewDays,
      potentialOvertimeHours: candidate.dtr.summary.overtimeHours, approvedOvertimeHours: candidate.value.overtimeHours });
  }
  const token = fingerprint({ payPeriod, targets });
  return { payPeriod, token, rows, totalDifference: roundMoney(rows.reduce((sum, row) => sum + row.difference, 0)),
    canApply: rows.length > 0 && rows.every(row => row.reviewDays === 0), targets };
}
export async function applyPayrollCutoff(request: Request) {
  const actor = verifyAdminDashboardSession(request.header("x-crm-admin-session"));
  if (!actor) throw fail(403, "A verified administrator session is required");
  if (request.body.confirm !== true || !String(request.body.reason || "").trim()) throw fail(400, "Explicit confirmation and a reason are required");
  const plan = await previewPayrollCutoff(String(request.body.payPeriod || ""), request.body.overtimeApprovals);
  if (!plan.canApply) throw new PayrollValidationError("Cutoff contains Needs Review rows. Resolve open or inconsistent attendance before generating payroll.");
  if (request.body.token !== plan.token) throw fail(409, "Payroll or attendance changed. Preview the cutoff again before confirming.");
  // One Mongo transaction covers all business mirrors and their before/after audit entries.
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      for (const target of plan.targets) await runWithBusiness(target.businessId, async () => {
        const current = await PayrollRecord.findById(target.id).session(session).lean();
        if (fingerprint(current || null) !== target.beforeHash) throw fail(409, "Payroll changed during confirmation. Preview again.");
        const audit = { at: new Date().toISOString(), actor: actor.employeeCode, reason: String(request.body.reason).trim().slice(0, 1000),
          before: current ? { ...current, calculationAudit: undefined } : {}, after: target.value };
        await PayrollRecord.updateOne({ _id: new Types.ObjectId(target.id) }, { $set: target.value, $push: { calculationAudit: audit } },
          { session, upsert: !current, runValidators: true, setDefaultsOnInsert: true });
      });
    });
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
  const source = await PayrollRecord.findById(request.params.id).lean();
  if (!source || source.isArchived) throw fail(404, "Payroll record not found");
  if (source.payrollOwnerBusinessId && source.payrollOwnerBusinessId !== getCurrentBusinessId()) throw new PayrollValidationError("Change payment status in the cutoff's owning business");
  if (paid && (source.incompleteShiftDays || source.status === "Review")) throw new PayrollValidationError("Resolve attendance review before marking payroll paid");
  const access = await getBusinessAccessForEmployeeCode(source.employeeId);
  const businessIds = [...new Set([...access, getCurrentBusinessId()])];
  const session = await mongoose.startSession();
  const paidOn = paid ? new Date().toLocaleDateString("en-US", { timeZone: "Asia/Manila", month: "short", day: "numeric", year: "numeric" }) : "-";
  try {
    await session.withTransaction(async () => {
      for (const businessId of businessIds) await runWithBusiness(businessId, async () => {
        const records = await PayrollRecord.find({ employeeId: source.employeeId, payPeriod: source.payPeriod, isArchived: false }).session(session).lean();
        if (records.length !== 1 || fingerprint(moneyFields(records[0])) !== fingerprint(moneyFields(source))) throw new PayrollValidationError("Payroll mirror mismatch; payment status was not changed");
        if (paid && (records[0].incompleteShiftDays || records[0].status === "Review")) throw new PayrollValidationError("A business has unresolved payroll review");
        if (records[0].status === (paid ? "Paid" : "Pending")) return;
        await PayrollRecord.updateOne({ _id: records[0]._id }, { $set: { status: paid ? "Paid" : "Pending", paidOn }, $push: { calculationAudit: {
          at: new Date().toISOString(), actor: verifyAdminDashboardSession(request.header("x-crm-admin-session"))!.employeeCode,
          reason: paid ? "Administrator marked shared cutoff paid" : "Administrator marked shared cutoff unpaid",
          before: { status: records[0].status, paidOn: records[0].paidOn }, after: { status: paid ? "Paid" : "Pending", paidOn } } } }, { session, runValidators: true });
      });
    });
  } finally { await session.endSession(); }
  return PayrollRecord.findById(source._id);
}
