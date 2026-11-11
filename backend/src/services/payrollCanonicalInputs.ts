import type { ClientSession, Types } from "mongoose";
import { savedPayrollPeriod } from "../../../shared/payrollPeriod";
import { currentCutoffLiveFrom, equalHalfCutoffAccrualEnabled } from "../config/payrollEarnings";
import { getBusinessById, getCurrentBusinessId, runWithBusiness } from "../config/tenancy";
import { AttendanceLedger } from "../models/AttendanceLedger";
import { getBusinessAccessForEmployeeCode } from "../models/BusinessUserAccess";
import { Employee } from "../models/Employee";
import { PayrollRecord } from "../models/Payroll";
import { Attendance } from "../models/Attendance";
import { PayrollValidationError } from "./payrollAccuracy";

export type CanonicalPayrollCopy = { employeeId: string; payPeriod: string; payrollOwnerBusinessId?: string; calculationSnapshot?: Record<string, unknown> };

// New payroll copies may share their established owner's inputs without creating or changing local shift policy.
export async function inheritedCurrentPayrollInputs(record: CanonicalPayrollCopy, session?: ClientSession) {
    const from = currentCutoffLiveFrom(), period = savedPayrollPeriod(record.payPeriod), snapshot = record.calculationSnapshot;
    if (!from || !period || period.start < from || snapshot?.inheritedPayrollInputs !== true) return null;
    const owner = record.payrollOwnerBusinessId, business = getCurrentBusinessId();
    if (!owner || owner === business || snapshot.payrollInputsBusinessId !== owner) throw new PayrollValidationError("Shared current payroll inputs need review.");
    const access = await getBusinessAccessForEmployeeCode(record.employeeId, session);
    if (!access.includes(business) || !access.includes(owner)) throw new PayrollValidationError("Shared current payroll access changed.");
    const ledgers = await AttendanceLedger.find({ employeeCode: record.employeeId, canonicalBusinessId: owner }, null, session ? { session } : undefined)
        .select("employeeCode canonicalBusinessId businessIds revision events corrections closures migrationRequired").limit(2).lean();
    if (ledgers.length !== 1 || ledgers[0].migrationRequired || !ledgers[0].businessIds.includes(owner)) throw new PayrollValidationError("Canonical current payroll attendance needs review.");
    return { owner, ledger: ledgers[0] };
}

// An unsaved future preview may reuse an established inherited copy, never invent local policy or overwrite a cutoff.
export async function inheritedFuturePayrollPreviewInputs(employee: { _id: Types.ObjectId; employeeCode: string; salary: number }, payPeriod: string) {
    const target = savedPayrollPeriod(payPeriod);
    if (!target || !equalHalfCutoffAccrualEnabled(payPeriod)) return null;
    const { getSystemSettings } = await import("../controllers/systemSettingsController");
    const { currentPeriod, isConfiguredPayrollPeriod, payrollCalculationContext } = await import("../controllers/payrollController");
    const { hubDayKey } = await import("./attendanceHubMath");
    const settings = await getSystemSettings(), current = savedPayrollPeriod(currentPeriod(settings.payrollBillingCycle, settings));
    if (!current || target.start <= current.start) return null;
    const records = await PayrollRecord.find({ employeeId: employee.employeeCode }).lean();
    const samePeriod = (label: string, range: NonNullable<ReturnType<typeof savedPayrollPeriod>>) => {
        const parsed = savedPayrollPeriod(label);
        return parsed?.start === range.start && parsed.end === range.end;
    };
    if (records.some(record => samePeriod(record.payPeriod, target))) throw new PayrollValidationError("A saved future cutoff needs review; no replacement preview was calculated.");
    const established = records.filter(record => samePeriod(record.payPeriod, current));
    if (established.length !== 1 || established[0].isArchived || established[0].calculationSnapshot?.inheritedPayrollInputs !== true) return null;
    const source = established[0], business = getCurrentBusinessId(), membership = source.calculationSnapshot?.businessIds;
    if (!Array.isArray(membership) || !membership.includes(business) || !membership.includes(source.payrollOwnerBusinessId)) throw new PayrollValidationError("Shared future payroll membership needs review.");
    const inherited = await inheritedCurrentPayrollInputs(source);
    if (!inherited || !getBusinessById(inherited.owner)) throw new PayrollValidationError("The verified future payroll owner is unavailable.");
    const localPeople = await Employee.find({ employeeCode: employee.employeeCode, status: { $ne: "Archived" } }).select("_id salary").limit(2).lean();
    if (localPeople.length !== 1 || String(localPeople[0]._id) !== String(employee._id) || localPeople[0].salary !== employee.salary) throw new PayrollValidationError("The future payroll employee identity needs review.");
    const verified = await runWithBusiness(inherited.owner, async () => {
        const people = await Employee.find({ employeeCode: employee.employeeCode, status: { $ne: "Archived" } }).limit(2).lean();
        if (people.length !== 1) throw new PayrollValidationError("The future payroll owner employee is unavailable.");
        if (people[0].salary !== employee.salary) throw new PayrollValidationError("Shared future payroll salaries differ.");
        const ownerRecords = await PayrollRecord.find({ employeeId: employee.employeeCode }).lean();
        if (ownerRecords.some(record => samePeriod(record.payPeriod, target))) throw new PayrollValidationError("A saved owner cutoff exists; shared future payroll needs review.");
        const ownerCurrent = ownerRecords.filter(record => samePeriod(record.payPeriod, current));
        if (ownerCurrent.length !== 1 || ownerCurrent[0].isArchived || ownerCurrent[0].payrollOwnerBusinessId !== inherited.owner ||
            !Array.isArray(ownerCurrent[0].calculationSnapshot?.businessIds) || !ownerCurrent[0].calculationSnapshot.businessIds.includes(business)) {
            throw new PayrollValidationError("The established future payroll owner needs review.");
        }
        const context = await payrollCalculationContext();
        if (context.settings.payrollBillingCycle !== "Semi-monthly" || !isConfiguredPayrollPeriod(payPeriod, context.settings)) throw new PayrollValidationError("Choose a complete configured future payroll cutoff.");
        return { employee: people[0], settings: context.settings };
    });
    const localEvidence = await Attendance.find({ employee: employee._id, isArchived: false,
        timeIn: { $gte: new Date(Date.parse(target.start) - 86_400_000), $lt: new Date(Date.parse(target.end) + 2 * 86_400_000) } }).select("timeIn").lean();
    if (localEvidence.some(row => { const day = hubDayKey(row.timeIn, verified.settings); return day >= target.start && day <= target.end; })) {
        throw new PayrollValidationError("Local future attendance needs review before sharing payroll inputs.");
    }
    return { owner: inherited.owner, employee: verified.employee };
}
