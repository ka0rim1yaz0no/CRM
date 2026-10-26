import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import { before, after, test } from "node:test";
import mongoose from "mongoose";
import { MongoMemoryReplSet } from "mongodb-memory-server";

const prefix = `dashboard_presence_${crypto.randomUUID().replaceAll("-", "")}`;
const businesses = Array.from({ length: 6 }, (_, index) => `presence-${index}`);
Object.assign(process.env, { NODE_ENV: "test", CRM_CALL_DASHBOARD_V2: "true", CRM_TIME_ACCOUNTING_V2: "true",
    CRM_SECURITY_LEGACY_AUTH: "true", CRM_ADMIN_ONE_CODE: "synthetic-presence-admin",
    CRM_ADMIN_SESSION_SECRET: crypto.randomBytes(48).toString("hex"),
    DEFAULT_BUSINESS_ID: businesses[0], DEFAULT_BUSINESS_DATABASE: `${prefix}_0`, CONTROL_DATABASE_NAME: `${prefix}_control`,
    BUSINESS_DATABASES: JSON.stringify(businesses.map((id, index) => ({ id, databaseName: `${prefix}_${index}` }))) });
const { createApp } = await import("../app");
const { runWithBusiness } = await import("../config/tenancy");
const { Employee } = await import("../models/Employee");
const { Attendance } = await import("../models/Attendance");
const { createAdminDashboardSession } = await import("../config/adminDashboardSession");
let mongo: MongoMemoryReplSet, server: http.Server, base = "";
before(async () => {
    mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    assert.equal(new URL(mongo.getUri(prefix)).hostname, "127.0.0.1");
    await mongoose.connect(mongo.getUri(prefix));
    server = http.createServer(createApp()); await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/call-dashboard`;
});
after(async () => { server?.closeAllConnections(); server?.close(); await mongoose.disconnect(); await mongo?.stop(); });

test("early Time In clears a previous off-phone badge before the next shift in all six businesses and survives fresh reads", async context => {
    context.mock.timers.enable({ apis: ["Date"], now: new Date("2026-10-23T14:58:00Z") });
    const admin = createAdminDashboardSession("synthetic-presence-admin")!;
    const code = "synthetic-early-presence";
    try {
        for (const business of businesses) await runWithBusiness(business, async () => {
            const employee = await Employee.create({ employeeCode: code, name: "Synthetic Early Attendance", role: "Sales Agent", team: "Operations",
                status: "Active", availabilityStatus: "ONLINE", dateHired: "2026-10-21" });
            await Attendance.insertMany([
                { employee: employee._id, source: "Time In", timeIn: new Date("2026-10-22T15:00:00Z") },
                { employee: employee._id, source: "Off the Phone Out", timeIn: new Date("2026-10-22T23:50:00Z") },
                { employee: employee._id, source: "Time In", timeIn: new Date("2026-10-23T13:30:00Z") },
                { employee: employee._id, source: "Lunch Break Out", timeIn: new Date("2026-10-23T14:00:00Z"), isEffective: false },
            ]);
        });
        const read = async (business: string) => {
            const response = await fetch(base, { headers: { "X-Business-Id": business, "X-CRM-Admin-Session": admin } });
            assert.equal(response.status, 200); assert.equal(response.headers.get("cache-control"), "no-store");
            const body = await response.json(); assert.equal(body.business.id, business);
            assert.equal(body.employees.length, 1); return body.employees[0];
        };
        for (const business of businesses) {
            for (let refresh = 0; refresh < 2; refresh++) {
                const row = await read(business);
                assert.equal(row.employeeCode, code); assert.equal(row.status, "ONLINE");
                assert.equal(row.statusStartedAt, null); assert.equal(row.transitionUntil, null);
                assert.equal(row.detail, "Outside call shift");
                assert.equal(row.offPhoneTotalMs, 10 * 60000); assert.equal(row.offPhoneCompletedMs, 10 * 60000);
                assert.equal(row.offPhoneActiveStartedAt, null);
            }
        }
        context.mock.timers.setTime(Date.parse("2026-10-23T15:01:00Z"));
        for (const business of businesses) {
            const row = await read(business); assert.equal(row.status, "ONLINE"); assert.equal(row.offPhoneTotalMs, 0);
            await runWithBusiness(business, async () => {
                assert.equal(await Attendance.countDocuments({}), 4, "dashboard reads never change stored attendance");
                assert.equal(await Attendance.countDocuments({ isEffective: false }), 1);
                assert.equal((await Employee.findOne({ employeeCode: code }).lean())?.availabilityStatus, "ONLINE");
            });
        }
    } finally { context.mock.timers.reset(); }
});
