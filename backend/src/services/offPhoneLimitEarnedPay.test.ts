import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { offPhoneNonBillableAt, offPhoneShiftBilling, nonBillableOffPhoneIntervals } from "../../../shared/attendanceOffPhone";
import { earnedPayrollTime } from "./payrollEarnedTime";
import { deriveAttendanceDays } from "./attendanceDerived";
import { attendanceSnapshot } from "./attendanceLedgerService";
import { assignAttendanceShift } from "./attendanceShift";
import { adjustedPayrollHours } from "../../../shared/payrollWorkedHours";
import { payrollDeductionRows } from "../../../shared/payrollPresentation";
import type { AttendanceLedgerDocument } from "../models/AttendanceLedger";
import { accuratePayrollDay } from "./payrollAccuracy";
import { currentEarnedPayrollRecords } from "./payrollEarningsRead";
import { earnedPayrollVersion } from "../config/payrollEarnings";
import { coachingShiftBilling } from "../../../shared/attendanceCoaching";

const start = new Date("2026-10-26T15:00:00Z"), end = new Date("2026-10-27T00:00:00Z");
const at = (minutes: number) => new Date(+start + minutes * 60_000);
const record = (source: string, minutes: number) => ({ source, timeIn: at(minutes) });
const limit = { paidMinutes: 20, effectiveFrom: start.toISOString() };
const policy = { shiftStart: start, shiftEnd: end, breakMinutes: 15, lunchMinutes: 60, graceMinutes: 0 };
const previousLimit = process.env.CRM_OFF_PHONE_PAID_LIMIT_FROM;
afterEach(() => { if (previousLimit === undefined) delete process.env.CRM_OFF_PHONE_PAID_LIMIT_FROM; else process.env.CRM_OFF_PHONE_PAID_LIMIT_FROM = previousLimit; });

test("Coaching has a separate twenty-minute shift budget and can never become non-billable", () => {
    const rows = [record("Time In", 0), record("Coaching Out", 10), record("Coaching In", 20),
        record("Off the Phone Out", 30), record("Off the Phone In", 45), record("Time Out", 50),
        record("Time In", 60), record("Coaching Out", 70)];
    const original = structuredClone(rows);
    const current = coachingShiftBilling(rows, start, end, at(75));
    assert.equal(current.remainingPaidMs, 5 * 60_000);
    assert.equal(current.active?.returnAt, at(80).toISOString());
    assert.equal(offPhoneShiftBilling(rows, start, end, at(75), limit).remainingPaidMs, 5 * 60_000);
    for (const now of [at(80), at(81), at(90), end, at(600)]) {
        const view = coachingShiftBilling(rows, start, end, now);
        assert.equal(view.totalMs, 20 * 60_000);
        assert.equal(view.remainingPaidMs, 0);
        assert.equal(view.active?.returnAt, at(80).toISOString());
        assert.deepEqual(nonBillableOffPhoneIntervals(rows, start, end, now, limit), []);
    }
    assert.equal(coachingShiftBilling(rows, at(1440), at(1980), at(1450)).remainingPaidMs, 20 * 60_000);
    assert.deepEqual(rows, original);
});

test("Coaching remains paid in earned payroll and an overdue server return does not create a deduction", () => {
    process.env.CRM_OFF_PHONE_PAID_LIMIT_FROM = limit.effectiveFrom;
    for (let business = 0; business < 6; business++) {
        const rows = [record("Time In", 0), record("Coaching Out", 10), record("Coaching In", 35), record("Time Out", 60)];
        const earned = earnedPayrollTime(rows, policy, end, 8);
        assert.equal(earned.grossHours, 1);
        assert.equal(earned.nonBillableOffPhoneMinutes, 0);
        assert.equal(earned.workedHours, 1);
        assert.equal(earned.deductibleMinutes, 0);
    }
    const nearEnd = coachingShiftBilling([record("Time In", 0), record("Coaching Out", 535)], start, end, at(545));
    assert.equal(nearEnd.totalMs, 5 * 60_000);
    assert.equal(nearEnd.active?.returnAt, end.toISOString());
});

