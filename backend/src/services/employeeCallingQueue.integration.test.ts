import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import { after, before, beforeEach, test } from "node:test";
import mongoose from "mongoose";
import { MongoMemoryReplSet } from "mongodb-memory-server";

const root = `calling_queue_${crypto.randomUUID().replaceAll("-", "")}`;
const businesses = Array.from({ length: 6 }, (_, index) => `calling-${index}`);
const now = new Date("2026-10-22T17:00:00Z");
process.env.NODE_ENV = "test";
process.env.CRM_SECURITY_LEGACY_AUTH = "true";
process.env.CRM_CALL_TIMING_V2 = "true";
process.env.CRM_ADMIN_SESSION_SECRET = crypto.randomBytes(48).toString("base64");
process.env.DEFAULT_BUSINESS_ID = businesses[0];
process.env.DEFAULT_BUSINESS_DATABASE = root;
process.env.CONTROL_DATABASE_NAME = `${root}_control`;
process.env.BUSINESS_DATABASES = JSON.stringify(businesses.map((id, index) => ({ id, databaseName: `${root}_${index}` })));
const { createApp } = await import("../app");
const { runWithBusiness } = await import("../config/tenancy");
const { Employee } = await import("../models/Employee");
const { Lead } = await import("../models/Lead");
const { getCallBridgeDeviceModel, getCallBridgeScheduleModel } = await import("../models/CallBridge");
const { setBusinessAccessForEmployeeCode } = await import("../models/BusinessUserAccess");
const { createAttendanceHubSession } = await import("../config/attendanceHubSession");
const { getAttendanceBusinessIdentity } = await import("../models/BusinessUserAccess");
const { AttendanceLedger } = await import("../models/AttendanceLedger");
const { CALLING_QUEUE_POLICY_VERSION } = await import("../../../shared/leadCallingPolicy");
let mongo: MongoMemoryReplSet, server: http.Server, base = "";
before(async () => {
    mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    const uri = mongo.getUri(root);
    assert.equal(new URL(uri).hostname, "127.0.0.1");
    await mongoose.connect(uri);
    await getCallBridgeScheduleModel().createIndexes();
    server = http.createServer(createApp());
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`;
});
after(async () => { server?.closeAllConnections(); server?.close(); await mongoose.disconnect(); await mongo?.stop(); });
beforeEach(async () => {
    for (const business of businesses) await runWithBusiness(business, async () => { await Lead.deleteMany({}); await Employee.deleteMany({}); });
    await getCallBridgeDeviceModel().deleteMany({}); await getCallBridgeScheduleModel().deleteMany({});
});

async function fixture(business = businesses[0], code = `synthetic-${crypto.randomUUID()}`) {
    await setBusinessAccessForEmployeeCode(code, businesses);
    const employee = await runWithBusiness(business, () => Employee.create({ name: code, employeeCode: code, role: "Sales", status: "Active", availabilityStatus: "ONLINE" }));
    const identity = await getAttendanceBusinessIdentity(code);
    assert.ok(identity);
    const at = new Date(+now - 100000).toISOString();
    await AttendanceLedger.updateOne({ _id: `access:${identity.id}` }, { $setOnInsert: { employeeCode: code, canonicalBusinessId: business, businessIds: businesses,
        revision: 1, events: [{ id: crypto.randomUUID(), source: "Time In", at, recordedAt: at, commandId: crypto.randomUUID(), sequence: 1 }] } }, { upsert: true });
    const bridgeToken = crypto.randomBytes(24).toString("hex");
    await getCallBridgeDeviceModel().findOneAndUpdate({ employeeCode: code, deviceId: code }, { $set: { employeeCode: code, employeeName: code,
        deviceName: "Synthetic device", deviceId: code, tokenHash: crypto.createHash("sha256").update(bridgeToken).digest("hex"), businessIds: businesses,
        bridgeVersion: "0.4.2", nextivaProcessDetected: true, audioSessionActive: false, state: "idle", lastSeenAt: now, lastStateChangedAt: now, lastIdleAt: now } }, { upsert: true });
    const request = (path: string, body?: unknown, version = CALLING_QUEUE_POLICY_VERSION, method = body === undefined ? "GET" : "POST") => fetch(`${base}${path}`, {
        method, headers: { "Content-Type": "application/json", "X-Business-Id": business,
            "X-CRM-Attendance-Session": createAttendanceHubSession(code)!, "X-CRM-Auto-Call-Version": version },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const add = (extra: Record<string, unknown> = {}) => runWithBusiness(business, () => Lead.create({ businessName: "Synthetic lead", assignedAgent: employee._id,
        assignedAgentName: code, status: "NEW", phone: "+12025550121", createdAt: new Date(+now - 100000), ...extra }));
    const queue = async () => { const response = await request("/my-leads?callingQueue=true"); assert.equal(response.status, 200); return response.json(); };
    return { business, code, employee, add, request, queue, bridgeToken };
}
type TestQueue = { nextLeadId: string | null; version: string; nextDecision: { normalizedPhone: string | null } | null };
type QueueEntry = { leadId: string; reason: string; callable: boolean };
const reservation = (code: string, queue: TestQueue, id = queue.nextLeadId, attemptId = crypto.randomUUID()) => ({ employeeCode: code, leadId: id,
    attemptId, queueVersion: queue.version, normalizedPhone: queue.nextDecision?.normalizedPhone });

test("without a saved note the same NEW or follow-up lead remains next after a real 30-second cooldown in six businesses", async context => {
    context.mock.timers.enable({ apis: ["Date"], now });
    try {
        let index = 0;
        for (const business of businesses) for (const status of ["NEW", "Follow up"]) {
            context.mock.timers.setTime(+now);
            await runWithBusiness(business, () => Lead.deleteMany({}));
            const f = await fixture(business), phone = `+1202555${String(1000 + index++ * 2).padStart(4, "0")}`;
            const lead = await f.add({ status, phone, createdAt: new Date(+now - 1000) });
            const next = await f.add({ status, phone: `+1202555${String(1001 + (index - 1) * 2).padStart(4, "0")}`, createdAt: new Date(+now - 100000) });
            assert.equal((await f.queue()).callingQueue.nextLeadId, String(lead._id));
            const recorded = await f.request(`/leads/${lead._id}/calls`, { callOutcome: "confirmed" });
            assert.equal(recorded.status, 201);
            const saved = await recorded.json(); assert.equal(saved.comments.length, 0); assert.equal(saved.callCount, 1);
            assert.equal((await f.queue()).callingQueue.nextLeadId, String(lead._id), "call history alone must not exclude an unnoted lead");
            await getCallBridgeScheduleModel().create({ employeeCode: f.code, lastCallEndedAt: now, nextCallAllowedAt: new Date(+now + 30000) });
            context.mock.timers.setTime(+now + 29999);
            await getCallBridgeDeviceModel().updateOne({ employeeCode: f.code }, { $set: { lastSeenAt: new Date() } });
            assert.equal((await f.request("/call-bridge/reserve", reservation(f.code, (await f.queue()).callingQueue))).status, 409, "29.999 seconds cannot reserve early");
            context.mock.timers.setTime(+now + 30000);
            await getCallBridgeDeviceModel().updateOne({ employeeCode: f.code }, { $set: { lastSeenAt: new Date() } });
            const repeatQueue = (await f.queue()).callingQueue;
            assert.equal(repeatQueue.nextLeadId, String(lead._id));
            const repeated = await f.request("/call-bridge/reserve", reservation(f.code, repeatQueue));
            assert.equal(repeated.status, 200); assert.equal((await repeated.json()).leadId, String(lead._id));
            const note = await f.request(`/leads/${lead._id}/comments`, { body: "Synthetic saved employee note" });
            assert.equal(note.status, 200);
            const refreshed = (await f.queue()).callingQueue;
            assert.equal(refreshed.nextLeadId, String(next._id), "a saved note advances the authoritative queue");
            assert.equal(refreshed.entries.find((entry: QueueEntry) => entry.leadId === String(lead._id)).reason, "COMMENT_COOLDOWN");
            assert.equal((await f.request("/call-bridge/reserve", reservation(f.code, repeatQueue))).status, 409, "a stale view cannot repeat a newly noted lead");
        }
    } finally { context.mock.timers.reset(); }
});

test("new leads and newly due callbacks cannot displace the last called unnoted lead in any business", async context => {
    context.mock.timers.enable({ apis: ["Date"], now });
    try {
        for (const business of businesses) {
            context.mock.timers.setTime(+now);
            const f = await fixture(business), lead = await f.add();
            assert.equal((await f.request(`/leads/${lead._id}/calls`, { callOutcome: "confirmed" })).status, 201);
            const fresh = await f.add({ phone: "+12025550122", createdAt: new Date(+now + 1) });
            const callback = await f.add({ phone: "+12025550123", status: "Follow up", followUpAt: new Date(+now + 30000) });
            const refreshed = (await f.queue()).callingQueue;
            assert.equal(refreshed.nextLeadId, String(lead._id), "a new NEW lead must not replace the unnoted call target");
            await getCallBridgeScheduleModel().create({ employeeCode: f.code, lastCallEndedAt: now, nextCallAllowedAt: new Date(+now + 30000) });
            context.mock.timers.setTime(+now + 30000);
            await getCallBridgeDeviceModel().updateOne({ employeeCode: f.code }, { $set: { lastSeenAt: new Date() } });
            const due = (await f.queue()).callingQueue;
            assert.equal(due.nextLeadId, String(lead._id), "a newly due callback must not replace the unnoted call target");
            assert.equal((await f.request("/call-bridge/reserve", reservation(f.code, due, String(fresh._id)))).status, 409);
            assert.equal((await f.request("/call-bridge/reserve", reservation(f.code, due))).status, 200);
            assert.equal((await f.request(`/leads/${lead._id}/comments`, { body: "Synthetic saved employee note" })).status, 200);
            assert.equal((await f.queue()).callingQueue.nextLeadId, String(callback._id), "saving a note restores normal callback priority");
        }
    } finally { context.mock.timers.reset(); }
});

test("repeat selection survives refresh and business switches without changing attendance or saved payroll", async context => {
    context.mock.timers.enable({ apis: ["Date"], now });
    try {
        const code = `synthetic-${crypto.randomUUID()}`, views = [];
        for (const business of businesses) {
            const f = await fixture(business, code), lead = await f.add();
            assert.equal((await f.request(`/leads/${lead._id}/calls`, { callOutcome: "confirmed" })).status, 201);
            await f.add({ phone: "+12025550122", createdAt: new Date(+now + 1) });
            const db = mongoose.connection.getClient().db(process.env.DEFAULT_BUSINESS_DATABASE + "_" + businesses.indexOf(business));
            await db.collection("payrollrecords").insertOne({ status: "Paid", netPay: 99, paidOn: now });
            views.push({ f, lead, db });
        }
        const attendance = JSON.stringify(await AttendanceLedger.find({ employeeCode: code }).lean());
        for (const { f, lead, db } of [...views].reverse()) {
            const leads = JSON.stringify(await runWithBusiness(f.business, () => Lead.find().sort({ _id: 1 }).lean()));
            const payroll = JSON.stringify(await db.collection("payrollrecords").find().toArray());
            for (let read = 0; read < 2; read++) assert.equal((await f.queue()).callingQueue.nextLeadId, String(lead._id));
            assert.equal(JSON.stringify(await runWithBusiness(f.business, () => Lead.find().sort({ _id: 1 }).lean())), leads);
            assert.equal(JSON.stringify(await db.collection("payrollrecords").find().toArray()), payroll);
        }
        assert.equal(JSON.stringify(await AttendanceLedger.find({ employeeCode: code }).lean()), attendance);
        assert.equal(await getCallBridgeScheduleModel().countDocuments({ employeeCode: code }), 0, "queue reads must not create retention records or call leases");
    } finally { context.mock.timers.reset(); }
});

test("releasing an ineligible latest call never resurrects an older unnoted call", async context => {
    context.mock.timers.enable({ apis: ["Date"], now });
    try {
        for (const scenario of ["noted", "closed", "archived", "reassigned", "future", "invalid-phone", "duplicate-comment"] as const) {
            context.mock.timers.setTime(+now);
            await runWithBusiness(businesses[0], () => Lead.deleteMany({}));
            const f = await fixture(), old = await f.add({ createdAt: new Date(+now - 100000) });
            assert.equal((await f.request(`/leads/${old._id}/calls`, { callOutcome: "confirmed" })).status, 201);
            context.mock.timers.setTime(+now + 1);
            const latest = await f.add({ phone: "+12025550122" });
            assert.equal((await f.request(`/leads/${latest._id}/calls`, { callOutcome: "confirmed" })).status, 201);
            const fresh = await f.add({ phone: "+12025550123", createdAt: new Date(+now + 2) });
            assert.equal((await f.queue()).callingQueue.nextLeadId, String(latest._id), scenario);
            await runWithBusiness(f.business, async () => {
                if (scenario === "noted") await Lead.updateOne({ _id: latest._id }, { $push: { comments: { authorType: "employee", authorName: f.code, body: "Synthetic note", createdAt: new Date() } } });
                if (scenario === "closed") await Lead.updateOne({ _id: latest._id }, { $set: { status: "Dead" } });
                if (scenario === "archived") await Lead.updateOne({ _id: latest._id }, { $set: { status: "Archived" } });
                if (scenario === "reassigned") await Lead.updateOne({ _id: latest._id }, { $set: { assignedAgent: new mongoose.Types.ObjectId() } });
                if (scenario === "future") await Lead.updateOne({ _id: latest._id }, { $set: { followUpAt: new Date(+now + 60000) } });
                if (scenario === "invalid-phone") await Lead.updateOne({ _id: latest._id }, { $set: { phone: "invalid" } });
                if (scenario === "duplicate-comment") await Lead.create({ businessName: "Synthetic duplicate", phone: latest.phone, status: "Qualified", comments: [{ authorType: "employee", authorName: f.code, body: "Synthetic note", createdAt: new Date() }] });
            });
            const released = (await f.queue()).callingQueue;
            assert.equal(released.nextLeadId, String(fresh._id), scenario);
            assert.equal((await f.request("/call-bridge/reserve", reservation(f.code, released, String(latest._id)))).status, 409, scenario);
        }
    } finally { context.mock.timers.reset(); }
});

test("an unnoted repeat target waits for another employee's phone lease rather than skipping to a new lead", async context => {
    context.mock.timers.enable({ apis: ["Date"], now });
    const previous = process.env.CRM_LEAD_PHONE_DEDUP_V2;
    process.env.CRM_LEAD_PHONE_DEDUP_V2 = "true";
    try {
        const f = await fixture(), lead = await f.add();
        assert.equal((await f.request(`/leads/${lead._id}/calls`, { callOutcome: "confirmed" })).status, 201);
        const fresh = await f.add({ phone: "+12025550122", createdAt: new Date(+now + 1) });
        const other = await fixture();
        await getCallBridgeScheduleModel().create({ employeeCode: other.code, reservedBusinessId: f.business, reservedPhone: lead.phone, callLeaseUntil: new Date(+now + 10000) });
        const blocked = (await f.queue()).callingQueue;
        assert.equal(blocked.nextLeadId, null);
        assert.equal(blocked.repeatLeadId, String(lead._id));
        assert.equal(blocked.waitReason, "WAITING_FOR_REPEAT_LEAD");
        assert.equal((await f.request("/call-bridge/reserve", reservation(f.code, blocked, String(fresh._id)))).status, 409);
        await getCallBridgeScheduleModel().updateOne({ employeeCode: other.code }, { $set: { callLeaseUntil: null, reservedPhone: "" } });
        assert.equal((await f.queue()).callingQueue.nextLeadId, String(lead._id));
    } finally {
        if (previous === undefined) delete process.env.CRM_LEAD_PHONE_DEDUP_V2; else process.env.CRM_LEAD_PHONE_DEDUP_V2 = previous;
        context.mock.timers.reset();
    }
});

test("only a confirmed employee call without a newer employee note is retained", async context => {
    context.mock.timers.enable({ apis: ["Date"], now });
    try {
        const f = await fixture(), lead = await f.add({ comments: [{ authorType: "employee", authorName: f.code, body: "Synthetic old note", createdAt: new Date(+now - 2 * 86400000) }] });
        const fresh = await f.add({ phone: "+12025550122", createdAt: new Date(+now - 1) });
        assert.equal((await f.request(`/leads/${lead._id}/calls`, { callOutcome: "failed" })).status, 201);
        assert.equal((await f.queue()).callingQueue.nextLeadId, String(fresh._id), "failed launches must not retain a target");
        assert.equal((await f.request(`/leads/${lead._id}/calls`, { callOutcome: "confirmed" })).status, 201);
        await runWithBusiness(f.business, () => Lead.updateOne({ _id: lead._id }, { $push: { comments: { authorType: "admin", authorName: "Synthetic admin", body: "Synthetic admin note", createdAt: new Date() } } }));
        assert.equal((await f.queue()).callingQueue.nextLeadId, String(lead._id), "old notes and admin notes do not complete the current employee call");
        assert.equal((await f.request(`/leads/${lead._id}/comments`, { body: "Synthetic current saved employee note" })).status, 200);
        context.mock.timers.setTime(+now + 2 * 86400000);
        assert.equal((await f.queue()).callingQueue.nextLeadId, String(fresh._id), "expiry of comment cooldown must not restore the previous repeat target");
    } finally { context.mock.timers.reset(); }
});

test("refresh dependencies retain hidden duplicate candidates and reveal only this employee's owned queue inputs in six businesses", async () => {
    const previous = process.env.CRM_LEAD_PHONE_DEDUP_V2;
    process.env.CRM_LEAD_PHONE_DEDUP_V2 = "true";
    try {
        for (const business of businesses) {
            const f = await fixture(business), own = await f.add({ phone: "+12025550121" });
            const other = await fixture(business), unrelated = await other.add({ phone: "+12025550123" });
            // Historical duplicates must be seeded directly in this isolated
            // replica; the current application correctly refuses to create one.
            await runWithBusiness(business, () => Lead.collection.insertOne({ businessName: "Synthetic legacy duplicate", phone: own.phone,
                assignedAgent: other.employee._id, assignedAgentName: other.code, status: "NEW", comments: [], activity: [],
                notes: "Synthetic existing work makes this the canonical copy", callCount: 2, createdAt: new Date(+now - 200000) }));
            const before = JSON.stringify(await runWithBusiness(business, () => Lead.find({}).sort({ _id: 1 }).lean()));
            const result = (await f.queue()).callingQueue;
            assert.equal(result.refreshDependencies.version, 1);
            assert.ok(result.refreshDependencies.leadIds.includes(String(own._id)));
            assert.ok(result.refreshDependencies.phones.includes(own.phone));
            assert.equal(result.entries.some((row: QueueEntry) => row.leadId === String(own._id)), false);
            assert.equal(result.refreshDependencies.leadIds.includes(String(unrelated._id)), false);
            assert.equal(result.refreshDependencies.phones.includes(unrelated.phone), false);
            assert.equal(JSON.stringify(await runWithBusiness(business, () => Lead.find({}).sort({ _id: 1 }).lean())), before);
        }
    } finally {
        if (previous === undefined) delete process.env.CRM_LEAD_PHONE_DEDUP_V2; else process.env.CRM_LEAD_PHONE_DEDUP_V2 = previous;
    }
});

test("six scoped queues omit unchanged dependency lists but keep fresh decisions, and new inputs always restore full metadata", async context => {
    context.mock.timers.enable({ apis: ["Date"], now });
    try {
        for (const business of businesses) {
            const f = await fixture(business); await f.add();
            const full = (await f.queue()).callingQueue;
            assert.match(full.refreshDependenciesFingerprint || "", /^[a-f0-9]{64}$/);
            const reduced = (await (await f.request("/my-leads?callingQueue=true&knownRefreshDependencies=" + full.refreshDependenciesFingerprint)).json()).callingQueue;
            assert.equal(reduced.refreshDependencies, undefined); assert.equal(reduced.refreshDependenciesUnchanged, true);
            const { refreshDependenciesUnchanged: unchanged, ...rest } = reduced; assert.equal(unchanged, true);
            assert.deepEqual({ ...rest, refreshDependencies: full.refreshDependencies }, full);
            const before = JSON.stringify(await runWithBusiness(business, () => Lead.find({}).sort({ _id: 1 }).lean()));
            assert.equal((await (await f.request("/my-leads?callingQueue=true&knownRefreshDependencies=" + "0".repeat(64))).json()).callingQueue.refreshDependencies.version, 1);
            assert.equal(JSON.stringify(await runWithBusiness(business, () => Lead.find({}).sort({ _id: 1 }).lean())), before);
            await f.add({ phone: "+12025550128" });
            const changed = (await (await f.request("/my-leads?callingQueue=true&knownRefreshDependencies=" + full.refreshDependenciesFingerprint)).json()).callingQueue;
            assert.notEqual(changed.refreshDependenciesFingerprint, full.refreshDependenciesFingerprint);
            assert.equal(changed.refreshDependenciesUnchanged, undefined); assert.equal(changed.refreshDependencies.leadIds.length, 2);
        }
    } finally { context.mock.timers.reset(); }
});

test("release conflicts distinguish protected calls from obsolete ownership and never clear either reservation", async context => {
    context.mock.timers.enable({ apis: ["Date"], now });
    try {
        const f = await fixture(); await f.add();
        const q = (await f.queue()).callingQueue, body = reservation(f.code, q);
        const accepted = await f.request("/call-bridge/reserve", body); assert.equal(accepted.status, 200);
        const token = (await accepted.json()).reservationToken;
        const before = JSON.stringify(await getCallBridgeScheduleModel().findOne({ employeeCode: f.code }).lean());
        const wrong = await f.request("/call-bridge/release", { employeeCode: f.code, leadId: q.nextLeadId, reservationToken: crypto.randomUUID() });
        assert.equal(wrong.status, 409); assert.equal((await wrong.json()).code, "CALL_RESERVATION_MISMATCH");
        assert.equal(JSON.stringify(await getCallBridgeScheduleModel().findOne({ employeeCode: f.code }).lean()), before);
        await getCallBridgeDeviceModel().updateOne({ employeeCode: f.code }, { $set: { state: "active", audioSessionActive: true } });
        const blocked = await f.request("/call-bridge/release", { employeeCode: f.code, leadId: q.nextLeadId, reservationToken: token });
        assert.equal(blocked.status, 409); assert.equal((await blocked.json()).code, "CALL_ACTIVE_RELEASE_BLOCKED");
        assert.equal(JSON.stringify(await getCallBridgeScheduleModel().findOne({ employeeCode: f.code }).lean()), before);
    } finally { context.mock.timers.reset(); }
});

test("six businesses share one deterministic due/NEW/follow-up queue and preserve visible waiting rows", async context => {
    context.mock.timers.enable({ apis: ["Date"], now });
    try {
        for (const business of businesses) {
            const f = await fixture(business);
            const fresh = await f.add({ phone: "+12025550122" });
            const later = await f.add({ phone: "+12025550123", status: "Follow up", followUpAt: new Date(+now - 1) });
            const due = await f.add({ phone: "+12025550124", status: "Follow up", followUpAt: new Date(+now - 60000) });
            const future = await f.add({ phone: "+12025550125", followUpAt: new Date(+now + 1) });
            const follow = await f.add({ phone: "+12025550126", status: "Follow up" });
            const page = await f.queue();
            const q = page.callingQueue;
            assert.deepEqual(page.leads.map((lead: { _id: string }) => lead._id), [due, later, fresh, follow, future].map(lead => String(lead._id)));
            assert.equal(q.nextLeadId, page.leads[0]._id);
            assert.equal(q.nextReason, "SCHEDULED_DUE");
            assert.equal(q.entries.find((entry: QueueEntry) => entry.leadId === String(future._id)).reason, "NOT_DUE");
            assert.equal(q.nextEligibilityChangeAt, new Date(+now + 1).toISOString());
            const accepted = await f.request("/call-bridge/reserve", reservation(f.code, q));
            assert.equal(accepted.status, 200);
            assert.equal((await accepted.json()).leadId, q.nextLeadId);
        }
    } finally { context.mock.timers.reset(); }
});

test("cached queue display facts invalidate on saved comments and can never authorize a stale dial in any business", async context => {
    context.mock.timers.enable({ apis: ["Date"], now });
    try {
        for (const business of businesses) {
            const f = await fixture(business), lead = await f.add();
            const first = (await f.queue()).callingQueue;
            assert.equal(first.nextLeadId, String(lead._id));
            const comment = { authorName: f.code, authorType: "employee", body: "Synthetic cooldown evidence", createdAt: now };
            await runWithBusiness(business, () => Lead.updateOne({ _id: lead._id }, { $push: { comments: comment } }));
            assert.equal((await f.queue()).callingQueue.nextLeadId, null, "saved API/model writes invalidate display facts immediately");
            await runWithBusiness(business, () => Lead.updateOne({ _id: lead._id }, { $set: { comments: [] } }));
            const available = (await f.queue()).callingQueue;
            assert.equal(available.nextLeadId, String(lead._id));
            await runWithBusiness(business, () => Lead.collection.updateOne({ _id: lead._id }, { $set: { comments: [comment] } }));
            const denied = await f.request("/call-bridge/reserve", reservation(f.code, available));
            assert.equal(denied.status, 409, "dispatch rechecks database facts even before a display-cache TTL expires");
            assert.equal((await denied.json()).code, "CALL_QUEUE_CHANGED");
            assert.equal(await getCallBridgeScheduleModel().countDocuments({ employeeCode: f.code }), 0);
        }
    } finally { context.mock.timers.reset(); }
});

test("stale versions, lower-priority choices, wrong phones and old clients cannot reserve", async context => {
    context.mock.timers.enable({ apis: ["Date"], now });
    try {
        const f = await fixture();
        const fresh = await f.add();
        await f.add({ status: "Follow up", followUpAt: new Date(+now - 1), phone: "+12025550122" });
        const q = (await f.queue()).callingQueue;
        for (const body of [reservation(f.code, q, String(fresh._id)), { ...reservation(f.code, q), queueVersion: "stale" }, { ...reservation(f.code, q), normalizedPhone: "+12025550129" }]) {
            const response = await f.request("/call-bridge/reserve", body);
            assert.equal(response.status, 409); assert.equal((await response.json()).code, "CALL_QUEUE_CHANGED");
        }
        assert.equal((await f.request("/call-bridge/reserve", reservation(f.code, q), "2026-10-15-call-timing-v6")).status, 409);
        assert.equal(await getCallBridgeScheduleModel().countDocuments({ employeeCode: f.code }), 0);
    } finally { context.mock.timers.reset(); }
});

test("due leads outside a loaded page rise to the head; a temporary future restriction expires at its UTC instant", async context => {
    context.mock.timers.enable({ apis: ["Date"], now });
    try {
        const f = await fixture();
        for (let index = 0; index < 55; index++) await f.add({ phone: `+12025550${String(100 + index).padStart(3, "0")}` });
        const scheduled = await f.add({ phone: "+12025550199", status: "Follow up", createdAt: new Date(+now - 86400000), followUpAt: new Date(+now + 1) });
        assert.notEqual((await f.queue()).callingQueue.nextLeadId, String(scheduled._id));
        context.mock.timers.setTime(+now + 1);
        const after = await f.queue();
        assert.equal(after.leads[0]._id, String(scheduled._id));
        assert.equal(after.callingQueue.nextLeadId, String(scheduled._id));
    } finally { context.mock.timers.reset(); }
});

test("status, notes and tomorrow schedules affect one lead and preserve draft-safe HTTP errors", async context => {
    context.mock.timers.enable({ apis: ["Date"], now });
    try {
        const f = await fixture();
        const first = await f.add({ createdAt: new Date(+now - 1) });
        const second = await f.add({ phone: "+12025550122" });
        const status = await f.request(`/leads/${first._id}/status`, { status: "Follow up" }, undefined, "PATCH");
        assert.equal(status.status, 200);
        assert.equal((await f.queue()).callingQueue.nextLeadId, String(second._id), "changing one status cannot pause other NEW leads");
        const save = await f.request(`/leads/${first._id}/comments`, { body: "Synthetic saved note" });
        assert.equal(save.status, 200);
        assert.equal((await f.queue()).callingQueue.nextLeadId, String(second._id));
        const failed = await f.request(`/leads/${second._id}/follow-up`, { followUpAt: "invalid" }, undefined, "PATCH");
        assert.equal(failed.status, 400);
        assert.equal((await f.queue()).callingQueue.nextLeadId, String(second._id));
        const scheduled = await f.request(`/leads/${first._id}/follow-up`, { followUpAt: new Date(+now + 86400000).toISOString() }, undefined, "PATCH");
        assert.equal(scheduled.status, 200);
        assert.equal((await f.queue()).callingQueue.nextLeadId, String(second._id));
    } finally { context.mock.timers.reset(); }
});

test("Dead disappears before pagination and cannot be reserved after saving or refreshing in any business", async context => {
    context.mock.timers.enable({apis:["Date"],now});
    try {
        for(const business of businesses) {
            const f=await fixture(business);
            const first=await f.add({createdAt:new Date(+now-1)});
            const second=await f.add({phone:"+12025550122"});
            const before=(await f.queue()).callingQueue;
            assert.equal(before.nextLeadId,String(first._id));
            const saved=await f.request(`/leads/${first._id}/status`,{status:"Dead"},undefined,"PATCH");
            assert.equal(saved.status,200); assert.equal((await saved.json()).status,"Dead");
            const fresh=await f.queue();
            assert.equal(fresh.callingQueue.nextLeadId,String(second._id));
            assert.ok(fresh.leads.every((lead:{_id:string})=>lead._id!==String(first._id)));
            assert.ok(fresh.callingQueue.entries.every((entry:QueueEntry)=>entry.leadId!==String(first._id)));
            assert.equal((await (await f.request(`/leads/${first._id}`)).json()).status,"Dead","fresh detail preserves the saved status");
            assert.equal((await f.request("/call-bridge/reserve",reservation(f.code,before))).status,409,"a stale browser cannot call the removed lead");
            const dead=await f.request("/my-leads/dead"); assert.equal(dead.status,200);
            assert.ok((await dead.json()).leads.some((lead:{_id:string})=>lead._id===String(first._id)),"history remains available in the Dead tab");
        }
    } finally {context.mock.timers.reset();}
});

test("full comment facts, duplicate phones and invalid schedules agree between listing and reservation", async context => {
    context.mock.timers.enable({ apis: ["Date"], now });
    try {
        const f = await fixture();
        const invalid = await f.add();
        await runWithBusiness(f.business, () => Lead.collection.updateOne({ _id: invalid._id }, { $set: { followUpAt: "invalid" } }));
        const hiddenComment = await f.add({ phone: "+12025550122", comments: [
            { authorType: "employee", authorName: "Synthetic", body: "Invalid old evidence", createdAt: null },
            ...Array.from({ length: 12 }, () => ({ authorType: "admin", authorName: "Synthetic", body: "Synthetic history", createdAt: now })),
        ] });
        const duplicate = await f.add({ phone: "+12025550123" });
        await runWithBusiness(f.business, () => Lead.create({ businessName: "Synthetic duplicate evidence", phone: "+1 (202) 555-0123", status: "Qualified",
            comments: [{ authorType: "employee", authorName: "Synthetic", body: "Synthetic cooldown", createdAt: now }] }));
        const good = await f.add({ phone: "+12025550124" });
        const page = await f.queue(), entries = page.callingQueue.entries;
        assert.equal(page.callingQueue.nextLeadId, String(good._id));
        for (const lead of [invalid, hiddenComment, duplicate]) assert.equal(entries.find((entry: QueueEntry) => entry.leadId === String(lead._id)).callable, false);
        assert.equal((await f.request("/call-bridge/reserve", reservation(f.code, page.callingQueue, String(duplicate._id)))).status, 409);
    } finally { context.mock.timers.reset(); }
});

test("a lost reserve response is replayable; competing attempts and duplicated dispatches consume only one lease", async context => {
    context.mock.timers.enable({ apis: ["Date"], now });
    try {
        const f = await fixture(); await f.add();
        const q = (await f.queue()).callingQueue, body = reservation(f.code, q);
        const first = await f.request("/call-bridge/reserve", body); assert.equal(first.status, 200);
        const token = (await first.json()).reservationToken;
        const replay = await f.request("/call-bridge/reserve", body); assert.equal(replay.status, 200);
        assert.equal((await replay.json()).reservationToken, token);
        assert.equal((await f.request("/call-bridge/reserve", reservation(f.code, q))).status, 409);
        const dispatch = { employeeCode: f.code, leadId: q.nextLeadId, reservationToken: token };
        const results = await Promise.all([f.request("/call-bridge/dial-start", dispatch), f.request("/call-bridge/dial-start", dispatch)]);
        const outputs = await Promise.all(results.map(response => { assert.equal(response.status, 200); return response.json(); }));
        assert.equal(outputs.filter(output => output.alreadyStarted === false).length, 1);
        assert.equal(outputs.filter(output => output.alreadyStarted === true).length, 1);
        const observed = await fetch(`${base}/call-bridge/heartbeat`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${f.bridgeToken}` },
            body: JSON.stringify({ state: "active", audioSessionActive: true, nextivaProcessDetected: true, bridgeVersion: "0.4.2" }) });
        assert.equal(observed.status, 200);
        const state = await f.request(`/call-bridge/status?employeeCode=${f.code}`);
        const observedState = await state.json();
        assert.equal(observedState.observedAttemptId, body.attemptId);
        assert.equal(observedState.observedLeadId, q.nextLeadId);
    } finally { context.mock.timers.reset(); }
});

