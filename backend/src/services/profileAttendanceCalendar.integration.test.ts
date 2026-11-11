import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import crypto from "node:crypto";
import http from "node:http";
import mongoose from "mongoose";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import type { AttendanceSource } from "../models/Attendance";

process.env.NODE_ENV = "test";
process.env.CRM_ATTENDANCE_INTEGRITY = "true";
process.env.CRM_ATTENDANCE_HUB = "true";
process.env.CRM_ATTENDANCE_ACTIVE_SESSION = "true";
process.env.CRM_ATTENDANCE_DURATION_MODEL = "true";
process.env.CRM_ATTENDANCE_ACCURACY_FIXES = "true";
process.env.CRM_ADMIN_ONE_CODE = "90000001";
process.env.CRM_ADMIN_SESSION_SECRET = crypto.randomBytes(48).toString("hex");
const prefix = `calendar_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
const businesses = Array.from({ length: 6 }, (_, i) => ({ id: `calendar-${i}`, name: `Calendar ${i}`, databaseName: `${prefix}_${i}` }));
const outside = { id: "calendar-outside", name: "Outside", databaseName: `${prefix}_outside` };
process.env.BUSINESS_DATABASES = JSON.stringify([...businesses, outside]);
process.env.DEFAULT_BUSINESS_ID = businesses[0].id;
process.env.DEFAULT_BUSINESS_DATABASE = businesses[0].databaseName;
process.env.CONTROL_DATABASE_NAME = `${prefix}_control`;

const { runWithBusiness } = await import("../config/tenancy");
const { Employee } = await import("../models/Employee");
const { AttendanceLedger, AttendancePolicy } = await import("../models/AttendanceLedger");
const { AttendanceDayNote } = await import("../models/AttendanceDayNote");
const { LeaveRequest } = await import("../models/LeaveRequest");
const { setBusinessAccessForEmployeeCode } = await import("../models/BusinessUserAccess");
const { resolveAttendanceIdentity } = await import("./attendanceLedgerService");
const { readEmployeeAttendanceCalendar } = await import("../controllers/attendanceHubController");
const { createAttendanceHubSession } = await import("../config/attendanceHubSession");
const { createAdminDashboardSession } = await import("../config/adminDashboardSession");
const { createApp } = await import("../app");
const code = "91000111";
let mongo: MongoMemoryReplSet, server: http.Server, base = "", foreignId = "", outsideId = "";
const ids: string[] = [];
const now = new Date("2026-10-28T17:00:00Z");
before(async () => {
    mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    await mongoose.connect(mongo.getUri(prefix), { autoIndex: false, autoCreate: false });
    await AttendancePolicy.create({ _id: "global-attendance", revision: 1, shiftStart: "23:00", shiftEnd: "08:00", recoveryTime: "22:59", graceMinutes: 0, breakMinutes: 15, lunchMinutes: 60 });
    for (const business of businesses) await runWithBusiness(business.id, async () => {
        const person = await Employee.create({ employeeCode: code, name: "Synthetic Calendar", role: "Test", dateHired: "2026-10-06", businessAccessIds: businesses.map(item => item.id) });
        ids.push(String(person._id));
        await LeaveRequest.create({ employee: person._id, leaveType: "Vacation", startDate: new Date("2026-10-08"), endDate: new Date("2026-10-08"), selectedDates: [new Date("2026-10-08")], reason: "Synthetic", status: "Approved" });
        await AttendanceDayNote.create({ employeeCode: code, dayKey: "2026-10-09", reason: "Synthetic exemption", excused: true });
        await mongoose.connection.getClient().db(business.databaseName).collection("payrollrecords").insertOne({ employeeId: code, payPeriod: "Oct 6, 2026 - Oct 20, 2026", grossPay: 100, deductions: 1, netPay: 99, status: "Paid", paidOn: new Date("2026-10-21") });
    });
    await setBusinessAccessForEmployeeCode(code, businesses.map(item => item.id));
    const identity = await runWithBusiness(businesses[0].id, () => resolveAttendanceIdentity(ids[0], { role: "employee", code }));
    const shift = { dayKey: "2026-10-06", start: "2026-10-06T15:00:00.000Z", end: "2026-10-07T00:00:00.000Z", resetDeadline: "2026-10-07T00:05:00.000Z" };
    await AttendanceLedger.create({ _id: identity.key, employeeCode: code, canonicalBusinessId: businesses[0].id, businessIds: businesses.map(item => item.id), revision: 9,
        events: [{ id: "in", commandId: "fixture", source: "Time In", sequence: 1, at: shift.start, recordedAt: shift.start, shift },
            { id: "out", commandId: "fixture", source: "Time Out", sequence: 2, at: shift.end, recordedAt: shift.end }], corrections: [], closures: [], jobs: [], audit: [], commands: [] });
    foreignId = await runWithBusiness(businesses[0].id, async () => String((await Employee.create({ employeeCode: "91000112", name: "Foreign", dateHired: "2026-10-01" }))._id));
    outsideId = await runWithBusiness(outside.id, async () => String((await Employee.create({ employeeCode: code, name: "Outside", dateHired: "2026-10-01" }))._id));
    server = http.createServer(createApp());
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`;
});
after(async () => { if (server) await new Promise<void>(resolve => server.close(() => resolve())); await mongoose.disconnect(); await mongo?.stop(); });
function request(business: string, id: string, month: string, token = createAttendanceHubSession(code)!, admin = false) {
    return fetch(`${base}/employees/${id}/attendance/calendar?month=${encodeURIComponent(month)}`, { headers: { "X-Business-Id": business, [admin ? "X-CRM-Admin-Session" : "X-CRM-Attendance-Session"]: token } });
}
test("six businesses reuse HR absence rules without changing paid payroll or punches", async () => {
    const ledgerBefore = JSON.stringify(await AttendanceLedger.find({}).sort({ _id: 1 }).lean());
    for (const business of businesses) {
        const collection = mongoose.connection.getClient().db(business.databaseName).collection("payrollrecords");
        const before = JSON.stringify(await collection.find({}).sort({ _id: 1 }).toArray());
        for (let refresh = 0; refresh < 2; refresh++) {
            const result = await runWithBusiness(business.id, () => readEmployeeAttendanceCalendar(business.id, code, "2026-10", now));
            const byDay = new Map(result.days.map(day => [day.dayKey, day]));
            assert.equal(byDay.get("2026-10-07")?.absent, true);
            assert.equal(byDay.get("2026-10-08")?.excused, true); assert.equal(byDay.get("2026-10-08")?.absent, false);
            assert.equal(byDay.get("2026-10-09")?.excused, true); assert.equal(byDay.get("2026-10-09")?.absent, false);
            for (const day of ["2026-10-05", "2026-10-06", "2026-10-10", "2026-10-11", "2026-10-28", "2026-10-29", "2026-10-30"]) assert.notEqual(byDay.get(day)?.absent, true, day);
            assert.ok(result.days.every(day => day.attendanceRevision === 9));
            assert.ok(!JSON.stringify(result).includes("Synthetic exemption"));
        }
        assert.equal(JSON.stringify(await collection.find({}).sort({ _id: 1 }).toArray()), before);
    }
    assert.equal(JSON.stringify(await AttendanceLedger.find({}).sort({ _id: 1 }).lean()), ledgerBefore);
});
test("an employee reads only their own calendar in authorized businesses; admin matches", async () => {
    for (const [index, business] of businesses.entries()) {
        const own = await request(business.id, ids[index], "2026-10"); assert.equal(own.status, 200);
        assert.equal(own.headers.get("cache-control"), "no-store");
        const value = await own.json(); assert.equal(value.month, "2026-10");
        const admin = await request(business.id, ids[index], "2026-10", createAdminDashboardSession("90000001")!, true); assert.equal(admin.status, 200);
        assert.deepEqual((await admin.json()).days, value.days);
        assert.ok(Object.keys(value).every(key => ["month", "serverTime", "days"].includes(key)));
    }
    assert.equal((await request(businesses[0].id, foreignId, "2026-10")).status, 403);
    assert.equal((await request(outside.id, outsideId, "2026-10")).status, 403);
    assert.equal((await request(businesses[0].id, ids[0], "2026-10", "")).status, 401);
    for (const month of ["2026-13", "2026-2", "invalid", "0001-01"]) assert.equal((await request(businesses[0].id, ids[0], month)).status, 422);
});