test("the twenty-minute limit is shared across every normal off-phone episode in a shift", () => {
    const records = [record("Time In", 0), record("Off the Phone Out", 60), record("Off the Phone In", 70),
        record("Off the Phone Out", 100), record("Off the Phone In", 110), record("Off the Phone Out", 120)];
    assert.equal(offPhoneShiftBilling(records, start, end, at(120), limit).remainingPaidMs, 0);
    const active = offPhoneShiftBilling(records, start, end, at(120), limit);
    assert.ok(offPhoneNonBillableAt(active, +at(120)));
    assert.equal(nonBillableOffPhoneIntervals(records, start, end, at(120), limit).reduce((sum, row) => sum + row.minutes, 0), 0);
    assert.equal(nonBillableOffPhoneIntervals(records, start, end, new Date(+at(120) + 1), limit)[0].minutes, 1);
    assert.equal(nonBillableOffPhoneIntervals(records, start, end, at(121), limit)[0].minutes, 1);
    assert.equal(nonBillableOffPhoneIntervals(records, start, end, new Date(+at(121) + 1), limit)[0].minutes, 2);
});

test("exact twenty minutes is free; a second beyond it starts one rounded-up deduction minute", () => {
    const records = [record("Time In", 0), record("Off the Phone Out", 30)];
    assert.equal(offPhoneShiftBilling(records, start, end, at(50), limit).intervals.length, 0);
    const billed = offPhoneShiftBilling(records, start, end, new Date(+at(50) + 1000), limit);
    assert.deepEqual(billed.intervals.map(row => [row.minutes, row.milliseconds, row.automatic]), [[1, 1000, true]]);
    assert.equal(billed.active?.nonBillableFrom, at(50).toISOString());
    assert.equal(offPhoneNonBillableAt(billed, +end), false, "a cached live view must stop showing accrual at shift end");
});

test("checkout and repeated Time In do not replenish the assigned shift budget, and the next shift gets its own", () => {
    const records = [record("Time In", 0), record("Off the Phone Out", 30), record("Off the Phone In", 45), record("Time Out", 60),
        record("Time In", 120), record("Off the Phone Out", 130), record("Off the Phone In", 136)];
    assert.equal(offPhoneShiftBilling(records, start, end, at(200), limit).intervals[0].minutes, 1);
    assert.equal(offPhoneShiftBilling([], at(1440), at(1980), at(1450), limit).remainingPaidMs, 20 * 60_000);
    const original = structuredClone(records); offPhoneShiftBilling(records, start, end, end, limit); assert.deepEqual(records, original);
});

test("manual non-billable time charges immediately but does not consume the paid allowance", () => {
    const rows = [record("Non-Billable Off the Phone Out", 10), record("Off the Phone In", 15), record("Off the Phone Out", 60)];
    const view = offPhoneShiftBilling(rows, start, end, at(70), limit);
    assert.equal(view.paidUsedMs, 10 * 60_000); assert.equal(view.intervals[0].minutes, 5);
    assert.equal(view.active?.nonBillableFrom, at(80).toISOString());
});

test("the automatic limit clips to its own shift and never retroactively converts older shifts", () => {
    const rows = [record("Off the Phone Out", -30), record("Off the Phone In", 30), record("Off the Phone Out", 530), record("Time Out", 545)];
    assert.deepEqual(offPhoneShiftBilling(rows, start, end, at(600), limit).intervals.map(row => row.minutes), [10, 10]);
    assert.equal(offPhoneShiftBilling(rows, start, end, at(600), { ...limit, effectiveFrom: at(1).toISOString() }).intervals.length, 0);
    assert.equal(offPhoneShiftBilling(rows, start, end, at(600)).intervals.length, 0);
});

test("canonical derived attendance and refresh snapshots retain one budget across multiple Time In sessions", () => {
    process.env.CRM_OFF_PHONE_PAID_LIMIT_FROM = limit.effectiveFrom;
    const rows = [record("Time In", 0), record("Off the Phone Out", 30), record("Off the Phone In", 45), record("Time Out", 60),
        record("Time In", 120), record("Off the Phone Out", 130)];
    const events = rows.map((row, sequence) => ({ id: `event-${sequence}`, commandId: `command-${sequence}`, sequence,
        source: row.source, at: row.timeIn.toISOString(), recordedAt: row.timeIn.toISOString(),
        ...(row.source === "Time In" ? { shift: assignAttendanceShift(row.timeIn) } : {}) })) as AttendanceLedgerDocument["events"];
    const ledger = { events, corrections: [], closures: [], audit: [], jobs: [], revision: 1 } as unknown as AttendanceLedgerDocument;
    for (let business = 0; business < 6; business++) {
        const snap = attendanceSnapshot(ledger, at(136));
        assert.equal(snap.offPhoneBilling?.remainingPaidMs, 0);
        assert.equal(snap.offPhoneBilling?.active?.nonBillableFrom, at(135).toISOString());
        assert.equal(deriveAttendanceDays(ledger, { ...policy, shiftStart: "23:00", shiftEnd: "08:00" }, at(136))[0].nonBillableOffPhoneMinutes, 1);
    }
});