test("selection changes before dispatch are rejected; availability and server calling hours stay enforced", async context => {
    context.mock.timers.enable({ apis: ["Date"], now });
    try {
        const f = await fixture(); await f.add();
        const q = (await f.queue()).callingQueue;
        const accepted = await f.request("/call-bridge/reserve", reservation(f.code, q));
        const token = (await accepted.json()).reservationToken;
        await f.add({ phone: "+12025550122", status: "Follow up", followUpAt: new Date(+now - 1000) });
        const stale = await f.request("/call-bridge/dial-start", { employeeCode: f.code, leadId: q.nextLeadId, reservationToken: token });
        assert.equal(stale.status, 409); assert.equal((await stale.json()).code, "CALL_QUEUE_CHANGED");
        await runWithBusiness(f.business, () => Employee.updateOne({ _id: f.employee._id }, { $set: { availabilityStatus: "OFFLINE" } }));
        assert.equal((await f.request("/call-bridge/reserve", reservation(f.code, (await f.queue()).callingQueue))).status, 409);
        await runWithBusiness(f.business, () => Employee.updateOne({ _id: f.employee._id }, { $set: { availabilityStatus: "ONLINE" } }));
        context.mock.timers.setTime(+new Date("2026-10-23T00:00:00Z"));
        const outside = await f.request("/call-bridge/reserve", reservation(f.code, (await f.queue()).callingQueue));
        assert.equal((await outside.json()).code, "OUTSIDE_CALLING_HOURS");
    } finally { context.mock.timers.reset(); }
});

