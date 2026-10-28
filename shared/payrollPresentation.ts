export type SavedDeductionSource = {
    calculationVersion?: string;
    deductions: number;
    lateMinutes?: number;
    lateHours?: number;
    excessLunchMinutes?: number;
    excessBreakMinutes?: number;
    nonBillableOffPhoneMinutes?: number;
    earlyTimeOutMinutes?: number;
    absenceMinutes?: number;
    workedMinutesOverride?: number | null;
    scheduledHours?: number | null;
};

export function payrollDeductionRows(record: SavedDeductionSource) {
    const rows = record.calculationVersion === "earned-hours-v1" ? [
        { label: "Excess lunch", minutes: record.excessLunchMinutes ?? 0 },
        { label: "Excess break", minutes: record.excessBreakMinutes ?? 0 },
    ] : record.calculationVersion !== "earned-hours-all-deductions-v1" && record.workedMinutesOverride !== null && record.workedMinutesOverride !== undefined ? [
        { label: "Adjusted time shortfall", minutes: Math.max(0, Math.round((record.scheduledHours ?? 0) * 60) - record.workedMinutesOverride - (record.nonBillableOffPhoneMinutes ?? 0)) },
        { label: "Excess lunch", minutes: record.excessLunchMinutes ?? 0 },
        { label: "Excess break", minutes: record.excessBreakMinutes ?? 0 },
    ] : [
        { label: "Late", minutes: record.lateMinutes ?? Math.round((record.lateHours ?? 0) * 60) },
        { label: "Excess lunch", minutes: record.excessLunchMinutes ?? 0 },
        { label: "Excess break", minutes: record.excessBreakMinutes ?? 0 },
        { label: "Undertime", minutes: record.earlyTimeOutMinutes ?? 0 },
        { label: "Absence", minutes: record.absenceMinutes ?? 0 },
    ];
    rows.push({ label: "Non-billable Off the Phone", minutes: record.nonBillableOffPhoneMinutes ?? 0 });
    const totalMinutes = rows.reduce((sum, row) => sum + row.minutes, 0);
    const cents = Math.round(record.deductions * 100);
    if (!totalMinutes) return [...rows.map(row => ({ ...row, amount: 0 })), ...(cents ? [{ label: "Other saved deductions", minutes: 0, amount: cents / 100 }] : [])];
    // Apportion the saved total in cents; presentation never recalculates payroll.
    const shares = rows.map((row, index) => ({ index, exact: cents * row.minutes / totalMinutes }));
    const allocated = shares.map(share => Math.floor(share.exact));
    const remainder = cents - allocated.reduce((sum, amount) => sum + amount, 0);
    shares.sort((a, b) => (b.exact - Math.floor(b.exact)) - (a.exact - Math.floor(a.exact)) || a.index - b.index);
    for (let index = 0; index < remainder; index++) allocated[shares[index].index]++;
    return rows.map((row, index) => ({ ...row, amount: allocated[index] / 100 }));
}

export type PayrollDeductionDisplayRow = { label: string; minutes: number; amount: number | null; note?: string };

// Earned pay already omits unworked time; keep it visible without allocating the deduction total to it again.
export function payrollDeductionDisplayRows(record: SavedDeductionSource): PayrollDeductionDisplayRow[] {
    const charged = payrollDeductionRows(record);
    if (record.calculationVersion !== "earned-hours-v1") return charged;
    const note = record.workedMinutesOverride !== null && record.workedMinutesOverride !== undefined
        ? "Paid hours manually adjusted" : "Already excluded from earned pay";
    const attendance = (label: string, minutes: number): PayrollDeductionDisplayRow => ({ label, minutes, amount: null, note });
    return [
        attendance("Late", record.lateMinutes ?? Math.round((record.lateHours ?? 0) * 60)),
        ...charged.filter(row => ["Excess lunch", "Excess break"].includes(row.label)),
        attendance("Undertime", record.earlyTimeOutMinutes ?? 0),
        attendance("Absence", record.absenceMinutes ?? 0),
        ...charged.filter(row => !["Excess lunch", "Excess break"].includes(row.label)),
    ];
}
