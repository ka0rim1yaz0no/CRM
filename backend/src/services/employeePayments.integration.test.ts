import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import { before, after, test } from "node:test";
import mongoose from "mongoose";
import { MongoMemoryReplSet } from "mongodb-memory-server";

const prefix = `employee_payments_${crypto.randomUUID().replaceAll("-", "")}`;
const businesses = Array.from({ length: 6 }, (_, index) => `payments-${index}`);
Object.assign(process.env, { NODE_ENV: "test", CRM_SECURITY_LEGACY_AUTH: "true", CRM_PAYROLL_ACCURACY: "true", CRM_ATTENDANCE_INTEGRITY: "true", CRM_ADMIN_ONE_CODE: "synthetic-payments-admin",
    CRM_ADMIN_TWO_CODE: "synthetic-payments-tracker", CRM_ADMIN_TWO_ACCESS: "tracker",
    CRM_ADMIN_SESSION_SECRET: crypto.randomBytes(48).toString("hex"),
    DEFAULT_BUSINESS_ID: businesses[0], DEFAULT_BUSINESS_DATABASE: `${prefix}_0`, CONTROL_DATABASE_NAME: `${prefix}_control`,
    BUSINESS_DATABASES: JSON.stringify(businesses.map((id, index) => ({ id, databaseName: `${prefix}_${index}` }))) });
const { createApp } = await import("../app");
const { runWithBusiness } = await import("../config/tenancy");
const { Employee } = await import("../models/Employee");
const { PayrollRecord } = await import("../models/Payroll");
const { Attendance } = await import("../models/Attendance");
const { EmployeePaymentHistoryPolicy } = await import("../models/EmployeePaymentHistoryPolicy");
const { SystemSettings } = await import("../models/SystemSettings");
const { initializeEmployeePaymentHistory } = await import("./employeePayments");
const { setBusinessAccessForEmployeeCode } = await import("../models/BusinessUserAccess");
const { createAttendanceHubSession } = await import("../config/attendanceHubSession");
const { createAdminDashboardSession } = await import("../config/adminDashboardSession");
let mongo: MongoMemoryReplSet, server: http.Server, base = "";
const people: Array<{ own: string; other: string }> = [];
const code = "synthetic-payment-employee";
const payment = { employeeId: code, employeeName: "Synthetic Payment Employee", department: "Fixture", payType: "Semi-monthly" as const,
    payPeriod: "Oct 6, 2026 - Oct 20, 2026", basicPay: 15000, grossPay: 15000, deductions: 48.91, netPay: 14951.09, status: "Pending" as const,
    lateMinutes: 12, excessBreakMinutes: 6, deductibleMinutes: 18, hourlyRate: 163.04, minuteRate: 2.72,
    email: "private@example.invalid", calculationAudit: [{ at: "2026-10-23T12:00:00Z", actor: "synthetic", reason: "private audit", before: {}, after: {} }],
    calculationSnapshot: { monthlySalary: 30000, evidence: [{ private: true }] } };