test("queue identity is verified and browse-all roles cannot dial someone else's assignments or business", async context => {
    context.mock.timers.enable({ apis: ["Date"], now });
    try {
        const f = await fixture(); const own = await f.add();
        const other = await fixture(); const otherLead = await other.add({ phone: "+12025550122" });
        await runWithBusiness(f.business, () => Employee.updateOne({ _id: f.employee._id }, { $set: { role: "Outside Sales" } }));
        const staleName = await f.add({ assignedAgent: other.employee._id, assignedAgentName: f.code, phone: "+12025550123" });
        const response = await f.request(`/my-leads?callingQueue=true&employeeId=${other.employee._id}&employeeNames=${other.code}`);
        const queue = (await response.json()).callingQueue;
        assert.equal(queue.nextLeadId, String(own._id));
        assert.ok(queue.entries.every((entry: QueueEntry) => entry.leadId !== String(otherLead._id)));
        assert.ok(queue.entries.every((entry: QueueEntry) => entry.leadId !== String(staleName._id)), "an explicit other assignee overrides a stale display name");
        assert.equal((await f.request("/call-bridge/reserve", reservation(f.code, queue, String(otherLead._id)))).status, 409);
        const denied = await fetch(`${base}/my-leads?callingQueue=true`, { headers: { "X-Business-Id": businesses[1], "X-CRM-Attendance-Session": createAttendanceHubSession(f.code)! } });
        assert.equal(denied.status, 403);
    } finally { context.mock.timers.reset(); }
});

