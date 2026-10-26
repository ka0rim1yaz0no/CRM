import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import { after, before, beforeEach, mock, test } from "node:test";
import mongoose from "mongoose";
import { MongoMemoryReplSet } from "mongodb-memory-server";

const root = `generation_${crypto.randomUUID().replaceAll("-", "")}`, businesses = Array.from({ length: 6 }, (_, i) => `generation-${i}`);
Object.assign(process.env, { NODE_ENV: "test", CRM_PAYROLL_ACCURACY: "true", CRM_ATTENDANCE_DURATION_MODEL: "true", CRM_ATTENDANCE_INTEGRITY: "true",
    CRM_ATTENDANCE_AUTO_TIMEOUT: "false", CRM_ATTENDANCE_RECOVERY_CUTOFF: "false", CRM_ADMIN_ONE_CODE: "90000001",
    CRM_ADMIN_SESSION_SECRET: crypto.randomBytes(48).toString("hex"), DEFAULT_BUSINESS_ID: businesses[0], DEFAULT_BUSINESS_DATABASE: `${root}_0`,
    CONTROL_DATABASE_NAME: `${root}_control`, BUSINESS_DATABASES: JSON.stringify(businesses.map((id, i) => ({ id, name: `Synthetic Generation ${i}`, databaseName: `${root}_${i}` }))) });