test("newly recorded attendance removes a confirmed absence on fresh reads in all six businesses", async () => {
    const ledger = await AttendanceLedger.findOne({ employeeCode: code }).lean(); assert.ok(ledger);
    const shift = { dayKey: "2026-10-07", start: "2026-10-07T15:00:00.000Z", end: "2026-10-08T00:00:00.000Z", resetDeadline: "2026-10-08T00:05:00.000Z" };
    await AttendanceLedger.updateOne({ _id: ledger._id }, { $inc: { revision: 1 }, $push: { events: { $each: [
        { id: "restored-in", commandId: "fixture-restored", source: "Time In", sequence: 3, at: shift.start, recordedAt: shift.start, shift },
        { id: "restored-out", commandId: "fixture-restored", source: "Time Out", sequence: 4, at: shift.end, recordedAt: shift.end },
    ] } } });
    for (const [index, business] of businesses.entries()) for (let refresh = 0; refresh < 2; refresh++) {
        const response = await request(business.id, ids[index], "2026-10"); assert.equal(response.status, 200);
        const body = await response.json(); assert.ok(!body.days.some((day: { dayKey: string; absent: boolean }) => day.dayKey === "2026-10-07" && day.absent));
        assert.ok(body.days.every((day: { attendanceRevision: number }) => day.attendanceRevision === 10));
        const paid = await mongoose.connection.getClient().db(business.databaseName).collection("payrollrecords").findOne({ employeeId: code });
        assert.equal(paid?.status, "Paid"); assert.equal(paid?.netPay, 99);
    }
});