test("a newly due callback cannot interrupt an active call", async context => {
    context.mock.timers.enable({ apis: ["Date"], now });
    try {
        const f = await fixture(); await f.add({ status: "Follow up", followUpAt: new Date(+now - 1) });
        const startedAt = new Date(+now - 10000);
        await getCallBridgeDeviceModel().updateOne({ employeeCode: f.code }, { $set: { state: "active", audioSessionActive: true } });
        await getCallBridgeScheduleModel().create({ employeeCode: f.code, lastCallStartedAt: startedAt });
        const q = (await f.queue()).callingQueue;
        assert.equal(q.nextReason, "SCHEDULED_DUE");
        assert.equal((await f.request("/call-bridge/reserve", reservation(f.code, q))).status, 409);
        const schedule = await getCallBridgeScheduleModel().findOne({ employeeCode: f.code }).lean();
        assert.equal(schedule?.lastCallStartedAt?.toISOString(), startedAt.toISOString());
        assert.equal(schedule?.reservedAttemptId, "");
    } finally { context.mock.timers.reset(); }
});

test("competing HTTP reservations across businesses have only one employee lease winner", async context => {
    context.mock.timers.enable({ apis: ["Date"], now });
    try {
        const a = await fixture(businesses[0]); await a.add();
        const b = await fixture(businesses[1], a.code); await b.add();
        const qa = (await a.queue()).callingQueue, qb = (await b.queue()).callingQueue;
        const results = await Promise.all([a.request("/call-bridge/reserve", reservation(a.code, qa)), b.request("/call-bridge/reserve", reservation(b.code, qb))]);
        assert.equal(results.filter(response => response.status === 200).length, 1);
        assert.equal(results.filter(response => response.status === 409).length, 1);
        assert.equal(await getCallBridgeScheduleModel().countDocuments({ employeeCode: a.code }), 1);
    } finally { context.mock.timers.reset(); }
});

