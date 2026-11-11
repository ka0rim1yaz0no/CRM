import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import { after, before, beforeEach, test } from "node:test";
import mongoose, { Types } from "mongoose";
import { MongoMemoryReplSet } from "mongodb-memory-server";
const root = "customers_" + crypto.randomUUID().replaceAll("-", "");
const businesses = Array.from({ length: 7 }, (_, i) => "customer-" + i);
Object.assign(process.env, { NODE_ENV: "test", CRM_SECURITY_LEGACY_AUTH: "true", CRM_LEAD_PHONE_DEDUP_V2: "true",
    CRM_ADMIN_ONE_CODE: "synthetic-customer-admin", CRM_ADMIN_SESSION_SECRET: crypto.randomBytes(48).toString("base64"),
    DEFAULT_BUSINESS_ID: businesses[0], DEFAULT_BUSINESS_DATABASE: root + "_0", CONTROL_DATABASE_NAME: root + "_control",
    BUSINESS_DATABASES: JSON.stringify(businesses.map((id, i) => ({ id, name: i === 0 ? "Order THCA" : "Synthetic Business " + i, databaseName: root + "_" + i }))) });
const { createApp } = await import("../app");
const { runWithBusiness } = await import("../config/tenancy");
const { createAdminDashboardSession } = await import("../config/adminDashboardSession");
const { Lead } = await import("../models/Lead");
const { getCallBridgeScheduleModel } = await import("../models/CallBridge");
const { storeOrderCustomerLead } = await import("./customerLeadMerge");
let mongo: MongoMemoryReplSet, server: http.Server, base = "", admin = "";
before(async () => {
    mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 }, instanceOpts: [{ args: ["--wiredTigerCacheSizeGB", "0.25"] }] });
    const uri = mongo.getUri(root); assert.equal(new URL(uri).hostname, "127.0.0.1"); await mongoose.connect(uri, { maxPoolSize: 2 });
    for (const business of businesses) await runWithBusiness(business, () => Lead.createIndexes());
    server = http.createServer(createApp()); await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    base = "http://127.0.0.1:" + (server.address() as { port: number }).port + "/api";
    admin = createAdminDashboardSession("synthetic-customer-admin")!;
});
after(async () => { server?.closeAllConnections(); server?.close(); await mongoose.disconnect(); await mongo?.stop(); });
beforeEach(async () => {
    for (const business of businesses) await runWithBusiness(business, async () => { await Lead.deleteMany({}); await Lead.db.db!.collection("leadcustomerguards").deleteMany({}); });
    await getCallBridgeScheduleModel().deleteMany({});
});
const input = (extra = {}) => ({ leadName: "Synthetic Customer", businessName: "Synthetic Customer", source: "Synthetic order #1", ...extra });
const request = (path: string, body?: unknown, business = businesses[0]!) => fetch(base + path, {
    method: body === undefined ? "GET" : "POST", headers: { "Content-Type": "application/json", "X-Business-Id": business, "X-CRM-Admin-Session": admin },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

test("phone-only and email-only customer orders become one lead with both details through actual create routes", async () => {
    const first = await request("/leads", input({ phone: "+12025550121", notes: "First order" })); assert.equal(first.status, 201);
    const next = await request("/leads", input({ email: "synthetic@example.test", source: "Synthetic order #2", notes: "Second order" })); assert.equal(next.status, 200);
    const customer = await next.json(); assert.equal(customer.phone, "+12025550121"); assert.equal(customer.email, "synthetic@example.test");
    assert.match(customer.notes, /First order/); assert.match(customer.notes, /Second order/); assert.match(customer.notes, /order #2/);
    await runWithBusiness(businesses[0]!, async () => assert.equal(await Lead.countDocuments({ status: { $ne: "Archived" } }), 1));
});
test("concurrent same-name order creation is serialized and cannot leave extra active leads", async () => {
    const responses = await Promise.all(Array.from({ length: 8 }, (_, i) => request("/leads", input({ email: "synthetic@example.test", source: "Synthetic order #" + i, notes: "Items from order " + i }))));
    assert.ok(responses.every(response => [200, 201].includes(response.status)), JSON.stringify(responses.map(response => response.status)));
    await runWithBusiness(businesses[0]!, async () => { const leads = await Lead.find({ status: { $ne: "Archived" } }).lean(); assert.equal(leads.length, 1);
        for (let i = 0; i < 8; i++) assert.match(leads[0]!.notes, new RegExp("Items from order " + i)); });
});
test("CSV import merges matching rows, reports merged counts and is replay-safe", async () => {
    const body = { leads: [input({ phone: "+12025550121", notes: "First order" }), input({ email: "synthetic@example.test", source: "Synthetic order #2", notes: "Second order" })] };
    const response = await request("/leads/import", body); assert.equal(response.status, 201); const result = await response.json();
    assert.equal(result.importedCount, 1); assert.equal(result.mergedCount, 1);
    const before = await runWithBusiness(businesses[0]!, async () => (await Lead.findOne().lean())!);
    const repeat = await request("/leads/import", body); assert.equal(repeat.status, 201); assert.equal((await repeat.json()).mergedCount, 2);
    await runWithBusiness(businesses[0]!, async () => { const after = (await Lead.findOne().lean())!; assert.equal(await Lead.countDocuments(), 1);
        assert.equal(after.notes, before.notes); assert.equal(after.comments.length, before.comments.length); });
});
test("different email identities under the same name require review instead of a new duplicate or mistaken merge", async () => {
    assert.equal((await request("/leads", input({ email: "one@example.test" }))).status, 201);
    assert.equal((await request("/leads", input({ email: "two@example.test" }))).status, 409);
    await runWithBusiness(businesses[0]!, async () => assert.equal(await Lead.countDocuments(), 1));
});
test("legacy copies are archived recoverably and preserve the primary owner, work and complete original documents", async () => {
    await runWithBusiness(businesses[0]!, async () => {
        const owner = new Types.ObjectId(), first = { _id: new Types.ObjectId(), ...input(), status: "Follow up", assignedAgent: owner,
            assignedAgentName: "Synthetic Owner", callCount: 2, notes: "Original human work", comments: [{ _id: new Types.ObjectId(), authorName: "Synthetic", authorType: "employee", body: "Keep note", createdAt: new Date() }] };
        const donor = { _id: new Types.ObjectId(), ...input({ source: "Synthetic order #2", email: "synthetic@example.test", notes: "Additional order" }),
            status: "Follow up", assignedAgent: owner, assignedAgentName: "Synthetic Owner" };
        await Lead.collection.insertMany([first, donor]); const original = await Lead.collection.findOne({ _id: donor._id });
        const result = await storeOrderCustomerLead(input({ email: "synthetic@example.test", notes: "Third order" })); assert.equal(result!.merged, true);
        const active = (await Lead.findById(result!.id).lean())!; assert.equal(String(active.assignedAgent), String(owner)); assert.equal(active.callCount, 2);
        assert.equal(active.comments[0]!.body, "Keep note"); assert.match(active.notes, /Additional order/); assert.match(active.notes, /Third order/);
        const archived = (await Lead.collection.findOne({ _id: donor._id }))!; assert.equal(archived.status, "Archived"); assert.equal(String(archived.duplicateOf), result!.id);
        for (const field of ["email", "notes", "assignedAgent", "assignedAgentName", "source"]) assert.deepEqual(archived[field], original![field]);
    });
});
test("active call reservations refuse merges without changing lead or call state", async () => {
    await runWithBusiness(businesses[0]!, async () => {
        const lead = await Lead.create(input({ email: "synthetic@example.test" }));
        await getCallBridgeScheduleModel().create({ employeeCode: "synthetic-caller", reservedBusinessId: businesses[0], reservedLeadId: String(lead._id), callLeaseUntil: new Date(Date.now() + 60000) });
        const before = JSON.stringify(await Lead.find().lean()), calls = JSON.stringify(await getCallBridgeScheduleModel().find().lean());
        await assert.rejects(storeOrderCustomerLead(input({ notes: "New order" })), /active call/);
        assert.equal(JSON.stringify(await Lead.find().lean()), before); assert.equal(JSON.stringify(await getCallBridgeScheduleModel().find().lean()), calls);
    });
});
test("other business create/import semantics and all protected financial/attendance collections stay unchanged", async () => {
    const protectedDb = mongoose.connection.db!;
    await protectedDb.collection("payrollrecords").insertOne({ synthetic: true, status: "Paid", amount: 100 });
    await protectedDb.collection("attendanceledgers").insertOne({ synthetic: true, events: [{ source: "Time In", at: new Date() }] });
    const evidence = async () => JSON.stringify([await protectedDb.collection("payrollrecords").find().toArray(), await protectedDb.collection("attendanceledgers").find().toArray()]);
    const before = await evidence();
    for (const business of businesses.slice(1)) {
        assert.equal((await request("/leads", input({ email: "synthetic@example.test" }), business)).status, 201);
        assert.equal((await request("/leads", input({ email: "synthetic@example.test" }), business)).status, 201);
        await runWithBusiness(business, async () => assert.equal(await Lead.countDocuments(), 2));
    }
    assert.equal((await request("/leads/import", { leads: [input({ notes: "Order content" }), input({ email: "synthetic@example.test" })] })).status, 201);
    assert.equal(await evidence(), before);
});
