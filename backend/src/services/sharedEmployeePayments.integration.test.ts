import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import { before, after, test } from "node:test";
import mongoose from "mongoose";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import type { Collection } from "mongodb";
import type { AttendanceLedgerDocument } from "../models/AttendanceLedger";

const prefix = `shared_payments_${crypto.randomUUID().replaceAll("-", "")}`;
const businesses = Array.from({ length: 7 }, (_, index) => `shared-payment-${index}`), owner = businesses[2];
Object.assign(process.env, { NODE_ENV: "test", CRM_SECURITY_LEGACY_AUTH: "true", CRM_PAYROLL_ACCURACY: "true", CRM_ATTENDANCE_INTEGRITY: "true",
    CRM_ADMIN_ONE_CODE: "synthetic-shared-admin", CRM_ADMIN_TWO_CODE: "synthetic-shared-tracker", CRM_ADMIN_TWO_ACCESS: "tracker",
    CRM_ADMIN_SESSION_SECRET: crypto.randomBytes(48).toString("hex"), CRM_EARNED_PAYROLL_FROM: "", CRM_FIXED_HALF_SALARY_FROM: "",
    DEFAULT_BUSINESS_ID: businesses[0], DEFAULT_BUSINESS_DATABASE: `${prefix}_0`, CONTROL_DATABASE_NAME: `${prefix}_control`,
    BUSINESS_DATABASES: JSON.stringify(businesses.map((id, index) => ({ id, databaseName: `${prefix}_${index}` }))) });
const { createApp } = await import("../app");
const { runWithBusiness } = await import("../config/tenancy");
const { Employee } = await import("../models/Employee");
const { PayrollRecord } = await import("../models/Payroll");
const { Attendance } = await import("../models/Attendance");
const { AttendanceLedger } = await import("../models/AttendanceLedger");
const { EmployeePaymentHistoryPolicy } = await import("../models/EmployeePaymentHistoryPolicy");
const { setBusinessAccessForEmployeeCode, getAttendanceBusinessIdentity } = await import("../models/BusinessUserAccess");
const { createAttendanceHubSession } = await import("../config/attendanceHubSession");
const code = "synthetic-shared-employee", people: Array<{ own: string; other: string }> = [];
const payPeriod = "Oct 6, 2026 - Oct 20, 2026";
const payment = { employeeId: code, employeeName: "Synthetic Shared Employee", department: "Fixture", payType: "Semi-monthly" as const,
    payPeriod, grossPay: 1000, deductions: 10, netPay: 990, status: "Paid" as const, paidOn: "Oct 25, 2026", payrollOwnerBusinessId: owner,
    calculationSnapshot: { monthlySalary: 2000, businessIds: [owner] }, lateMinutes: 2, deductibleMinutes: 2 };