test("readiness cannot advertise an unresolved call as ready and release cannot shorten a later deadline", async context => {
    context.mock.timers.enable({ apis: ["Date"], now });
    try {
        const f = await fixture(); await f.add();
        await getCallBridgeScheduleModel().create({ employeeCode: f.code, lastCallStartedAt: new Date(+now - 1000) });
        const pending = await (await f.request(`/call-bridge/status?employeeCode=${f.code}`)).json();
        assert.equal(pending.ready, false);
        assert.equal(pending.waitCode, "CALL_END_UNCONFIRMED");
        await getCallBridgeScheduleModel().updateOne({ employeeCode: f.code }, { $set: { lastCallStartedAt: null } });
        const q = (await f.queue()).callingQueue;
        const token = (await (await f.request("/call-bridge/reserve", reservation(f.code, q))).json()).reservationToken;
        const body = { employeeCode: f.code, leadId: q.nextLeadId, reservationToken: token };
        assert.equal((await f.request("/call-bridge/dial-start", body)).status, 200);
        const later = new Date(+now + 90000);
        await getCallBridgeScheduleModel().updateOne({ employeeCode: f.code }, { $set: { nextCallAllowedAt: later } });
        context.mock.timers.setTime(+now + 31000);
        const released = await f.request("/call-bridge/release", body);
        assert.equal(released.status, 200);
        assert.equal((await released.json()).nextCallAllowedAt, later.toISOString());
    } finally { context.mock.timers.reset(); }
});

