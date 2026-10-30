export type SavedDeductionSource = {
    calculationVersion?: string;
    minuteRate?: number | null;
    hourlyRate?: number | null;
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
    ] : record.calculationVersion === "earned-hours-late-rest-v1" ? [
        { label: "Late", minutes: record.lateMinutes ?? Math.round((record.lateHours ?? 0) * 60) },
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

export type PayrollDeductionDisplayRow = { label: string; minutes: number; amount: number | null; informationalAmount?: number; note?: string };

// Earned pay already omits unworked time; keep it visible without allocating the deduction total to it again.
export function payrollDeductionDisplayRows(record: SavedDeductionSource): PayrollDeductionDisplayRow[] {
    const charged = payrollDeductionRows(record);
    const lateAndRest = record.calculationVersion === "earned-hours-late-rest-v1";
    if (record.calculationVersion !== "earned-hours-v1" && !lateAndRest) return charged;
    const note = record.workedMinutesOverride !== null && record.workedMinutesOverride !== undefined
        ? "Paid hours manually adjusted" : undefined;
    const rate = record.minuteRate ?? (record.hourlyRate == null ? undefined : record.hourlyRate / 60);
    const attendance = (label: string, minutes: number): PayrollDeductionDisplayRow => {
        const reference = ["Undertime", "Absence"].includes(label) && Number.isSafeInteger(minutes) && minutes >= 0 &&
            typeof rate === "number" && Number.isFinite(rate) && rate >= 0 ? Math.round((minutes * rate + Number.EPSILON) * 100) / 100 : undefined;
        return { label, minutes, amount: null, ...(reference !== undefined && Number.isFinite(reference) ? { informationalAmount: reference } : {}),
            ...(note ? { note } : {}) };
    };
    return [
        ...(lateAndRest ? charged.filter(row => row.label === "Late") : [attendance("Late", record.lateMinutes ?? Math.round((record.lateHours ?? 0) * 60))]),
        ...charged.filter(row => ["Excess lunch", "Excess break"].includes(row.label)),
        attendance("Undertime", record.earlyTimeOutMinutes ?? 0),
        attendance("Absence", record.absenceMinutes ?? 0),
        ...charged.filter(row => !["Late", "Excess lunch", "Excess break"].includes(row.label)),
    ];
}

// Reference values belong to the displayed total, never to the saved cash deduction field.
export function payrollDeductionDisplayTotal(record: SavedDeductionSource): number | null {
    if (!Number.isFinite(record.deductions) || record.deductions < 0) return null;
    let cents = Math.round(record.deductions * 100);
    for (const row of payrollDeductionDisplayRows(record)) {
        if (row.amount !== null || !["Undertime", "Absence"].includes(row.label)) continue;
        if (row.informationalAmount === undefined) { if (row.minutes > 0) return null; continue; }
        cents += Math.round(row.informationalAmount * 100);
    }
    return Number.isSafeInteger(cents) ? cents / 100 : null;
}
