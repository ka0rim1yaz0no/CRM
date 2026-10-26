import assert from "node:assert/strict";
import test from "node:test";
import { nonBillableOffPhoneIntervals, nonBillableOffPhoneSource as outgoing } from "../../../shared/attendanceOffPhone";
import { adjustedPayrollHours } from "../../../shared/payrollWorkedHours";
import { payrollDeductionRows } from "../../../shared/payrollPresentation";
import { accuratePayrollDay } from "./payrollAccuracy";
import { calculateSlotAttendance } from "./timeAccounting";
import { attendanceUndoPlan } from "../../../src/lib/attendanceUndo";
import { missingTimeOutChanges } from "../../../src/lib/attendanceMissingTimeOut";
import type { AttendanceSessionSnapshot } from "../../../src/api/attendanceSession";
import { auditAttendance } from "./dataCheckMath";
import { callDashboardStatus } from "./callDashboardService";

const start = new Date("2026-10-19T15:00:00Z"), end = new Date("2026-10-20T00:00:00Z");
const at = (seconds: number) => new Date(+start + seconds * 1000);
const record = (source: string, seconds: number) => ({ source, timeIn: at(seconds) });
const policy = { shiftStart: start, shiftEnd: end, graceMinutes: 0, breakMinutes: 15, lunchMinutes: 60 };

test("non-billable minutes round each interval up, have no allowance and never charge normal off-phone", () => {
    for (const [seconds, expected] of [[0, 0], [1, 1], [60, 1], [61, 2], [900, 15], [901, 16]]) {
        const records = [record("Time In", 0), record(outgoing, 100), record("Off the Phone In", 100 + seconds), record("Time Out", 32400)];
        const day = calculateSlotAttendance(records, policy, end);
        assert.equal(day.nonBillableOffPhoneMinutes, expected);
        assert.equal(day.deductibleMinutes, expected);
        const paid = calculateSlotAttendance(records.map(item => item.source === outgoing ? { ...item, source: "Off the Phone Out" } : item), policy, end);
        assert.equal(paid.nonBillableOffPhoneMinutes, 0); assert.equal(paid.deductibleMinutes, 0);
    }
});

test("only actual in-shift non-billable time is charged, including overnight checkout and current accrued time", () => {
    const records = [record("Time In", -60), record(outgoing, -30), record("Off the Phone In", 30), record(outgoing, 32100), record("Time Out", 32700)];
    const intervals = nonBillableOffPhoneIntervals(records, start, end, at(33000));
    assert.deepEqual(intervals.map(item => item.minutes), [1, 5]);
    assert.equal(intervals.reduce((sum, item) => sum + item.milliseconds, 0), 330000);
    assert.equal(nonBillableOffPhoneIntervals([record(outgoing, 100)], start, end, at(161))[0].minutes, 2);
    assert.equal(nonBillableOffPhoneIntervals([record(outgoing, 32500)], start, end, at(33000))[0].minutes, 0);
});

test("attendance-based pay includes non-billable time once and weekend overtime excludes it", () => {
    const previous = process.env.CRM_PAYROLL_ACCURACY; process.env.CRM_PAYROLL_ACCURACY = "true";
    try {
        const records = [record("Time In", 0), record(outgoing, 3600), record("Off the Phone In", 4201), record("Time Out", 32400)];
        const day = accuratePayrollDay(records, policy, end, 8, false);
        assert.equal(day.review, false); assert.equal(day.components.nonBillableOffPhoneMinutes, 11);
        assert.equal(day.components.deductibleMinutes, 11); assert.equal(day.regularHours, 8 - 11 / 60);
        const weekend = accuratePayrollDay(records, policy, end, 8, true);
        assert.equal(weekend.overtimeHours, 9 - 11 / 60); assert.equal(weekend.components.deductibleMinutes, 0);
        const extended = [record("Time In", 0), record(outgoing, 32460), record("Off the Phone In", 32521), record("Time Out", 36000)];
        assert.equal(accuratePayrollDay(extended, policy, at(36000), 8, true).overtimeHours, 10 - 2 / 60);
    } finally { if (previous === undefined) delete process.env.CRM_PAYROLL_ACCURACY; else process.env.CRM_PAYROLL_ACCURACY = previous; }
});

