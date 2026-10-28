import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import { after, before, beforeEach, test } from "node:test";
import mongoose, { Types } from "mongoose";
import { MongoMemoryReplSet } from "mongodb-memory-server";

const root = `phone_${crypto.randomUUID().replaceAll("-", "")}`;
const businesses = Array.from({ length: 6 }, (_, i) => `phone-${i}`);
Object.assign(process.env, { NODE_ENV: "test", CRM_SECURITY_LEGACY_AUTH: "true", CRM_LEAD_PHONE_DEDUP_V2: "true", CRM_CALL_TIMING_V2: "true", CRM_DASHBOARD_V2: "true",
    CRM_ADMIN_ONE_CODE: "synthetic-phone-admin", CRM_ADMIN_SESSION_SECRET: crypto.randomBytes(48).toString("base64"),
    DEFAULT_BUSINESS_ID: businesses[0], DEFAULT_BUSINESS_DATABASE: `${root}_0`, CONTROL_DATABASE_NAME: `${root}_control`,
    BUSINESS_DATABASES: JSON.stringify(businesses.map((id, i) => ({ id, databaseName: `${root}_${i}` }))) });
const { createApp } = await import("../app");
const { runWithBusiness } = await import("../config/tenancy");
const { Lead } = await import("../models/Lead");
const { Employee } = await import("../models/Employee");
const { setBusinessAccessForEmployeeCode } = await import("../models/BusinessUserAccess");
const { createAttendanceHubSession } = await import("../config/attendanceHubSession");
const { getCallBridgeScheduleModel } = await import("../models/CallBridge");
const { LeadPhoneSlot, reservePhoneSlot, consumePhoneSlot, busyPhonesForEmployee } = await import("./leadPhoneDispatch");
let mongo: MongoMemoryReplSet, server: http.Server, base = "", admin = "";
before(async () => {
    mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    await mongoose.connect(mongo.getUri(root));
    for (const business of businesses) await runWithBusiness(business, () => Lead.createIndexes());
    server = http.createServer(createApp()); await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`;
    const login = await fetch(base + "/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ employeeCode: "synthetic-phone-admin" }) });
    admin = (await login.json()).sessionToken;
});
after(async () => { server?.closeAllConnections(); server?.close(); await mongoose.disconnect(); await mongo?.stop(); });
beforeEach(async () => {
    for (const business of businesses) await runWithBusiness(business, async () => { await Lead.deleteMany({}); await Employee.deleteMany({}); await LeadPhoneSlot.deleteMany({}); });
    await getCallBridgeScheduleModel().deleteMany({});
});
async function fixture(business = businesses[0]) {
    const person = async (label: string) => {
        const code = `synthetic-${label}-${crypto.randomUUID()}`; await setBusinessAccessForEmployeeCode(code, businesses);
        return runWithBusiness(business, () => Employee.create({ employeeCode: code, name: `Synthetic ${label}`, role: "Sales", status: "Active", availabilityStatus: "ONLINE" }));
    };
    const owner = await person("Owner"), other = await person("Other");
    const old = async (extra = {}) => runWithBusiness(business, async () => {
        const record = { _id: new Types.ObjectId(), businessName: `Synthetic ${crypto.randomUUID()}`, phone: "+12025550121", status: "NEW", assignedAgent: owner._id,
            assignedAgentName: owner.name, createdAt: new Date("2026-10-01T00:00:00Z"), updatedAt: new Date("2026-10-01T00:00:00Z"), ...extra };
        await Lead.collection.insertOne(record); return record;
    });
    const request = (path: string, body?: unknown, employeeCode?: string) => fetch(base + path, { method: body === undefined ? "GET" : "PATCH",
        headers: { "Content-Type": "application/json", "X-Business-Id": business, ...(employeeCode ? { "X-CRM-Attendance-Session": createAttendanceHubSession(employeeCode)! } : { "X-CRM-Admin-Session": admin }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { business, owner, other, old, request };
}

test("six tenants choose one phone-first canonical before admin/employee pagination and counts without writing legacy records", async () => {
    for (const business of businesses) {
        const f = await fixture(business);
        for (const [i, phone] of ["(202) 555-0121", "2025550121", "+1 202 555 0121"].entries()) await f.old({ phone, googlePlaceId: `synthetic-place-${i}`, businessAddress: `Synthetic address ${i}` });
        const due = await f.old({ phone: "1-202-555-0121", googlePlaceId: "synthetic-due", status: "Follow up", followUpAt: new Date(Date.now() - 1000) });
        await f.old({ phone: "+12025550121", assignedAgent: f.other._id, assignedAgentName: f.other.name });
        const page = await (await f.request("/admin-leads?tab=leads&limit=1")).json();
        assert.equal(page.total, 1); assert.equal(page.leads[0]._id, String(due._id));
        assert.equal((await (await f.request("/admin-leads?tab=leads&limit=1&page=2")).json()).leads.length, 0);
        const own = await (await f.request(`/my-leads?callingQueue=true&employeeId=${f.owner._id}`, undefined, f.owner.employeeCode)).json();
        assert.equal(own.total, 1); assert.equal(own.callingQueue.nextLeadId, String(due._id));
        assert.equal((await (await f.request(`/my-leads?callingQueue=true&employeeId=${f.other._id}`, undefined, f.other.employeeCode)).json()).total, 0);
        const counts = await (await f.request(`/my-leads/counts?employeeId=${f.owner._id}`, undefined, f.owner.employeeCode)).json();
        assert.equal(counts.ALL, 1);
        await runWithBusiness(business, async () => { assert.equal(await Lead.countDocuments(), 5); assert.equal(await Lead.countDocuments({ status: "Archived" }), 0); assert.equal(await Lead.countDocuments({ activePhoneKey: { $exists: true } }), 0); });
    }
});

test("Insights matches canonical lead status totals, includes unassigned leads and refreshes after changes in all six businesses", async () => {
    for (const business of businesses) {
        const f = await fixture(business);
        await f.old({ status: "Follow up", followUpAt: new Date(Date.now() - 60000) });
        for (let i = 0; i < 6; i++) await f.old({ googlePlaceId: `synthetic-shadow-${i}`, updatedAt: new Date() });
        const current = await f.old({ phone: "+12025550122" });
        await f.old({ phone: "+12025550123", assignedAgent: null, assignedAgentName: "" });
        await f.old({ phone: "+12025550124", status: "Qualified" });
        await f.old({ phone: "+12025550125", status: "Ongoing Negotiation" });
        await f.old({ phone: "+12025550126", status: "Completed" });
        await f.old({ phone: "+12025550127", status: "Dead" });
        await f.old({ phone: current.phone, status: "Archived", comments: [{ authorType: "employee", authorName: f.owner.name,
            body: "Synthetic preserved history", createdAt: new Date() }] });
        const before = await runWithBusiness(business, async () => JSON.stringify(await Lead.find().sort({ _id: 1 }).lean()));
        for (let refresh = 0; refresh < 2; refresh++) {
            const counts = await (await f.request("/leads/counts")).json();
            const dashboard = await (await f.request("/leads/agent-dashboard")).json();
            const workspaceResponse = await f.request("/dashboard-workspace/summary?preset=today");
            assert.equal(workspaceResponse.status, 200);
            const workspace = await workspaceResponse.json();
            assert.deepEqual(dashboard.pipeline, { newLeads: 2, followUps: 1, qualified: 1 });
            assert.deepEqual(workspace.dashboard.pipeline, dashboard.pipeline);
            assert.equal(dashboard.pipeline.newLeads, counts.NEW);
            assert.equal(dashboard.pipeline.followUps, counts["Follow up"]);
            assert.equal(dashboard.pipeline.qualified, counts.Qualified);
            assert.equal(dashboard.agents.reduce((sum: number, row: { newLeads: number }) => sum + row.newLeads, 0), 1);
        }
        assert.equal(await runWithBusiness(business, async () => JSON.stringify(await Lead.find().sort({ _id: 1 }).lean())), before,
            "dashboard and refresh reads must not alter lead records or history");
        const changed = await f.request(`/leads/${current._id}/status`, { status: "Dead" });
        assert.equal(changed.status, 200);
        for (let refresh = 0; refresh < 2; refresh++) {
            const counts = await (await f.request("/leads/counts")).json();
            const workspace = await (await f.request("/dashboard-workspace/summary?preset=today")).json();
            assert.equal(workspace.dashboard.pipeline.newLeads, 1);
            assert.equal(workspace.dashboard.pipeline.newLeads, counts.NEW);
            assert.equal(workspace.dashboard.pipeline.followUps, counts["Follow up"]);
            assert.equal(workspace.dashboard.pipeline.qualified, counts.Qualified);
        }
    }
});

test("new manual, insertMany, provider-upsert and changed/restored identities reject full-number duplicates, including concurrent creation", async () => {
    const f = await fixture();
    await runWithBusiness(f.business, async () => {
        const results = await Promise.allSettled([Lead.create({ businessName: "Synthetic A", phone: "202-555-0121" }), Lead.create({ businessName: "Synthetic B", phone: "+12025550121" })]);
        assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
        assert.equal(await Lead.countDocuments(), 1);
        await assert.rejects(Lead.insertMany([{ businessName: "Synthetic C", phone: "+12025550121" }]));
        await assert.rejects(Lead.bulkWrite([{ updateOne: { filter: { googlePlaceId: "synthetic-other-provider" }, update: { $set: { businessName: "Synthetic D", phone: "(202) 555-0121", status: "NEW" } }, upsert: true } }]));
        const archived = await Lead.create({ businessName: "Synthetic archived", phone: "+12025550121", status: "Archived" });
        await assert.rejects(Lead.updateOne({ _id: archived._id }, { $set: { status: "NEW" } }));
        const other = await Lead.create({ businessName: "Synthetic other", phone: "+12025550122" });
        await assert.rejects(Lead.findByIdAndUpdate(other._id, { $set: { phone: "+12025550121" } }));
        assert.equal(await Lead.countDocuments({ status: { $ne: "Archived" } }), 2);
    });
    await runWithBusiness(businesses[1], async () => { const lead = await Lead.create({ businessName: "Synthetic separate tenant", phone: "+12025550121" }); assert.ok(lead._id); });
});

test("metadata edits of legacy duplicates remain possible and duplicate history cannot silently restore", async () => {
    const f = await fixture(), one = await f.old(), two = await f.old();
    await runWithBusiness(f.business, async () => {
        await Lead.updateOne({ _id: one._id }, { $set: { notes: "Synthetic preserved note", status: "Follow up" } });
        assert.equal((await Lead.findById(one._id).lean())!.notes, "Synthetic preserved note");
        await Lead.updateOne({ _id: two._id }, { $set: { status: "Archived", duplicateOf: one._id } });
        await assert.rejects(Lead.updateOne({ _id: two._id }, { $set: { status: "NEW", phone: "+12025550123" } }));
        assert.equal((await Lead.findById(two._id).lean())!.status, "Archived");
        await Lead.updateOne({ _id: one._id }, { $set: { status: "Archived" } });
        await assert.rejects(Lead.create({ businessName: "Synthetic reimport", phone: "2025550121" }));
        await Lead.updateOne({ _id: one._id }, { $set: { status: "NEW" } });
        assert.equal((await Lead.findById(one._id).lean())!.status, "NEW");
    });
});

async function transaction<T>(operation: (session: mongoose.ClientSession) => Promise<T>) {
    const session = await mongoose.startSession();
    try { return await session.withTransaction(() => operation(session)); }
    finally { await session.endSession(); }
}

test("phone dispatch fencing permits one competing reservation and one consumption, with the existing exact 30-second deadline", async () => {
    const f = await fixture(), now = new Date();
    await getCallBridgeScheduleModel().insertMany([f.owner, f.other].map(person => ({ employeeCode: person.employeeCode })));
    const attempts = await Promise.allSettled([f.owner, f.other].map(person => runWithBusiness(f.business, () => transaction(async session => {
        const claimed = await reservePhoneSlot("202-555-0121", person.employeeCode, person.employeeCode, now, session);
        if (claimed) await getCallBridgeScheduleModel().updateOne({ employeeCode: person.employeeCode }, { $set: { lastReservedAt: now, callLeaseUntil: new Date(+now + 30000) } }, { session });
        return claimed;
    }))));
    assert.equal(attempts.filter(result => result.status === "fulfilled" && result.value).length, 1);
    await runWithBusiness(f.business, async () => {
        const slot = (await LeadPhoneSlot.findOne().lean())!;
        const other = slot.employeeCode === f.owner.employeeCode ? f.other.employeeCode : f.owner.employeeCode;
        assert.equal(await transaction(session => consumePhoneSlot("+12025550121", slot.employeeCode, slot.attemptId, session)), true);
        assert.equal(await transaction(session => consumePhoneSlot("+12025550121", slot.employeeCode, slot.attemptId, session)), false);
        await getCallBridgeScheduleModel().updateOne({ employeeCode: slot.employeeCode }, { $set: { callLeaseUntil: null, lastCallStartedAt: new Date(+now - 10000), lastCallEndedAt: now, nextCallAllowedAt: new Date(+now + 30000) } });
        assert.equal((await busyPhonesForEmployee(["+12025550121"], other, new Date(+now + 29999))).size, 1);
        assert.equal((await busyPhonesForEmployee(["+12025550121"], other, new Date(+now + 30000))).size, 0);
        assert.equal(await transaction(session => reservePhoneSlot("+12025550121", other, "next-attempt", new Date(+now + 30000), session)), true);
    });
    await runWithBusiness(businesses[1], () => transaction(async session => {
        assert.equal(await reservePhoneSlot("+12025550121", "synthetic-tenant-owner", "tenant-attempt", now, session), true);
    }));
});

test("activation preserves pre-existing calls and adopts an unstarted lease without resetting its timestamp", async () => {
    const f = await fixture(), lead = await f.old(), now = new Date(), reserved = new Date(+now - 5000);
    await getCallBridgeScheduleModel().create({ employeeCode: f.owner.employeeCode, reservedBusinessId: f.business,
        reservedPhone: lead.phone, reservedLeadId: String(lead._id), lastObservedLeadId: String(lead._id), lastCallStartedAt: reserved });
    await runWithBusiness(f.business, async () => {
        assert.equal((await busyPhonesForEmployee(["+12025550121"], f.other.employeeCode, now)).size, 1);
        assert.equal(await transaction(session => reservePhoneSlot(lead.phone, f.other.employeeCode, "blocked-attempt", now, session)), false);
        assert.equal(await transaction(session => reservePhoneSlot("+12025550122", f.other.employeeCode, "other-phone", now, session)), true);
        await getCallBridgeScheduleModel().updateOne({ employeeCode: f.owner.employeeCode }, { $set: { lastCallStartedAt: null, reservedAttemptId: "pre-activation", lastReservedAt: reserved, lastDialStartedAt: null, callLeaseUntil: new Date(+now + 25000) } });
        assert.equal(await transaction(session => consumePhoneSlot(lead.phone, f.owner.employeeCode, "pre-activation", session)), true);
        assert.equal(+(await LeadPhoneSlot.findById("+12025550121").lean())!.reservedAt, +reserved);
        assert.equal(+(await getCallBridgeScheduleModel().findOne({ employeeCode: f.owner.employeeCode }).lean())!.lastReservedAt!, +reserved);
    });
});

test("signed employee bulk archive preserves history, excludes other owners, clears owned duplicates, and is idempotent in all businesses", async () => {
    for (const business of businesses) {
        const f = await fixture(business), followUpAt = new Date(), canonical = await f.old({ notes: "Synthetic retained", followUpAt, status: "Follow up",
            comments: [{ authorType: "employee", authorName: f.owner.name, body: "Synthetic retained history", createdAt: new Date() }] });
        const copy = await f.old({ phone: "(202) 555-0121", googlePlaceId: "synthetic-copy" });
        const other = await f.old({ assignedAgent: f.other._id, assignedAgentName: f.other.name });
        const body = { leadIds: [String(canonical._id)], expectedAssignmentRevisions: { [String(canonical._id)]: 0 } };
        const response = await f.request("/leads/employee/bulk/archive", body, f.owner.employeeCode);
        assert.equal(response.status, 200, JSON.stringify(await response.clone().json()));
        const result = await response.json(); assert.equal(result.archivedCount, 2); assert.equal(result.preservedOtherOwnerCount, 1);
        await runWithBusiness(business, async () => {
            const saved = (await Lead.findById(canonical._id).lean())!;
            assert.equal(saved.notes, "Synthetic retained"); assert.equal(saved.comments[0].body, "Synthetic retained history"); assert.equal(+saved.followUpAt!, +followUpAt);
            assert.equal(saved.activity.length, 1); assert.equal((await Lead.findById(copy._id).lean())!.status, "Archived");
            assert.equal((await Lead.findById(other._id).lean())!.status, "NEW");
        });
        assert.equal((await (await f.request("/leads/employee/bulk/archive", body, f.owner.employeeCode)).json()).archivedCount, 0);
        await runWithBusiness(business, async () => assert.equal((await Lead.findById(canonical._id).lean())!.activity.length, 1));
    }
});

test("forged identities, cross-tenant/other-owner IDs, oversized selections and employee access to admin bulk archive fail closed", async () => {
    const f = await fixture(), own = await f.old(), other = await f.old({ assignedAgent: f.other._id, assignedAgentName: f.other.name });
    const elsewhere = await (await fixture(businesses[1])).old();
    for (const id of [other._id, elsewhere._id, new Types.ObjectId()]) {
        assert.equal((await f.request("/leads/employee/bulk/archive", { leadIds: [String(own._id), String(id)] }, f.owner.employeeCode)).status, 403);
    }
    assert.equal((await f.request("/leads/employee/bulk/archive", { leadIds: ["invalid"] }, f.owner.employeeCode)).status, 400);
    assert.equal((await f.request("/leads/employee/bulk/archive", { leadIds: Array.from({ length: 101 }, () => String(own._id)) }, f.owner.employeeCode)).status, 400);
    assert.equal((await f.request("/leads/bulk/archive", { leadIds: [String(own._id)] }, f.owner.employeeCode)).status, 403);
    process.env.CRM_SECURITY_LEGACY_AUTH = "false";
    try { assert.equal((await f.request("/leads/bulk/archive", { leadIds: [String(own._id)] }, f.owner.employeeCode)).status, 403); }
    finally { process.env.CRM_SECURITY_LEGACY_AUTH = "true"; }
    await runWithBusiness(f.business, async () => assert.equal(await Lead.countDocuments({ status: "Archived" }), 0));
});

test("bulk archive skips an observed active call and preserves the 30-second schedule and admin archive behavior", async () => {
    const f = await fixture(), lead = await f.old();
    const start = new Date();
    await getCallBridgeScheduleModel().create({ employeeCode: f.owner.employeeCode, lastCallStartedAt: start, lastObservedLeadId: String(lead._id), nextCallAllowedAt: new Date(+start + 30000) });
    const response = await f.request("/leads/employee/bulk/archive", { leadIds: [String(lead._id)] }, f.owner.employeeCode);
    const result = await response.json(); assert.equal(result.archivedCount, 0); assert.deepEqual(result.busyIds, [String(lead._id)]);
    const schedule = (await getCallBridgeScheduleModel().findOne({ employeeCode: f.owner.employeeCode }).lean())!;
    assert.equal(+schedule.lastCallStartedAt!, +start); assert.equal(+schedule.nextCallAllowedAt!, +start + 30000);
    await getCallBridgeScheduleModel().deleteMany({});
    assert.equal((await f.request("/leads/bulk/archive", { leadIds: [String(lead._id)] })).status, 200);
    await runWithBusiness(f.business, async () => assert.equal((await Lead.findById(lead._id).lean())!.status, "Archived"));
});