const { createApp } = await import("../app");
const { Employee } = await import("../models/Employee");
const { Attendance } = await import("../models/Attendance");
const { AttendanceLedger, AttendancePolicy } = await import("../models/AttendanceLedger");
const { PayrollRecord } = await import("../models/Payroll");
const { PayrollGenerationPolicy } = await import("../models/PayrollGenerationPolicy");
const { EmployeePaymentHistoryPolicy } = await import("../models/EmployeePaymentHistoryPolicy");
const { SystemSettings } = await import("../models/SystemSettings");
const { runWithBusiness, getBusinessConnection } = await import("../config/tenancy");
const { setBusinessAccessForEmployeeCode } = await import("../models/BusinessUserAccess");
const { createAdminDashboardSession } = await import("../config/adminDashboardSession");
const { assignAttendanceShift } = await import("./attendanceShift");
const { calculatePayrollCandidate } = await import("./payrollRecomputeService");
const { generateFutureMissingPayroll } = await import("./payrollMissingGeneration");
const { employeePayments } = await import("./employeePayments");
const period = "Oct 21, 2026 - Nov 5, 2026", code = "90000003";
let mongo: MongoMemoryReplSet, server: http.Server, base = "", token = "";
before(async () => {
    mock.timers.enable({ apis: ["Date"], now: new Date("2026-10-26T08:00:00Z") });
    mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } }); await mongoose.connect(mongo.getUri(root));
    server = http.createServer(createApp()); await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`;
});
after(async () => {
    if (server?.listening) await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
    await mongoose.disconnect(); await mongo?.stop(); mock.timers.reset();
});
beforeEach(async () => {
    mock.timers.setTime(Date.parse("2026-10-26T08:00:00Z")); token = createAdminDashboardSession("90000001")!;
    await AttendanceLedger.deleteMany({}); await AttendancePolicy.deleteMany({});
    await AttendancePolicy.create({ _id: "global-attendance", revision: 1, shiftStart: "23:00", shiftEnd: "08:00", breakMinutes: 15, lunchMinutes: 60, graceMinutes: 0 });
    const times = ["2026-10-22T15:00:00Z", "2026-10-22T16:00:00Z", "2026-10-22T16:10:01Z", "2026-10-23T00:00:00Z"];
    const events = (["Time In", "Non-Billable Off the Phone Out", "Off the Phone In", "Time Out"] as const).map((source, i) => ({
        id: `event-${i}`, commandId: `event-${i}`, source, at: times[i], recordedAt: times[i], sequence: i,
        ...(i === 0 ? { shift: assignAttendanceShift(new Date(times[0])) } : {}),
    }));
    await setBusinessAccessForEmployeeCode(code, businesses);
    await setBusinessAccessForEmployeeCode("90000004", businesses);
    await AttendanceLedger.create({ _id: "generation-attendance", employeeCode: code, canonicalBusinessId: businesses[0], businessIds: businesses, revision: 1, events });
    for (const business of businesses) await runWithBusiness(business, async () => {
        await Employee.deleteMany({}); await Attendance.deleteMany({}); await PayrollRecord.deleteMany({});
        await SystemSettings.deleteMany({}); await EmployeePaymentHistoryPolicy.deleteMany({}); await PayrollGenerationPolicy.deleteMany({});
        await PayrollRecord.init(); await PayrollGenerationPolicy.createCollection();
        await SystemSettings.create({ key: "system", payrollBillingCycle: "Semi-monthly" });
        await EmployeePaymentHistoryPolicy.create({ _id: "employee-payment-history", fromDate: "2026-10-06", initialPayPeriod: "Oct 6, 2026 - Oct 20, 2026", activatedAt: new Date() });
        const person = await Employee.create({ employeeCode: code, name: "Synthetic Missing Employee", email: "generation@example.invalid", role: "Sales", salary: 30000, status: "Active" });
        await Attendance.insertMany(events.map(event => ({ employee: person._id, source: event.source, timeIn: new Date(event.at), eventId: event.id,
            sequence: event.sequence, ledgerIdentity: "generation-attendance", ledgerRevision: 1, isEffective: true })));
        await Employee.create({ employeeCode: "90000004", name: "Synthetic Saved Employee", role: "Sales", salary: 30000, status: "Active" });
        await PayrollRecord.create({ employeeId: "90000004", employeeName: "Synthetic Saved Employee", department: "Synthetic", payPeriod: period,
            payType: "Semi-monthly", grossPay: 15000, deductions: 250, netPay: 14750, status: "Paid", paidOn: "Oct 26, 2026", isArchived: false });
    });
});
async function request(route: string, body: unknown, business = businesses[0], auth = token) {
    const response = await fetch(base + route, { method: "POST", headers: { "Content-Type": "application/json", "X-Business-Id": business, "X-CRM-Admin-Session": auth }, body: JSON.stringify(body) });
    return { status: response.status, data: await response.json() };
}
const preview = () => request("/payroll/missing/preview", { payPeriod: period });
const confirm = (plan: { token: string }, extra = {}) => request("/payroll/missing/confirm", { payPeriod: period, token: plan.token, confirm: true, reason: "Synthetic missing-only generation", enableFuture: false, ...extra });
const records = () => Promise.all(businesses.map(business => runWithBusiness(business, () => PayrollRecord.find().sort({ _id: 1 }).lean())));

test("missing-only generation preserves saved paid records, includes non-billable deductions and refreshes Payroll/Payments in six businesses", async () => {
    const before = await records(), ledger = JSON.stringify(await AttendanceLedger.find().lean());
    const plan = await preview(); assert.equal(plan.status, 200, JSON.stringify(plan.data)); assert.equal(plan.data.rows.length, 1);
    assert.equal(plan.data.rows[0].nonBillableOffPhoneMinutes, 11); assert.ok(plan.data.rows[0].nonBillableOffPhoneDeduction > 0);
    assert.deepEqual(await records(), before); assert.equal(plan.data.rows[0].businessIds.length, 6);
    const applied = await confirm(plan.data); assert.equal(applied.status, 200, JSON.stringify(applied.data)); assert.equal(applied.data.created, 1); assert.equal(applied.data.mirrors, 6);
    for (const [i, business] of businesses.entries()) await runWithBusiness(business, async () => {
        for (let refresh = 0; refresh < 2; refresh++) {
            const result = await PayrollRecord.findOne({ employeeId: code }).lean(); assert.ok(result);
            assert.equal(result.nonBillableOffPhoneMinutes, 11); assert.equal(result.deductions, plan.data.rows[0].deductions);
            assert.ok(!["Paid", "Completed"].includes(result.status)); assert.equal(result.calculationAudit?.length, 1);
            const payments = await employeePayments(code, 1, "history"); assert.equal(payments.items.length, 1);
            assert.equal(payments.items[0].netPay, result.netPay); assert.equal(payments.items[0].status, result.status);
            assert.deepEqual(await PayrollRecord.find({ employeeId: "90000004" }).lean(), before[i]);
        }
    });
    assert.equal(JSON.stringify(await AttendanceLedger.find().lean()), ledger);
    assert.equal((await preview()).data.rows.length, 0); assert.equal((await confirm(plan.data)).status, 409);
});

test("simultaneous confirmations insert only one cutoff and one audit in every business", async () => {
    const plan = await preview(); const results = await Promise.all([confirm(plan.data), confirm(plan.data)]);
    assert.deepEqual(results.map(result => result.status).sort(), [200, 409]);
    for (const business of businesses) await runWithBusiness(business, async () => {
        assert.equal(await PayrollRecord.countDocuments({ employeeId: code }), 1);
        assert.equal((await PayrollRecord.findOne({ employeeId: code }).lean())?.calculationAudit?.length, 1);
    });
});

test("changed attendance, unverified access, invalid confirmation and wrong cutoff cannot write", async () => {
    const before = await records(), plan = await preview();
    assert.equal((await confirm(plan.data, { confirm: false })).status, 400);
    assert.equal((await confirm(plan.data, { reason: " " })).status, 400);
    assert.equal((await confirm(plan.data, { enableFuture: "true" })).status, 400);
    assert.equal((await request("/payroll/missing/confirm", {}, businesses[0], "forged")).status, 401);
    assert.equal((await request("/payroll/missing/preview", { payPeriod: "Nov 6, 2026 - Nov 20, 2026" })).status, 409);
    await AttendanceLedger.updateOne({ _id: "generation-attendance" }, { $inc: { revision: 1 } });
    assert.equal((await confirm(plan.data)).status, 409); assert.deepEqual(await records(), before);
});

test("a change immediately before transaction and a failed mirror insert roll back the entire generation", async () => {
    const before = await records(), plan = await preview(), start = mongoose.startSession.bind(mongoose);
    const changed = mock.method(mongoose, "startSession", async (...args: Parameters<typeof mongoose.startSession>) => {
        await AttendanceLedger.updateOne({ _id: "generation-attendance" }, { $inc: { revision: 1 } }); return start(...args);
    });
    try { assert.equal((await confirm(plan.data)).status, 409); } finally { changed.mock.restore(); }
    assert.deepEqual(await records(), before);
    const fresh = await preview();
    const failed = mock.method(getBusinessConnection(businesses[1]).model("PayrollRecord"), "create", () => { throw new Error("Synthetic mirror failure"); });
    try { assert.equal((await confirm(fresh.data, { enableFuture: true })).status, 500); } finally { failed.mock.restore(); }
    assert.deepEqual(await records(), before); assert.equal(await PayrollGenerationPolicy.countDocuments(), 0);
});

test("overlapping payable history and inconsistent mirrors are held without changing history", async () => {
    await runWithBusiness(businesses[3], () => PayrollRecord.create({ employeeId: code, employeeName: "Synthetic Missing Employee", department: "Synthetic",
        payPeriod: "Oct 6, 2026 - Nov 5, 2026", grossPay: 15000, deductions: 0, netPay: 15000, status: "Pending" }));
    const before = await records(), plan = await preview(); assert.equal(plan.status, 200); assert.equal(plan.data.rows.length, 0);
    assert.match(plan.data.held[0].reason, /overlapping/); assert.deepEqual(await records(), before);
    await runWithBusiness(businesses[3], () => PayrollRecord.deleteMany({ employeeId: code }));
    await runWithBusiness(businesses[2], () => Employee.updateOne({ employeeCode: code }, { salary: 60000 }));
    assert.match((await preview()).data.held[0].reason, /inputs differ/);
});

test("saved date aliases, archived drafts and archived paid history never reappear as new payroll", async () => {
    await runWithBusiness(businesses[0], () => PayrollRecord.create({ employeeId: code, employeeName: "Synthetic Missing Employee", department: "Synthetic",
        payPeriod: "2026-10-21 - 2026-11-05", grossPay: 15000, deductions: 0, netPay: 15000, status: "Pending", isArchived: true }));
    assert.equal((await preview()).data.rows.length, 0);
    await runWithBusiness(businesses[0], () => PayrollRecord.deleteMany({ employeeId: code }));
    await runWithBusiness(businesses[1], () => PayrollRecord.create({ employeeId: code, employeeName: "Synthetic Missing Employee", department: "Synthetic",
        payPeriod: "October 21, 2026 - November 5, 2026", grossPay: 15000, deductions: 0, netPay: 15000, status: "Paid", isArchived: true }));
    const plan = await preview(); assert.equal(plan.data.rows.length, 0); assert.match(plan.data.held[0].reason, /already has/);
});

test("opt-in future generation follows the configured rollover once and never rewrites current or paid payroll", async () => {
    assert.equal(await generateFutureMissingPayroll(), null);
    const plan = await preview(); assert.equal((await confirm(plan.data, { enableFuture: true })).status, 200);
    const current = await records(); assert.equal(await generateFutureMissingPayroll(), null); assert.deepEqual(await records(), current);
    const policy = await PayrollGenerationPolicy.findById("missing-current-payroll").lean(); assert.ok(policy); assert.equal(policy.startsAfter, "2026-11-05");
    mock.timers.setTime(Date.parse("2026-11-11T08:00:00Z")); token = createAdminDashboardSession("90000001")!;
    const generated = await generateFutureMissingPayroll(); assert.ok(generated); assert.equal(generated.created, 2); assert.equal(generated.mirrors, 12);
    assert.equal(generated.payPeriod, "Nov 6, 2026 - Nov 20, 2026");
    for (const [i, business] of businesses.entries()) await runWithBusiness(business, async () => {
        const existing = await PayrollRecord.find({ _id: { $in: current[i].map(record => record._id) } }).sort({ _id: 1 }).lean(); assert.deepEqual(existing, current[i]);
        const person = await Employee.findOne({ employeeCode: code }).lean(); assert.ok(person);
        const next = await PayrollRecord.findOne({ employeeId: code, payPeriod: generated.payPeriod }).lean(); assert.ok(next);
        assert.equal(next.netPay, (await calculatePayrollCandidate(person, generated.payPeriod)).value.netPay);
    });
    const after = await records(); assert.equal(await generateFutureMissingPayroll(), null); assert.deepEqual(await records(), after);
    assert.equal(await runWithBusiness(businesses[1], () => generateFutureMissingPayroll()), null, "a business without opt-in never schedules generation");
});