test("the automatic caller is explicitly restricted to the approved timing configuration", async context => {
    context.mock.timers.enable({ apis: ["Date"], now });
    try {
        const f = await fixture(); await f.add();
        const q = (await f.queue()).callingQueue;
        process.env.CRM_CALL_TIMING_V2 = "false";
        const response = await f.request("/call-bridge/reserve", reservation(f.code, q));
        assert.equal(response.status, 409);
        assert.equal((await response.json()).code, "CALL_TIMING_CONFIGURATION_REQUIRED");
        assert.equal(await getCallBridgeScheduleModel().countDocuments({ employeeCode: f.code }), 0);
    } finally { process.env.CRM_CALL_TIMING_V2 = "true"; context.mock.timers.reset(); }
});

test("six-business HTTP timing: confirmed end, saves, refresh, due priority and exactly one dispatch at 15000ms", async context => {
    context.mock.timers.enable({ apis: ["Date"], now });
    try {
        for (const business of businesses) {
            context.mock.timers.setTime(+now);
            const f = await fixture(business);
            const first = await f.add({ createdAt: new Date(+now - 1) });
            await f.add({ phone: "+12025550122", createdAt: new Date(+now - 2) });
            const due = await f.add({ phone: "+12025550123", status: "Follow up", followUpAt: new Date(+now + 125000) });
            const heartbeat = async (elapsed: number, active: boolean) => {
                context.mock.timers.setTime(+now + elapsed);
                const response = await fetch(`${base}/call-bridge/heartbeat`, { method: "POST",
                    headers: { "Content-Type": "application/json", Authorization: `Bearer ${f.bridgeToken}` },
                    body: JSON.stringify({ state: active ? "active" : "idle", audioSessionActive: active, nextivaProcessDetected: true, bridgeVersion: "0.4.2" }) });
                assert.equal(response.status, 200);
            };
            const initial = (await f.queue()).callingQueue;
            assert.equal(initial.nextLeadId, String(first._id));
            const token = (await (await f.request("/call-bridge/reserve", reservation(f.code, initial))).json()).reservationToken;
            assert.equal((await f.request("/call-bridge/dial-start", { employeeCode: f.code, leadId: initial.nextLeadId, reservationToken: token })).status, 200);
            await heartbeat(0, true);
            await heartbeat(90000, true);
            assert.equal((await f.request("/call-bridge/reserve", reservation(f.code, (await f.queue()).callingQueue))).status, 409, "a call longer than 30 seconds stays protected");
            await heartbeat(120000, false);
            await heartbeat(127999, false);
            assert.equal((await getCallBridgeScheduleModel().findOne({ employeeCode: f.code }))?.lastCallEndedAt, null);
            await heartbeat(128000, false);
            const endedAt = new Date(+now + 120000), deadline = new Date(+now + 135000);
            const status = async () => (await (await f.request(`/call-bridge/status?employeeCode=${f.code}`)).json());
            for (const elapsed of [130000, 131000, 132000]) {
                context.mock.timers.setTime(+now + elapsed);
                if (elapsed === 130000) assert.equal((await f.request(`/leads/${first._id}/comments`, { body: "Synthetic post-call note" })).status, 200);
                if (elapsed === 131000) assert.equal((await f.request(`/leads/${first._id}/status`, { status: "Follow up" }, undefined, "PATCH")).status, 200);
                if (elapsed === 132000) assert.equal((await f.request(`/leads/${first._id}/follow-up`, { followUpAt: new Date(+now + 86400000).toISOString() }, undefined, "PATCH")).status, 200);
                const refreshed = await status();
                assert.equal(refreshed.lastCallEndedAt, endedAt.toISOString());
                assert.equal(refreshed.nextCallAllowedAt, deadline.toISOString(), "read/refresh/note/status/schedule cannot restart the cooldown");
            }
            await heartbeat(134999, false);
            const queue = (await f.queue()).callingQueue;
            assert.equal(queue.nextLeadId, String(due._id));
            const early = await f.request("/call-bridge/reserve", reservation(f.code, queue));
            assert.equal(early.status, 409);
            assert.equal((await early.json()).nextCallAllowedAt, deadline.toISOString());
            await heartbeat(135000, false);
            const attempts = await Promise.all([f.request("/call-bridge/reserve", reservation(f.code, queue)), f.request("/call-bridge/reserve", reservation(f.code, queue))]);
            assert.equal(attempts.filter(response => response.status === 200).length, 1);
            const accepted = await attempts.find(response => response.status === 200)!.json();
            const dispatch = await f.request("/call-bridge/dial-start", { employeeCode: f.code, leadId: queue.nextLeadId, reservationToken: accepted.reservationToken });
            assert.equal(dispatch.status, 200);
            const dial = await dispatch.json();
            assert.equal(dial.startedAt, deadline.toISOString());
            context.diagnostic(JSON.stringify({ layer: "HTTP/Mongo/fake-server-clock", business, endedAt: endedAt.toISOString(),
                confirmationAt: new Date(+now + 128000).toISOString(), nextCallAllowedAt: deadline.toISOString(),
                rejectedAt: new Date(+now + 134999).toISOString(), attemptedDialAt: dial.startedAt, eligibleHead: "SCHEDULED_DUE", cooldownMs: +deadline - +endedAt, schedulingJitterMs: +new Date(dial.startedAt) - +deadline, realCalls: 0 }));
        }
    } finally { context.mock.timers.reset(); }
});