let mongo: MongoMemoryReplSet, server: http.Server, base = "", ledgerId = "";
before(async () => {
    mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    assert.equal(new URL(mongo.getUri(prefix)).hostname, "127.0.0.1"); await mongoose.connect(mongo.getUri(prefix));
    await setBusinessAccessForEmployeeCode(code, businesses);
    const mapping = await getAttendanceBusinessIdentity(code); ledgerId = `access:${mapping!.id}`;
    await AttendanceLedger.create({ _id: ledgerId, employeeCode: code, businessIds: businesses, canonicalBusinessId: owner,
        revision: 0, events: [], corrections: [], closures: [], migrationRequired: false });
    for (const business of businesses) await runWithBusiness(business, async () => {
        const own = await Employee.create({ employeeCode: code, name: "Synthetic Shared Employee", status: "Active" });
        const other = await Employee.create({ employeeCode: "synthetic-other-person", name: "Synthetic Other Person", status: "Active" });
        people.push({ own: String(own._id), other: String(other._id) });
        if (business === owner) {
            await EmployeePaymentHistoryPolicy.create({ _id: "employee-payment-history", fromDate: "2026-10-06", initialPayPeriod: payPeriod, activatedAt: new Date() });
            await PayrollRecord.create(payment);
            await PayrollRecord.create({ ...payment, payPeriod: "Oct 21, 2026 - Nov 5, 2026", status: "Pending", paidOn: "-" });
            await PayrollRecord.create({ ...payment, payPeriod: "Sep 21, 2026 - Oct 5, 2026" });
            await PayrollRecord.create({ ...payment, employeeId: "synthetic-other-person", grossPay: 9999, deductions: 0, netPay: 9999 });
        }
    });
    server = http.createServer(createApp()); await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`;
});
after(async () => { server?.closeAllConnections(); server?.close(); await mongoose.disconnect(); await mongo?.stop(); });
function request(index: number, token: string | null, view = "current", own = true) {
    return fetch(`${base}/employees/${own ? people[index].own : people[index].other}/payments?view=${view}`, {
        headers: { "X-Business-Id": businesses[index], ...(token ? { "X-CRM-Attendance-Session": token } : {}) },
    });
}
async function evidence() {
    const records: unknown[] = [];
    for (const business of businesses) await runWithBusiness(business, async () => records.push([business,
        await PayrollRecord.find().sort({ _id: 1 }).lean(), await EmployeePaymentHistoryPolicy.find().lean(), await Attendance.find().lean()]));
    return JSON.stringify([records, await AttendanceLedger.find().sort({ _id: 1 }).lean()]);
}

test("one existing saved payroll is visible twice in all seven authorized businesses without copying records", async context => {
    context.mock.timers.enable({ apis: ["Date"], now: new Date("2026-10-23T12:00:00Z") }); context.after(() => context.mock.timers.reset());
    const token = createAttendanceHubSession(code)!, before = await evidence();
    for (let index = 0; index < businesses.length; index++) for (let refresh = 0; refresh < 2; refresh++) {
        const response = await request(index, token); assert.equal(response.status, 200);
        const body = await response.json(); assert.equal(body.business.id, businesses[index]); assert.equal(body.setupPending, false);
        assert.equal(body.total, 1); assert.equal(body.items[0].netPay, 990); assert.equal(body.items[0].status, "Paid");
        assert.equal(body.items[0].paidOn, "Oct 25, 2026"); assert.equal(body.currentPayPeriod, payPeriod); assert.equal(body.historyFrom, "2026-10-06");
        for (const key of ["employeeId", "employeeName", "calculationSnapshot", "calculationAudit", "email"]) assert.equal(key in body.items[0], false);
    }
    assert.equal(await evidence(), before, "GET must not create business payroll copies, policies or punches");
});

test("shared history uses the owner's frozen boundary, filters before pagination and never sums business copies", async context => {
    context.mock.timers.enable({ apis: ["Date"], now: new Date("2026-10-23T12:00:00Z") }); context.after(() => context.mock.timers.reset());
    const token = createAttendanceHubSession(code)!;
    for (let index = 0; index < businesses.length; index++) {
        const body = await (await request(index, token, "history")).json(); assert.equal(body.total, 2);
        assert.deepEqual(body.items.map((item: { netPay: number }) => item.netPay), [990, 990]);
        assert.ok(body.items.every((item: { cutoffStart: string }) => item.cutoffStart >= "2026-10-06"));
    }
});

test("another employee ID, forged sessions and tracker access cannot read shared payment history", async () => {
    const token = createAttendanceHubSession(code)!, tracker = createAttendanceHubSession("synthetic-shared-tracker")!;
    for (let index = 0; index < businesses.length; index++) {
        assert.equal((await request(index, token, "current", false)).status, 403);
        assert.equal((await request(index, null)).status, 401); assert.equal((await request(index, "forged.token")).status, 401);
        assert.equal((await request(index, tracker)).status, 403);
    }
});

test("revoking access to the canonical source prevents cross-business payment disclosure", async context => {
    context.mock.timers.enable({ apis: ["Date"], now: new Date("2026-10-23T12:00:00Z") }); context.after(() => context.mock.timers.reset());
    await setBusinessAccessForEmployeeCode(code, businesses.filter(id => id !== owner));
    try { const body = await (await request(0, createAttendanceHubSession(code)!)).json(); assert.equal(body.total, 0); assert.equal(body.setupPending, true); }
    finally { await setBusinessAccessForEmployeeCode(code, businesses); }
});

test("a ledger for another identity or an unconfigured owner cannot redirect payroll reads", async context => {
    context.mock.timers.enable({ apis: ["Date"], now: new Date("2026-10-23T12:00:00Z") }); context.after(() => context.mock.timers.reset());
    try {
        for (const fields of [{ employeeCode: "synthetic-unrelated" }, { canonicalBusinessId: "unconfigured-owner" }, { migrationRequired: true }]) {
            // Legacy migration metadata is stored outside the modeled ledger fields.
            await (AttendanceLedger.collection as unknown as Collection<AttendanceLedgerDocument>).updateOne({ _id: ledgerId }, { $set: fields });
            const stored = await (AttendanceLedger.collection as unknown as Collection<AttendanceLedgerDocument>).findOne({ _id: ledgerId });
            for (const [key, value] of Object.entries(fields)) assert.equal((stored as unknown as Record<string, unknown>)[key], value);
            const body = await (await request(0, createAttendanceHubSession(code)!)).json(); assert.equal(body.total, 0, JSON.stringify(fields));
            await (AttendanceLedger.collection as unknown as Collection<AttendanceLedgerDocument>).updateOne({ _id: ledgerId }, { $set: { employeeCode: code, canonicalBusinessId: owner, migrationRequired: false } });
        }
    } finally { await (AttendanceLedger.collection as unknown as Collection<AttendanceLedgerDocument>).updateOne({ _id: ledgerId }, { $set: { employeeCode: code, canonicalBusinessId: owner, migrationRequired: false } }); }
});

test("a newly authorized business can read existing shared payroll without changing the ledger's older membership", async context => {
    context.mock.timers.enable({ apis: ["Date"], now: new Date("2026-10-23T12:00:00Z") }); context.after(() => context.mock.timers.reset());
    await AttendanceLedger.updateOne({ _id: ledgerId }, { $set: { businessIds: [owner] } });
    try {
        const before = await evidence(), body = await (await request(0, createAttendanceHubSession(code)!)).json();
        assert.equal(body.business.id, businesses[0]); assert.equal(body.total, 1); assert.equal(body.items[0].netPay, 990);
        assert.equal(await evidence(), before);
    } finally { await AttendanceLedger.updateOne({ _id: ledgerId }, { $set: { businessIds: businesses } }); }
});
