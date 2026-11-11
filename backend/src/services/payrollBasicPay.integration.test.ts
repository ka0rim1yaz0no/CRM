import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import { after, before, beforeEach, test } from "node:test";
import mongoose from "mongoose";
import { MongoMemoryReplSet } from "mongodb-memory-server";

const root = `salary_${crypto.randomUUID().replaceAll("-", "")}`;
const businesses = Array.from({ length: 6 }, (_, index) => ({ id: `salary-${index}`, databaseName: `${root}_${index}` }));
Object.assign(process.env, { NODE_ENV: "test", CRM_PAYROLL_ACCURACY: "true", CRM_SECURITY_LEGACY_AUTH: "true", CRM_ADMIN_ONE_CODE: "90000001",
    CRM_ADMIN_SESSION_SECRET: crypto.randomBytes(48).toString("hex"), CONTROL_DATABASE_NAME: `${root}_control`,
    DEFAULT_BUSINESS_ID: businesses[0].id, DEFAULT_BUSINESS_DATABASE: businesses[0].databaseName, BUSINESS_DATABASES: JSON.stringify(businesses) });
const { createApp } = await import("../app");
const { runWithBusiness } = await import("../config/tenancy");
const { Employee } = await import("../models/Employee");
const { PayrollRecord } = await import("../models/Payroll");
const { AttendanceLedger } = await import("../models/AttendanceLedger");
const { setBusinessAccessForEmployeeCode } = await import("../models/BusinessUserAccess");
const { createAdminDashboardSession } = await import("../config/adminDashboardSession");
const { createAttendanceHubSession } = await import("../config/attendanceHubSession");
let mongo: MongoMemoryReplSet, server: http.Server, base = "", token = "";
const code = "90000003";
before(async () => {
    mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } }); await mongoose.connect(mongo.getUri(root));
    server = http.createServer(createApp()); await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`; token = createAdminDashboardSession("90000001")!;
});
after(async () => { server?.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await mongoose.disconnect(); await mongo?.stop(); });
beforeEach(async () => {
    for (const business of businesses) await runWithBusiness(business.id, async () => { await Employee.deleteMany({}); await PayrollRecord.deleteMany({}); });
    await AttendanceLedger.deleteMany({}); await setBusinessAccessForEmployeeCode(code, businesses.map(row => row.id));
    for (const business of businesses) await runWithBusiness(business.id, async () => {
        await Employee.create({ employeeCode: code, name: "Synthetic Salary", role: "Sales", salary: 32000, status: "Active", businessAccessIds: businesses.map(row => row.id) });
        for (const [index, status] of (["Paid", "Completed", "Pending"] as const).entries()) await PayrollRecord.create({ employeeId: code,
            employeeName: "Synthetic Salary", department: "Synthetic", payPeriod: `Synthetic saved ${index}`, payType: "Semi-monthly", status,
            grossPay: 15000, basicPay: 15000, deductions: 50, netPay: 14950, paidOn: "Oct 25, 2026", calculationSnapshot: { monthlySalary: 30000 } });
    });
    await AttendanceLedger.create({ _id: "synthetic-salary-attendance", employeeCode: code, businessIds: businesses.map(row => row.id), revision: 1,
        events: [{ id: "original", source: "Time In", at: "2026-10-28T15:00:00Z", recordedAt: "2026-10-28T15:00:00Z", sequence: 1, commandId: "fixture" }] });
});
const request = (business: string, method = "GET", body?: unknown, headers = {}) => fetch(`${base}/payroll/employees/${code}/basic-pay`, {
    method, headers: { "Content-Type": "application/json", "X-Business-Id": business, "X-CRM-Admin-Session": token, ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
async function evidence() {
    const records = [];
    for (const business of businesses) records.push(await runWithBusiness(business.id, () => PayrollRecord.find({}).sort({ _id: 1 }).lean()));
    return JSON.stringify({ records, attendance: await AttendanceLedger.find({}).sort({ _id: 1 }).lean() });
}

test("current monthly salary is readable without substituting an older saved cutoff in all six businesses", async () => {
    const before = await evidence();
    for (const business of businesses) {
        const response = await request(business.id); assert.equal(response.status, 200); assert.equal(response.headers.get("cache-control"), "no-store");
        assert.deepEqual(await response.json(), { employeeId: code, businessId: business.id, monthlySalary: 32000 });
    }
    assert.equal(await evidence(), before, "opening the salary editor must not write payroll or attendance");
});

test("salary saves are visible on a fresh read in every assigned business while saved payroll and attendance stay unchanged", async () => {
    const before = await evidence();
    for (const value of [33000.5, 0]) {
        const response = await request(businesses[2].id, "PATCH", { basicPay: value }); assert.equal(response.status, 200);
        for (const business of businesses) {
            const fresh = await request(business.id); assert.equal(fresh.status, 200); assert.equal((await fresh.json()).monthlySalary, value);
        }
        assert.equal(await evidence(), before);
    }
});

test("empty, non-numeric and unsafe salary submissions cannot silently set the salary to zero", async () => {
    const before = await evidence();
    for (const value of [null, false, [], {}, "", "  ", "not-money", -1, 1e30]) {
        assert.equal((await request(businesses[0].id, "PATCH", { basicPay: value })).status, 422);
    }
    assert.equal((await request(businesses[0].id, "PATCH", {})).status, 422);
    assert.equal((await (await request(businesses[0].id)).json()).monthlySalary, 32000);
    assert.equal(await evidence(), before);
});

test("an employee or forged admin cannot read or update salary and archived employees cannot receive no-op success", async () => {
    const employeeHeaders = { "X-CRM-Admin-Session": "", "X-CRM-Attendance-Session": createAttendanceHubSession(code)! };
    assert.equal((await request(businesses[0].id, "GET", undefined, employeeHeaders)).status, 403);
    assert.equal((await request(businesses[0].id, "PATCH", { basicPay: 1 }, employeeHeaders)).status, 403);
    assert.ok([401, 403].includes((await request(businesses[0].id, "GET", undefined, { "X-CRM-Admin-Session": "invalid" })).status));
    await runWithBusiness(businesses[0].id, () => Employee.updateOne({ employeeCode: code }, { status: "Archived" }));
    assert.equal((await request(businesses[0].id)).status, 404);
    assert.equal((await request(businesses[0].id, "PATCH", { basicPay: 1 })).status, 404);
});
