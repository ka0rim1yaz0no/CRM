import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import { before, after, test } from "node:test";
import mongoose from "mongoose";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import type { AttendanceSource } from "../models/Attendance";

const prefix = `missing_checkout_${crypto.randomUUID().replaceAll("-", "")}`;
const businesses = Array.from({ length: 6 }, (_, index) => `missing-${index}`);
Object.assign(process.env, { NODE_ENV: "test", CRM_ATTENDANCE_INTEGRITY: "true", CRM_ATTENDANCE_DURATION_MODEL: "true",
    CRM_ATTENDANCE_HUB: "true", CRM_ATTENDANCE_ACCURACY_FIXES: "true", CRM_PAYROLL_ACCURACY: "true",
    CRM_CALL_DASHBOARD_V2: "true", CRM_TIME_ACCOUNTING_V2: "true", CRM_DASHBOARD_V2: "true",
    CRM_ATTENDANCE_AUTO_TIMEOUT: "false", CRM_ATTENDANCE_BREAK_GAP: "false", CRM_SECURITY_LEGACY_AUTH: "true",
    CRM_ADMIN_ONE_CODE: "synthetic-checkout-admin", CRM_ADMIN_SESSION_SECRET: crypto.randomBytes(48).toString("hex"),
    DEFAULT_BUSINESS_ID: businesses[0], DEFAULT_BUSINESS_DATABASE: `${prefix}_0`, CONTROL_DATABASE_NAME: `${prefix}_control`,
    BUSINESS_DATABASES: JSON.stringify(businesses.map((id, index) => ({ id, databaseName: `${prefix}_${index}` }))) });
