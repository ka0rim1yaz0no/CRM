import { savedPayrollPeriod } from "../../../shared/payrollPeriod";

type SavedPayroll = { _id: unknown; employeeId: string; payPeriod: string; grossPay: number; deductions: number; netPay: number; status: string };
const detailFields = ["basicPay", "minuteRate", "hourlyRate", "paidHoursPerDay", "workingDays", "attendanceDays", "absentDays", "workedHours",
    "scheduledHours", "workedMinutesOverride", "overtimeHours", "overtimeApproved", "deductibleMinutes", "incompleteShiftDays", "paidOn"];
const minuteFields = ["excessLunchMinutes", "excessBreakMinutes", "earlyTimeOutMinutes", "absenceMinutes"];
function signature(record: SavedPayroll) {
    const fields = record as SavedPayroll & Record<string, unknown>;
    return JSON.stringify([record.grossPay, record.deductions, record.netPay, record.status,
        fields.lateMinutes ?? Math.round(Number(fields.lateHours || 0) * 60), ...minuteFields.map(key => fields[key] ?? 0),
        ...detailFields.map(key => fields[key] ?? null)]);
}

function validAmounts(record: SavedPayroll) {
    return [record.grossPay, record.deductions, record.netPay].every(value => typeof value === "number" && Number.isFinite(value) && value >= 0 && Number.isSafeInteger(Math.round(value * 100))) &&
        Math.round(record.grossPay * 100) - Math.round(record.deductions * 100) === Math.round(record.netPay * 100);
}

export function payrollReadGroups<T extends SavedPayroll>(records: T[]) {
    const groups = new Map<string, { period: NonNullable<ReturnType<typeof savedPayrollPeriod>>; records: T[] }>();
    const unknown: T[] = [];
    for (const record of records) {
        const period = savedPayrollPeriod(record.payPeriod);
        if (!period) { unknown.push(record); continue; }
        const key = JSON.stringify([record.employeeId, period.start, period.end]);
        const group = groups.get(key) || { period, records: [] }; group.records.push(record); groups.set(key, group);
    }
    return { unknown, groups: [...groups.values()].map(group => {
        const canonical = group.records.filter(record => record.payPeriod.trim() === group.period.label);
        const conflicting = new Set(group.records.map(signature)).size > 1;
        // Preserve the unique record already selected by Admin Payroll. Never prefer Paid, latest, or a larger amount.
        const selected = group.records.length === 1 ? group.records[0] : canonical.length === 1 ? canonical[0]
            : !conflicting ? [...group.records].sort((a, b) => String(a._id).localeCompare(String(b._id)))[0] : null;
        const record = selected && validAmounts(selected) ? selected : null;
        return { ...group, record, requiresReview: conflicting || record === null };
    }) };
}
