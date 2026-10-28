import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import { before, after, test } from "node:test";
import mongoose from "mongoose";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import type { AttendanceSource } from "../models/Attendance";
import { timeOutBeforeTimeInMessage } from "../../../shared/attendanceTimeOut";

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
const { getAccuratePayrollDtr } = await import("./payrollRecomputeService");
const { PayrollRecord } = await import("../models/Payroll");
const { executeAttendanceCommand, autoTimeOutCommandId } = await import("./attendanceLedgerService");
const { employeePayments, initializeEmployeePaymentHistory } = await import("./employeePayments");
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
        const cutoff = "Oct 21, 2026 - Oct 21, 2026", originalPayroll: unknown[] = [];
        for (let index = 0; index < businesses.length; index++) originalPayroll.push(await runWithBusiness(businesses[index], async () => {
            await PayrollRecord.create({ employeeName: "Synthetic Missing Checkout", employeeId: data.code, department: "Synthetic",
                payType: "Semi-monthly", payPeriod: cutoff, grossPay: 15000, deductions: 50, netPay: 14950,
                status: "Review", paidOn: "-", incompleteShiftDays: 1 });
            return await PayrollRecord.findOne({ employeeId: data.code }).lean();
        }));
        const priorDtr = await runWithBusiness(businesses[0], async () => getAccuratePayrollDtr((await Employee.findById(data.people[0]._id).lean())!, cutoff));
        assert.equal(priorDtr.currentAttendanceReviewDays, 1);
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
            for (let refresh = 0; refresh < 2; refresh++) {
                for (const route of [`/attendance?all=true&employeeIds=${data.people[index]._id}`, `/employees/${data.people[index]._id}/attendance?all=true`]) {
                    const response = await data.request(index, route); assert.equal(response.status, 200);
                    const history = await response.json();
                    for (const record of history) {
                        const canonical = fresh.records.find((event: { id: string }) => event.id === record.eventId);
                        assert.ok(canonical); assert.equal(record.sequence, canonical.sequence);
                        assert.equal(record.shiftDayKey, canonical.shiftDayKey, "HR must retain canonical overnight ownership, including late added checkouts");
                    }
                }
            }
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
                for (let refresh = 0; refresh < 2; refresh++) {
                    const dtr = await getAccuratePayrollDtr((await Employee.findById(data.people[index]._id).lean())!, cutoff);
                    assert.equal(dtr.currentAttendanceReviewDays, 0, "the resolved checkout must not retain a stale current review flag");
                    assert.equal(dtr.summary.incompleteShiftDays, 1, "saved cutoff history remains unchanged until approved recompute");
                    assert.deepEqual([dtr.summary.grossPay, dtr.summary.deductions, dtr.summary.netPay], [15000, 50, 14950]);
                    assert.equal(dtr.rows[0].deductibleMinutes, 18);
                }
                assert.deepEqual(await PayrollRecord.findOne({ employeeId: data.code }).lean(), originalPayroll[index]);
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

