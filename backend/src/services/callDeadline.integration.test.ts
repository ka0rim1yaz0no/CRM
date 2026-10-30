import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import {after, before, beforeEach, test} from "node:test";
import mongoose from "mongoose";
import {MongoMemoryReplSet} from "mongodb-memory-server";

const root = `deadline_${crypto.randomUUID().replaceAll("-", "")}`;
const businesses = Array.from({length: 6}, (_, i) => ({id: `deadline-${i}`, databaseName: `${root}_${i}`}));
const now = new Date("2026-10-28T17:00:00Z");
Object.assign(process.env, {NODE_ENV: "test", CRM_SECURITY_LEGACY_AUTH: "true", CRM_CALL_TIMING_V2: "true", CRM_LEAD_PHONE_DEDUP_V2: "true", CRM_ATTENDANCE_INTEGRITY: "true",
    CRM_ADMIN_SESSION_SECRET: crypto.randomBytes(48).toString("base64"), DEFAULT_BUSINESS_ID: businesses[0].id,
    DEFAULT_BUSINESS_DATABASE: businesses[0].databaseName, CONTROL_DATABASE_NAME: `${root}_control`, BUSINESS_DATABASES: JSON.stringify(businesses)});
const {createApp} = await import("../app");
const {runWithBusiness} = await import("../config/tenancy");
const {Employee} = await import("../models/Employee");
const {Lead} = await import("../models/Lead");
const {AttendanceLedger} = await import("../models/AttendanceLedger");
const {setBusinessAccessForEmployeeCode, getAttendanceBusinessIdentity} = await import("../models/BusinessUserAccess");
const {createAttendanceHubSession} = await import("../config/attendanceHubSession");
const {getCallBridgeDeviceModel, getCallBridgeScheduleModel} = await import("../models/CallBridge");
const {prepareDeadlineQueue} = await import("./callDeadlinePreparation");
const {LeadPhoneSlot} = await import("./leadPhoneDispatch");
const {CALLING_QUEUE_POLICY_VERSION} = await import("../../../shared/leadCallingPolicy");
let mongo: MongoMemoryReplSet, server: http.Server, base = "";
let fixtureNumber = 0;
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
before(async () => {
    mongo = await MongoMemoryReplSet.create({replSet: {count: 1}}); await mongoose.connect(mongo.getUri(root));
    await getCallBridgeScheduleModel().createIndexes();
    server = http.createServer(createApp()); await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as {port: number}).port}/api`;
});
after(async () => {server?.closeAllConnections(); server?.close(); await mongoose.disconnect(); await mongo?.stop();});
beforeEach(async () => {
    for (const business of businesses) await runWithBusiness(business.id, async () => {await Lead.deleteMany({}); await Employee.deleteMany({}); await LeadPhoneSlot.deleteMany({});});
    await getCallBridgeDeviceModel().deleteMany({}); await getCallBridgeScheduleModel().deleteMany({}); await AttendanceLedger.deleteMany({});
});
async function fixture(business = businesses[0]) {
    const phone = `+12025550${String(101 + fixtureNumber++).padStart(3, "0")}`;
    const code = `synthetic-${crypto.randomUUID()}`; await setBusinessAccessForEmployeeCode(code, businesses.map(row => row.id));
    const employee = await runWithBusiness(business.id, () => Employee.create({employeeCode: code, name: "Synthetic Sales", role: "Sales", status: "Active", availabilityStatus: "ONLINE"}));
    const identity = await getAttendanceBusinessIdentity(code); assert.ok(identity);
    const key = `access:${identity.id}`, at = new Date(+now - 3600000).toISOString();
    const timeIn = {id: "in", source: "Time In" as const, at, recordedAt: at, commandId: "fixture", sequence: 1};
    await AttendanceLedger.create({_id: key, employeeCode: code, businessIds: businesses.map(row => row.id), canonicalBusinessId: business.id, revision: 1, events: [timeIn]});
    const deadline = new Date(+now + 10000);
    await getCallBridgeDeviceModel().create({employeeCode: code, deviceId: code, employeeName: "Synthetic", deviceName: "Synthetic", tokenHash: crypto.randomUUID(),
        state: "idle", nextivaProcessDetected: true, audioSessionActive: false, bridgeVersion: "0.4.2", businessIds: [business.id], lastSeenAt: now, lastStateChangedAt: now, lastIdleAt: now});
    await getCallBridgeScheduleModel().create({employeeCode: code, lastCallEndedAt: new Date(+now - 20000), nextCallAllowedAt: deadline});
    const add = (extra = {}) => runWithBusiness(business.id, () => Lead.create({businessName: "Synthetic", phone, status: "NEW", assignedAgent: employee._id, assignedAgentName: employee.name, ...extra}));
    const request = (attemptId = crypto.randomUUID(), signal?: AbortSignal, browser = {}) => fetch(base + "/call-bridge/dial-at-deadline", {method: "POST", signal,
        headers: {"Content-Type": "application/json", "X-Business-Id": business.id, "X-CRM-Attendance-Session": createAttendanceHubSession(code)!,
            "X-CRM-User-Code": code, "X-CRM-User-Type": "employee", "X-CRM-Auto-Call-Version": CALLING_QUEUE_POLICY_VERSION},
        body: JSON.stringify({employeeCode: code, attemptId, notBefore: deadline.toISOString(), ...browser})});
    await mongoose.connection.getClient().db(business.databaseName).collection("payrollrecords").insertOne({employee: employee._id, status: "Paid", netPay: 99, paidOn: new Date("2026-10-21")});
    return {business, code, employee, key, timeIn, deadline, add, request};
}

test("preparation selects the future due head without taking a lease and tracks legacy/raw lead writes", async context => {
    context.mock.timers.enable({apis: ["Date"], now});
    try {
        const f = await fixture(), old = await f.add();
        const due = await f.add({phone: "+12025550122", status: "Follow up", followUpAt: f.deadline});
        const before = JSON.stringify(await getCallBridgeScheduleModel().findOne({employeeCode: f.code}).lean());
        const plan = await runWithBusiness(f.business.id, () => prepareDeadlineQueue(f.employee, f.business.id, +f.deadline));
        try {
            assert.equal(plan.queue.nextLeadId, String(due._id));
            assert.equal(JSON.stringify(await getCallBridgeScheduleModel().findOne({employeeCode: f.code}).lean()), before);
            await runWithBusiness(f.business.id, () => Lead.collection.updateOne({_id: due._id}, {$set: {status: "Dead"}}));
            for (let i = 0; i < 40 && plan.queue.nextLeadId !== String(old._id); i++) {await plan.refresh(); await pause(25);}
            assert.equal(plan.queue.nextLeadId, String(old._id), "change streams include writes that bypass application cache hooks");
        } finally {await plan.close();}
    } finally {context.mock.timers.reset();}
});

test("all six businesses prepare before the deadline, authorize no early dial and replay only one dispatch", async context => {
    context.mock.timers.enable({apis: ["Date"], now});
    try {
        for (const business of businesses) {
            context.mock.timers.setTime(+now); const f = await fixture(business); const lead = await f.add();
            const paidBefore = JSON.stringify(await mongoose.connection.getClient().db(business.databaseName).collection("payrollrecords").findOne({employee: f.employee._id}));
            const punchesBefore = JSON.stringify((await AttendanceLedger.findById(f.key).lean())?.events);
            const attempt = crypto.randomUUID(); let completed = false;
            const pending = f.request(attempt).then(response => {completed = true; return response;});
            await pause(250); context.mock.timers.setTime(+f.deadline - 1); await pause(125);
            assert.equal(completed, false);
            assert.equal((await getCallBridgeScheduleModel().findOne({employeeCode: f.code}).lean())?.lastDialStartedAt, null);
            context.mock.timers.setTime(+f.deadline);
            const response = await pending; const body = await response.json(); assert.equal(response.status, 200, JSON.stringify(body));
            assert.equal(body.leadId, String(lead._id)); assert.equal(body.startedAt, f.deadline.toISOString()); assert.equal(body.alreadyStarted, false);
            const replay = await f.request(attempt); assert.equal(replay.status, 200); assert.equal((await replay.json()).alreadyStarted, true);
            assert.equal(JSON.stringify(await mongoose.connection.getClient().db(business.databaseName).collection("payrollrecords").findOne({employee: f.employee._id})), paidBefore);
            assert.equal(JSON.stringify((await AttendanceLedger.findById(f.key).lean())?.events), punchesBefore);
        }
    } finally {context.mock.timers.reset();}
});

test("the deadline endpoint retains signed employee, business and deadline boundaries", async context => {
    context.mock.timers.enable({apis: ["Date"], now});
    try {
        const f=await fixture();await f.add();
        const body={employeeCode:f.code,attemptId:crypto.randomUUID(),notBefore:f.deadline.toISOString()};
        const headers={"Content-Type":"application/json","X-Business-Id":f.business.id,"X-CRM-Attendance-Session":createAttendanceHubSession(f.code)!,"X-CRM-Auto-Call-Version":CALLING_QUEUE_POLICY_VERSION};
        assert.equal((await fetch(base+"/call-bridge/dial-at-deadline",{method:"POST",headers:{"Content-Type":"application/json","X-Business-Id":f.business.id},body:JSON.stringify(body)})).status,401);
        assert.equal((await fetch(base+"/call-bridge/dial-at-deadline",{method:"POST",headers,body:JSON.stringify({...body,employeeCode:"synthetic-other"})})).status,403);
        const future=await fetch(base+"/call-bridge/dial-at-deadline",{method:"POST",headers,body:JSON.stringify({...body,notBefore:new Date(+f.deadline+60000).toISOString()})});
        assert.equal(future.status,409);assert.equal((await future.json()).code,"CALL_DEADLINE_CHANGED");
        assert.equal((await getCallBridgeScheduleModel().findOne({employeeCode:f.code}).lean())?.lastDialStartedAt,null);
    }finally{context.mock.timers.reset();}
});

test("fractional-second stored bridge dates preserve the exact deadline in all six businesses", async context => {
    context.mock.timers.enable({apis: ["Date"], now});
    try {
        for (const business of businesses) {
            for (const fraction of [1, 237, 999]) {
                context.mock.timers.setTime(+now); const f = await fixture(business); await f.add();
                f.deadline.setMilliseconds(fraction);
                await getCallBridgeScheduleModel().updateOne({employeeCode: f.code}, {$set: {
                    lastCallEndedAt: new Date(+f.deadline - 30000), nextCallAllowedAt: f.deadline,
                }});
                let completed = false;
                const pending = f.request().then(response => {completed = true; return response;});
                await pause(250); context.mock.timers.setTime(+f.deadline - 1); await pause(125);
                assert.equal(completed, false, "a valid fractional deadline must wait, not conflict or authorize early");
                context.mock.timers.setTime(+f.deadline);
                const response = await pending; const body = await response.json();
                assert.equal(response.status, 200, JSON.stringify(body));
                assert.equal(body.startedAt, f.deadline.toISOString());
            }
        }
    } finally {context.mock.timers.reset();}
});

test("off-phone, non-billable off-phone, breaks, lunch and checkout during preparation prevent authorization", async context => {
    context.mock.timers.enable({apis: ["Date"], now});
    try {
        for (const source of ["Off the Phone Out", "Non-Billable Off the Phone Out", "Coaching Out", "Break Out", "Lunch Break Out", "Time Out"]) {
            context.mock.timers.setTime(+now); const f = await fixture(); await f.add(); const pending = f.request(); await pause(150);
            const at = new Date(+now + 5000).toISOString();
            await AttendanceLedger.updateOne({_id: f.key}, {$push: {events: {id: "pause", source, at, recordedAt: at, commandId: "pause", sequence: 2}}, $inc: {revision: 1}});
            context.mock.timers.setTime(+f.deadline);
            assert.equal((await pending).status, 409, source);
            assert.equal((await getCallBridgeScheduleModel().findOne({employeeCode: f.code}).lean())?.lastDialStartedAt, null);
        }
    } finally {context.mock.timers.reset();}
});

test("active or unknown bridge signals and changed roles stop the prepared call", async context => {
    context.mock.timers.enable({apis: ["Date"], now});
    try {
        for (const state of ["active", "unknown", "role"]) {
            context.mock.timers.setTime(+now); const f = await fixture(); await f.add(); const pending = f.request(); await pause(150);
            if (state === "role") await runWithBusiness(f.business.id, () => Employee.updateOne({_id: f.employee._id}, {$set: {role: "Support"}}));
            else await getCallBridgeDeviceModel().updateOne({employeeCode: f.code}, {$set: {state, audioSessionActive: state === "active"}});
            context.mock.timers.setTime(+f.deadline); assert.equal((await pending).status, 409);
            assert.equal((await getCallBridgeScheduleModel().findOne({employeeCode: f.code}).lean())?.lastDialStartedAt, null);
            assert.equal(await runWithBusiness(f.business.id, () => LeadPhoneSlot.countDocuments()), 0, "rejected authorization cannot leave a consumed phone slot");
        }
    } finally {context.mock.timers.reset();}
});

test("two prepared tabs have one winner and a disconnected request never authorizes a dial", async context => {
    context.mock.timers.enable({apis: ["Date"], now});
    try {
        const f = await fixture(); await f.add();
        const first = f.request(), second = f.request(); await pause(300); context.mock.timers.setTime(+f.deadline);
        const results = await Promise.all([first, second]); assert.equal(results.filter(response => response.status === 200).length, 1);
        assert.equal(results.filter(response => response.status === 409).length, 1);
        context.mock.timers.setTime(+now); const cancelled = await fixture(businesses[1]); await cancelled.add();
        const abort = new AbortController(), request = cancelled.request(crypto.randomUUID(), abort.signal).catch(() => null);
        await pause(200); abort.abort(); await request; await pause(100); context.mock.timers.setTime(+cancelled.deadline); await pause(200);
        assert.equal((await getCallBridgeScheduleModel().findOne({employeeCode: cancelled.code}).lean())?.lastDialStartedAt, null);
    } finally {context.mock.timers.reset();}
});

test("switchable bridges require current browser ownership at the deadline across all businesses", async context => {
    context.mock.timers.enable({apis: ["Date"], now});
    try {
        for (const business of businesses) {
            for (const takeover of [false, true]) {
                context.mock.timers.setTime(+now); const f = await fixture(business); await f.add();
                const browser = {browserDeviceKey: crypto.randomUUID(), browserSessionId: crypto.randomUUID()};
                await getCallBridgeDeviceModel().updateOne({employeeCode: f.code}, {$set: {accountSwitchingEnabled: true,
                    browserDeviceKeyHash: crypto.createHash("sha256").update(browser.browserDeviceKey).digest("hex"), browserSessionId: browser.browserSessionId}});
                const pending = f.request(crypto.randomUUID(), undefined, browser); await pause(150);
                if (takeover) await getCallBridgeDeviceModel().updateOne({employeeCode: f.code}, {$set: {browserSessionId: crypto.randomUUID()}});
                context.mock.timers.setTime(+f.deadline); const response = await pending;
                assert.equal(response.status, takeover ? 409 : 200);
                if (takeover) {
                    assert.equal((await response.json()).code, "CALL_BROWSER_SESSION_CHANGED");
                    assert.equal((await getCallBridgeScheduleModel().findOne({employeeCode: f.code}).lean())?.lastDialStartedAt, null);
                    assert.equal(await runWithBusiness(business.id, () => LeadPhoneSlot.countDocuments({employeeCode: f.code})), 0);
                }
            }
        }
    } finally {context.mock.timers.reset();}
});