test("earned hours include only time actually attended, never future shift hours or a full salary", () => {
    assert.equal(earnedPayrollTime([], policy, at(60), 8).grossHours, 0);
    assert.equal(earnedPayrollTime([record("Time In", 0)], policy, at(60), 8).workedHours, 1);
    assert.equal(earnedPayrollTime([record("Time In", 60), record("Time Out", 120)], policy, end, 8).workedHours, 1);
    assert.equal(earnedPayrollTime([record("Time In", 0), record("Time Out", 540)], policy, end, 8).workedHours, 8);
});

test("taken lunch allowance and excess rest are excluded once, not twice", () => {
    const rows = [record("Time In", 0), record("Break Out", 60), record("Break In", 76), record("Lunch Break Out", 180),
        record("Lunch Break In", 241), record("Time Out", 540)];
    const earned = earnedPayrollTime(rows, policy, end, 8);
    assert.equal(earned.grossHours, 8); assert.equal(earned.deductibleMinutes, 2); assert.equal(earned.workedHours, 8 - 2 / 60);
    const open = earnedPayrollTime(rows.slice(0, 4), policy, at(241), 8);
    assert.equal(open.excessLunchMinutes, 1);
    assert.equal(open.excessBreakMinutes, 1);
});

test("non-billable excess reduces earned hours once and never makes pay negative", () => {
    process.env.CRM_OFF_PHONE_PAID_LIMIT_FROM = limit.effectiveFrom;
    const rows = [record("Time In", 0), record("Off the Phone Out", 10), record("Off the Phone In", 35), record("Time Out", 60)];
    const earned = earnedPayrollTime(rows, policy, end, 8);
    assert.equal(earned.grossHours, 1); assert.equal(earned.nonBillableOffPhoneMinutes, 5); assert.equal(earned.workedHours, 55 / 60);
    const tiny = earnedPayrollTime([record("Time In", 0), record("Non-Billable Off the Phone Out", 0)], policy, new Date(+start + 1000), 8);
    assert.equal(tiny.workedHours, 0);
});

test("earned Edit Hours and deduction presentation do not re-charge lateness, absence or non-billable minutes", () => {
    const basis = { calculationVersion: "earned-hours-v1", scheduledHours: 8, excessBreakMinutes: 1, excessLunchMinutes: 1, nonBillableOffPhoneMinutes: 5 };
    const adjusted = adjustedPayrollHours(basis, 413);
    assert.equal(adjusted.deductibleMinutes, 7); assert.equal(adjusted.earnedGrossHours, 7); assert.equal(adjusted.workedHours, 413 / 60);
    assert.throws(() => adjustedPayrollHours(basis, 480), /exceed/);
    const rows = payrollDeductionRows({ ...basis, deductions: 14, lateMinutes: 60, earlyTimeOutMinutes: 120, absenceMinutes: 480 });
    assert.equal(rows.reduce((sum, row) => sum + row.minutes, 0), 7); assert.equal(rows.reduce((sum, row) => sum + row.amount, 0), 14);
    assert.ok(!rows.some(row => ["Late", "Absence", "Undertime"].includes(row.label)));
});

test("approved all-deductions basis includes late, early departure, excess rest and non-billable time once", () => {
    process.env.CRM_OFF_PHONE_PAID_LIMIT_FROM = limit.effectiveFrom;
    const rows = [record("Time In", 10), record("Break Out", 60), record("Break In", 76),
        record("Lunch Break Out", 180), record("Lunch Break In", 241), record("Off the Phone Out", 300),
        record("Off the Phone In", 326), record("Time Out", 530)];
    const prior = earnedPayrollTime(rows, policy, end, 8);
    const approved = earnedPayrollTime(rows, policy, end, 8, true);
    assert.equal(approved.grossHours, 460 / 60); assert.equal(approved.workedHours, prior.workedHours);
    assert.equal(approved.lateMinutes, 10); assert.equal(approved.earlyTimeOutMinutes, 10);
    assert.equal(approved.excessBreakMinutes, 1); assert.equal(approved.excessLunchMinutes, 1);
    assert.equal(approved.nonBillableOffPhoneMinutes, 6); assert.equal(approved.deductibleMinutes, 28);
    const lines = payrollDeductionRows({ ...approved, calculationVersion: "earned-hours-all-deductions-v1", deductions: 28 });
    assert.equal(lines.reduce((sum, row) => sum + row.amount, 0), 28);
    for (const label of ["Late", "Undertime", "Excess break", "Excess lunch", "Non-billable Off the Phone"]) assert.ok(lines.find(row => row.label === label)!.amount > 0);
});

