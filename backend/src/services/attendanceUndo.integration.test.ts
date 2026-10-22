import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import { before, after, test } from "node:test";
import mongoose from "mongoose";
import { MongoMemoryReplSet } from "mongodb-memory-server";

const prefix = `undo_${crypto.randomUUID().replaceAll("-", "")}`;
const businesses = Array.from({ length: 6 }, (_, i) => `undo-${i}`);
Object.assign(process.env, { NODE_ENV: "test", CRM_ATTENDANCE_INTEGRITY: "true", CRM_ATTENDANCE_DURATION_MODEL: "true",
    CRM_ATTENDANCE_HUB: "true", CRM_ATTENDANCE_ACCURACY_FIXES: "true", CRM_PAYROLL_ACCURACY: "true",
    CRM_ATTENDANCE_AUTO_TIMEOUT: "false", CRM_ATTENDANCE_BREAK_GAP: "false", CRM_SECURITY_LEGACY_AUTH: "true",
    CRM_ADMIN_ONE_CODE: "synthetic-undo-admin", CRM_ADMIN_SESSION_SECRET: crypto.randomBytes(48).toString("hex"),
    DEFAULT_BUSINESS_ID: businesses[0], DEFAULT_BUSINESS_DATABASE: `${prefix}_0`, CONTROL_DATABASE_NAME: `${prefix}_control`,
    BUSINESS_DATABASES: JSON.stringify(businesses.map((id, i) => ({ id, databaseName: `${prefix}_${i}` }))) });
