import assert from "node:assert/strict";
import crypto from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { before, after, test } from "node:test";
import mongoose, { Types } from "mongoose";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import { compactLeadFactsStage, expandCompactLeadFacts, readCompactLeadFacts, type CompactLeadFact } from "./compactLeadFacts";

const root = `compact_facts_${crypto.randomUUID().replaceAll("-", "")}`;
const businesses = Array.from({ length: 6 }, (_, index) => ({ id: `compact-${index}`, databaseName: `${root}_${index}` }));
Object.assign(process.env, { NODE_ENV: "test", BUSINESS_DATABASES: JSON.stringify(businesses),
    DEFAULT_BUSINESS_ID: businesses[0].id, DEFAULT_BUSINESS_DATABASE: businesses[0].databaseName,
    CONTROL_DATABASE_NAME: root + "_control", CRM_LEAD_PHONE_DEDUP_V2: "true" });
const baseline = process.env.CRM_COMPACT_BASELINE_SOURCE;
if (baseline) assert.ok(path.isAbsolute(baseline), "The optional compact-read baseline must be an absolute path");
const { employeeCallingQueue } = await import("./employeeCallingQueue");
const { runWithBusiness } = await import("../config/tenancy");
const { Employee } = await import("../models/Employee");
const oldQueue = baseline ? await import(pathToFileURL(path.join(baseline, "backend/src/services/employeeCallingQueue.ts")).href) : null;
const oldTenancy = baseline ? await import(pathToFileURL(path.join(baseline, "backend/src/config/tenancy.ts")).href) : null;
const now = new Date("2026-10-30T17:00:00.237Z");
type Person = { _id: Types.ObjectId; employeeCode: string; name: string; aliases: string[] };
const people: Array<{ business: typeof businesses[number]; person: Person; repeated: Types.ObjectId; callback: Types.ObjectId; foreign: Types.ObjectId }> = [];
let mongo: MongoMemoryReplSet;

before(async () => {
    mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 }, instanceOpts: [{ args: ["--wiredTigerCacheSizeGB", "0.25"] }] });
    const uri = mongo.getUri(root);
    assert.equal(new URL(uri).hostname, "127.0.0.1");
    await mongoose.connect(uri, { monitorCommands: true });
    for (const business of businesses) await runWithBusiness(business.id, async () => {
        const person = await Employee.create({ employeeCode: `synthetic-${business.id}`, name: `Synthetic ${business.id}`,
            aliases: ["Synthetic legacy name"], role: "Sales", status: "Active" });
        const repeated = new Types.ObjectId(), other = new Types.ObjectId();
        const rows = Array.from({ length: 120 }, (_, index) => ({ _id: index === 0 ? repeated : new Types.ObjectId(),
            businessName: `Synthetic business ${index}`, businessAddress: `Synthetic address ${index}`, phone: `+1202555${String(1000 + index)}`,
            assignedAgent: index === 5 ? other : person._id, assignedAgentName: person.name, status: index % 8 === 1 ? "Follow up" : "NEW",
            followUpAt: index % 8 === 1 ? new Date(+now + (index % 3 - 1) * 1000) : null,
            createdAt: new Date(+now - index * 10000 - 86400000), updatedAt: now,
            notes: index % 3 === 0 ? "Synthetic note" : "", callCount: index === 0 ? 1 : 0,
            callsByEmployee: index === 0 ? [{ employee: person._id, count: 1, lastCallAt: new Date(+now - 30000) }] : [],
            comments: index % 11 === 1 ? [{ authorType: "employee", authorName: person.name, createdAt: new Date(+now - 1000), body: "Synthetic saved note" }] : [],
            callLogs: [], googlePlaceId: "", providerPlaceId: "", placeProvider: "" }));
        rows.push({ ...rows[5], _id: new Types.ObjectId(), assignedAgent: person._id, notes: "", callCount: 0 });
        await mongoose.connection.getClient().db(business.databaseName).collection("leads").insertMany(rows);
        await mongoose.connection.getClient().db(business.databaseName).collection("payrollrecords").insertOne({ fixture: "Synthetic saved payroll", netPay: 123, status: "Paid", paidOn: now });
        await mongoose.connection.getClient().db(business.databaseName).collection("attendances").insertOne({ fixture: "Synthetic original punch", source: "Time In", timeIn: now });
        people.push({ business, person: { _id: person._id, employeeCode: person.employeeCode, name: person.name, aliases: person.aliases },
            repeated, callback: rows[25]._id, foreign: rows[5]._id });
    });
});
after(async () => { await mongoose.disconnect(); await mongo?.stop(); });