test("all-deductions charges absence only after a completed scheduled shift and undertime only after checkout", context => {
    const previous = process.env.CRM_ATTENDANCE_ACCURACY_FIXES;
    process.env.CRM_ATTENDANCE_ACCURACY_FIXES = "true";
    context.after(() => { if (previous === undefined) delete process.env.CRM_ATTENDANCE_ACCURACY_FIXES; else process.env.CRM_ATTENDANCE_ACCURACY_FIXES = previous; });
    assert.equal(earnedPayrollTime([], policy, at(100), 8, true).absenceMinutes, 0);
    assert.equal(earnedPayrollTime([], policy, end, 8, true).absenceMinutes, 480);
    assert.equal(earnedPayrollTime([record("Time In", 10)], policy, at(100), 8, true).earlyTimeOutMinutes, 0);
    assert.equal(earnedPayrollTime([record("Time In", 10), record("Time Out", 100)], policy, at(101), 8, true).earlyTimeOutMinutes, 440);
    assert.equal(accuratePayrollDay([], policy, end, 8, true, false, true).earned.absenceMinutes, 0);
});

test("new earned Edit Hours preserves physical paid hours and subtracts approved shortfall charges separately", () => {
    const adjusted = adjustedPayrollHours({ scheduledHours: 8, calculationVersion: "earned-hours-all-deductions-v1",
        excessBreakMinutes: 1, excessLunchMinutes: 1, nonBillableOffPhoneMinutes: 5,
        lateMinutes: 10, earlyTimeOutMinutes: 20, absenceMinutes: 0 }, 420);
    assert.equal(adjusted.workedHours, 7); assert.equal(adjusted.earnedGrossHours, 427 / 60);
    assert.equal(adjusted.deductibleMinutes, 37);
    assert.equal(Math.round(adjusted.earnedGrossHours! * 60) - adjusted.deductibleMinutes, 390);
});

test("paid and completed saved payrolls stay frozen when the additional deduction policy is enabled", async () => {
    const previousEarned = process.env.CRM_EARNED_PAYROLL_FROM, previousAll = process.env.CRM_EARNED_ALL_DEDUCTIONS_FROM;
    try {
        process.env.CRM_EARNED_PAYROLL_FROM = "2026-10-21"; process.env.CRM_EARNED_ALL_DEDUCTIONS_FROM = "2026-10-21";
        for (const status of ["Paid", "Completed"]) {
            const record = { employeeId: "synthetic-paid", payPeriod: "Oct 21, 2026 - Nov 5, 2026", status,
                grossPay: 1000, deductions: 25, netPay: 975, paidOn: "Oct 28, 2026", calculationVersion: "earned-hours-v1" };
            const original = structuredClone(record);
            assert.deepEqual((await currentEarnedPayrollRecords([record], record.payPeriod))[0], original);
        }
    } finally {
        if (previousEarned === undefined) delete process.env.CRM_EARNED_PAYROLL_FROM; else process.env.CRM_EARNED_PAYROLL_FROM = previousEarned;
        if (previousAll === undefined) delete process.env.CRM_EARNED_ALL_DEDUCTIONS_FROM; else process.env.CRM_EARNED_ALL_DEDUCTIONS_FROM = previousAll;
    }
});

test("excluding undertime and absence preserves attended hours and the Late, Break, Lunch and non-billable charges", () => {
    process.env.CRM_OFF_PHONE_PAID_LIMIT_FROM = limit.effectiveFrom;
    const rows = [record("Time In", 10), record("Break Out", 60), record("Break In", 76), record("Lunch Break Out", 180),
        record("Lunch Break In", 241), record("Off the Phone Out", 300), record("Off the Phone In", 326), record("Time Out", 530)];
    const old = earnedPayrollTime(rows, policy, end, 8, true), value = earnedPayrollTime(rows, policy, end, 8, true, true);
    assert.equal(value.grossHours, old.grossHours); assert.equal(value.workedHours, old.workedHours);
    assert.equal(value.lateMinutes, 10); assert.equal(value.earlyTimeOutMinutes, 10);
    assert.equal(value.deductibleMinutes, 18);
    assert.equal(value.deductibleMinutes, value.lateMinutes + value.excessBreakMinutes + value.excessLunchMinutes + value.nonBillableOffPhoneMinutes);
    const absent = earnedPayrollTime([], policy, end, 8, true, true);
    assert.equal(absent.absenceMinutes, 480); assert.equal(absent.deductibleMinutes, 0); assert.equal(absent.grossHours, 0);
});

