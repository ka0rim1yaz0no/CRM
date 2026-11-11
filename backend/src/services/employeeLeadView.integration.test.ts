import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import {after, before, beforeEach, test} from "node:test";
import mongoose from "mongoose";
import {MongoMemoryReplSet} from "mongodb-memory-server";

const root = `employee_view_${crypto.randomUUID().replaceAll("-", "")}`;
const businesses = Array.from({length: 7}, (_, index) => `view-${index}`);
const now = new Date("2026-10-22T17:00:00Z");
process.env.NODE_ENV = "test";
process.env.CRM_SECURITY_LEGACY_AUTH = "true";
process.env.CRM_CALL_TIMING_V2 = "true";
process.env.CRM_LEAD_PHONE_DEDUP_V2 = "true";
process.env.CRM_ADMIN_SESSION_SECRET = crypto.randomBytes(48).toString("base64");
process.env.DEFAULT_BUSINESS_ID = businesses[0];
process.env.DEFAULT_BUSINESS_DATABASE = `${root}_0`;
process.env.CONTROL_DATABASE_NAME = `${root}_control`;
process.env.BUSINESS_DATABASES = JSON.stringify(businesses.map((id, index) => ({id, databaseName: `${root}_${index}`})));
const {createApp} = await import("../app");
const {runWithBusiness} = await import("../config/tenancy");
const {Employee} = await import("../models/Employee");
const {Lead} = await import("../models/Lead");
const {getCallBridgeDeviceModel, getCallBridgeScheduleModel} = await import("../models/CallBridge");
const {setBusinessAccessForEmployeeCode} = await import("../models/BusinessUserAccess");
const {createAttendanceHubSession} = await import("../config/attendanceHubSession");
const {invalidateLeadPhoneSnapshot} = await import("./leadPhoneSnapshotCache");
let mongo: MongoMemoryReplSet, server: http.Server, base = "";
before(async () => {
    mongo = await MongoMemoryReplSet.create({replSet: {count: 1}, instanceOpts: [{args: ["--wiredTigerCacheSizeGB", "0.25"]}]});
    const uri = mongo.getUri(root); assert.equal(new URL(uri).hostname, "127.0.0.1");
    await mongoose.connect(uri); server = http.createServer(createApp());
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as {port: number}).port}/api`;
});
after(async () => {server?.closeAllConnections(); server?.close(); await mongoose.disconnect(); await mongo?.stop();});
beforeEach(async () => {
    for (const business of businesses) await runWithBusiness(business, async () => {
        await Lead.deleteMany({}); await Employee.deleteMany({}); invalidateLeadPhoneSnapshot(business);
    });
    await getCallBridgeDeviceModel().deleteMany({}); await getCallBridgeScheduleModel().deleteMany({});
});
type Page = {leads: Array<{_id: string; status: string; businessAddress: string}>; page: number; total: number; hasMore: boolean;
    nextPage: number | null; callingQueue?: {nextLeadId: string | null; entries: unknown[]}};
async function fixture(business = businesses[0]) {
    const code = `synthetic-view-${crypto.randomUUID()}`;
    await setBusinessAccessForEmployeeCode(code, businesses);
    const owner = await runWithBusiness(business, () => Employee.create({employeeCode: code, name: code, role: "Sales", status: "Active", availabilityStatus: "ONLINE"}));
    const add = (extra: Record<string, unknown> = {}) => runWithBusiness(business, () => Lead.create({businessName: `Synthetic ${crypto.randomUUID()}`,
        status: "NEW", phone: "+12025550121", assignedAgent: owner._id, assignedAgentName: owner.name, createdAt: new Date(+now - 100000), ...extra}));
    const request = (query = "", employeeCode: string | null = code) => fetch(`${base}/my-leads?${query}`, {headers: {"X-Business-Id": business,
        ...(employeeCode ? {"X-CRM-Attendance-Session": createAttendanceHubSession(employeeCode)!} : {})}});
    const read = async (query = "") => {const response = await request(query); assert.equal(response.status, 200); return response.json() as Promise<Page>;};
    return {business, code, owner, add, read, request};
}
test("new assigned leads are first after refresh in all seven businesses without displacing automatic callback priority", async context => {
    context.mock.timers.enable({apis: ["Date"], now});
    try {
        for (const business of businesses) {
            const f = await fixture(business);
            const due = await f.add({status: "Follow up", followUpAt: new Date(+now - 1000), phone: "+12025550122"});
            const fresh = await f.add({createdAt: new Date(+now - 1000)});
            await f.add({phone: "+12025550123", createdAt: new Date(+now - 2000)});
            const beforeQueue = await f.read("callingQueue=true"); assert.equal(beforeQueue.callingQueue!.nextLeadId, String(due._id));
            for (let refresh = 0; refresh < 2; refresh++) {
                const workspace = await f.read("workspaceView=true&windowEndPage=1");
                assert.equal(workspace.leads[0]._id, String(fresh._id)); assert.equal(workspace.total, 3); assert.equal(workspace.callingQueue, undefined);
                assert.equal((await f.read("callingQueue=true")).callingQueue!.nextLeadId, String(due._id));
            }
        }
    } finally {context.mock.timers.reset();}
});
test("scrolled windows retain every canonical assigned new lead and exclude other owners, unassigned and worked duplicates", async context => {
    context.mock.timers.enable({apis: ["Date"], now});
    try {
        const f = await fixture(), seed = Array.from({length: 151}, (_, index) => ({businessName: `Synthetic visible ${index}`, phone: `+1202555${String(index + 1000).padStart(4, "0")}`,
            status: "NEW", assignedAgent: f.owner._id, assignedAgentName: f.owner.name, createdAt: new Date(+now - 500000 + index * 1000), businessAddress: "Dallas, TX"}));
        const records = await runWithBusiness(f.business, () => Lead.insertMany(seed));
        const otherOwner = new mongoose.Types.ObjectId();
        await f.add({phone: "+12025550321", assignedAgent: otherOwner, assignedAgentName: "Synthetic other"});
        await f.add({phone: "+12025550322", assignedAgent: null, assignedAgentName: ""});
        const hidden = await f.add({phone: "+12025550323", createdAt: new Date(+now - 1)});
        // Seed a legacy duplicate directly in the disposable database; real writes must still reject duplicates.
        const worked = {_id: new mongoose.Types.ObjectId()};
        await mongoose.connection.getClient().db(`${root}_0`).collection("leads").insertOne({...worked,
            phone: hidden.phone, status: "Qualified", businessName: "Synthetic legacy worked duplicate", notes: "Synthetic retained saved work",
            assignedAgent: f.owner._id, assignedAgentName: f.owner.name, createdAt: new Date(+now - 999999), updatedAt: now, comments: [], activity: [], callLogs: []});
        invalidateLeadPhoneSnapshot(f.business);
        const readRecords = () => runWithBusiness(f.business, async () => JSON.stringify(await Lead.find().sort({_id: 1}).lean()));
        const before = await readRecords();
        for (let refresh = 0; refresh < 2; refresh++) {
            const first = await f.read("workspaceView=true&windowEndPage=3&limit=50");
            assert.equal(first.page, 3); assert.equal(first.leads.length, 150); assert.equal(first.total, 151); assert.equal(first.hasMore, true); assert.equal(first.nextPage, 4);
            assert.equal(new Set(first.leads.map(row => row._id)).size, 150); assert.equal(first.leads[0]._id, String(records.at(-1)!._id));
            const rest = await f.read("workspaceView=true&windowStartPage=4&windowEndPage=4&limit=50");
            assert.equal(rest.leads.length, 1); assert.equal(rest.hasMore, false); assert.equal(rest.nextPage, null);
            assert.equal(new Set([...first.leads, ...rest.leads].map(row => row._id)).size, 151);
            assert.ok(!first.leads.some(row => [String(hidden._id), String(worked._id)].includes(row._id)));
        }
        assert.equal(await readRecords(), before);
        assert.equal(await getCallBridgeScheduleModel().countDocuments(), 0); assert.equal(await getCallBridgeDeviceModel().countDocuments(), 0);
    } finally {context.mock.timers.reset();}
});
test("new assignments appear and reassigned or archived leads disappear from the same refreshed window", async context => {
    context.mock.timers.enable({apis: ["Date"], now});
    try {
        const f = await fixture(), retained = await f.add(), removed = await f.add({phone: "+12025550122"});
        assert.equal((await f.read("workspaceView=true&windowEndPage=3")).total, 2);
        const fresh = await f.add({phone: "+12025550123", createdAt: new Date(+now - 1)});
        await runWithBusiness(f.business, async () => {await Lead.updateOne({_id: removed._id}, {$set: {assignedAgent: new mongoose.Types.ObjectId(), assignedAgentName: "Synthetic moved"}});});
        invalidateLeadPhoneSnapshot(f.business);
        const result = await f.read("workspaceView=true&windowEndPage=3");
        assert.deepEqual(result.leads.map(row => row._id), [fresh, retained].map(row => String(row._id)));
        assert.equal(result.total, 2); assert.equal(result.page, 1); assert.equal(result.hasMore, false);
        await runWithBusiness(f.business, () => Lead.updateOne({_id: retained._id}, {$set: {status: "Archived"}})); invalidateLeadPhoneSnapshot(f.business);
        assert.deepEqual((await f.read("workspaceView=true&windowEndPage=1")).leads.map(row => row._id), [String(fresh._id)]);
    } finally {context.mock.timers.reset();}
});
test("workspace windows preserve search, state and signed ownership, including attempts to supply another employee ID", async () => {
    const f = await fixture(), local = await f.add({businessName: "Synthetic findme", businessAddress: "Dallas, TX"});
    await f.add({phone: "+12025550122", businessName: "Synthetic findme", businessAddress: "Miami, FL"});
    await f.add({phone: "+12025550123", businessName: "Synthetic unrelated", businessAddress: "Dallas, TX"});
    const foreign = await fixture(businesses[1]); await foreign.add({businessName: "Synthetic findme", businessAddress: "Dallas, TX"});
    const result = await f.read(`workspaceView=true&windowEndPage=2&search=findme&state=TX&employeeId=${foreign.owner._id}`);
    assert.deepEqual(result.leads.map(row => row._id), [String(local._id)]);
    const crossBusiness = await fetch(`${base}/my-leads?workspaceView=true&windowEndPage=1`, {headers: {"X-Business-Id": businesses[2], "X-CRM-Attendance-Session": createAttendanceHubSession(f.code)!}});
    assert.equal(crossBusiness.status, 403); await crossBusiness.arrayBuffer();
    const unsigned = await f.request("workspaceView=true&windowEndPage=1", null); assert.equal(unsigned.status, 401); await unsigned.arrayBuffer();
});
test("invalid or oversized windows and mixing browsing with dial-queue controls fail closed", async () => {
    const f = await fixture();
    for (const query of ["workspaceView=true&windowEndPage=21", "workspaceView=true&windowStartPage=0&windowEndPage=1",
        "workspaceView=true&windowStartPage=2&windowEndPage=1", "workspaceView=true&windowEndPage=1.5", "workspaceView=true&windowEndPage=Infinity",
        "workspaceView=true&windowStartPage=1", "windowEndPage=2", "workspaceView=true&callingQueue=true", "workspaceView=true&autoCallEligible=true"]) {
        const response = await f.request(query); assert.equal(response.status, 400, query); await response.arrayBuffer();
    }
});
test("workspace and automatic reads leave saved payroll, attendance and call controls byte-for-byte unchanged", async () => {
    const f = await fixture(); await f.add();
    const db = mongoose.connection.getClient().db(`${root}_0`);
    for (const collection of ["payrollrecords", "attendancesessions", "attendancecorrections"]) await db.collection(collection).insertOne({synthetic: true, status: "retained", value: 1});
    const schedule = await getCallBridgeScheduleModel().create({employeeCode: f.code, autoCallPaused: true, autoCallControlVersion: 7});
    const evidence = async () => JSON.stringify({records: await runWithBusiness(f.business, () => Lead.find().sort({_id: 1}).lean()),
        payroll: await db.collection("payrollrecords").find().toArray(), attendance: await db.collection("attendancesessions").find().toArray(),
        corrections: await db.collection("attendancecorrections").find().toArray(), schedule: await getCallBridgeScheduleModel().findById(schedule._id).lean()});
    const before = await evidence();
    for (let refresh = 0; refresh < 2; refresh++) {await f.read("workspaceView=true&windowEndPage=2"); await f.read("callingQueue=true");}
    assert.equal(await evidence(), before);
});

test("saving a note moves NEW and existing follow-up leads below untouched work after refresh in all seven businesses", async context => {
    context.mock.timers.enable({apis: ["Date"], now});
    try {
        for (const business of businesses) for (const status of ["NEW", "Follow up"]) {
            await runWithBusiness(business, () => Lead.deleteMany({}));
            const f = await fixture(business), saved = await f.add({status, createdAt: new Date(+now - 1000)});
            const untouched = await f.add({phone: "+12025550122", status: "Follow up", createdAt: new Date(+now - 5000)});
            const remainingNew = status === "NEW" ? await f.add({phone: "+12025550123", status: "NEW", createdAt: new Date(+now - 10000)}) : null;
            const initial = await f.read("workspaceView=true&windowEndPage=2"); assert.equal(initial.leads[0]._id, String(saved._id));
            const beforeQueue = await f.read("callingQueue=true");
            const response = await fetch(base + `/leads/${saved._id}/comments`, {method: "POST", headers: {"Content-Type": "application/json", "X-Business-Id": business,
                "X-CRM-Attendance-Session": createAttendanceHubSession(f.code)!}, body: JSON.stringify({body: "Synthetic saved employee note"})});
            assert.equal(response.status, 200); const updated = await response.json();
            assert.equal(updated.status, "Follow up"); assert.equal(updated.comments.at(-1).body, "Synthetic saved employee note");
            assert.equal(String(updated.assignedAgent._id || updated.assignedAgent), String(f.owner._id));
            assert.equal(+new Date(updated.createdAt), +saved.createdAt!);
            const expected = [...(remainingNew ? [remainingNew] : []), untouched, saved].map(row => String(row._id));
            for (let refresh = 0; refresh < 2; refresh++) {
                const page = await f.read("workspaceView=true&windowEndPage=2"); assert.deepEqual(page.leads.map(row => row._id), expected);
                const queue = await f.read("callingQueue=true");
                assert.equal(queue.callingQueue!.nextLeadId, String((remainingNew || untouched)._id));
                assert.equal((queue.callingQueue as unknown as {policyVersion: string}).policyVersion,
                    (beforeQueue.callingQueue as unknown as {policyVersion: string}).policyVersion);
            }
            assert.equal(await getCallBridgeScheduleModel().countDocuments(), 0, "a note/read never authorizes a dial");
        }
    } finally {context.mock.timers.reset();}
});

test("a rejected empty note never changes sidebar order, ownership or saved records", async context => {
    context.mock.timers.enable({apis: ["Date"], now});
    try {
        const f = await fixture(), first = await f.add({createdAt: new Date(+now - 1)});
        await f.add({phone: "+12025550122", createdAt: new Date(+now - 1000)});
        const records = () => runWithBusiness(f.business, async () => JSON.stringify(await Lead.find().sort({_id: 1}).lean()));
        const before = await records();
        const response = await fetch(base + `/leads/${first._id}/comments`, {method: "POST", headers: {"Content-Type": "application/json", "X-Business-Id": f.business,
            "X-CRM-Attendance-Session": createAttendanceHubSession(f.code)!}, body: JSON.stringify({body: "   "})});
        assert.equal(response.status, 400); await response.arrayBuffer();
        assert.equal((await f.read("workspaceView=true&windowEndPage=1")).leads[0]._id, String(first._id));
        assert.equal(await records(), before);
    } finally {context.mock.timers.reset();}
});