async function evidence() {
    const data: unknown[] = [];
    for (const business of businesses) for (const name of ["leads", "attendances", "payrollrecords"]) {
        data.push(await mongoose.connection.getClient().db(business.databaseName).collection(name).find({}).sort({ _id: 1 }).toArray());
    }
    return crypto.createHash("sha256").update(JSON.stringify(data)).digest("hex");
}
async function compare(scope: typeof people[number], at = now) {
    const after = await runWithBusiness(scope.business.id, () => employeeCallingQueue(scope.person, scope.business.id, at, true));
    if (oldQueue && oldTenancy) {
        const before = await oldTenancy.runWithBusiness(scope.business.id, () => oldQueue.employeeCallingQueue(scope.person, scope.business.id, at, true));
        assert.deepEqual(after, before);
    }
    assert.deepEqual(after.scope, { businessId: scope.business.id, employeeId: String(scope.person._id), employeeCode: scope.person.employeeCode });
    assert.equal(after.entries.some(entry => entry.leadId === String(scope.foreign)), false);
    return after;
}

test("MongoDB compaction retains exact BSON facts in six businesses and reduces their transport size", async () => {
    const fields = ["_id", "phone", "status", "followUpAt", "assignedAgent", "assignedAgentName", "createdAt", "googlePlaceId",
        "providerPlaceId", "placeProvider", "businessName", "businessAddress", "callCount", "notes", "callLogCount", "manualCommentCount"];
    let oldBytes = 0, nextBytes = 0;
    for (const business of businesses) {
        const collection = mongoose.connection.getClient().db(business.databaseName).collection("compactfixtures");
        const rows = Array.from({ length: 200 }, (_, index) => ({ _id: new Types.ObjectId(), phone: index % 2 ? null : "+12025550121",
            status: "NEW", assignedAgent: new Types.ObjectId(), assignedAgentName: "Synthetic employee", createdAt: now,
            businessName: "Synthetic business", businessAddress: "Synthetic address", callCount: 0, notes: "", callLogCount: 0, manualCommentCount: 0,
            ...(index % 3 === 0 ? { followUpAt: null, googlePlaceId: "", providerPlaceId: "", placeProvider: "" } : {}) }));
        await collection.insertMany(rows);
        const complete = await collection.find({}).toArray();
        const packed = await collection.aggregate<CompactLeadFact>([compactLeadFactsStage(fields)]).toArray();
        assert.deepEqual(expandCompactLeadFacts(packed, fields), complete);
        const cursor = collection.aggregate<CompactLeadFact>([compactLeadFactsStage(fields)], { batchSize: 17 });
        assert.deepEqual(await readCompactLeadFacts(cursor, fields), complete);
        assert.equal(cursor.closed, true);
        oldBytes += complete.reduce((sum, row) => sum + mongoose.mongo.BSON.calculateObjectSize(row), 0);
        nextBytes += packed.reduce((sum, row) => sum + mongoose.mongo.BSON.calculateObjectSize(row), 0);
    }
    assert.ok(nextBytes < oldBytes * .75, "Compaction must reduce bytes before it is considered useful");
    console.log(JSON.stringify({ fixtureOnly: true, documents: 1200, oldBytes, nextBytes, reductionPercent: Math.round(100 * (1 - nextBytes / oldBytes)) }));
});