test("the late-and-rest earned version never allocates cash to undertime or absence, including Edit Hours", () => {
    const basis = { calculationVersion: "earned-hours-late-rest-v1", scheduledHours: 24, excessBreakMinutes: 1, excessLunchMinutes: 1,
        nonBillableOffPhoneMinutes: 5, lateMinutes: 10, earlyTimeOutMinutes: 120, absenceMinutes: 480 };
    const value = adjustedPayrollHours(basis, 420);
    assert.equal(value.workedHours, 7); assert.equal(value.earnedGrossHours, 427 / 60); assert.equal(value.deductibleMinutes, 17);
    const rows = payrollDeductionRows({ ...basis, deductions: 13.59 });
    assert.equal(rows.length, 4); assert.ok(!rows.some(row => ["Undertime", "Absence"].includes(row.label)));
    assert.equal(rows.reduce((sum, row) => sum + Math.round(row.amount * 100), 0), 1359);
    assert.equal(rows.find(row => row.label === "Late")!.minutes, 10);
    assert.throws(() => adjustedPayrollHours({ ...basis, lateMinutes: -1 }, 420), /shortfall/);
});

test("the exclusion policy is cutoff-scoped and leaves older earned versions unchanged until opted in", () => {
    const names = ["CRM_EARNED_PAYROLL_FROM", "CRM_EARNED_ALL_DEDUCTIONS_FROM", "CRM_EARNED_EXCLUDE_UNDERTIME_ABSENCE_FROM"];
    const prior = names.map(name => process.env[name]);
    try {
        process.env.CRM_EARNED_PAYROLL_FROM = "2026-10-06"; process.env.CRM_EARNED_ALL_DEDUCTIONS_FROM = "2026-10-06";
        delete process.env.CRM_EARNED_EXCLUDE_UNDERTIME_ABSENCE_FROM;
        assert.equal(earnedPayrollVersion("Oct 21, 2026 - Nov 5, 2026"), "earned-hours-all-deductions-v1");
        process.env.CRM_EARNED_EXCLUDE_UNDERTIME_ABSENCE_FROM = "2026-10-21";
        assert.equal(earnedPayrollVersion("Oct 6, 2026 - Oct 20, 2026"), "earned-hours-all-deductions-v1");
        assert.equal(earnedPayrollVersion("Oct 21, 2026 - Nov 5, 2026"), "earned-hours-late-rest-v1");
        assert.equal(earnedPayrollVersion("Nov 6, 2026 - Nov 20, 2026"), "earned-hours-late-rest-v1");
        process.env.CRM_EARNED_EXCLUDE_UNDERTIME_ABSENCE_FROM = "invalid";
        assert.throws(() => earnedPayrollVersion("Oct 21, 2026 - Nov 5, 2026"), /exclusion cutoff/);
    } finally { names.forEach((name, index) => { if (prior[index] === undefined) delete process.env[name]; else process.env[name] = prior[index]; }); }
});

test("paid and completed all-deductions payrolls retain their original amounts and six cash categories after the new exclusion", async () => {
    const names = ["CRM_EARNED_PAYROLL_FROM", "CRM_EARNED_ALL_DEDUCTIONS_FROM", "CRM_EARNED_EXCLUDE_UNDERTIME_ABSENCE_FROM"];
    const prior = names.map(name => process.env[name]);
    try {
        for (const name of names) process.env[name] = "2026-10-21";
        for (const status of ["Paid", "Completed"]) {
            const record = { employeeId: "synthetic-frozen", payPeriod: "Oct 21, 2026 - Nov 5, 2026", status,
                grossPay: 1000, deductions: 100, netPay: 900, paidOn: "Oct 28, 2026", calculationVersion: "earned-hours-all-deductions-v1",
                lateMinutes: 1, earlyTimeOutMinutes: 1, absenceMinutes: 480, excessBreakMinutes: 1, excessLunchMinutes: 1, nonBillableOffPhoneMinutes: 1 };
            const original = structuredClone(record), shown = (await currentEarnedPayrollRecords([record], record.payPeriod))[0];
            assert.deepEqual(shown, original); assert.equal(payrollDeductionRows(shown).length, 6);
        }
    } finally { names.forEach((name, index) => { if (prior[index] === undefined) delete process.env[name]; else process.env[name] = prior[index]; }); }
});