const { createApp } = await import("../app");
const { runWithBusiness } = await import("../config/tenancy");
const { Employee } = await import("../models/Employee");
const { AttendanceLedger, AttendancePolicy } = await import("../models/AttendanceLedger");
const { setBusinessAccessForEmployeeCode } = await import("../models/BusinessUserAccess");
const { createAttendanceHubSession } = await import("../config/attendanceHubSession");
const { createAdminDashboardSession } = await import("../config/adminDashboardSession");
let mongo: MongoMemoryReplSet, server: http.Server, base = "";
before(async () => {
    mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } }); await mongoose.connect(mongo.getUri(prefix));
    await AttendancePolicy.create({ _id: "global-attendance", revision: 1, graceMinutes: 0, breakMinutes: 15, lunchMinutes: 60, shiftStart: "23:00", shiftEnd: "08:00", recoveryEnabled: false, recoveryTime: "22:59" });
    server = http.createServer(createApp()); await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`;
});

test("reviewed earlier break and lunch pair undo preserves newer checkout and recalculates hub, dashboard and payroll in all six businesses", async context => {
    context.mock.timers.enable({ apis: ["Date"], now: new Date("2026-10-22T15:05:00Z") });
    try {
        const code = "synthetic-paired-undo";
        await setBusinessAccessForEmployeeCode(code, businesses);
        const people: Array<{ _id: mongoose.Types.ObjectId }> = [];
        for (const business of businesses) people.push(await runWithBusiness(business, () => Employee.create({ employeeCode: code, name: "Synthetic Paired Undo", role: "Test", team: "Fixture", status: "Active", dateHired: "2026-10-22" })));
        const employee = createAttendanceHubSession(code)!, admin = createAdminDashboardSession("synthetic-undo-admin")!;
        const request = (index: number, path: string, body?: unknown, asAdmin = false) => fetch(`${base}${path}`, { method: body ? "POST" : "GET",
            headers: { "Content-Type": "application/json", "X-Business-Id": businesses[index], [asAdmin ? "X-CRM-Admin-Session" : "X-CRM-Attendance-Session"]: asAdmin ? admin : employee },
            ...(body ? { body: JSON.stringify(body) } : {}) });
        const endpoint = (index: number, path: string) => `/employees/${people[index]._id}/attendance/${path}`;
        let revision = 0;
        let records: Array<{ id: string; source: string; commandId: string }> = [];
        for (const [source, at] of [["Time In","2026-10-22T15:05:00Z"],["Break Out","2026-10-22T16:00:00Z"],["Break In","2026-10-22T16:16:01Z"],
            ["Lunch Break Out","2026-10-22T18:00:00Z"],["Lunch Break In","2026-10-22T19:01:00Z"],["Time Out","2026-10-22T23:50:00Z"]]) {
            context.mock.timers.setTime(+new Date(at));
            const response = await request(0, endpoint(0,"commands"), { commandId: crypto.randomUUID(), expectedRevision: revision, operation: "action", source });
            assert.equal(response.status,200,JSON.stringify(await response.clone().json())); const saved = await response.json(); revision = saved.revision; records = saved.records;
        }
        context.mock.timers.setTime(+new Date("2026-10-23T00:10:00Z"));
        const original = structuredClone(records), checkout = original.at(-1)!;
        const { attendancePayrollDtr } = await import("../controllers/payrollController");
        const { deliverAttendanceLedger } = await import("./attendanceLedgerOutbox");
        const verify = async (breakMinutes: number, lunchMinutes: number) => {
            const ledger = await AttendanceLedger.findOne({ employeeCode: code }).select("_id").lean();
            await deliverAttendanceLedger(ledger!._id);
            for (let i=0;i<6;i++) {
                const snapshot = await (await request(i,endpoint(i,"session"))).json();
                assert.equal(snapshot.state,"OFFLINE"); assert.equal(snapshot.records.at(-1).id,checkout.id,"later checkout is never removed or rewritten");
                const day = snapshot.dashboardDays.find((day: {dayKey:string})=>day.dayKey==="2026-10-22");
                assert.deepEqual([day.milliseconds.overBreak,day.milliseconds.overLunch,day.milliseconds.underTime].map((n:number)=>n/60000),[breakMinutes,lunchMinutes,10]);
                const hubResponse = await request(i,`/attendance-hub/days?shiftView=date&shiftDate=2026-10-22&employee=${code}&business=${businesses[i]}`,undefined,true);
                assert.equal(hubResponse.status,200); const hub = (await hubResponse.json()).rows[0];
                assert.deepEqual([hub.milliseconds.overBreak,hub.milliseconds.overLunch,hub.milliseconds.underTime].map((n:number)=>n/60000),[breakMinutes,lunchMinutes,10]);
                const dtr = await runWithBusiness(businesses[i],()=>attendancePayrollDtr(people[i]._id,"Oct 21, 2026 - Nov 5, 2026"));
                const row = dtr.rows.find(row=>row.dateKey==="2026-10-22")!;
                assert.deepEqual([row.lateMinutes,row.excessBreakMinutes,row.excessLunchMinutes,row.earlyTimeOutMinutes,row.deductibleMinutes],[5,breakMinutes,lunchMinutes,10,15+breakMinutes+lunchMinutes]);
            }
        };
        await verify(2,1);
        for (const [index,prefix] of ["Break","Lunch Break"].entries()) {
            const targets = original.filter(event=>event.source===`${prefix} Out`||event.source===`${prefix} In`);
            const body = { commandId:crypto.randomUUID(),expectedRevision:revision,operation:"correct",reason:"Synthetic reviewed paired Undo; preserve newer checkout",changes:targets.map(event=>({targetId:event.id,remove:true})) };
            const preview = await request(index+1,endpoint(index+1,"preview"),body,true); assert.equal(preview.status,200,JSON.stringify(await preview.clone().json()));
            const planned = await preview.json(); assert.deepEqual(planned.targets.sort(),targets.map(event=>event.id).sort());
            assert.equal((await (await request(0,endpoint(0,"session"))).json()).revision,revision,"preview never changes records or deductions");
            const response = await request(index+1,endpoint(index+1,"commands"),body,true); assert.equal(response.status,200); revision = (await response.json()).revision;
            await verify(0,index?0:1);
            const replay = await request(index+1,endpoint(index+1,"commands"),body,true); assert.equal((await replay.json()).revision,revision);
        }
        const ledger = await AttendanceLedger.findOne({employeeCode:code}).lean(); assert.equal(ledger!.events.length,6); assert.equal(ledger!.corrections.length,2);
    } finally {context.mock.timers.reset();}
});
after(async () => { server?.closeAllConnections(); server?.close(); await mongoose.disconnect(); await mongo?.stop(); });

test("signed previews and both explicit undo targets stay audited and synchronized after fresh reads in six businesses", async () => {
    const code = "synthetic-undo-employee";
    await setBusinessAccessForEmployeeCode(code, businesses);
    const people: Array<{ _id: mongoose.Types.ObjectId }> = [];
    for (const business of businesses) people.push(await runWithBusiness(business, () => Employee.create({ employeeCode: code, name: "Synthetic Undo Employee", role: "Test", team: "Fixture", status: "Active" })));
    const employee = createAttendanceHubSession(code)!, admin = createAdminDashboardSession("synthetic-undo-admin")!;
    const request = (index: number, path: string, body?: unknown, asAdmin = false) => fetch(`${base}/employees/${people[index]._id}/attendance/${path}`, {
        method: body ? "POST" : "GET", headers: { "Content-Type": "application/json", "X-Business-Id": businesses[index],
            [asAdmin ? "X-CRM-Admin-Session" : "X-CRM-Attendance-Session"]: asAdmin ? admin : employee }, ...(body ? { body: JSON.stringify(body) } : {}) });
    let revision = 0;
    const commands: string[] = [];
    for (const source of ["Time In", "Break Out", "Break In"]) {
        const commandId = crypto.randomUUID(); commands.push(commandId);
        const response = await request(0, "commands", { commandId, expectedRevision: revision, operation: "action", source });
        assert.equal(response.status, 200, JSON.stringify(await response.clone().json())); revision = (await response.json()).revision;
    }
    const invalid = { commandId: crypto.randomUUID(), expectedRevision: revision, operation: "undo", targetCommandId: commands[1], reason: "Synthetic dependent undo test" };
    for (let i = 0; i < 6; i++) {
        const response = await request(i, "preview", invalid, true); assert.equal(response.status, 422);
        const rejected = await response.json(); assert.equal(rejected.code, "INVALID_TIMELINE"); assert.ok(rejected.details.length);
        assert.equal((await (await request(i, "session")).json()).revision, revision);
    }
    for (const [offset, targetCommandId] of [commands[2], commands[1]].entries()) {
        const input = { commandId: crypto.randomUUID(), expectedRevision: revision, operation: "undo", targetCommandId, reason: "Synthetic reviewed accidental button" };
        const preview = await request(offset + 1, "preview", input, true); assert.equal(preview.status, 200);
        assert.equal((await (await request(0, "session")).json()).revision, revision, "preview never commits");
        const committed = await request(offset + 1, "commands", input, true); assert.equal(committed.status, 200); revision = (await committed.json()).revision;
        for (let i = 0; i < 6; i++) {
            const fresh = await (await request(i, "session")).json();
            assert.equal(fresh.revision, revision); assert.equal(fresh.state, offset ? "ONLINE" : "BREAK"); assert.equal(fresh.syncPending, false);
            assert.equal(fresh.audit.at(-1).operation, "undo");
        }
        const replay = await request(offset + 1, "commands", input, true); assert.equal(replay.status, 200); assert.equal((await replay.json()).revision, revision);
    }
    const ledger = await AttendanceLedger.findOne({ employeeCode: code }).lean();
    assert.equal(ledger!.events.length, 3, "original evidence is retained"); assert.equal(ledger!.corrections.length, 2);
    const unauthorized = await request(0, "preview", { ...invalid, expectedRevision: revision }); assert.equal(unauthorized.status, 403);
});