test("releasing a reserved or unconfirmed attempt never starts a second cooldown or fabricates an end", async context => {
    context.mock.timers.enable({ apis: ["Date"], now });
    try {
        for (const dispatched of [false, true]) {
            context.mock.timers.setTime(+now);
            const f = await fixture(); await f.add();
            const q = (await f.queue()).callingQueue;
            const token = (await (await f.request("/call-bridge/reserve", reservation(f.code, q))).json()).reservationToken;
            const body = { employeeCode: f.code, leadId: q.nextLeadId, reservationToken: token };
            if (dispatched) assert.equal((await f.request("/call-bridge/dial-start", body)).status, 200);
            context.mock.timers.setTime(+now + 5000);
            const released = await f.request("/call-bridge/release", body);
            assert.equal(released.status, 200);
            const state = await released.json();
            assert.equal(state.lastCallEndedAt, null);
            assert.equal(state.nextCallAllowedAt, dispatched ? new Date(+now + 30000).toISOString() : null);
            if (dispatched) {
                assert.equal((await f.request("/call-bridge/reserve", reservation(f.code, q))).status, 409);
                context.mock.timers.setTime(+now + 30000);
                await getCallBridgeDeviceModel().updateOne({ employeeCode: f.code }, { $set: { lastSeenAt: new Date(), state: "unknown" } });
                assert.equal((await f.request("/call-bridge/reserve", reservation(f.code, q))).status, 409, "an unknown bridge must not permit a retry after the deadline");
                await getCallBridgeDeviceModel().updateOne({ employeeCode: f.code }, { $set: { state: "idle", lastIdleAt: new Date() } });
            }
            const retry = await f.request("/call-bridge/reserve", reservation(f.code, q));
            assert.equal(retry.status, 200, "the original retry deadline, not release time plus 30 seconds, permits retry");
        }
    } finally { context.mock.timers.reset(); }
});