before(async () => {
    mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    assert.equal(new URL(mongo.getUri(prefix)).hostname, "127.0.0.1");
    await mongoose.connect(mongo.getUri(prefix));
    server = http.createServer(createApp()); await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`;
    await setBusinessAccessForEmployeeCode(code, businesses);
    for (const business of businesses) await runWithBusiness(business, async () => {
        const own = await Employee.create({ employeeCode: code, name: "Synthetic Payment Employee", status: "Active" });
        const other = await Employee.create({ employeeCode: "synthetic-other", name: "Synthetic Other Employee", status: "Active" });
        people.push({ own: String(own._id), other: String(other._id) });
        await PayrollRecord.create(payment);
        await PayrollRecord.create({ ...payment, payPeriod: "Sep 21, 2026 - Oct 5, 2026" });
        await PayrollRecord.create({ ...payment, employeeId: "synthetic-other", grossPay: 99999, netPay: 99950.09 });
        await PayrollRecord.create({ ...payment, isArchived: true });
    });
});
after(async () => { server?.closeAllConnections(); server?.close(); await mongoose.disconnect(); await mongo?.stop(); });
const request = (index: number, token: string | null, suffix = "", own = true, headers = {}) => fetch(`${base}/employees/${own ? people[index].own : people[index].other}/payments${suffix}`,
    { headers: { "X-Business-Id": businesses[index], ...(token ? { "X-CRM-Attendance-Session": token } : {}), ...headers } });

test("employee history starts at the admin's configured current cutoff, is frozen once, and GET never writes", async context => {
    context.mock.timers.enable({ apis: ["Date"], now: new Date("2026-10-23T12:00:00Z") });
    try {
        const token = createAttendanceHubSession(code)!;
        const missing = await (await request(0, token)).json(); assert.equal(missing.setupPending, true); assert.deepEqual(missing.items, []);
        const dry = await initializeEmployeePaymentHistory(); assert.equal(dry.dryRun, true); assert.equal(dry.businesses.length, 6);
        for (const business of businesses) await runWithBusiness(business, async () => assert.equal(await EmployeePaymentHistoryPolicy.countDocuments(), 0));
        const applied = await initializeEmployeePaymentHistory(true);
        assert.ok(applied.businesses.every(item => item.fromDate === "2026-10-06"));
        for (let index = 0; index < 6; index++) {
            for (let refresh = 0; refresh < 2; refresh++) {
                const response = await request(index, token); assert.equal(response.status, 200); assert.match(response.headers.get("cache-control")!, /no-store/);
                const body = await response.json(); assert.equal(body.total, 1); assert.equal(body.currentPayPeriod, payment.payPeriod);
                assert.equal(body.historyFrom, "2026-10-06"); assert.equal(body.items[0].netPay, payment.netPay);
                assert.equal(body.items[0].scheduledPayDate, "2026-10-25"); assert.equal(body.items[0].paidOn, null);
                assert.equal(body.items[0].monthlySalary, 30000);
                for (const key of ["email", "calculationAudit", "calculationSnapshot", "employeeName", "employeeId"]) assert.equal(key in body.items[0], false, key);
            }
            await runWithBusiness(businesses[index], async () => {
                assert.equal(await PayrollRecord.countDocuments(), 4); assert.equal(await Attendance.countDocuments(), 0);
                const row = await PayrollRecord.findOne({ employeeId: code, isArchived: false, payPeriod: payment.payPeriod }).lean();
                assert.equal(row!.netPay, payment.netPay); assert.equal(row!.status, "Pending");
            });
        }
        context.mock.timers.setTime(Date.parse("2026-11-26T12:00:00Z"));
        const repeated = await initializeEmployeePaymentHistory(true);
        assert.ok(repeated.businesses.every(item => item.existing && item.fromDate === "2026-10-06"));
        assert.equal((await (await request(0, createAttendanceHubSession(code)!, "?view=history")).json()).total, 1);
    } finally { context.mock.timers.reset(); }
});

test("signed own-record authorization remains enforced with legacy authentication on or off in every tenant", async () => {
    const token = createAttendanceHubSession(code)!, tracker = createAttendanceHubSession("synthetic-payments-tracker")!;
    try {
        for (const flag of ["true", "false"]) {
            process.env.CRM_SECURITY_LEGACY_AUTH = flag;
            for (let index = 0; index < 6; index++) {
                assert.equal((await request(index, token)).status, 200);
                assert.equal((await request(index, token, "", false)).status, 403);
                assert.equal((await request(index, tracker)).status, 403);
                assert.equal((await request(index, null, "", true, { "X-CRM-User-Code": code, "X-CRM-User-Type": "employee" })).status, 401);
                assert.equal((await request(index, "forged.token")).status, 401);
                assert.equal((await request(index, token, "?page=-1")).status, 400);
                const admin = await request(index, null, "", true, { "X-CRM-Admin-Session": createAdminDashboardSession("synthetic-payments-admin")! });
                assert.equal(admin.status, 200);
                const payroll = await fetch(`${base}/payroll/records`, { headers: { "X-Business-Id": businesses[index], "X-CRM-Attendance-Session": token } });
                assert.equal(payroll.status, 403, "the admin payroll API remains admin-only");
            }
        }
        await setBusinessAccessForEmployeeCode(code, [businesses[0]]);
        assert.equal((await request(1, token)).status, 403);
        await runWithBusiness(businesses[0], () => Employee.updateOne({ _id: people[0].own }, { $set: { status: "Archived" } }));
        assert.equal((await request(0, token)).status, 403);
    } finally {
        process.env.CRM_SECURITY_LEGACY_AUTH = "true";
        await setBusinessAccessForEmployeeCode(code, businesses);
        await runWithBusiness(businesses[0], () => Employee.updateOne({ _id: people[0].own }, { $set: { status: "Active" } }));
    }
});

test("fresh reads reflect saved payment status and deductions, with no recalculation or historical record changes", async context => {
    context.mock.timers.enable({ apis: ["Date"], now: new Date("2026-10-23T12:00:00Z") });
    context.after(() => context.mock.timers.reset());
    const token = createAttendanceHubSession(code)!;
    for (let index = 0; index < 6; index++) {
        await runWithBusiness(businesses[index], async () => {
            await PayrollRecord.updateOne({ employeeId: code, payPeriod: payment.payPeriod, isArchived: false },
                { $set: { status: "Paid", paidOn: "Oct 25, 2026", deductions: 49.01, netPay: 14950.99 } });
            await SystemSettings.updateOne({ key: "system" }, { $set: { currencyCode: "PHP" } }, { upsert: true });
        });
        for (let refresh = 0; refresh < 2; refresh++) {
            const body = await (await request(index, token)).json();
            assert.equal(body.items[0].status, "Paid"); assert.equal(body.items[0].paidOn, "Oct 25, 2026");
            assert.equal(body.items[0].deductions, 49.01); assert.equal(body.items[0].netPay, 14950.99);
        }
    }
});

test("invalid and conflicting cutoffs are flagged instead of guessed; filtering happens before pagination", async () => {
    const token = createAttendanceHubSession(code)!;
    await runWithBusiness(businesses[0], async () => {
        await PayrollRecord.insertMany([
            { ...payment, payPeriod: "Oct 21, 2026 - Nov 5, 2026" }, { ...payment, payPeriod: "Oct 21, 2026 - Nov 5, 2026", deductions: 0, netPay: 15000 },
            { ...payment, payPeriod: "Nov 6, 2026 - Nov 20, 2026", netPay: 1 }, { ...payment, payPeriod: "Current Month" },
        ]);
        for (let year = 2020; year < 2026; year++) for (let month = 0; month < 12; month++) {
            const start = new Date(year, month, 6).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
            const end = new Date(year, month, 20).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
            await PayrollRecord.create({ ...payment, payPeriod: `${start} - ${end}` });
        }
    });
    const body = await (await request(0, token, "?view=history")).json(); assert.equal(body.total, 1); assert.equal(body.items[0].payPeriod, payment.payPeriod); assert.equal(body.reviewCount, 2);
    assert.equal((await (await request(0, token, "?page=2")).json()).items.length, 0);
});

test("current-only is the default; history excludes old and overlapping monthly cutoffs; aliases never change saved payment status", async context => {
    context.mock.timers.enable({ apis: ["Date"], now: new Date("2026-10-23T12:00:00Z") });
    context.after(() => context.mock.timers.reset());
    const employeeCode = "synthetic-alias-employee";
    await setBusinessAccessForEmployeeCode(employeeCode, businesses);
    for (let index = 0; index < businesses.length; index++) {
        const seeded = await runWithBusiness(businesses[index], async () => {
            const person = await Employee.create({ employeeCode, name: "Synthetic Alias Employee", status: "Active" });
            const canonical = await PayrollRecord.create({ ...payment, employeeId: employeeCode });
            await PayrollRecord.create({ ...payment, employeeId: employeeCode, payPeriod: "2026-10-06 - 2026-10-20",
                ...(index % 3 === 1 ? { status: "Paid", paidOn: "Oct 25, 2026" } : index % 3 === 2 ? { deductions: 0, netPay: 15000 } : {}) });
            await PayrollRecord.create({ ...payment, employeeId: employeeCode, payPeriod: "Oct 21, 2026 - Nov 5, 2026" });
            await PayrollRecord.create({ ...payment, employeeId: employeeCode, payPeriod: "Oct 6, 2026 - Nov 5, 2026", payType: "Monthly", grossPay: 0, deductions: 0, netPay: 0, status: "Review" });
            await PayrollRecord.create({ ...payment, employeeId: employeeCode, payPeriod: "May 2026 16-End" });
            return { person, canonical, before: JSON.stringify(await PayrollRecord.find({ employeeId: employeeCode }).sort({ _id: 1 }).lean()) };
        });
        const headers = { "X-Business-Id": businesses[index], "X-CRM-Attendance-Session": createAttendanceHubSession(employeeCode)! };
        for (let refresh = 0; refresh < 2; refresh++) {
            const current = await (await fetch(`${base}/employees/${seeded.person._id}/payments`, { headers })).json();
            assert.equal(current.view, "current"); assert.equal(current.total, 1); assert.equal(current.items[0].id, String(seeded.canonical._id));
            assert.equal(current.items[0].status, "Pending"); assert.equal(current.items[0].deductions, payment.deductions);
            assert.equal(current.items[0].requiresReview, index % 3 !== 0); assert.equal(current.reviewCount, index % 3 === 0 ? 0 : 1);
            const history = await (await fetch(`${base}/employees/${seeded.person._id}/payments?view=history`, { headers })).json();
            assert.equal(history.total, 2); assert.ok(history.items.every((item: { cutoffStart: string; payPeriod: string }) => item.cutoffStart >= "2026-10-06" && item.payPeriod !== "Oct 6, 2026 - Nov 5, 2026"));
            const adminHeaders = { "X-Business-Id": businesses[index], "X-CRM-Admin-Session": createAdminDashboardSession("synthetic-payments-admin")! };
            const admin = await (await fetch(`${base}/payroll/records?payPeriod=${encodeURIComponent(payment.payPeriod)}&search=${employeeCode}`, { headers: adminHeaders })).json();
            assert.equal(admin.length, 1); assert.equal(String(admin[0]._id), current.items[0].id);
            for (const key of ["grossPay", "deductions", "netPay", "status", "requiresReview"]) assert.equal(admin[0][key], current.items[0][key]);
            const paidFilter = await (await fetch(`${base}/payroll/records?payPeriod=${encodeURIComponent(payment.payPeriod)}&search=${employeeCode}&status=Paid`, { headers: adminHeaders })).json();
            assert.equal(paidFilter.length, 0, "an alternate Paid label cannot override the canonical Pending record");
        }
        const paidAttempt = await fetch(`${base}/payroll/records/${seeded.canonical._id}/paid`, { method: "PATCH", headers: {
            "X-Business-Id": businesses[index], "X-CRM-Admin-Session": createAdminDashboardSession("synthetic-payments-admin")! } });
        assert.equal(paidAttempt.status, 422, "an alias group must be reviewed before payment status can change");
        await runWithBusiness(businesses[index], async () => assert.equal(JSON.stringify(await PayrollRecord.find({ employeeId: employeeCode }).sort({ _id: 1 }).lean()), seeded.before));
    }
});

test("each business freezes its own configured cutoff and later payroll periods accumulate without moving history", async context => {
    context.mock.timers.enable({ apis: ["Date"], now: new Date("2026-10-23T12:00:00Z") });
    try {
        await runWithBusiness(businesses[5], async () => {
            await EmployeePaymentHistoryPolicy.deleteOne({ _id: "employee-payment-history" });
            await SystemSettings.updateOne({ key: "system" }, { $set: { payrollBillingCycle: "Semi-monthly",
                payrollFirstCutoffStartDay: 1, payrollFirstCutoffEndDay: 15, payrollFirstCutoffPayDay: 20,
                payrollSecondCutoffStartDay: 16, payrollSecondCutoffEndDay: 31, payrollSecondCutoffPayDay: 5 } }, { upsert: true });
            await PayrollRecord.create({ ...payment, payPeriod: "Oct 16, 2026 - Oct 31, 2026" });
        });
        const activated = await initializeEmployeePaymentHistory(true);
        assert.equal(activated.businesses[5].fromDate, "2026-10-16"); assert.equal(activated.businesses[0].fromDate, "2026-10-06");
        const fresh = await (await request(5, createAttendanceHubSession(code)!)).json();
        assert.equal(fresh.items.length, 1); assert.equal(fresh.items[0].scheduledPayDate, "2026-11-05");
        context.mock.timers.setTime(Date.parse("2026-11-10T12:00:00Z"));
        await runWithBusiness(businesses[5], () => PayrollRecord.create({ ...payment, payPeriod: "Nov 1, 2026 - Nov 15, 2026" }));
        await initializeEmployeePaymentHistory(true);
        const later = await (await request(5, createAttendanceHubSession(code)!, "?view=history")).json();
        assert.equal(later.historyFrom, "2026-10-16"); assert.equal(later.items.length, 2);
        assert.equal(later.items[0].payPeriod, "Nov 1, 2026 - Nov 15, 2026");
    } finally { context.mock.timers.reset(); }
});