const { createApp } = await import("../app");
const { runWithBusiness } = await import("../config/tenancy");
const { Employee } = await import("../models/Employee");
const { Attendance } = await import("../models/Attendance");
const { AttendanceLedger, AttendancePolicy } = await import("../models/AttendanceLedger");
const { setBusinessAccessForEmployeeCode } = await import("../models/BusinessUserAccess");
const { createAttendanceHubSession } = await import("../config/attendanceHubSession");
const { createAdminDashboardSession } = await import("../config/adminDashboardSession");
const { resolveAttendanceIdentity } = await import("./attendanceLedgerService");
const { deliverAttendanceLedger } = await import("./attendanceLedgerOutbox");
const { assignAttendanceShift } = await import("./attendanceShift");
const { attendancePayrollDtr } = await import("../controllers/payrollController");
let mongo: MongoMemoryReplSet, server: http.Server, base = "";
before(async () => {
    mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    assert.equal(new URL(mongo.getUri(prefix)).hostname, "127.0.0.1");
    await mongoose.connect(mongo.getUri(prefix));
    await AttendancePolicy.create({ _id: "global-attendance", revision: 1, graceMinutes: 0, breakMinutes: 15, lunchMinutes: 60,
        shiftStart: "23:00", shiftEnd: "08:00", recoveryEnabled: false, recoveryTime: "22:59" });
    server = http.createServer(createApp()); await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`;
});
after(async () => { server?.closeAllConnections(); server?.close(); await mongoose.disconnect(); await mongo?.stop(); });

async function seed(code: string, entries: Array<[AttendanceSource, string]>) {
    await setBusinessAccessForEmployeeCode(code, businesses);
    const people: Array<{ _id: mongoose.Types.ObjectId }> = [];
    for (const business of businesses) people.push(await runWithBusiness(business, () => Employee.create({ employeeCode: code, name: "Synthetic Missing Checkout",
        role: "Sales Agent", team: "Operations", status: "Active", dateHired: "2026-10-21" })));
    const admin = createAdminDashboardSession("synthetic-checkout-admin")!, employee = createAttendanceHubSession(code)!;
    const identity = await runWithBusiness(businesses[0], () => resolveAttendanceIdentity(String(people[0]._id), { role: "admin", code: "synthetic-checkout-admin" }));
    const events = entries.map(([source, at], sequence) => ({ id: crypto.randomUUID(), commandId: `synthetic-original-${sequence}`, source, at, recordedAt: at, sequence,
        ...(source === "Time In" ? { shift: assignAttendanceShift(new Date(at), "23:00", "08:00", "22:59"), legacyReviewed: true, legacyBoundary: true } : {}) }));
    await AttendanceLedger.create({ _id: identity.key, employeeCode: code, businessIds: businesses, canonicalBusinessId: businesses[0], revision: 1, events });
    const request = (index: number, endpoint: string, body?: unknown, asEmployee = false) => fetch(`${base}${endpoint}`, { method: body ? "POST" : "GET",
        headers: { "Content-Type": "application/json", "X-Business-Id": businesses[index],
            [asEmployee ? "X-CRM-Attendance-Session" : "X-CRM-Admin-Session"]: asEmployee ? employee : admin }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const endpoint = (index: number, action: string) => `/employees/${people[index]._id}/attendance/${action}`;
    return { code, people, identity, events, request, endpoint };
}

test("adding a reviewed historical checkout updates all six replicas, deductions, DTR and dashboards without touching the current session", async context => {
    context.mock.timers.enable({ apis: ["Date"], now: new Date("2026-10-22T18:00:00Z") });
    try {
        const data = await seed("synthetic-historical-checkout", [["Time In", "2026-10-21T15:05:00Z"], ["Break Out", "2026-10-21T16:00:00Z"],
            ["Break In", "2026-10-21T16:16:01Z"], ["Lunch Break Out", "2026-10-21T18:00:00Z"], ["Lunch Break In", "2026-10-21T19:01:00Z"],
            ["Time In", "2026-10-22T15:00:00Z"], ["Break Out", "2026-10-22T17:00:00Z"]]);
        const before = await (await data.request(0, data.endpoint(0, "session"))).json();
        const command = { commandId: crypto.randomUUID(), expectedRevision: before.revision, fingerprint: before.fingerprint,
            operation: "correct", reason: "Synthetic reviewed missing checkout", changes: [{ source: "Time Out", at: "2026-10-21T23:50:00Z" }] };
        assert.equal((await data.request(0, data.endpoint(0, "preview"), command, true)).status, 403);
        const reviewed = await data.request(1, data.endpoint(1, "preview"), command);
        assert.equal(reviewed.status, 200, JSON.stringify(await reviewed.clone().json()));
        assert.equal((await (await data.request(0, data.endpoint(0, "session"))).json()).revision, before.revision);
        const response = await data.request(1, data.endpoint(1, "commands"), command);
        assert.equal(response.status, 200, JSON.stringify(await response.clone().json()));
        const saved = await response.json();
        assert.equal(saved.state, "BREAK"); assert.equal(saved.sessionId, before.sessionId); assert.equal(saved.stateSince, before.stateSince);
        await deliverAttendanceLedger(data.identity.key);
        for (let index = 0; index < 6; index++) {
            const fresh = await (await data.request(index, data.endpoint(index, "session"))).json();
            assert.equal(fresh.revision, saved.revision); assert.equal(fresh.state, "BREAK"); assert.equal(fresh.syncPending, false);
            const day = fresh.dashboardDays.find((item: { dayKey: string }) => item.dayKey === "2026-10-21");
            assert.deepEqual([day.milliseconds.late, day.milliseconds.overBreak, day.milliseconds.overLunch, day.milliseconds.underTime].map((n: number) => n / 60000), [5, 2, 1, 10]);
            const hubResponse = await data.request(index, `/attendance-hub/days?shiftView=date&shiftDate=2026-10-21&employee=${data.code}&business=${businesses[index]}`);
            assert.equal(hubResponse.status, 200);
            const hub = (await hubResponse.json()).rows[0];
            assert.equal(hub.timeOut, new Date(command.changes[0].at).toISOString());
            assert.deepEqual([hub.milliseconds.late, hub.milliseconds.overBreak, hub.milliseconds.overLunch, hub.milliseconds.underTime].map((n: number) => n / 60000), [5, 2, 1, 10]);
            const dtr = await runWithBusiness(businesses[index], () => attendancePayrollDtr(data.people[index]._id, "Oct 21, 2026 - Nov 5, 2026"));
            const row = dtr.rows.find(item => item.dateKey === "2026-10-21")!;
            assert.deepEqual([row.lateMinutes, row.excessBreakMinutes, row.excessLunchMinutes, row.earlyTimeOutMinutes, row.deductibleMinutes], [5, 2, 1, 10, 18]);
            await runWithBusiness(businesses[index], async () => {
                const replicas = await Attendance.find({ employee: data.people[index]._id, source: "Time Out", isEffective: true }).lean();
                assert.equal(replicas.length, 1); assert.equal(replicas[0].attendanceStatus, "Undertime");
                assert.equal((await Employee.findById(data.people[index]._id).lean())?.availabilityStatus, "BREAK");
            });
        }
        const replay = await data.request(2, data.endpoint(2, "commands"), command); assert.equal((await replay.json()).revision, saved.revision);
        const stale = await data.request(3, data.endpoint(3, "commands"), { ...command, commandId: crypto.randomUUID() }); assert.equal(stale.status, 409);
        const duplicate = await data.request(4, data.endpoint(4, "preview"), { ...command, expectedRevision: saved.revision, commandId: crypto.randomUUID() });
        assert.equal(duplicate.status, 422, "a refreshed administrator cannot add a second checkout to the closed session");
        const ledger = await AttendanceLedger.findById(data.identity.key).lean();
        assert.deepEqual(ledger!.events.slice(0, data.events.length), data.events); assert.equal(ledger!.audit.at(-1)?.reason, command.reason);
    } finally { context.mock.timers.reset(); }
});

test("open break, lunch and off-phone intervals require an explicit paired return and retain deductions in all businesses", async context => {
    context.mock.timers.enable({ apis: ["Date"], now: new Date("2026-10-22T18:00:00Z") });
    try {
        for (const [restIndex, [out, incoming]] of ([["Break Out", "Break In"], ["Lunch Break Out", "Lunch Break In"], ["Off the Phone Out", "Off the Phone In"]] as const).entries()) {
            const data = await seed(`synthetic-rest-${restIndex}`, [["Time In", "2026-10-21T15:00:00Z"], [out, "2026-10-21T23:30:00Z"]]);
            const before = await (await data.request(0, data.endpoint(0, "session"))).json();
            const at = "2026-10-22T00:00:00Z";
            const command = { commandId: crypto.randomUUID(), expectedRevision: before.revision, operation: "correct", reason: "Synthetic reviewed rest closure",
                changes: [{ source: incoming, at }, { source: "Time Out", at }] };
            const response = await data.request(0, data.endpoint(0, "commands"), command);
            assert.equal(response.status, 200, JSON.stringify(await response.clone().json()));
            await deliverAttendanceLedger(data.identity.key);
            for (let index = 0; index < 6; index++) {
                const fresh = await (await data.request(index, data.endpoint(index, "session"))).json();
                assert.equal(fresh.state, "OFFLINE");
                assert.deepEqual(fresh.records.slice(-2).map((item: { source: string }) => item.source), [incoming, "Time Out"]);
                const day = fresh.dashboardDays.find((item: { dayKey: string }) => item.dayKey === "2026-10-21");
                assert.equal(day.milliseconds.underTime, 0);
                if (out === "Break Out") assert.equal(day.milliseconds.overBreak / 60000, 15);
            }
        }
    } finally { context.mock.timers.reset(); }
});

test("a current-shift checkout refreshes the actual call dashboard and employee quick view in every business", async context => {
    context.mock.timers.enable({ apis: ["Date"], now: new Date("2026-10-22T18:00:00Z") });
    try {
        const data = await seed("synthetic-current-checkout", [["Time In", "2026-10-22T15:00:00Z"], ["Break Out", "2026-10-22T17:30:00Z"]]);
        const before = await (await data.request(0, data.endpoint(0, "session"))).json();
        await AttendanceLedger.updateOne({ _id: data.identity.key }, { $set: { jobs: businesses.map(businessId => ({ businessId, revision: before.revision, done: false })) } });
        await deliverAttendanceLedger(data.identity.key);
        for (let index = 0; index < businesses.length; index++) {
            const response = await data.request(index, "/call-dashboard");
            assert.equal(response.status, 200);
            assert.equal((await response.json()).employees.find((row: { employeeCode: string }) => row.employeeCode === data.code)?.status, "BREAK");
        }
        const command = { commandId: crypto.randomUUID(), expectedRevision: before.revision, fingerprint: before.fingerprint,
            operation: "correct", reason: "Synthetic current missing checkout", changes: [
                { source: "Break In", at: "2026-10-22T17:50:00Z" }, { source: "Time Out", at: "2026-10-22T17:50:00Z" },
            ] };
        const preview = await data.request(0, data.endpoint(0, "preview"), command);
        assert.equal(preview.status, 200);
        const saved = await data.request(0, data.endpoint(0, "commands"), command);
        assert.equal(saved.status, 200, JSON.stringify(await saved.clone().json()));
        await deliverAttendanceLedger(data.identity.key);
        for (let index = 0; index < businesses.length; index++) {
            for (let refresh = 0; refresh < 2; refresh++) {
                const response = await data.request(index, "/call-dashboard");
                assert.equal(response.status, 200); assert.equal(response.headers.get("cache-control"), "no-store");
                const employee = (await response.json()).employees.find((row: { employeeCode: string }) => row.employeeCode === data.code);
                assert.equal(employee.status, "OFFLINE"); assert.equal(employee.timeBucketsMs.break, 20 * 60000);
                const quick = await data.request(index, `/dashboard-workspace/employee/${data.code}?preset=custom&from=2026-10-22&to=2026-10-22`);
                assert.equal(quick.status, 200, JSON.stringify(await quick.clone().json()));
                const fresh = await quick.json(); assert.equal(fresh.employee.availabilityStatus, "OFFLINE");
                assert.equal(fresh.attendance.summary.underTime, 370 * 60000); assert.equal(fresh.attendance.summary.overBreak, 5 * 60000);
                const dtr = await runWithBusiness(businesses[index], () => attendancePayrollDtr(data.people[index]._id, "Oct 21, 2026 - Nov 5, 2026"));
                const day = dtr.rows.find(row => row.dateKey === "2026-10-22")!;
                assert.equal(day.status, "Needs Review", "payroll remains provisional until the scheduled shift end");
                assert.equal(day.deductibleMinutes, 0);
            }
        }
        context.mock.timers.setTime(Date.parse("2026-10-23T01:00:00Z"));
        for (let index = 0; index < businesses.length; index++) {
            const dtr = await runWithBusiness(businesses[index], () => attendancePayrollDtr(data.people[index]._id, "Oct 21, 2026 - Nov 5, 2026"));
            const day = dtr.rows.find(row => row.dateKey === "2026-10-22")!;
            assert.deepEqual([day.earlyTimeOutMinutes, day.excessBreakMinutes, day.deductibleMinutes], [370, 5, 375]);
            assert.notEqual(day.status, "Needs Review");
        }
    } finally { context.mock.timers.reset(); }
});