test("Edit Hours cannot charge the same non-billable shortfall twice or silently remove it", () => {
    const basis = { scheduledHours: 8, excessBreakMinutes: 0, excessLunchMinutes: 0, nonBillableOffPhoneMinutes: 10 };
    assert.equal(adjustedPayrollHours(basis, 470).deductibleMinutes, 10);
    assert.equal(adjustedPayrollHours(basis, 480).deductibleMinutes, 10);
    assert.equal(adjustedPayrollHours(basis, 460).deductibleMinutes, 20);
    assert.throws(() => adjustedPayrollHours({ ...basis, nonBillableOffPhoneMinutes: NaN }, 470));
    const rows = payrollDeductionRows({ ...basis, deductions: 27.2, workedMinutesOverride: 470 });
    assert.equal(rows.find(item => item.label === "Adjusted time shortfall")?.minutes, 0);
    assert.equal(rows.find(item => item.label === "Non-billable Off the Phone")?.minutes, 10);
    assert.equal(rows.reduce((sum, item) => sum + Math.round(item.amount * 100), 0), 2720);
});

test("both undo directions and Add Time Out retain the non-billable interval identity", () => {
    const events = [record("Time In", 0), record(outgoing, 60), record("Off the Phone In", 121), record("Off the Phone Out", 180), record("Off the Phone In", 240)]
        .map((item, index) => ({ id: `e${index}`, commandId: `c${index}`, sequence: index, source: item.source, at: item.timeIn.toISOString() }));
    const shift = { dayKey: "2026-10-19", start: start.toISOString(), end: end.toISOString(), resetDeadline: at(86400).toISOString() };
    const snapshot = { records: events, serverTime: at(500).toISOString(), audit: events.map(event => ({ commandId: event.commandId, actor: { role: "employee" }, operation: "action" })),
        sessions: [{ id: "s", startedAt: start.toISOString(), endedAt: null, lifecycle: "open", shift, events }] } as unknown as AttendanceSessionSnapshot;
    for (const index of [1, 2]) assert.deepEqual(attendanceUndoPlan(snapshot, snapshot.records[index], shift.dayKey).events.map(item => item.id), ["e1", "e2"]);
    snapshot.records = snapshot.records.slice(0, 2); snapshot.sessions[0].events = snapshot.records;
    const changes = missingTimeOutChanges(snapshot, shift.dayKey, "s", "2026-10-19T23:03:00", true);
    assert.deepEqual(changes.map(item => item.source), ["Off the Phone In", "Time Out"]);
});

test("the independent audit and dashboard agree on non-billable presence and minutes", () => {
    const records = [record("Time In", 0), record(outgoing, 60), record("Off the Phone In", 121), record("Time Out", 32400)];
    const audit = auditAttendance(records.map((item, index) => ({ id: `audit-${index}`, code: "synthetic", source: item.source, at: item.timeIn.toISOString(), sequence: index })),
        "2026-10-19", { shiftStart: "23:00", shiftEnd: "08:00", graceMinutes: 0, breakMinutes: 15, lunchMinutes: 60 }, end);
    assert.equal(audit.nonBillableOffPhoneMinutes, 2); assert.equal(audit.deductible, 2); assert.deepEqual(audit.issues, []);
    const dashboard = callDashboardStatus({ availabilityStatus: "OFF THE PHONE", devices: [], attendance: records.slice(0, 2), offPhoneStartedAt: at(60), now: at(100), shift: { start, end } });
    assert.equal(dashboard.status, "OFF THE PHONE"); assert.equal(+dashboard.statusStartedAt!, +at(60));
});
