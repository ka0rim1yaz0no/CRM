import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import { after, before, beforeEach, test } from "node:test";
import mongoose from "mongoose";
import { MongoMemoryReplSet } from "mongodb-memory-server";

const root = `assignment_${crypto.randomUUID().replaceAll("-", "")}`;
const businesses = Array.from({ length: 6 }, (_, i) => `assignment-${i}`);
const now = new Date("2026-10-22T17:00:00Z");
process.env.NODE_ENV = "test";
process.env.CRM_SECURITY_LEGACY_AUTH = "true";
process.env.CRM_CALL_TIMING_V2 = "true";
process.env.CRM_ADMIN_ONE_CODE = "synthetic-assignment-admin";
process.env.CRM_ADMIN_TWO_CODE = "synthetic-assignment-tracker";
process.env.CRM_TRACKER_ADMIN_CODES = "synthetic-assignment-tracker";
process.env.CRM_ADMIN_SESSION_SECRET = crypto.randomBytes(48).toString("base64");
process.env.DEFAULT_BUSINESS_ID = businesses[0];
process.env.DEFAULT_BUSINESS_DATABASE = `${root}_0`;
process.env.CONTROL_DATABASE_NAME = `${root}_control`;
process.env.BUSINESS_DATABASES = JSON.stringify(businesses.map((id, i) => ({ id, databaseName: `${root}_${i}` })));
const { createApp } = await import("../app");
const { runWithBusiness } = await import("../config/tenancy");
const { Employee } = await import("../models/Employee");
const { Lead } = await import("../models/Lead");
const { SystemSettings } = await import("../models/SystemSettings");
const { setBusinessAccessForEmployeeCode } = await import("../models/BusinessUserAccess");
const { getCallBridgeScheduleModel, getCallBridgeDeviceModel } = await import("../models/CallBridge");
const { createAttendanceHubSession } = await import("../config/attendanceHubSession");
const { reassignLeadsFromAgent, runLeadAutoAssignmentBatch } = await import("../controllers/leadController");
const { employeeCallingQueue } = await import("./employeeCallingQueue");
const { withLeadDispatchOwnership } = await import("./leadAssignment");
let mongo: MongoMemoryReplSet, server: http.Server, base = "", adminSession = "", trackerSession = "";
before(async () => {
    mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    const uri = mongo.getUri(root);
    assert.equal(new URL(uri).hostname, "127.0.0.1");
    await mongoose.connect(uri);
    await getCallBridgeScheduleModel().createIndexes();
    server = http.createServer(createApp());
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`;
    for (const kind of ["admin", "tracker"]) {
        const response = await fetch(`${base}/auth/login`, { method: "POST", headers: { "Content-Type": "application/json", "X-Business-Id": businesses[0] }, body: JSON.stringify({ employeeCode: `synthetic-assignment-${kind}` }) });
        assert.equal(response.status, 200);
        const session = await response.json();
        if (kind === "admin") adminSession = session.sessionToken;
        else trackerSession = session.attendanceHubSession;
    }
});
after(async () => { server?.closeAllConnections(); server?.close(); await mongoose.disconnect(); await mongo?.stop(); });
beforeEach(async () => {
    for (const business of businesses) await runWithBusiness(business, async () => {
        await Lead.deleteMany({}); await Employee.deleteMany({}); await SystemSettings.deleteMany({});
    });
    await getCallBridgeScheduleModel().deleteMany({}); await getCallBridgeDeviceModel().deleteMany({});
});
function request(business: string, path: string, body?: unknown, employeeCode?: string, extra: Record<string, string> = {}) {
    return fetch(base + path, { method: body === undefined ? "GET" : "PATCH", headers: { "Content-Type": "application/json", "X-Business-Id": business,
        ...(employeeCode ? { "X-CRM-Attendance-Session": createAttendanceHubSession(employeeCode)! } : { "X-CRM-Admin-Session": adminSession }), ...extra },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
async function fixture(business = businesses[0]) {
    const person = async (label: string, extra = {}) => {
        const code = `synthetic-${label}-${crypto.randomUUID()}`;
        await setBusinessAccessForEmployeeCode(code, businesses);
        return runWithBusiness(business, () => Employee.create({ employeeCode: code, name: `Synthetic ${label}`, role: "Sales", status: "Active", availabilityStatus: "ONLINE", ...extra }));
    };
    const owner = await person("Owner"), active = await person("Active"), training = await person("Training", { status: "Training" });
    const add = (extra = {}) => runWithBusiness(business, () => Lead.create({ businessName: `Synthetic ${crypto.randomUUID()}`, assignedAgent: owner._id, assignedAgentName: owner.name, phone: "+12025550121", status: "NEW", ...extra }));
    const assign = (leadId: string, recipientId: string, code?: string, expected = 0) => request(business, `/leads/${leadId}/assign`, { assignedAgent: recipientId, expectedAssignmentRevision: expected }, code);
    const read = (id: string) => runWithBusiness(business, () => Lead.findById(id).lean());
    return { business, owner, active, training, person, add, assign, read };
}

test("Active and Training Sales recipients are accepted in every business; Paused, Archived and unrelated Agents are rejected", async () => {
    for (const business of businesses) {
        const f = await fixture(business);
        for (const target of [f.active, f.training]) {
            const lead = await f.add();
            const response = await f.assign(String(lead._id), String(target._id), f.owner.employeeCode);
            assert.equal(response.status, 200, JSON.stringify(await response.clone().json()));
            const saved = await f.read(String(lead._id));
            assert.equal(String(saved!.assignedAgent), String(target._id)); assert.equal(saved!.assignedAgentName, target.name);
        }
        const blocked = [await f.person("Paused", { status: "Paused" }), await f.person("Archived", { status: "Archived" }), await f.person("Support", { role: "Support Agent", team: "Operations" })];
        for (const target of blocked) for (const code of [undefined, f.owner.employeeCode]) {
            const lead = await f.add();
            assert.equal((await f.assign(String(lead._id), String(target._id), code)).status, 400);
            assert.equal(String((await f.read(String(lead._id)))!.assignedAgent), String(f.owner._id));
        }
        const recipients = await (await request(business, "/employees?leadRecipients=true")).json();
        assert.deepEqual(recipients.map((e: { _id: string }) => e._id).sort(), [f.owner, f.active, f.training].map(e => String(e._id)).sort());
        assert.equal(JSON.stringify(recipients).includes("bankAccountNumber"), false);
    }
});

test("business-local IDs and canonical access are enforced, including an explicitly empty access list", async () => {
    const a = await fixture(businesses[0]), b = await fixture(businesses[1]);
    const lead = await a.add();
    assert.equal((await a.assign(String(lead._id), String(b.active._id))).status, 400);
    assert.equal((await b.assign(String(lead._id), String(b.active._id))).status, 404);
    for (const access of [[businesses[1]], []]) {
        await setBusinessAccessForEmployeeCode(a.active.employeeCode, access);
        assert.equal((await a.assign(String(lead._id), String(a.active._id))).status, 400);
        const recipients = await (await request(a.business, "/employees?leadRecipients=true")).json();
        assert.ok(!recipients.some((e: { _id: string }) => e._id === String(a.active._id)));
    }
    await setBusinessAccessForEmployeeCode(a.owner.employeeCode, []);
    assert.equal((await a.assign(String(lead._id), String(a.training._id), a.owner.employeeCode)).status, 403);
});

test("signed owner handoff preserves notes, call history, schedules and status; old/new queues agree after refresh", async () => {
    for (const business of businesses) {
        const f = await fixture(business);
        const lead = await f.add({ status: "Follow up", followUpAt: new Date(+now - 1000), followUpNote: "Synthetic callback", notes: "Synthetic note", callCount: 3,
            comments: [{ body: "Synthetic retained comment", authorName: "Admin", authorType: "admin" }], activity: [{ label: "Synthetic call", detail: "Synthetic retained history", actorName: f.owner.name, actorType: "employee" }] });
        const old = await f.read(String(lead._id));
        assert.equal((await f.assign(String(lead._id), String(f.training._id), f.owner.employeeCode)).status, 200);
        const saved = (await f.read(String(lead._id)))!;
        for (const field of ["notes", "callCount", "followUpNote", "status"] as const) assert.equal(saved[field], old![field]);
        assert.equal(+saved.followUpAt!, +old!.followUpAt!); assert.deepEqual(saved.comments, old!.comments);
        assert.equal(saved.activity.length, old!.activity.length + 1);
        assert.equal(saved.activity[0].actorName, f.owner.name);
        for (let refresh = 0; refresh < 2; refresh++) {
            const adminPage = await (await request(business, "/admin-leads?search=Synthetic")).json();
            const adminLead = adminPage.leads.find((row: { _id: string }) => row._id === String(lead._id));
            assert.equal(adminLead?.assignmentRevision, 1, "admin pagination retains the ownership revision after refresh");
            const recipientPage = await (await request(business, `/my-leads?search=Synthetic&employeeId=${f.training._id}`, undefined, f.training.employeeCode)).json();
            const recipientLead = recipientPage.leads.find((row: { _id: string }) => row._id === String(lead._id));
            assert.equal(recipientLead?.assignmentRevision, 1, "filtered employee pagination retains the ownership revision after refresh");
        }
        for (let refresh = 0; refresh < 2; refresh++) await runWithBusiness(business, async () => {
            assert.equal((await employeeCallingQueue(f.owner, business, now)).nextLeadId, null);
            assert.equal((await employeeCallingQueue(f.training, business, now)).nextLeadId, String(lead._id));
            const page = await (await request(business, `/my-leads?search=Synthetic&employeeId=${f.owner._id}`, undefined, f.owner.employeeCode)).json();
            assert.ok(!page.leads.some((row: { _id: string }) => row._id === String(lead._id)));
        });
    }
});

test("manual admin and bulk assignments work with automatic assignment off, preserve duplicate groups and report actual no-ops", async () => {
    for (const business of businesses) {
        const f = await fixture(business);
        await runWithBusiness(business, () => SystemSettings.create({ autoAssignLeadsEnabled: false }));
        const one = await f.add({ businessName: "Synthetic duplicate", phone: "+12025550121" }), two = await f.add({ businessName: "Synthetic duplicate", phone: "+12025550121" });
        assert.equal((await f.assign(String(one._id), String(f.training._id))).status, 200);
        assert.equal(String((await f.read(String(two._id)))!.assignedAgent), String(f.training._id));
        const body = { leadIds: [String(one._id)], assignedAgent: String(f.active._id), assignedAgentName: "Forged stale name" };
        const result = await request(business, "/leads/bulk/assign", body);
        assert.equal(result.status, 200); assert.deepEqual(await result.json(), { assignedCount: 1, updatedRecordCount: 2, conflictCount: 0 });
        for (const lead of [one, two]) { const saved = (await f.read(String(lead._id)))!; assert.equal(saved.assignedAgentName, f.active.name); assert.equal(saved.activity.length, 2); }
        const replay = await request(business, "/leads/bulk/assign", body);
        assert.equal((await replay.json()).updatedRecordCount, 0);
        assert.equal((await f.read(String(one._id)))!.activity.length, 2);
        const cleared = await request(business, "/leads/bulk/assign", { ...body, assignedAgent: "UNASSIGNED" });
        assert.equal((await cleared.json()).updatedRecordCount, 2);
        assert.equal((await f.read(String(two._id)))!.assignedAgentName, "");
    }
});

test("Reassign New and automatic batches honor Settings and keep recipient names canonical", async () => {
    for (const business of businesses) {
        const f = await fixture(business);
        await f.add({ assignedAgentName: "Synthetic stale name" });
        await runWithBusiness(business, () => SystemSettings.create({ autoAssignLeadsEnabled: false }));
        assert.equal((await request(business, "/leads/reassign-new", {})).status, 400);
        await runWithBusiness(business, () => SystemSettings.updateOne({}, { $set: { autoAssignLeadsEnabled: true } }));
        const response = await request(business, "/leads/reassign-new", {}); assert.equal(response.status, 200);
        const result = await response.json(); assert.equal(result.reassignedCount, 1);
        assert.equal(result.leads[0].assignedAgentName, result.leads[0].assignedAgent.name);
        const unassigned = await f.add({ assignedAgent: null, assignedAgentName: "", phone: "+12025550122" });
        const nameOwned = await f.add({ assignedAgent: null, assignedAgentName: f.owner.name, phone: "+12025550123" });
        await runWithBusiness(business, () => runLeadAutoAssignmentBatch());
        const saved = (await f.read(String(unassigned._id)))!;
        const recipient = await runWithBusiness(business, () => Employee.findById(saved.assignedAgent).lean());
        assert.equal(saved.assignedAgentName, recipient!.name);
        assert.equal((await f.read(String(nameOwned._id)))!.assignedAgent, null, "batch does not steal legacy name-owned leads");
    }
});

test("detail edits preserve an existing Paused owner; an actual PUT transfer uses signed audit identity and clears auto metadata", async () => {
    for (const business of businesses) {
        const f = await fixture(business), lead = await f.add({ autoAssignedAt: now, notes: "Synthetic retained note" });
        await runWithBusiness(business, () => Employee.updateOne({ _id: f.owner._id }, { $set: { status: "Paused" } }));
        const put = (body: unknown) => fetch(`${base}/leads/${lead._id}`, { method: "PUT", headers: { "Content-Type": "application/json", "X-Business-Id": business, "X-CRM-Admin-Session": adminSession }, body: JSON.stringify(body) });
        const detail = { ...lead.toObject(), businessName: `Synthetic edited ${business}`, assignedAgent: String(f.owner._id) };
        const unchanged = await put(detail); assert.equal(unchanged.status, 200);
        const kept = (await f.read(String(lead._id)))!;
        assert.equal(String(kept.assignedAgent), String(f.owner._id)); assert.equal(+kept.autoAssignedAt!, +now);
        const transfer = await put({ ...detail, assignedAgent: String(f.training._id), assignedAgentName: "Forged name", expectedAssignmentRevision: 0,
            activityActorName: "Forged actor", activityActorType: "system" });
        assert.equal(transfer.status, 200);
        const saved = (await f.read(String(lead._id)))!;
        assert.equal(saved.assignedAgentName, f.training.name); assert.equal(saved.autoAssignedAt, null);
        assert.equal(saved.activity[0].actorType, "admin"); assert.notEqual(saved.activity[0].actorName, "Forged actor");
        assert.equal(saved.notes, "Synthetic retained note");
    }
});

test("archive/delete reassignment sets both fields or clears both when Settings is off", async () => {
    for (const business of businesses) for (const enabled of [false, true]) {
        const f = await fixture(business), lead = await f.add();
        await runWithBusiness(business, async () => {
            await SystemSettings.findOneAndUpdate({ key: "system" }, { $set: { autoAssignLeadsEnabled: enabled } }, { upsert: true });
            const result = await reassignLeadsFromAgent(String(f.owner._id));
            assert.equal(enabled ? result.reassignedCount : result.unassignedCount, 1);
        });
        const saved = (await f.read(String(lead._id)))!;
        if (!enabled) { assert.equal(saved.assignedAgent, null); assert.equal(saved.assignedAgentName, ""); }
        else { const person = await runWithBusiness(business, () => Employee.findById(saved.assignedAgent).lean()); assert.equal(saved.assignedAgentName, person!.name); }
    }
});

test("concurrent admin/employee transfers have one winner, reject stale revisions and repeated audit writes", async () => {
    for (const business of businesses) {
        const f = await fixture(business), lead = await f.add();
        const results = await Promise.all([f.assign(String(lead._id), String(f.active._id), f.owner.employeeCode), f.assign(String(lead._id), String(f.training._id))]);
        assert.equal(results.filter(r => r.status === 200).length, 1);
        assert.ok(results.some(r => r.status === 409 || r.status === 403));
        const saved = (await f.read(String(lead._id)))!; assert.equal(saved.activity.length, 1); assert.equal(saved.assignmentRevision, 1);
        assert.equal((await f.assign(String(lead._id), String(f.active._id))).status, 409);
        assert.equal((await f.assign(String(lead._id), String(saved.assignedAgent), undefined, 1)).status, 200);
        assert.equal((await f.read(String(lead._id)))!.activity.length, 1);
        const bulk = await request(business, "/leads/bulk/assign", { leadIds: [String(lead._id)], assignedAgent: String(f.training._id), expectedAssignmentRevisions: { [String(lead._id)]: 0 } });
        assert.equal(bulk.status, 409);
    }
});

test("IDs beat stale names and ambiguous name-only ownership never grants a transfer or calling queue", async () => {
    const f = await fixture(), explicit = await f.add({ assignedAgent: f.active._id, assignedAgentName: f.owner.name });
    assert.equal((await f.assign(String(explicit._id), String(f.training._id), f.owner.employeeCode)).status, 403);
    await f.person("Same name", { name: f.owner.name });
    const legacy = await f.add({ assignedAgent: null, assignedAgentName: f.owner.name, phone: "+12025550122" });
    assert.equal((await f.assign(String(legacy._id), String(f.training._id), f.owner.employeeCode)).status, 403);
    await runWithBusiness(f.business, async () => {
        assert.equal((await employeeCallingQueue(f.owner, f.business, now)).nextLeadId, null);
        const page = await (await request(f.business, `/my-leads?search=Synthetic&employeeId=${f.owner._id}`, undefined, f.owner.employeeCode)).json();
        assert.equal(page.leads.length, 0);
    });
});

test("forged/absent actors, trackers, and employees using admin batch routes remain forbidden even with the legacy flag off", async () => {
    const f = await fixture(), lead = await f.add();
    const oldFlag = process.env.CRM_SECURITY_LEGACY_AUTH;
    process.env.CRM_SECURITY_LEGACY_AUTH = "false";
    try {
        assert.equal((await request(f.business, `/leads/${lead._id}/assign`, { assignedAgent: String(f.active._id) }, undefined, { "X-CRM-Admin-Session": "forged" })).status, 401);
        for (const route of ["/leads/bulk/assign", "/leads/reassign-new", `/leads/${lead._id}/auto-assign`]) {
            const body = { leadIds: [String(lead._id)], assignedAgent: String(f.active._id) };
            assert.equal((await request(f.business, route, body, f.owner.employeeCode)).status, 403);
            assert.equal((await request(f.business, route, body, undefined, { "X-CRM-Admin-Session": "", "X-CRM-Attendance-Session": trackerSession })).status, 403);
        }
    } finally { process.env.CRM_SECURITY_LEGACY_AUTH = oldFlag; }
});

test("reassignment cannot alter an active call or its 30-second cooldown, and the old owner cannot dispatch", async () => {
    for (const business of businesses) {
        const f = await fixture(business), lead = await f.add();
        const schedule = await getCallBridgeScheduleModel().create({ employeeCode: f.owner.employeeCode, reservedBusinessId: business, reservedLeadId: String(lead._id),
            reservedAttemptId: crypto.randomUUID(), lastCallStartedAt: new Date(+now - 1000), lastCallEndedAt: new Date(+now - 60000), nextCallAllowedAt: new Date(+now + 30000) });
        const before = await getCallBridgeScheduleModel().findById(schedule._id).lean();
        assert.equal((await f.assign(String(lead._id), String(f.training._id), f.owner.employeeCode)).status, 200);
        assert.deepEqual(await getCallBridgeScheduleModel().findById(schedule._id).lean(), before);
        await runWithBusiness(business, async () => {
            let dialed = false;
            assert.equal(await withLeadDispatchOwnership(String(lead._id), String(f.owner._id), async () => { dialed = true; return true; }), null);
            assert.equal(dialed, false);
        });
    }
});

test("dispatch committing before a concurrent handoff remains one legitimate active call and preserves its cooldown", async () => {
    for (const business of businesses) {
        const f = await fixture(business), lead = await f.add();
        const end = new Date(+now - 30000), deadline = new Date(+end + 30000);
        await getCallBridgeScheduleModel().create({ employeeCode: f.owner.employeeCode, lastCallEndedAt: end, nextCallAllowedAt: deadline });
        let enter!: () => void, release!: () => void;
        const entered = new Promise<void>(resolve => { enter = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
        const dispatch = runWithBusiness(business, () => withLeadDispatchOwnership(String(lead._id), String(f.owner._id), async session => {
            enter(); await gate;
            await getCallBridgeScheduleModel().updateOne({ employeeCode: f.owner.employeeCode }, { $set: { lastDialStartedAt: now, lastCallStartedAt: now } }, { session });
            return true;
        }));
        await entered;
        const transfer = f.assign(String(lead._id), String(f.training._id));
        release();
        assert.equal(await dispatch, true); assert.equal((await transfer).status, 200);
        const saved = await f.read(String(lead._id)); assert.equal(saved!.callingDispatchRevision, 1); assert.equal(saved!.assignmentRevision, 1);
        const schedule = await getCallBridgeScheduleModel().findOne({ employeeCode: f.owner.employeeCode }).lean();
        assert.equal(+schedule!.lastCallStartedAt!, +now); assert.equal(+schedule!.nextCallAllowedAt!, +deadline); assert.equal(+schedule!.lastCallEndedAt!, +end);
    }
});

test("old owner reservation and dispatch are rejected after a transfer while new queue priority stays due/NEW/follow-up", async context => {
    context.mock.timers.enable({ apis: ["Date"], now });
    try {
        for (const business of businesses) {
            const f = await fixture(business), lead = await f.add();
            const { CALLING_QUEUE_POLICY_VERSION } = await import("../../../shared/leadCallingPolicy");
            await getCallBridgeDeviceModel().create({ employeeCode: f.owner.employeeCode, employeeName: f.owner.name, deviceName: "Synthetic device", deviceId: f.owner.employeeCode, tokenHash: crypto.randomBytes(24).toString("hex"), businessIds: businesses,
                bridgeVersion: "0.4.2", state: "idle", nextivaProcessDetected: true, audioSessionActive: false, lastSeenAt: now, lastStateChangedAt: now, lastIdleAt: now });
            const queue = await runWithBusiness(business, () => employeeCallingQueue(f.owner, business, now));
            const attemptId = crypto.randomUUID();
            const body = { employeeCode: f.owner.employeeCode, leadId: String(lead._id), attemptId, queueVersion: queue.version, normalizedPhone: queue.entries.find(entry => entry.leadId === queue.nextLeadId)!.normalizedPhone };
            const headers = { "Content-Type": "application/json", "X-Business-Id": business, "X-CRM-Attendance-Session": createAttendanceHubSession(f.owner.employeeCode)!, "X-CRM-Auto-Call-Version": CALLING_QUEUE_POLICY_VERSION };
            const post = (path: string, payload: unknown) => fetch(base + path, { method: "POST", headers, body: JSON.stringify(payload) });
            const reserved = await post("/call-bridge/reserve", body); assert.equal(reserved.status, 200);
            assert.equal((await f.assign(String(lead._id), String(f.training._id), f.owner.employeeCode)).status, 200);
            assert.equal((await post("/call-bridge/reserve", body)).status, 409, "even a replayed reservation must revalidate ownership");
            assert.equal((await post("/call-bridge/dial-start", { ...body, reservationToken: attemptId })).status, 409);
            await f.add({ assignedAgent: f.training._id, assignedAgentName: f.training.name, status: "Follow up", followUpAt: new Date(+now - 1000), phone: "+12025550122" });
            const received = await runWithBusiness(business, () => employeeCallingQueue(f.training, business, now));
            assert.equal(received.nextReason, "SCHEDULED_DUE");
        }
    } finally { context.mock.timers.reset(); }
});