test("legacy shiftless and unpaired punches agree with HR after refresh without changing records", async () => {
    const legacyCode = "91000113", legacyIds: string[] = [];
    for (const business of businesses) await runWithBusiness(business.id, async () => {
        const person = await Employee.create({ employeeCode: legacyCode, name: "Synthetic Legacy", dateHired: "2026-10-01", businessAccessIds: businesses.map(item => item.id) });
        legacyIds.push(String(person._id));
    });
    await setBusinessAccessForEmployeeCode(legacyCode, businesses.map(item => item.id));
    const identity = await runWithBusiness(businesses[0].id, () => resolveAttendanceIdentity(legacyIds[0], { role: "employee", code: legacyCode }));
    const rows: Array<[AttendanceSource, string]> = [
        ["Time In", "2026-10-12T15:00:00Z"], ["Break Out", "2026-10-12T17:00:00Z"],
        ["Break In", "2026-10-12T17:15:00Z"], ["Off the Phone Out", "2026-10-12T18:00:00Z"],
        ["Time Out", "2026-10-13T00:00:00Z"], ["Break In", "2026-10-14T17:00:00Z"],
    ];
    await AttendanceLedger.create({ _id: identity.key, employeeCode: legacyCode, canonicalBusinessId: businesses[0].id,
        businessIds: businesses.map(item => item.id), revision: 3, events: rows.map(([source, at], sequence) => ({
            id: `legacy-${sequence}`, source, at, recordedAt: at, sequence: sequence + 1, commandId: "legacy", legacyReviewed: true,
        })), corrections: [], closures: [], jobs: [], audit: [], commands: [] });
    const ledgersBefore = JSON.stringify(await AttendanceLedger.find({}).sort({ _id: 1 }).lean());
    const client = mongoose.connection.getClient();
    const payrollBefore = await Promise.all(businesses.map(business => client.db(business.databaseName).collection("payrollrecords").find({}).sort({ _id: 1 }).toArray()));
    for (const [index, business] of businesses.entries()) for (let refresh = 0; refresh < 2; refresh++) {
        const token = createAttendanceHubSession(legacyCode)!;
        const calendarResponse = await request(business.id, legacyIds[index], "2026-10", token);
        assert.equal(calendarResponse.status, 200);
        const calendar = await calendarResponse.json();
        for (const key of ["2026-10-12", "2026-10-14"]) {
            assert.ok(!calendar.days.some((day: { dayKey: string; absent: boolean }) => day.dayKey === key && day.absent));
            const query = new URLSearchParams({ preset: "custom", from: key, to: key, business: business.id, employeeCode: legacyCode });
            const hrResponse = await fetch(`${base}/attendance-hub/day/${key}?${query}`, { headers: { "X-Business-Id": business.id, "X-CRM-Admin-Session": createAdminDashboardSession("90000001")! } });
            assert.equal(hrResponse.status, 200);
            const hr = (await hrResponse.json()).day;
            assert.equal(hr.absent, false); assert.equal(hr.attendanceRevision, 3);
            assert.equal(hr.events.length, key === "2026-10-12" ? 5 : 1);
            if (key === "2026-10-12") assert.equal(hr.timeIn, new Date(rows[0][1]).toISOString());
            else assert.ok(hr.review.includes("Missing Time In"));
        }
    }
    assert.equal(JSON.stringify(await AttendanceLedger.find({}).sort({ _id: 1 }).lean()), ledgersBefore);
    const payrollAfter = await Promise.all(businesses.map(business => client.db(business.databaseName).collection("payrollrecords").find({}).sort({ _id: 1 }).toArray()));
    assert.equal(JSON.stringify(payrollAfter), JSON.stringify(payrollBefore));
});