test("concurrent UI reads share candidate loads but fresh deadline/dispatch reads never do", async () => {
    const scope = people[0], before = await evidence();
    const expected = await compare(scope);
    const client = mongoose.connection.getClient(); let candidateLoads = 0;
    const observe = (event: { command: { pipeline?: Array<{ $project?: { v?: unknown[] } }> } }) => {
        if (event.command.pipeline?.some(stage => stage.$project?.v?.includes("$updatedAt"))) candidateLoads++;
    };
    client.on("commandStarted", observe);
    try {
        const pages = await Promise.all(Array.from({ length: 20 }, () => runWithBusiness(scope.business.id,
            () => employeeCallingQueue(scope.person, scope.business.id, now, false, { cacheComments: true }))));
        pages.forEach(page => assert.deepEqual(page, expected));
        assert.ok(candidateLoads > 0 && candidateLoads < 20, "only unfinished display reads may be shared");
        candidateLoads = 0;
        const fresh = await Promise.all(Array.from({ length: 10 }, () => runWithBusiness(scope.business.id,
            () => employeeCallingQueue(scope.person, scope.business.id, now, true, { cacheComments: true }))));
        fresh.forEach(page => assert.deepEqual(page, expected));
        assert.equal(candidateLoads, 10, "fresh authorizations must keep independent fresh reads");
        assert.equal(await evidence(), before);
    } finally { client.off("commandStarted", observe); }
});

test("all six queues retain every decision, order, repeat lead, ownership and callback boundary without record writes", async () => {
    const before = await evidence();
    for (const scope of people) for (const offset of [-1, 0, 1]) {
        const queue = await compare(scope, new Date(+now + offset));
        assert.equal(queue.repeatLeadId, String(scope.repeated)); assert.equal(queue.nextLeadId, String(scope.repeated));
        assert.equal(queue.entries[0].leadId, String(scope.repeated));
        const callback = queue.entries.find(entry => entry.leadId === String(scope.callback));
        assert.equal(callback?.callable, offset >= 0);
        assert.equal(callback?.reason, offset < 0 ? "NOT_DUE" : "SCHEDULED_DUE");
        assert.equal(callback?.nextEligibleAt, offset < 0 ? now.toISOString() : null);
    }
    assert.equal(await evidence(), before);
});

test("saved notes and reassignment still release the old repeat lead in all six businesses", async () => {
    for (const scope of people) {
        const collection = mongoose.connection.getClient().db(scope.business.databaseName).collection<{
            _id: Types.ObjectId; comments: Array<{ authorType: string; createdAt: Date }>; assignedAgent?: Types.ObjectId; updatedAt?: Date;
        }>("leads");
        await collection.updateOne({ _id: scope.repeated }, { $push: { comments: { authorType: "employee", createdAt: now } }, $set: { updatedAt: now } });
        const before = await evidence(), noted = await compare(scope);
        assert.notEqual(noted.repeatLeadId, String(scope.repeated)); assert.equal(await evidence(), before);
        await collection.updateOne({ _id: scope.repeated }, { $set: { comments: [], assignedAgent: new Types.ObjectId() } });
        const reassignedEvidence = await evidence(), reassigned = await compare(scope);
        assert.equal(reassigned.entries.some(entry => entry.leadId === String(scope.repeated)), false);
        assert.equal(await evidence(), reassignedEvidence);
    }
});

test("10/25/50 concurrent reads match isolated serial results without crossing tenants", async () => {
    const before = await evidence();
    const expected: Array<Awaited<ReturnType<typeof compare>>> = [];
    for (const person of people) expected.push(await compare(person));
    for (const count of [10, 25, 50]) await Promise.all(Array.from({ length: count }, async (_, index) => {
        const i = index % people.length;
        assert.deepEqual(await compare(people[i]), expected[i]);
    }));
    assert.equal(await evidence(), before);
});
