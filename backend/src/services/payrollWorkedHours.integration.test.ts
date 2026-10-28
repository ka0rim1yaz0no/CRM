import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import { after, before, beforeEach, mock, test } from "node:test";
import mongoose from "mongoose";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import type { SessionEvent } from "./attendanceSessionState";
import { adjustedPayrollHours } from "../../../shared/payrollWorkedHours";
import { payrollDeductionRows } from "../../../shared/payrollPresentation";
import { payrollPaymentAliasBlocker, payrollPaymentStatus } from "../../../shared/payrollPaymentStatus";

const root = `hours_${crypto.randomUUID().replaceAll("-", "")}`;
const businesses = Array.from({ length: 6 }, (_, index) => `hours-${index}`);
process.env.NODE_ENV = "test";
process.env.CRM_PAYROLL_ACCURACY = "true";
process.env.CRM_ATTENDANCE_DURATION_MODEL = "true";
process.env.CRM_ATTENDANCE_INTEGRITY = "true";
process.env.CRM_ATTENDANCE_AUTO_TIMEOUT = "false";
process.env.CRM_ATTENDANCE_RECOVERY_CUTOFF = "false";
process.env.CRM_ADMIN_ONE_CODE = "90000001";
process.env.CRM_ADMIN_SESSION_SECRET = crypto.randomBytes(48).toString("hex");
process.env.DEFAULT_BUSINESS_ID = businesses[0];
process.env.DEFAULT_BUSINESS_DATABASE = `${root}_0`;
process.env.CONTROL_DATABASE_NAME = `${root}_control`;
process.env.BUSINESS_DATABASES = JSON.stringify(businesses.map((id, index) => ({ id, name: `Synthetic Hours ${index}`, databaseName: `${root}_${index}` })));
const { createApp } = await import("../app");
const { Employee } = await import("../models/Employee");
const { Attendance } = await import("../models/Attendance");
const { AttendanceLedger, AttendancePolicy } = await import("../models/AttendanceLedger");
const { PayrollRecord } = await import("../models/Payroll");
const { PayrollAttendanceFence } = await import("../models/PayrollAttendanceFence");
const { EmployeePaymentHistoryPolicy } = await import("../models/EmployeePaymentHistoryPolicy");
const { SystemSettings } = await import("../models/SystemSettings");
const { runWithBusiness, getBusinessConnection } = await import("../config/tenancy");
const { setBusinessAccessForEmployeeCode } = await import("../models/BusinessUserAccess");
const { createAdminDashboardSession } = await import("../config/adminDashboardSession");
const { calculatePayrollCandidate } = await import("./payrollRecomputeService");
const { assignAttendanceShift } = await import("./attendanceShift");
const period = "Oct 6, 2026 - Oct 20, 2026", code = "90000003";
let mongo: MongoMemoryReplSet, server: http.Server, base = "", token = "", id = "";
before(async () => {
    mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } }); await mongoose.connect(mongo.getUri(root));
    server = http.createServer(createApp());
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`;
    token = createAdminDashboardSession("90000001")!;
});
after(async () => {
    if (server?.listening) await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
    await mongoose.disconnect(); await mongo?.stop();
});
beforeEach(async () => {
    await PayrollAttendanceFence.deleteMany({}); await AttendanceLedger.deleteMany({}); await AttendancePolicy.deleteMany({});
    await AttendancePolicy.create({ _id: "global-attendance", revision: 1, shiftStart: "23:00", shiftEnd: "08:00", breakMinutes: 15, lunchMinutes: 60, graceMinutes: 0 });
    const start = Date.parse("2026-10-15T15:00:00Z");
    const events: SessionEvent[] = [["Time In", 0], ["Break Out", 60], ["Break In", 76], ["Lunch Break Out", 200], ["Lunch Break In", 261], ["Time Out", 540]]
        .map(([source, minutes], sequence) => ({ id: `e${sequence}`, commandId: `c${sequence}`, source: source as SessionEvent["source"], sequence,
            at: new Date(start + Number(minutes) * 60000).toISOString(), recordedAt: new Date(start + Number(minutes) * 60000).toISOString(),
            ...(sequence === 0 ? { shift: assignAttendanceShift(new Date(start)) } : {}) }));
    await setBusinessAccessForEmployeeCode(code, businesses);
    await AttendanceLedger.create({ _id: "synthetic-hours", employeeCode: code, businessIds: businesses, canonicalBusinessId: businesses[0], revision: 1, events });
    for (const business of businesses) await runWithBusiness(business, async () => {
        await Employee.deleteMany({}); await Attendance.deleteMany({}); await PayrollRecord.deleteMany({}); await SystemSettings.deleteMany({}); await EmployeePaymentHistoryPolicy.deleteMany({});
        await SystemSettings.create({ key: "system", payrollFirstCutoffStartDay: 6, payrollFirstCutoffEndDay: 20, payrollSecondCutoffStartDay: 21, payrollSecondCutoffEndDay: 5 });
        await EmployeePaymentHistoryPolicy.create({ _id: "employee-payment-history", fromDate: "2026-10-06", initialPayPeriod: period, activatedAt: new Date() });
        const employee = await Employee.create({ employeeCode: code, name: "Synthetic Hours Employee", email: "hours@example.invalid", salary: 30000,
            role: "Sales", status: "Active", team: "Synthetic", businessAccessIds: businesses });
        await Attendance.insertMany(events.map(event => ({ employee: employee._id, source: event.source, timeIn: new Date(event.at), eventId: event.id,
            sequence: event.sequence, ledgerIdentity: "synthetic-hours", ledgerRevision: 1, isEffective: true })));
    });
    for (const business of businesses) await runWithBusiness(business, async () => {
        const employee = await Employee.findOne({ employeeCode: code }).lean(); assert.ok(employee);
        const candidate = await calculatePayrollCandidate(employee, period);
        const saved = await PayrollRecord.create({ ...candidate.value, payrollOwnerBusinessId: businesses[0],
            calculationSnapshot: { ...candidate.value.calculationSnapshot, businessIds: businesses } });
        await PayrollRecord.init(); if (business === businesses[0]) id = String(saved._id);
    });
});
async function request(route: string, body?: unknown, business = businesses[0], auth = token) {
    const response = await fetch(`${base}${route}`, { method: body === undefined ? "GET" : "POST", headers: { "Content-Type": "application/json", "X-Business-Id": business,
        "X-CRM-Admin-Session": auth }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, data: await response.json() };
}
const preview = (workedMinutes: unknown = 4800) => request(`/payroll/records/${id}/worked-minutes/preview`, { workedMinutes });
const confirm = (plan: { token: string; workedMinutes: number }, extra = {}) => request(`/payroll/records/${id}/worked-minutes/confirm`, {
    token: plan.token, workedMinutes: plan.workedMinutes, confirm: true, reason: "Synthetic reviewed total-hours adjustment", ...extra });
async function saved(business = businesses[0]) { return runWithBusiness(business, () => PayrollRecord.findOne({ employeeId: code }).lean()); }

test("earned all-deductions policy matches all six refreshed Payroll and Payments views and preserves paid records", async context => {
    context.mock.timers.enable({ apis: ["Date"], now: new Date("2026-10-11T01:00:00Z") });
    const originalToken = token; token = createAdminDashboardSession("90000001")!;
    const names = ["CRM_EARNED_PAYROLL_FROM", "CRM_EARNED_ALL_DEDUCTIONS_FROM", "CRM_OFF_PHONE_PAID_LIMIT_FROM", "CRM_ATTENDANCE_ACCURACY_FIXES"];
    const previous = names.map(name => process.env[name]);
    context.after(() => { context.mock.timers.reset(); token = originalToken; names.forEach((name, index) => {
        if (previous[index] === undefined) delete process.env[name]; else process.env[name] = previous[index];
    }); });
    process.env.CRM_EARNED_PAYROLL_FROM = "2026-10-06"; process.env.CRM_EARNED_ALL_DEDUCTIONS_FROM = "2026-10-06";
    process.env.CRM_OFF_PHONE_PAID_LIMIT_FROM = "2026-10-06T15:00:00Z"; process.env.CRM_ATTENDANCE_ACCURACY_FIXES = "true";
    const start = Date.parse("2026-10-06T15:00:00Z");
    const entries = [["Time In", 10], ["Break Out", 60], ["Break In", 76], ["Lunch Break Out", 180], ["Lunch Break In", 241],
        ["Off the Phone Out", 300], ["Off the Phone In", 326], ["Time Out", 530],
        ["Time In", 1440], ["Lunch Break Out", 1620], ["Lunch Break In", 1680], ["Time Out", 1980],
        ["Time In", 2880], ["Lunch Break Out", 3060], ["Lunch Break In", 3120], ["Time Out", 3420]];
    const events: SessionEvent[] = entries.map(([source, minutes], sequence) => ({ id: `all-${sequence}`, commandId: `all-${sequence}`,
        source: source as SessionEvent["source"], sequence, at: new Date(start + Number(minutes) * 60000).toISOString(),
        recordedAt: new Date(start + Number(minutes) * 60000).toISOString(),
        ...(source === "Time In" ? { shift: assignAttendanceShift(new Date(start + Number(minutes) * 60000)) } : {}) }));
    await AttendanceLedger.updateOne({ _id: "synthetic-hours" }, { $set: { events, revision: 2 } });
    const originals: Array<Awaited<ReturnType<typeof saved>>> = [];
    for (const business of businesses) await runWithBusiness(business, async () => {
        const employee = (await Employee.findOne({ employeeCode: code }).lean())!;
        await Attendance.deleteMany({ employee: employee._id });
        await Attendance.insertMany(events.map(event => ({ employee: employee._id, source: event.source, timeIn: new Date(event.at), eventId: event.id,
            sequence: event.sequence, ledgerIdentity: "synthetic-hours", ledgerRevision: 2, isEffective: true })));
        await SystemSettings.updateOne({ key: "system" }, { payrollBillingCycle: "Semi-monthly" }); originals.push(await saved(business));
    });
    const candidate = await runWithBusiness(businesses[0], async () => calculatePayrollCandidate((await Employee.findOne({ employeeCode: code }).lean())!, period));
    const value = candidate.value;
    assert.equal(value.calculationVersion, "earned-hours-all-deductions-v1");
    assert.equal(value.lateMinutes, 10); assert.equal(value.earlyTimeOutMinutes, 10); assert.equal(value.absenceMinutes, 480);
    assert.equal(value.excessBreakMinutes, 1); assert.equal(value.excessLunchMinutes, 1); assert.equal(value.nonBillableOffPhoneMinutes, 6);
    assert.equal(value.deductibleMinutes, 508); assert.ok(Math.abs(value.earnedGrossHours! - 1420 / 60) < 1e-10);
    assert.equal(value.deductions, Math.round(508 * value.minuteRate * 100) / 100);
    assert.equal(value.netPay, Math.round((value.grossPay - value.deductions) * 100) / 100); assert.ok(value.netPay > 0);
    for (const [index, business] of businesses.entries()) {
        const login = await request("/auth/login", { employeeCode: code }, business); assert.equal(login.status, 200);
        for (let refresh = 0; refresh < 2; refresh++) {
            const list = await request(`/payroll/records?payPeriod=${encodeURIComponent(period)}`, undefined, business);
            assert.equal(list.status, 200); assert.equal(list.data[0].netPay, value.netPay); assert.equal(list.data[0].deductions, value.deductions);
            const dtr = await request(`/payroll/dtr/${code}?payPeriod=${encodeURIComponent(period)}`, undefined, business);
            assert.equal(dtr.status, 200); assert.equal(dtr.data.summary.deductibleMinutes, 508); assert.equal(dtr.data.summary.netPay, value.netPay);
            const response = await fetch(`${base}/employees/${login.data.user._id}/payments`, { headers: { "X-Business-Id": business, "X-CRM-Attendance-Session": login.data.attendanceHubSession } });
            assert.equal(response.status, 200); const item = (await response.json()).items[0];
            assert.equal(item.netPay, value.netPay); assert.equal(item.deductions, value.deductions);
            const lines = payrollDeductionRows(item); assert.equal(lines.length, 6);
            assert.equal(lines.reduce((sum, row) => sum + Math.round(row.amount * 100), 0), Math.round(value.deductions * 100));
            assert.ok(lines.every(row => row.amount > 0));
        }
        assert.deepEqual(await saved(business), originals[index]);
    }
    const plan = await request("/payroll/recompute/preview", { payPeriod: period, overtimeApprovals: {} });
    assert.equal(plan.status, 200); assert.equal(plan.data.canApply, true, JSON.stringify(plan.data));
    const applied = await request("/payroll/recompute/confirm", { token: plan.data.token, payPeriod: period, overtimeApprovals: {}, confirm: true, reason: "Synthetic approved all-deductions policy" });
    assert.equal(applied.status, 200, JSON.stringify(applied.data));
    const hours = await preview(900); assert.equal(hours.status, 200, JSON.stringify(hours.data));
    assert.equal(hours.data.after.deductibleMinutes, 508); assert.equal(hours.data.after.status, value.status);
    const changed = await confirm(hours.data); assert.equal(changed.status, 200, JSON.stringify(changed.data));
    for (const business of businesses) await runWithBusiness(business, async () => {
        const record = (await saved(business))!;
        await PayrollRecord.updateOne({ _id: record._id }, { $set: { status: "Paid", paidOn: "Oct 9, 2026" } });
        const frozen = await saved(business);
        const list = await request(`/payroll/records?payPeriod=${encodeURIComponent(period)}`, undefined, business);
        assert.equal(list.data[0].netPay, frozen!.netPay); assert.equal(list.data[0].earnedToDate, undefined);
        assert.equal(list.data[0].status, "Paid"); assert.equal(list.data[0].paidOn, frozen!.paidOn); assert.deepEqual(await saved(business), frozen);
    });
});

test("earned current pay and the whole-shift off-phone limit match Payroll, Payments and DTR in six businesses without rewriting saved or paid records", async context => {
    context.mock.timers.enable({ apis: ["Date"], now: new Date("2026-10-16T08:00:00Z") });
    const originalToken = token; token = createAdminDashboardSession("90000001")!;
    const oldEarned = process.env.CRM_EARNED_PAYROLL_FROM, oldLimit = process.env.CRM_OFF_PHONE_PAID_LIMIT_FROM;
    context.after(() => { context.mock.timers.reset(); token = originalToken;
        if (oldEarned === undefined) delete process.env.CRM_EARNED_PAYROLL_FROM; else process.env.CRM_EARNED_PAYROLL_FROM = oldEarned;
        if (oldLimit === undefined) delete process.env.CRM_OFF_PHONE_PAID_LIMIT_FROM; else process.env.CRM_OFF_PHONE_PAID_LIMIT_FROM = oldLimit; });
    process.env.CRM_EARNED_PAYROLL_FROM = "2026-10-06";
    process.env.CRM_OFF_PHONE_PAID_LIMIT_FROM = "2026-10-15T15:00:00Z";
    const start = Date.parse("2026-10-15T15:00:00Z");
    const events: SessionEvent[] = [["Time In", 0], ["Off the Phone Out", 60], ["Off the Phone In", 70], ["Time Out", 120],
        ["Time In", 180], ["Off the Phone Out", 240], ["Off the Phone In", 250 + 1 / 60],
        ["Lunch Break Out", 300], ["Lunch Break In", 360], ["Time Out", 540]].map(([source, minutes], sequence) => ({
        id: `earned-${sequence}`, commandId: `earned-${sequence}`, source: source as SessionEvent["source"], sequence,
        at: new Date(start + Number(minutes) * 60000).toISOString(), recordedAt: new Date(start + Number(minutes) * 60000).toISOString(),
        ...(source === "Time In" ? { shift: assignAttendanceShift(new Date(start + Number(minutes) * 60000)) } : {}) }));
    await AttendanceLedger.updateOne({ _id: "synthetic-hours" }, { $set: { events, revision: 2 } });
    const originals: Array<Awaited<ReturnType<typeof saved>>> = [];
    for (const business of businesses) await runWithBusiness(business, async () => {
        const person = await Employee.findOne({ employeeCode: code }).lean(); assert.ok(person);
        await Attendance.deleteMany({ employee: person._id });
        await Attendance.insertMany(events.map(event => ({ employee: person._id, source: event.source, timeIn: new Date(event.at), eventId: event.id,
            sequence: event.sequence, ledgerIdentity: "synthetic-hours", ledgerRevision: 2, isEffective: true })));
        await SystemSettings.updateOne({ key: "system" }, { payrollBillingCycle: "Semi-monthly" });
        originals.push(await saved(business));
    });
    const ledgerBefore = JSON.stringify(await AttendanceLedger.find().lean());
    const candidate = await runWithBusiness(businesses[0], async () => calculatePayrollCandidate((await Employee.findOne({ employeeCode: code }).lean())!, period));
    assert.equal(candidate.value.calculationVersion, "earned-hours-v1");
    assert.equal(candidate.value.nonBillableOffPhoneMinutes, 1); assert.equal(candidate.value.deductibleMinutes, 1);
    assert.equal(candidate.value.workedHours, 7 - 1 / 60); assert.equal(candidate.value.attendanceDays, 1);
    assert.equal(candidate.value.grossPay, Math.round(7 * candidate.rates.hourlyRate * 100) / 100);
    assert.equal(candidate.value.netPay, Math.round((candidate.value.grossPay - candidate.value.deductions) * 100) / 100);
    for (const [index, business] of businesses.entries()) {
        const login = await request("/auth/login", { employeeCode: code }, business); assert.equal(login.status, 200);
        for (let refresh = 0; refresh < 2; refresh++) {
            const list = await request(`/payroll/records?payPeriod=${encodeURIComponent(period)}`, undefined, business);
            assert.equal(list.status, 200, JSON.stringify(list.data));
            assert.equal(list.data[0].earnedToDate, true); assert.equal(list.data[0].netPay, candidate.value.netPay);
            assert.equal(list.data[0].settlementRequired, true); assert.equal(list.data[0].status, originals[index]!.status);
            const stats = await request(`/payroll/stats?payPeriod=${encodeURIComponent(period)}`, undefined, business);
            assert.equal(stats.status, 200); assert.equal(stats.data.netPayroll, candidate.value.netPay);
            const dtr = await request(`/payroll/dtr/${code}?payPeriod=${encodeURIComponent(period)}`, undefined, business);
            assert.equal(dtr.status, 200); assert.equal(dtr.data.summary.netPay, candidate.value.netPay);
            assert.equal(dtr.data.summary.workedHours, candidate.value.workedHours);
            const response = await fetch(`${base}/employees/${login.data.user._id}/payments`, { headers: { "X-Business-Id": business, "X-CRM-Attendance-Session": login.data.attendanceHubSession } });
            assert.equal(response.status, 200); const payments = await response.json();
            assert.equal(payments.items[0].netPay, candidate.value.netPay); assert.equal(payments.items[0].deductions, candidate.value.deductions);
            assert.equal(payments.items[0].earnedToDate, true); assert.equal(payments.items[0].nonBillableOffPhoneMinutes, 1);
            const rows = payrollDeductionRows(payments.items[0]); assert.equal(rows.find(row => row.label === "Non-billable Off the Phone")!.minutes, 1);
            assert.ok(!rows.some(row => ["Late", "Undertime", "Absence"].includes(row.label)));
        }
        assert.deepEqual(await saved(business), originals[index], "current earnings reads must not save or settle a payroll");
    }
    const blocked = await request(`/payroll/records/${id}/payment-status/preview`, { paid: true });
    assert.equal(blocked.status, 200); assert.equal(blocked.data.canApply, false); assert.ok(blocked.data.blockers.some((message: string) => /Recompute/.test(message)));
    const plan = await request("/payroll/recompute/preview", { payPeriod: period, overtimeApprovals: {} });
    assert.equal(plan.status, 200); assert.equal(plan.data.canApply, true, JSON.stringify(plan.data));
    const applied = await request("/payroll/recompute/confirm", { token: plan.data.token, payPeriod: period, overtimeApprovals: {}, confirm: true, reason: "Reviewed synthetic earned hours" });
    assert.equal(applied.status, 200, JSON.stringify(applied.data));
    const early = await request(`/payroll/records/${id}/payment-status/preview`, { paid: true });
    assert.equal(early.status, 200); assert.equal(early.data.canApply, false);
    assert.ok(early.data.blockers.some((message: string) => /still in progress/.test(message)), "a partial earned cutoff cannot be silently frozen as fully paid");
    const legacyPaid = await fetch(`${base}/payroll/records/${id}/paid`, { method: "PATCH", headers: { "X-Business-Id": businesses[0], "X-CRM-Admin-Session": token } });
    assert.equal(legacyPaid.status, 422, "legacy direct payment endpoints cannot bypass the earned-cutoff preview");
    context.mock.timers.setTime(new Date("2026-10-21T01:00:00Z").getTime()); token = createAdminDashboardSession("90000001")!;
    const payment = await request(`/payroll/records/${id}/payment-status/preview`, { paid: true });
    assert.equal(payment.status, 200); assert.equal(payment.data.canApply, true, JSON.stringify(payment.data));
    const paid = await request(`/payroll/records/${id}/payment-status/confirm`, { token: payment.data.token, paid: true, confirm: true, acknowledgeAttendance: true, reason: "Synthetic settled earned payroll" });
    assert.equal(paid.status, 200, JSON.stringify(paid.data));
    for (const business of businesses) {
        const frozen = await saved(business); assert.ok(frozen); assert.equal(frozen.status, "Paid"); assert.equal(frozen.netPay, candidate.value.netPay);
        const list = await request(`/payroll/records?payPeriod=${encodeURIComponent(period)}`, undefined, business);
        assert.equal(list.data[0].netPay, frozen.netPay); assert.equal(list.data[0].earnedToDate, undefined);
        const login = await request("/auth/login", { employeeCode: code }, business);
        const response = await fetch(`${base}/employees/${login.data.user._id}/payments?view=history`, { headers: { "X-Business-Id": business, "X-CRM-Attendance-Session": login.data.attendanceHubSession } });
        const payments = await response.json(); assert.equal(payments.items[0].netPay, frozen.netPay);
        assert.equal(payments.items[0].status, "Paid"); assert.equal(payments.items[0].paidOn, frozen.paidOn);
        assert.deepEqual(await saved(business), frozen);
    }
    assert.equal(JSON.stringify(await AttendanceLedger.find().lean()), ledgerBefore);
});

test("total-hours preview is read-only, uses saved rate, counts rest excess once and applies atomically to six businesses", async () => {
    const before = await saved(); assert.ok(before);
    for (const business of businesses) {
        const other = await saved(business); assert.ok(other);
        const fields = ["grossPay", "basicPay", "workingDays", "minuteRate", "paidHoursPerDay", "hourlyRate", "lateMinutes", "excessLunchMinutes", "excessBreakMinutes",
            "absenceMinutes", "earlyTimeOutMinutes", "deductibleMinutes", "incompleteShiftDays", "deductions", "netPay", "attendanceDays", "absentDays", "absentHours", "lateDays", "lateHours", "workedHours", "scheduledHours", "status", "paidOn"] as const;
        for (const field of fields) assert.deepEqual(other[field], before[field], `Synthetic mirror seed differs at ${field}`);
    }
    const ledger = JSON.stringify(await AttendanceLedger.find().lean());
    const punches = await Promise.all(businesses.map(business => runWithBusiness(business, async () => JSON.stringify(await Attendance.find().lean()))));
    const plan = await preview(); assert.equal(plan.status, 200, JSON.stringify(plan.data));
    assert.equal(plan.data.after.workedHours, 80); assert.equal(plan.data.after.grossPay, before.grossPay);
    assert.equal(plan.data.after.status, before.status); assert.equal(plan.data.after.paidOn, before.paidOn);
    assert.equal(plan.data.after.deductibleMinutes, Math.round(before.scheduledHours * 60) - 4800 + before.excessBreakMinutes + before.excessLunchMinutes);
    assert.deepEqual(await saved(), before);
    assert.equal((await confirm(plan.data)).status, 200);
    for (const [index, business] of businesses.entries()) {
        const current = await saved(business); assert.ok(current);
        assert.equal(current.workedMinutesOverride, 4800); assert.equal(current.workedHours, 80); assert.equal(current.netPay, plan.data.after.netPay);
        assert.equal(current.status, before.status); assert.equal(current.paidOn, before.paidOn); assert.equal(current.calculationAudit?.length, 1);
        const dtr = await request(`/payroll/dtr/${code}?payPeriod=${encodeURIComponent(period)}`, undefined, business);
        assert.equal(dtr.status, 200); assert.equal(dtr.data.summary.workedHours, 80); assert.equal(dtr.data.summary.netPay, current.netPay);
        const login = await request("/auth/login", { employeeCode: code }, business); assert.equal(login.status, 200);
        const response = await fetch(`${base}/employees/${login.data.user._id}/payments?view=history`, { headers: { "X-Business-Id": business,
            "X-CRM-Attendance-Session": login.data.attendanceHubSession } });
        assert.equal(response.status, 200); const payments = await response.json(); assert.equal(payments.items[0].workedHours, 80);
        assert.equal(payments.items[0].netPay, current.netPay); assert.equal(payments.items[0].workedMinutesOverride, 4800);
        assert.equal((await request("/dashboard-workspace/summary?preset=today", undefined, business)).status, 200);
        assert.equal(JSON.stringify(await runWithBusiness(business, () => Attendance.find().lean())), punches[index]);
        const rows = payrollDeductionRows(current); assert.equal(rows[0].label, "Adjusted time shortfall");
        assert.equal(rows.reduce((sum, row) => sum + Math.round(row.amount * 100), 0), Math.round(current.deductions * 100));
    }
    assert.equal(JSON.stringify(await AttendanceLedger.find().lean()), ledger);
    assert.equal((await confirm(plan.data)).status, 409, "replayed confirmation must not apply again");
    const candidate = await runWithBusiness(businesses[0], async () => calculatePayrollCandidate((await Employee.findOne({ employeeCode: code }).lean())!, period));
    assert.equal(candidate.value.workedMinutesOverride, 4800); assert.equal(candidate.value.workedHours, 80);
    assert.equal(candidate.value.deductions, plan.data.after.deductions, "later recompute cannot silently discard the approved total");
});

test("invalid totals, missing reason, missing confirmation and unverified access cannot write payroll", async () => {
    const before = await saved();
    for (const minutes of [-1, 0.1, "1", null, 1e15]) assert.ok((await preview(minutes)).status >= 400);
    const plan = await preview(); assert.equal(plan.status, 200);
    assert.equal((await confirm(plan.data, { confirm: false })).status, 400);
    assert.equal((await confirm(plan.data, { reason: " " })).status, 400);
    assert.equal((await request(`/payroll/records/${id}/worked-minutes/preview`, { workedMinutes: 4800 }, businesses[0], "invalid")).status, 401);
    assert.deepEqual(await saved(), before);
});

test("a stale preview and a change immediately before the transaction reject every mirror", async () => {
    const plan = await preview(); assert.equal(plan.status, 200);
    const startSession = mongoose.startSession.bind(mongoose);
    let changed = false;
    const stub = mock.method(mongoose, "startSession", async (...args: Parameters<typeof mongoose.startSession>) => {
        if (!changed) { changed = true; await AttendanceLedger.updateOne({ _id: "synthetic-hours" }, { $inc: { revision: 1 } }); }
        return startSession(...args);
    });
    try { assert.equal((await confirm(plan.data)).status, 409); } finally { stub.mock.restore(); }
    for (const business of businesses) assert.equal((await saved(business))?.workedMinutesOverride, null);
});

test("two simultaneous confirmations create exactly one audit and never partial business copies", async () => {
    const plan = await preview(); assert.equal(plan.status, 200);
    const responses = await Promise.all([confirm(plan.data), confirm(plan.data)]);
    assert.deepEqual(responses.map(item => item.status).sort(), [200, 409]);
    for (const business of businesses) { const current = await saved(business); assert.equal(current?.workedHours, 80); assert.equal(current?.calculationAudit?.length, 1); }
});

test("a failed mirror write rolls back all hours, amounts and audit entries", async () => {
    const plan = await preview(); assert.equal(plan.status, 200);
    const stub = mock.method(getBusinessConnection(businesses[1]).model("PayrollRecord"), "updateOne", () => { throw new Error("Synthetic mirror failure"); });
    try { assert.equal((await confirm(plan.data)).status, 500); } finally { stub.mock.restore(); }
    for (const business of businesses) {
        const record = await saved(business); assert.ok(record); assert.equal(record.workedMinutesOverride, null); assert.equal(record.calculationAudit?.length ?? 0, 0);
        assert.equal(record.netPay, plan.data.before.netPay);
    }
});

test("paid, completed, mismatched mirrors, aliases and missing saved rate stay protected", async () => {
    const original = await saved(); assert.ok(original);
    for (const status of ["Paid", "Completed"] as const) {
        await PayrollRecord.updateOne({ _id: id }, { status }); assert.equal((await preview()).status, 422);
    }
    await PayrollRecord.updateOne({ _id: id }, { status: original.status });
    await runWithBusiness(businesses[5], () => PayrollRecord.updateOne({ employeeId: code }, { netPay: original.netPay + 1 }));
    assert.equal((await preview()).status, 422);
    await runWithBusiness(businesses[5], () => PayrollRecord.updateOne({ employeeId: code }, { netPay: original.netPay }));
    const { _id, ...alias } = original; void _id;
    await PayrollRecord.create({ ...alias, payPeriod: "October 6, 2026 - October 20, 2026" }); assert.equal((await preview()).status, 422);
    await PayrollRecord.deleteOne({ payPeriod: "October 6, 2026 - October 20, 2026" });
    for (const business of businesses) await runWithBusiness(business, () => PayrollRecord.updateOne({ employeeId: code }, { minuteRate: 0 }));
    assert.equal((await preview()).status, 422);
    for (const business of businesses) assert.equal((await saved(business))?.workedMinutesOverride, null);
});

test("zero and scheduled-hour boundaries keep break and lunch excess separate", () => {
    assert.equal(adjustedPayrollHours({ scheduledHours: 88, excessBreakMinutes: 1, excessLunchMinutes: 2 }, 5280).deductibleMinutes, 3);
    assert.equal(adjustedPayrollHours({ scheduledHours: 88, excessBreakMinutes: 1, excessLunchMinutes: 2 }, 0).deductibleMinutes, 5283);
});

const paymentPreview = (paid = true) => request(`/payroll/records/${id}/payment-status/preview`, { paid });
const paymentConfirm = (plan: { token: string; paid: boolean }, extra = {}) => request(`/payroll/records/${id}/payment-status/confirm`, {
    token: plan.token, paid: plan.paid, confirm: true, reason: "Synthetic administrator confirms saved payment only", acknowledgeAttendance: true, ...extra });

test("attendance Review is not a payment state; saved-money conflicts and previous payments remain protected", () => {
    assert.equal(payrollPaymentStatus("Review"), "Pending"); assert.equal(payrollPaymentStatus("Paid"), "Paid");
    const item = { grossPay: 15000, deductions: 50, netPay: 14950, status: "Review", paidOn: "-" };
    assert.equal(payrollPaymentAliasBlocker([item, { ...item, status: "Pending" }]), null);
    assert.match(payrollPaymentAliasBlocker([item, { ...item, deductions: 49, netPay: 14951 }])!, /different payroll amounts/);
    assert.match(payrollPaymentAliasBlocker([item, { ...item, status: "Paid" }])!, /payment statuses/);
    assert.match(payrollPaymentAliasBlocker([{ ...item, status: "Completed" }])!, /locked/);
});

test("stale saved attendance review can be paid only by an acknowledged administrator, refreshing Payments in all six businesses", async () => {
    for (const business of businesses) await runWithBusiness(business, () => PayrollRecord.updateOne({ employeeId: code }, { status: "Review", incompleteShiftDays: 1 }));
    const original = await saved(); assert.ok(original); const ledger = JSON.stringify(await AttendanceLedger.find().lean());
    const plan = await paymentPreview(); assert.equal(plan.status, 200, JSON.stringify(plan.data)); assert.equal(plan.data.canApply, true, JSON.stringify(plan.data.blockers));
    assert.ok(plan.data.warnings.length); assert.ok(plan.data.rows.every((row: { currentAttendanceReviewDays: number }) => row.currentAttendanceReviewDays === 0));
    assert.equal((await paymentConfirm(plan.data, { acknowledgeAttendance: false })).status, 400);
    assert.equal((await paymentConfirm(plan.data, { reason: " " })).status, 400);
    assert.equal((await paymentConfirm(plan.data)).status, 200);
    for (const business of businesses) {
        const current = await saved(business); assert.ok(current);
        for (const key of ["grossPay", "deductions", "netPay", "workedHours", "minuteRate", "incompleteShiftDays"] as const) assert.equal(current[key], original[key]);
        assert.equal(current.status, "Paid"); assert.notEqual(current.paidOn, "-"); assert.equal(current.calculationAudit?.length, 1);
        const employee = await runWithBusiness(business, () => Employee.findOne({ employeeCode: code }).lean()); assert.ok(employee);
        const login = await request("/auth/login", { employeeCode: code }, business); assert.equal(login.status, 200);
        for (let refresh = 0; refresh < 2; refresh++) {
            const response: Awaited<ReturnType<typeof fetch>> = await fetch(`${base}/employees/${employee._id}/payments?view=history`, { headers: { "X-Business-Id": business, "X-CRM-Attendance-Session": login.data.attendanceHubSession } });
            assert.equal(response.status, 200); const body = await response.json(); assert.equal(body.items[0].status, "Paid");
            assert.equal(body.items[0].paidOn, current.paidOn); assert.equal(body.items[0].netPay, original.netPay);
            const admin = await request(`/payroll/records?payPeriod=${encodeURIComponent(period)}`, undefined, business);
            assert.equal(admin.data[0].status, "Paid"); assert.equal(admin.data[0].netPay, original.netPay);
        }
    }
    assert.equal(JSON.stringify(await AttendanceLedger.find().lean()), ledger);
    assert.equal((await paymentConfirm(plan.data)).status, 409);
    const unpaid = await paymentPreview(false); assert.equal(unpaid.data.canApply, true);
    assert.equal((await paymentConfirm(unpaid.data)).status, 200);
    for (const business of businesses) { const current = await saved(business); assert.equal(current?.status, "Pending"); assert.equal(current?.paidOn, "-"); assert.equal(current?.netPay, original.netPay); }
});

test("equal-money cutoff aliases settle together without editing differing attendance details", async () => {
    for (const business of businesses) await runWithBusiness(business, async () => {
        const current = await saved(business); assert.ok(current); const { _id, ...alias } = current; void _id;
        await PayrollRecord.create({ ...alias, payPeriod: "2026-10-06 - 2026-10-20", status: "Review", incompleteShiftDays: 1, lateMinutes: current.lateMinutes + 1 });
    });
    const plan = await paymentPreview(); assert.equal(plan.status, 200); assert.equal(plan.data.canApply, true, JSON.stringify(plan.data.blockers));
    assert.equal((await paymentConfirm(plan.data)).status, 200);
    for (const business of businesses) await runWithBusiness(business, async () => {
        const records = await PayrollRecord.find({ employeeId: code }).sort({ payPeriod: 1 }).lean(); assert.equal(records.length, 2);
        assert.ok(records.every(record => record.status === "Paid" && record.calculationAudit?.length === 1));
        assert.equal(new Set(records.map(record => record.netPay)).size, 1); assert.equal(new Set(records.map(record => record.lateMinutes)).size, 2);
    });
});

test("actual unfinished attendance stays unchanged while a reasoned saved-payment confirmation is allowed", async () => {
    const current = await AttendanceLedger.findById("synthetic-hours").lean(); assert.ok(current);
    await AttendanceLedger.updateOne({ _id: current._id }, { events: current.events.slice(0, -1), $inc: { revision: 1 } });
    const before = JSON.stringify(await AttendanceLedger.find().lean());
    const plan = await paymentPreview(); assert.equal(plan.status, 200); assert.equal(plan.data.canApply, true);
    assert.ok(plan.data.rows.every((row: { currentAttendanceReviewDays: number }) => row.currentAttendanceReviewDays > 0));
    assert.equal((await paymentConfirm(plan.data, { acknowledgeAttendance: false })).status, 400);
    assert.equal((await paymentConfirm(plan.data)).status, 200);
    assert.equal(JSON.stringify(await AttendanceLedger.find().lean()), before);
});

test("different saved amounts or contradictory payment history cannot be bypassed by acknowledgement", async () => {
    const source = await saved(); assert.ok(source); const { _id, ...alias } = source; void _id;
    await PayrollRecord.create({ ...alias, payPeriod: "2026-10-06 - 2026-10-20", deductions: source.deductions - 1, netPay: source.netPay + 1 });
    let plan = await paymentPreview(); assert.equal(plan.data.canApply, false); assert.equal((await paymentConfirm(plan.data)).status, 422);
    await PayrollRecord.deleteOne({ payPeriod: "2026-10-06 - 2026-10-20" });
    await runWithBusiness(businesses[5], () => PayrollRecord.updateOne({ employeeId: code }, { status: "Paid", paidOn: "Oct 24, 2026" }));
    plan = await paymentPreview(); assert.equal(plan.data.canApply, false); assert.equal((await paymentConfirm(plan.data)).status, 422);
    assert.equal((await saved())?.status, "Pending"); assert.equal((await saved(businesses[5]))?.status, "Paid");
});

test("concurrent payment confirmations settle once and attendance changes invalidate the preview", async () => {
    let plan = await paymentPreview(); assert.equal(plan.data.canApply, true);
    await AttendanceLedger.updateOne({ _id: "synthetic-hours" }, { $inc: { revision: 1 } });
    assert.equal((await paymentConfirm(plan.data)).status, 409);
    plan = await paymentPreview(); const results = await Promise.all([paymentConfirm(plan.data), paymentConfirm(plan.data)]);
    assert.deepEqual(results.map(item => item.status).sort(), [200, 409]);
    for (const business of businesses) assert.equal((await saved(business))?.calculationAudit?.length, 1);
});

test("payment failure in a second business rolls back all statuses and audits; employee sessions cannot approve", async () => {
    const plan = await paymentPreview(); assert.equal(plan.data.canApply, true);
    const stub = mock.method(getBusinessConnection(businesses[1]).model("PayrollRecord"), "updateOne", () => { throw new Error("Synthetic payment failure"); });
    try { assert.equal((await paymentConfirm(plan.data)).status, 500); } finally { stub.mock.restore(); }
    for (const business of businesses) { const record = await saved(business); assert.equal(record?.status, "Pending"); assert.equal(record?.calculationAudit?.length ?? 0, 0); }
    assert.equal((await request(`/payroll/records/${id}/payment-status/confirm`, { ...plan.data, confirm: true }, businesses[0], "forged")).status, 401);
});

test("an unpaid zero-value monthly draft does not falsely block a dated cutoff, but a payable overlap still blocks", async () => {
    for (const business of businesses) await runWithBusiness(business, async () => {
        const source = await saved(business); assert.ok(source); const { _id, ...draft } = source; void _id;
        await PayrollRecord.create({ ...draft, payPeriod: "Oct 6, 2026 - Nov 5, 2026", payType: "Monthly", status: "Review", grossPay: 0, deductions: 0, netPay: 0 });
    });
    const plan = await paymentPreview(); assert.equal(plan.data.canApply, true, JSON.stringify(plan.data.blockers));
    assert.ok(plan.data.warnings.some((message: string) => message.includes("zero-value draft")));
    await runWithBusiness(businesses[1], () => PayrollRecord.updateOne({ payType: "Monthly" }, { grossPay: 1, netPay: 1 }));
    const blocked = await paymentPreview(); assert.equal(blocked.data.canApply, false); assert.equal((await paymentConfirm(blocked.data)).status, 422);
    await runWithBusiness(businesses[1], () => PayrollRecord.updateOne({ payType: "Monthly" }, { grossPay: 0, netPay: 0 }));
    const fresh = await paymentPreview(); assert.equal((await paymentConfirm(fresh.data)).status, 200);
    for (const business of businesses) {
        const draft = await runWithBusiness(business, () => PayrollRecord.findOne({ payType: "Monthly" }).lean());
        assert.equal(draft?.status, "Review"); assert.equal(draft?.netPay, 0); assert.equal(draft?.calculationAudit?.length ?? 0, 0);
    }
});

test("non-billable off-phone deductions survive reviewed generation, repeated reads, Payments and six business mirrors", async () => {
    const ledger = await AttendanceLedger.findById("synthetic-hours").lean(); assert.ok(ledger);
    const originalPayroll = await Promise.all(businesses.map(business => saved(business)));
    const first = ledger.events[0];
    const events: SessionEvent[] = [first,
        { ...first, id: "nb-start", commandId: "nb-start", sequence: 1, source: "Non-Billable Off the Phone Out", at: "2026-10-15T16:00:00.000Z" },
        { ...first, id: "nb-return", commandId: "nb-return", sequence: 2, source: "Off the Phone In", at: "2026-10-15T16:10:01.000Z" },
        { ...first, id: "paid-start", commandId: "paid-start", sequence: 3, source: "Off the Phone Out", at: "2026-10-15T17:00:00.000Z" },
        { ...first, id: "paid-return", commandId: "paid-return", sequence: 4, source: "Off the Phone In", at: "2026-10-15T18:00:00.000Z" },
        { ...first, id: "checkout", commandId: "checkout", sequence: 5, source: "Time Out", at: "2026-10-16T00:00:00.000Z" }];
    await AttendanceLedger.updateOne({ _id: ledger._id }, { $set: { events, revision: 2 } });
    for (const business of businesses) await runWithBusiness(business, async () => {
        const employee = await Employee.findOne({ employeeCode: code }).lean(); assert.ok(employee);
        await Attendance.deleteMany({ employee: employee._id });
        await Attendance.insertMany(events.map(event => ({ employee: employee._id, source: event.source, timeIn: new Date(event.at), eventId: event.id,
            sequence: event.sequence, ledgerIdentity: ledger._id, ledgerRevision: 2, isEffective: true })));
        await SystemSettings.updateOne({ key: "system" }, { payrollBillingCycle: "Semi-monthly" });
    });
    for (const [index, business] of businesses.entries()) {
        const candidate = await runWithBusiness(business, async () => calculatePayrollCandidate((await Employee.findOne({ employeeCode: code }).lean())!, period));
        assert.equal(candidate.value.nonBillableOffPhoneMinutes, 11);
        const row = candidate.dtr.rows.find(item => item.dateKey === "2026-10-15")!;
        assert.equal(row.nonBillableOffPhoneMinutes, 11); assert.equal(row.deductibleMinutes, 11);
        assert.equal(row.regularHours, 8 - 11 / 60);
        assert.equal(candidate.value.deductions, Math.round(candidate.value.deductibleMinutes * candidate.value.minuteRate * 100) / 100);
        assert.deepEqual(await saved(business), originalPayroll[index], "preview must not rewrite existing amounts or status");
    }
    const proposed = await request("/payroll/recompute/preview", { payPeriod: period, overtimeApprovals: {} });
    assert.equal(proposed.status, 200, JSON.stringify(proposed.data)); assert.equal(proposed.data.canApply, true);
    const details = proposed.data.rows[0].nonBillableOffPhone;
    assert.equal(details.before.minutes, 0); assert.equal(details.before.amount, 0);
    assert.equal(details.after.minutes, 11);
    const proposedCandidate = await runWithBusiness(businesses[0], async () => calculatePayrollCandidate((await Employee.findOne({ employeeCode: code }).lean())!, period));
    assert.equal(details.minuteRate, proposedCandidate.value.minuteRate);
    assert.equal(details.after.amount, payrollDeductionRows(proposedCandidate.value).find(item => item.label === "Non-billable Off the Phone")?.amount);
    for (const [index, business] of businesses.entries()) assert.deepEqual(await saved(business), originalPayroll[index]);
    const applied = await request("/payroll/recompute/confirm", { token: proposed.data.token, payPeriod: period, overtimeApprovals: {}, confirm: true, reason: "Synthetic reviewed non-billable off-phone deduction" });
    assert.equal(applied.status, 200, JSON.stringify(applied.data));
    for (const business of businesses) {
        const current = await saved(business); assert.ok(current); assert.equal(current.nonBillableOffPhoneMinutes, 11);
        for (let refresh = 0; refresh < 2; refresh++) {
            const dtr = await request(`/payroll/dtr/${code}?payPeriod=${encodeURIComponent(period)}`, undefined, business);
            assert.equal(dtr.status, 200); assert.equal(dtr.data.summary.nonBillableOffPhoneMinutes, 11);
            assert.equal(dtr.data.summary.deductions, current.deductions); assert.equal(dtr.data.summary.netPay, current.netPay);
            const login = await request("/auth/login", { employeeCode: code }, business); assert.equal(login.status, 200);
            const response = await fetch(`${base}/employees/${login.data.user._id}/payments?view=history`, { headers: { "X-Business-Id": business, "X-CRM-Attendance-Session": login.data.attendanceHubSession } });
            const payments = await response.json(); assert.equal(response.status, 200);
            assert.equal(payments.items[0].nonBillableOffPhoneMinutes, 11); assert.equal(payments.items[0].netPay, current.netPay);
            assert.equal(payments.items[0].status, current.status);
            const rows = payrollDeductionRows(payments.items[0]); assert.equal(rows.find(item => item.label === "Non-billable Off the Phone")?.minutes, 11);
            assert.equal(rows.reduce((sum, item) => sum + Math.round(item.amount * 100), 0), Math.round(current.deductions * 100));
        }
        assert.deepEqual(await saved(business), current, "refresh must not modify saved payroll");
    }
    const refreshedPreview = await request("/payroll/recompute/preview", { payPeriod: period, overtimeApprovals: {} });
    assert.equal(refreshedPreview.status, 200);
    assert.deepEqual(refreshedPreview.data.rows[0].nonBillableOffPhone.before, details.after);
});

test("current cutoff opens with the full roster, distinguishing missing payroll from saved records after refresh in six businesses", async context => {
    context.mock.timers.enable({ apis: ["Date"], now: new Date("2026-10-26T08:00:00Z") });
    context.after(() => context.mock.timers.reset());
    const previousToken = token; token = createAdminDashboardSession("90000001")!;
    context.after(() => { token = previousToken; });
    const nextPeriod = "Oct 21, 2026 - Nov 5, 2026";
    for (const business of businesses) await runWithBusiness(business, async () => {
        await SystemSettings.updateOne({ key: "system" }, { payrollBillingCycle: "Semi-monthly" });
        const source = await saved(business); assert.ok(source); const { _id, ...value } = source; void _id;
        await Employee.create({ employeeCode: "90000004", name: "Second Synthetic Employee", role: "Sales", status: "Active" });
        await PayrollRecord.create({ ...value, employeeId: "90000004", employeeName: "Second Synthetic Employee" });
        await PayrollRecord.create({ ...value, payPeriod: nextPeriod, status: "Pending" });
        await PayrollRecord.create({ ...value, payPeriod: "2026-10-06 - 2026-10-20" });
        await PayrollRecord.create({ ...value, payPeriod: "Sep 21, 2026 - Oct 5, 2026" });
        await PayrollRecord.create({ ...value, payPeriod: "Oct 6, 2026 - Nov 5, 2026", payType: "Monthly" });
        await Employee.create({ employeeCode: "90000005", name: "Archived Synthetic Employee", role: "Sales", status: "Archived" });
        await PayrollRecord.create({ ...value, employeeId: "90000005", employeeName: "Archived Synthetic Employee" });
    });
    const before = await Promise.all(businesses.map(business => runWithBusiness(business, async () => JSON.stringify(await PayrollRecord.find().sort({ _id: 1 }).lean()))));
    for (const [index, business] of businesses.entries()) {
        for (let refresh = 0; refresh < 2; refresh++) {
            const cutoffs = await request("/payroll/cutoffs", undefined, business); assert.equal(cutoffs.status, 200);
            assert.equal(cutoffs.data.defaultPayPeriod, nextPeriod); assert.equal(cutoffs.data.currentPayPeriod, nextPeriod);
            assert.deepEqual(cutoffs.data.items.map((item: { recordedEmployees: number }) => item.recordedEmployees), [1, 2]);
            assert.deepEqual(cutoffs.data.items.map((item: { visibleEmployees: number }) => item.visibleEmployees), [2, 2]);
            const records = await request("/payroll/records", undefined, business); assert.equal(records.data.length, 1);
            const gaps = await request("/payroll/roster-gaps", undefined, business); assert.equal(gaps.status, 200); assert.equal(gaps.data.length, 1);
            assert.equal(gaps.data[0].employeeId, "90000004"); assert.equal(gaps.data[0].state, "not-generated");
            assert.equal(gaps.data[0].payPeriod, nextPeriod); assert.ok(!["_id", "grossPay", "netPay", "deductions", "paidOn"].some(key => key in gaps.data[0]));
            const stats = await request("/payroll/stats", undefined, business); assert.equal(stats.data.payPeriod, nextPeriod); assert.equal(stats.data.recordedEmployees, 1);
            assert.equal(stats.data.totalEmployees, 2); assert.equal(stats.data.unrecordedEmployees, 1);
            assert.equal(stats.data.netPayroll, records.data.reduce((sum: number, item: { netPay: number }) => sum + item.netPay, 0));
            const explicit = await request(`/payroll/records?payPeriod=${encodeURIComponent(nextPeriod)}`, undefined, business);
            assert.equal(explicit.data.length, 1); assert.equal(explicit.data[0].employeeId, code);
            const nextStats = await request(`/payroll/stats?payPeriod=${encodeURIComponent(nextPeriod)}`, undefined, business);
            assert.equal(nextStats.data.recordedEmployees, 1); assert.equal(nextStats.data.netPayroll, explicit.data[0].netPay);
            const history = await request(`/payroll/records?payPeriod=${encodeURIComponent(period)}`, undefined, business); assert.equal(history.data.length, 2);
            assert.deepEqual((await request(`/payroll/roster-gaps?payPeriod=${encodeURIComponent(period)}`, undefined, business)).data, []);
            assert.equal((await request("/payroll/roster-gaps?search=Second", undefined, business)).data.length, 1);
            assert.equal((await request("/payroll/roster-gaps?search=unrelated", undefined, business)).data.length, 0);
            assert.equal((await request("/payroll/roster-gaps?status=Paid", undefined, business)).data.length, 0);
            assert.equal((await request("/payroll/roster-gaps?status=Not%20generated", undefined, business)).data.length, 1);
            assert.deepEqual((await request("/payroll/records?status=Not%20generated", undefined, business)).data, []);
        }
        for (const invalid of ["invalid cutoff", "Sep 21, 2026 - Oct 5, 2026", "Oct 6, 2026 - Nov 5, 2026"]) {
            assert.equal((await request(`/payroll/records?payPeriod=${encodeURIComponent(invalid)}`, undefined, business)).status, 422);
        }
        assert.equal(JSON.stringify(await runWithBusiness(business, () => PayrollRecord.find().sort({ _id: 1 }).lean())), before[index]);
    }
    assert.equal((await request("/payroll/cutoffs", undefined, businesses[0], "forged")).status, 401);
    assert.equal((await request("/payroll/roster-gaps", undefined, businesses[0], "forged")).status, 401);
    context.mock.timers.setTime(Date.parse("2026-11-11T08:00:00Z"));
    token = createAdminDashboardSession("90000001")!;
    assert.equal((await request("/payroll/cutoffs")).data.defaultPayPeriod, "Nov 6, 2026 - Nov 20, 2026");
    assert.deepEqual((await request("/payroll/records")).data, []);
    assert.equal((await request("/payroll/roster-gaps")).data.length, 2);
    assert.equal((await request("/payroll/stats")).data.recordedEmployees, 0);
});

test("ambiguous current cutoff aliases stay visible as conflicts, never as generated or payable records", async context => {
    context.mock.timers.enable({ apis: ["Date"], now: new Date("2026-10-26T08:00:00Z") });
    context.after(() => context.mock.timers.reset());
    const previousToken = token; token = createAdminDashboardSession("90000001")!; context.after(() => { token = previousToken; });
    for (const business of businesses) await runWithBusiness(business, async () => {
        await SystemSettings.updateOne({ key: "system" }, { payrollBillingCycle: "Semi-monthly" });
        const source = await saved(business); assert.ok(source); const { _id, ...value } = source; void _id;
        await PayrollRecord.create({ ...value, payPeriod: "2026-10-21 - 2026-11-05" });
        await PayrollRecord.create({ ...value, payPeriod: "October 21, 2026 - November 5, 2026", deductions: value.deductions + 1, netPay: value.netPay - 1 });
        const before = JSON.stringify(await PayrollRecord.find().sort({ _id: 1 }).lean());
        const gaps = await request("/payroll/roster-gaps", undefined, business); assert.equal(gaps.data.length, 1); assert.equal(gaps.data[0].state, "conflict");
        assert.deepEqual((await request("/payroll/records", undefined, business)).data, []);
        assert.equal((await request("/payroll/roster-gaps?status=Review%20required", undefined, business)).data.length, 1);
        assert.equal((await request("/payroll/roster-gaps?status=Not%20generated", undefined, business)).data.length, 0);
        assert.equal(JSON.stringify(await PayrollRecord.find().sort({ _id: 1 }).lean()), before);
    });
});

test("automatic current-cutoff previews include non-billable deductions, exclude saved aliases and paid records, and never write across six businesses", async context => {
    context.mock.timers.enable({ apis: ["Date"], now: new Date("2026-10-20T08:00:00Z") });
    context.after(() => context.mock.timers.reset());
    const previousToken = token; token = createAdminDashboardSession("90000001")!; context.after(() => { token = previousToken; });
    const ledger = await AttendanceLedger.findById("synthetic-hours").lean(); assert.ok(ledger);
    const first = ledger.events[0];
    const events: SessionEvent[] = [first,
        { ...first, id: "auto-nb", commandId: "auto-nb", source: "Non-Billable Off the Phone Out", sequence: 1, at: "2026-10-15T16:00:00Z" },
        { ...first, id: "auto-back", commandId: "auto-back", source: "Off the Phone In", sequence: 2, at: "2026-10-15T16:10:01Z" },
        { ...first, id: "auto-end", commandId: "auto-end", source: "Time Out", sequence: 3, at: "2026-10-16T00:00:00Z" }];
    await AttendanceLedger.updateOne({ _id: ledger._id }, { events, revision: 2 });
    const originals: string[] = [];
    for (const business of businesses) await runWithBusiness(business, async () => {
        const original = await saved(business); assert.ok(original);
        const { _id, ...value } = original; void _id;
        await PayrollRecord.deleteMany({});
        for (const [employeeCode, status, isArchived, payPeriod] of [["90000004", "Paid", false, period], ["90000005", "Pending", false, "October 6, 2026 - October 20, 2026"],
            ["90000006", "Paid", true, "2026-10-06 - 2026-10-20"]] as const) {
            await Employee.create({ employeeCode, name: `Synthetic Saved ${employeeCode}`, role: "Sales", status: "Active", salary: 30000 });
            await PayrollRecord.create({ ...value, employeeId: employeeCode, status, isArchived, payPeriod });
        }
        await SystemSettings.updateOne({ key: "system" }, { payrollBillingCycle: "Semi-monthly" });
        const employee = await Employee.findOne({ employeeCode: code }).lean(); assert.ok(employee);
        await Attendance.deleteMany({ employee: employee._id });
        await Attendance.insertMany(events.map(event => ({ employee: employee._id, source: event.source, timeIn: new Date(event.at), eventId: event.id,
            sequence: event.sequence, ledgerIdentity: ledger._id, ledgerRevision: 2, isEffective: true })));
        originals.push(JSON.stringify(await PayrollRecord.find().sort({ _id: 1 }).lean()));
    });
    const originalLedger = JSON.stringify(await AttendanceLedger.find().lean());
    for (const [index, business] of businesses.entries()) {
        for (let refresh = 0; refresh < 2; refresh++) {
            const result = await request("/payroll/current-previews", undefined, business);
            assert.equal(result.status, 200, JSON.stringify(result.data));
            assert.equal(result.data.previewOnly, true); assert.equal(result.data.businessId, business); assert.equal(result.data.payPeriod, period);
            assert.equal(result.data.rows.length, 1); const row = result.data.rows[0], value = row.calculation;
            assert.equal(row.employeeCode, code); assert.equal(value.nonBillableOffPhoneMinutes, 11); assert.ok(value.scheduledDays > 0);
            assert.ok(row.warnings.some((message: string) => message.includes("Cutoff in progress")));
            assert.equal(Math.round(value.grossPay * 100) - Math.round(value.deductions * 100), Math.round(value.netPay * 100));
            assert.equal(value.deductionDetails.reduce((sum: number, item: { amount: number }) => sum + Math.round(item.amount * 100), 0), Math.round(value.deductions * 100));
            assert.equal(value.nonBillableOffPhoneDeduction, value.deductionDetails.find((item: { label: string }) => item.label === "Non-billable Off the Phone").amount);
            assert.equal("token" in result.data, false); assert.equal("status" in row, false); assert.equal("_id" in row, false);
        }
        assert.equal(JSON.stringify(await runWithBusiness(business, () => PayrollRecord.find().sort({ _id: 1 }).lean())), originals[index]);
    }
    assert.equal((await request("/payroll/current-previews?payPeriod=Sep%2021,%202026%20-%20Oct%205,%202026")).status, 422);
    assert.equal((await request("/payroll/current-previews", undefined, businesses[0], "forged")).status, 401);
    assert.equal((await fetch(`${base}/payroll/current-previews`, { method: "POST", headers: { "X-Business-Id": businesses[0], "X-CRM-Admin-Session": token } })).status, 404);
    context.mock.timers.setTime(Date.parse("2026-10-26T08:00:00Z")); token = createAdminDashboardSession("90000001")!;
    const next = await request("/payroll/current-previews"); assert.equal(next.status, 200);
    assert.equal(next.data.payPeriod, "Oct 21, 2026 - Nov 5, 2026"); assert.ok(next.data.rows.some((row: { employeeCode: string }) => row.employeeCode === code));
    assert.equal((await request(`/payroll/current-previews?payPeriod=${encodeURIComponent(period)}`)).status, 422);
    for (const [index, business] of businesses.entries()) assert.equal(JSON.stringify(await runWithBusiness(business, () => PayrollRecord.find().sort({ _id: 1 }).lean())), originals[index]);
    assert.equal(JSON.stringify(await AttendanceLedger.find().lean()), originalLedger);
});