test("08:05 automatic checkout is owned by the original weekday or weekend shift after refresh in all six businesses", async context => {
    context.mock.timers.enable({ apis: ["Date"], now: new Date("2026-10-25T01:00:00Z") });
    const flag = process.env.CRM_ATTENDANCE_AUTO_TIMEOUT;
    process.env.CRM_ATTENDANCE_AUTO_TIMEOUT = "true";
    try {
        for (const day of ["2026-10-23", "2026-10-24"]) {
            const next = new Date(`${day}T00:00:00Z`); next.setUTCDate(next.getUTCDate() + 1);
            const nextDay = next.toISOString().slice(0, 10), checkoutAt = `${nextDay}T00:05:00.000Z`;
            const data = await seed(`synthetic-automatic-${day}`, [["Time In", `${day}T15:00:05Z`], ["Break Out", `${day}T23:45:00Z`]]);
            const session = await (await data.request(0, data.endpoint(0, "session"))).json();
            const command = { operation: "auto-time-out" as const, commandId: autoTimeOutCommandId(session.sessionId),
                expectedRevision: session.revision, sessionId: session.sessionId, reason: "Synthetic automatic overnight checkout" };
            await runWithBusiness(businesses[0], () => executeAttendanceCommand(data.identity, command,
                { role: "system", code: "attendance-auto-time-out" }, new Date(checkoutAt)));
            await deliverAttendanceLedger(data.identity.key);
            for (let index = 0; index < businesses.length; index++) for (let refresh = 0; refresh < 2; refresh++) {
                const fresh = await (await data.request(index, data.endpoint(index, "session"))).json();
                assert.equal(fresh.state, "OFFLINE");
                const out = fresh.records.find((event: { source: string }) => event.source === "Time Out");
                assert.equal(out.at, checkoutAt); assert.equal(out.autoTimeOut, true); assert.equal(out.shiftDayKey, day);
                const history = await (await data.request(index, `/attendance?all=true&employeeIds=${data.people[index]._id}`)).json();
                const hrOut = history.find((event: { eventId: string }) => event.eventId === out.id);
                assert.equal(hrOut.shiftDayKey, day); assert.equal(hrOut.sequence, out.sequence); assert.equal(hrOut.autoTimeOut, true);
                assert.equal(fresh.dashboardDays.filter((item: { timeIn: string | null }) => item.timeIn).length, 1);
                assert.equal(fresh.dashboardDays.find((item: { dayKey: string }) => item.dayKey === day).timeOut, checkoutAt);
                const hub = await (await data.request(index, `/attendance-hub/days?shiftView=date&shiftDate=${day}&employee=${data.code}&business=${businesses[index]}`)).json();
                assert.equal(hub.rows[0].timeOut, checkoutAt); assert.equal(hub.rows[0].dayKey, day);
                const dtr = await runWithBusiness(businesses[index], () => attendancePayrollDtr(data.people[index]._id, "Oct 21, 2026 - Nov 5, 2026"));
                const row = dtr.rows.find(item => item.dateKey === day)!;
                assert.notEqual(row.status, "Needs Review"); assert.equal(row.recordCount, 4);
                assert.equal(dtr.rows.find(item => item.dateKey === nextDay)!.recordCount, 0);
                const dashboard = await (await data.request(index, "/call-dashboard")).json();
                assert.equal(dashboard.employees.find((item: { employeeCode: string }) => item.employeeCode === data.code).status, "OFFLINE");
            }
            const count = (await AttendanceLedger.findById(data.identity.key).lean())!.events.length;
            await runWithBusiness(businesses[0], () => executeAttendanceCommand(data.identity, command,
                { role: "system", code: "attendance-auto-time-out" }, new Date(checkoutAt)));
            assert.equal((await AttendanceLedger.findById(data.identity.key).lean())!.events.length, count);
        }
    } finally { process.env.CRM_ATTENDANCE_AUTO_TIMEOUT = flag; context.mock.timers.reset(); }
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

test("earlier Add Time Out replaces later actions in one session, and Undo restores them across six businesses", async context => {
    context.mock.timers.enable({ apis: ["Date"], now: new Date("2026-10-22T18:00:00Z") });
    try {
        await initializeEmployeePaymentHistory(true);
        const data = await seed("synthetic-early-checkout", [["Time In", "2026-10-21T15:00:00Z"], ["Break Out", "2026-10-21T16:00:00Z"],
            ["Break In", "2026-10-21T16:20:00Z"], ["Lunch Break Out", "2026-10-21T18:00:00Z"], ["Lunch Break In", "2026-10-21T19:01:00Z"],
            ["Non-Billable Off the Phone Out", "2026-10-21T20:00:00Z"], ["Off the Phone In", "2026-10-21T20:05:01Z"],
            ["Time In", "2026-10-22T15:00:00Z"], ["Break Out", "2026-10-22T17:00:00Z"]]);
        const originalSaved: unknown[] = [];
        for (let index = 0; index < 6; index++) originalSaved.push(await runWithBusiness(businesses[index], async () => {
            const payPeriod = (await employeePayments(data.code)).currentPayPeriod;
            await PayrollRecord.create({ employeeId: data.code, employeeName: "Synthetic Missing Checkout", department: "Fixture", payType: "Semi-monthly",
                payPeriod, grossPay: 15000, deductions: 50, netPay: 14950, status: index % 2 ? "Paid" : "Pending", paidOn: index % 2 ? "Oct 22, 2026" : "-" });
            return PayrollRecord.findOne({ employeeId: data.code }).lean();
        }));
        const before = await (await data.request(0, data.endpoint(0, "session"))).json();
        const command = { operation: "add-time-out", commandId: crypto.randomUUID(), expectedRevision: before.revision, fingerprint: before.fingerprint,
            sessionId: before.sessions[0].id, timeOutAt: "2026-10-21T18:30:00Z", closeRest: true, reason: "Synthetic reviewed earlier checkout" };
        assert.equal((await data.request(0, data.endpoint(0, "commands"), command, true)).status, 403);
        const preview = await data.request(0, data.endpoint(0, "preview"), command);
        assert.equal(preview.status, 200, JSON.stringify(await preview.clone().json()));
        assert.deepEqual((await preview.json()).targets, data.events.slice(4, 7).map(event => event.id));
        assert.equal((await AttendanceLedger.findById(data.identity.key).lean())!.revision, before.revision);
        const response = await data.request(1, data.endpoint(1, "commands"), command);
        assert.equal(response.status, 200, JSON.stringify(await response.clone().json()));
        const saved = await response.json();
        assert.equal(saved.state, "BREAK"); assert.equal(saved.sessionId, before.sessionId);
        const verify = async (reversed: boolean) => {
            for (let index = 0; index < 6; index++) for (let refresh = 0; refresh < 2; refresh++) {
                const fresh = await (await data.request(index, data.endpoint(index, "session"))).json();
                assert.equal(fresh.state, "BREAK"); assert.equal(fresh.sessionId, before.sessionId); assert.equal(fresh.syncPending, false);
                assert.deepEqual(fresh.sessions[1].events.map((event: { id: string }) => event.id), before.sessions[1].events.map((event: { id: string }) => event.id));
                const events = fresh.sessions[0].events;
                if (reversed) assert.deepEqual(events.map((event: { source: string; at: string }) => [event.source, Date.parse(event.at)]), data.events.slice(0, 7).map(event => [event.source, Date.parse(event.at)]));
                else {
                    assert.deepEqual(events.slice(-2).map((event: { source: string }) => event.source), ["Lunch Break In", "Time Out"]);
                    assert.ok(events.every((event: { at: string }) => Date.parse(event.at) <= Date.parse(command.timeOutAt)));
                }
                const dtr = await runWithBusiness(businesses[index], () => attendancePayrollDtr(data.people[index]._id, "Oct 21, 2026 - Nov 5, 2026"));
                const day = dtr.rows.find(row => row.dateKey === "2026-10-21")!;
                if (!reversed) assert.deepEqual([day.excessBreakMinutes, day.excessLunchMinutes, day.nonBillableOffPhoneMinutes, day.earlyTimeOutMinutes, day.deductibleMinutes], [5, 0, 0, 330, 335]);
                const history = await (await data.request(index, `/attendance?all=true&employeeIds=${data.people[index]._id}`)).json();
                assert.ok(history.filter((row: { isEffective?: boolean }) => row.isEffective !== false).every((row: { eventId: string }) => fresh.records.some((event: { id: string }) => row.eventId === event.id)));
                await runWithBusiness(businesses[index], async () => {
                    assert.deepEqual(await PayrollRecord.findOne({ employeeId: data.code }).lean(), originalSaved[index]);
                    const payments = await employeePayments(data.code);
                    assert.equal(payments.items.length, 1);
                    assert.deepEqual([payments.items[0].grossPay, payments.items[0].deductions, payments.items[0].netPay, payments.items[0].status], [15000, 50, 14950, index % 2 ? "Paid" : "Pending"]);
                    assert.equal((await Employee.findById(data.people[index]._id).lean())?.availabilityStatus, "BREAK");
                });
            }
        };
        await verify(false);
        const replay = await data.request(2, data.endpoint(2, "commands"), command); assert.equal((await replay.json()).revision, saved.revision);
        const undo = { operation: "undo", targetCommandId: command.commandId, expectedRevision: saved.revision, commandId: crypto.randomUUID(), reason: "Synthetic undo earlier checkout" };
        const undoPreview = await data.request(0, data.endpoint(0, "preview"), undo); assert.equal(undoPreview.status, 200, JSON.stringify(await undoPreview.clone().json()));
        const undone = await data.request(3, data.endpoint(3, "commands"), undo); assert.equal(undone.status, 200, JSON.stringify(await undone.clone().json()));
        await verify(true);
        const ledger = await AttendanceLedger.findById(data.identity.key).lean(); assert.deepEqual(ledger!.events.slice(0, data.events.length), data.events);
        assert.equal((await data.request(0, data.endpoint(0, "commands"), { ...undo, commandId: crypto.randomUUID() })).status, 409);
    } finally { context.mock.timers.reset(); }
});

test("earlier current checkout goes OFFLINE and rejects stale, cross-session and future corrections", async context => {
    context.mock.timers.enable({ apis: ["Date"], now: new Date("2026-10-22T18:00:00Z") });
    try {
        for (const [index, outgoing] of (["Break Out", "Lunch Break Out", "Off the Phone Out", "Non-Billable Off the Phone Out"] as const).entries()) {
            const data = await seed(`synthetic-early-current-${index}`, [["Time In", "2026-10-22T15:00:00Z"], [outgoing, "2026-10-22T16:00:00Z"],
                [outgoing === "Break Out" ? "Break In" : outgoing === "Lunch Break Out" ? "Lunch Break In" : "Off the Phone In", "2026-10-22T17:00:00Z"]]);
            const before = await (await data.request(0, data.endpoint(0, "session"))).json();
            const command = { operation: "add-time-out", commandId: crypto.randomUUID(), expectedRevision: before.revision, sessionId: before.sessionId,
                timeOutAt: "2026-10-22T16:30:01Z", closeRest: true, reason: "Synthetic earlier current checkout" };
            for (const invalid of [{ timeOutAt: "2026-10-22T14:59:59Z" }, { timeOutAt: "2026-10-22T18:00:01Z" }, { closeRest: false }, { sessionId: "another-session" }]) {
                assert.ok([409, 422].includes((await data.request(0, data.endpoint(0, "preview"), { ...command, ...invalid })).status));
            }
            const saved = await data.request(0, data.endpoint(0, "commands"), command); assert.equal(saved.status, 200, JSON.stringify(await saved.clone().json()));
            const after = await saved.json(); assert.equal(after.state, "OFFLINE");
            for (let business = 0; business < 6; business++) {
                const snapshot = await (await data.request(business, data.endpoint(business, "session"))).json(); assert.equal(snapshot.state, "OFFLINE");
                const dashboard = await (await data.request(business, "/call-dashboard")).json();
                assert.equal(dashboard.employees.find((item: { employeeCode: string }) => item.employeeCode === data.code).status, "OFFLINE");
            }
            assert.equal((await data.request(0, data.endpoint(0, "commands"), { ...command, commandId: crypto.randomUUID() })).status, 409);
            const undo = { operation: "undo", targetCommandId: command.commandId, expectedRevision: after.revision, commandId: crypto.randomUUID(), reason: "Synthetic undo current checkout" };
            const undone = await data.request(0, data.endpoint(0, "commands"), undo); assert.equal(undone.status, 200, JSON.stringify(await undone.clone().json()));
            assert.equal((await undone.json()).state, "ONLINE");
        }
    } finally { context.mock.timers.reset(); }
});

test("all six businesses explain checkout-before-check-in without changing attendance or paid payroll", async context => {
    context.mock.timers.enable({ apis: ["Date"], now: new Date("2026-10-27T02:00:00Z") });
    try {
        const data = await seed("synthetic-checkout-order", [["Time In", "2026-10-26T14:59:37Z"]]);
        const before = await (await data.request(0, data.endpoint(0, "session"))).json();
        const payroll = [];
        for (let index = 0; index < 6; index++) payroll.push(await runWithBusiness(businesses[index], async () => {
            await PayrollRecord.create({ employeeId: data.code, employeeName: "Synthetic Missing Checkout", department: "Fixture", payType: "Semi-monthly",
                payPeriod: "Oct 21, 2026 - Nov 5, 2026", grossPay: 15000, deductions: 50, netPay: 14950, status: "Paid", paidOn: "Oct 26, 2026" });
            return PayrollRecord.findOne({ employeeId: data.code }).lean();
        }));
        for (let index = 0; index < 6; index++) {
            for (const action of ["preview", "commands"]) {
                const response = await data.request(index, data.endpoint(index, action), { operation: "add-time-out", commandId: crypto.randomUUID(),
                    expectedRevision: before.revision, sessionId: before.sessionId, timeOutAt: "2026-10-26T03:38:00Z", closeRest: false, reason: "Synthetic invalid AM/PM test" });
                assert.equal(response.status, 422);
                const failure = await response.json(); assert.equal(failure.code, "INVALID_CHECKOUT"); assert.equal(failure.message, timeOutBeforeTimeInMessage);
            }
            const refreshed = await (await data.request(index, data.endpoint(index, "session"))).json();
            assert.equal(refreshed.revision, before.revision); assert.deepEqual(refreshed.records, before.records);
            assert.deepEqual(refreshed.audit, before.audit); assert.equal(refreshed.state, "ONLINE");
            assert.deepEqual(await runWithBusiness(businesses[index], () => PayrollRecord.findOne({ employeeId: data.code }).lean()), payroll[index]);
        }
    } finally { context.mock.timers.reset(); }
});