const { LeadCallStat } = await import("../models/leadCallStat");
const { getBusinessConnection } = await import("../config/tenancy");
test("only a successfully saved note or outcome releases the repeat target in all six businesses", async context => {
    context.mock.timers.enable({ apis: ["Date"], now });
    try { for (const business of businesses) for (const outcome of ["log-call", "not-connected", "voicemail"]) {
        const f = await fixture(business), lead = await f.add(), next = await f.add({ phone: "+12025550122", createdAt: new Date(+now - 200000) });
        assert.equal((await f.request(`/leads/${lead._id}/calls`, { callOutcome: "confirmed" })).status, 201);
        const before = (await f.queue()).callingQueue; assert.equal(before.nextLeadId, String(lead._id));
        const ledger = JSON.stringify(await AttendanceLedger.find().sort({ _id: 1 }).lean());
        const response = await f.request(`/log/${lead._id}/${outcome}`, { employeeId: String(f.employee._id) }, CALLING_QUEUE_POLICY_VERSION, "PATCH");
        assert.equal(response.status, 200, JSON.stringify(await response.json()));
        const saved = await runWithBusiness(business, () => Lead.findById(lead._id).lean());
        assert.equal(saved?.comments.length, 0, "logging a tag must never fabricate or auto-save a comment");
        assert.equal(+saved!.lastCallOutcomeAt!, +now);
        for (let read = 0; read < 2; read++) {
            const current = (await f.queue()).callingQueue;
            assert.equal(current.nextLeadId, String(next._id));
            assert.equal(current.entries.find((entry: QueueEntry) => entry.leadId === String(lead._id)).callable, false);
        }
        assert.equal((await f.request("/call-bridge/reserve", reservation(f.code, before))).status, 409);
        assert.equal(JSON.stringify(await AttendanceLedger.find().sort({ _id: 1 }).lean()), ledger);
        await runWithBusiness(business, () => Lead.deleteMany({}));
    } } finally { context.mock.timers.reset(); }
});

test("a failed outcome metadata write rolls back the statistic and never releases an unnoted lead", async context => {
    context.mock.timers.enable({ apis: ["Date"], now });
    try {
        const f = await fixture(), lead = await f.add();
        await runWithBusiness(f.business, () => LeadCallStat.createIndexes());
        assert.equal((await f.request(`/leads/${lead._id}/calls`, { callOutcome: "confirmed" })).status, 201);
        const model = getBusinessConnection(f.business).model("Lead") as typeof Lead;
        const original = model.updateOne.bind(model);
        const mocked = context.mock.method(model, "updateOne", (...args: Parameters<typeof Lead.updateOne>) => {
            if ((args[1] as { $set?: { lastCallOutcomeAt?: unknown } })?.$set?.lastCallOutcomeAt) throw Error("SYNTHETIC_OUTCOME_WRITE_FAILED");
            return original(...args);
        });
        try {
            assert.equal((await f.request(`/log/${lead._id}/voicemail`, { employeeId: String(f.employee._id) }, CALLING_QUEUE_POLICY_VERSION, "PATCH")).status, 500);
        } finally { mocked.mock.restore(); }
        assert.equal(await runWithBusiness(f.business, () => LeadCallStat.countDocuments({ lead: lead._id })), 0);
        assert.equal((await f.queue()).callingQueue.nextLeadId, String(lead._id));
        assert.equal((await runWithBusiness(f.business, () => Lead.findById(lead._id).lean()))?.lastCallOutcomeAt, null);
    } finally { context.mock.timers.reset(); }
});

test("saved outcome timestamps cannot be forged through lead editing and foreign tags cannot release another employee's queue", async context => {
    context.mock.timers.enable({ apis: ["Date"], now });
    try {
        const own = await fixture(), other = await fixture(), lead = await own.add(), foreign = await other.add({ phone: "+12025550123" });
        assert.equal((await own.request(`/log/${foreign._id}/not-connected`, { employeeId: String(other.employee._id) }, CALLING_QUEUE_POLICY_VERSION, "PATCH")).status, 403);
        const input = { ...lead.toObject(), phone: lead.phone, lastCallOutcomeAt: now, assignedAgent: String(own.employee._id) };
        assert.equal((await own.request(`/leads/${lead._id}`, input, CALLING_QUEUE_POLICY_VERSION, "PUT")).status, 200);
        assert.equal((await runWithBusiness(own.business, () => Lead.findById(lead._id).lean()))?.lastCallOutcomeAt, null);
    } finally { context.mock.timers.reset(); }
});
