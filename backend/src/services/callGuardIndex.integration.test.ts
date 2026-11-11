import assert from "node:assert/strict";
import crypto from "node:crypto";
import { before, after, test } from "node:test";
import mongoose, { Types } from "mongoose";
import { MongoMemoryReplSet } from "mongodb-memory-server";

const prefix = `call_guard_index_${crypto.randomBytes(8).toString("hex")}`;
const businesses = Array.from({ length: 6 }, (_, index) => ({ id: `guard-index-${index}`, databaseName: `${prefix}_${index}` }));
Object.assign(process.env, { NODE_ENV: "test", DEFAULT_BUSINESS_ID: businesses[0].id,
    DEFAULT_BUSINESS_DATABASE: businesses[0].databaseName, CONTROL_DATABASE_NAME: prefix + "_control", BUSINESS_DATABASES: JSON.stringify(businesses) });
const { runWithBusiness } = await import("../config/tenancy");
const { Lead } = await import("../models/Lead");
const { getLeadDialBlock, getTransactionalLeadDialBlock } = await import("../controllers/callBridgeController");
let mongo: MongoMemoryReplSet;
before(async () => {
    mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    const uri = new URL(mongo.getUri(prefix));
    assert.ok(uri.hostname === "127.0.0.1" && uri.port !== "27017" && uri.pathname === "/" + prefix);
    await mongoose.connect(uri.href, { autoIndex: false, autoCreate: false, monitorCommands: true });
});
after(async () => { await mongoose.disconnect(); await mongo?.stop(); });

test("saved employee comments and outcome tags declare non-unique lookup indexes", () => {
    const indexes = Lead.schema.indexes();
    const lookup = indexes.find(([keys]) => keys["comments.authorType"] === 1);
    assert.ok(lookup, "A selective employee-comment index is required before calling is considered optimized");
    assert.deepEqual(lookup[0], { "comments.authorType": 1 });
    assert.equal(lookup[1].unique, undefined); assert.equal(lookup[1].name, "employee_comment_lookup");
    const outcome = indexes.find(([keys]) => keys.lastCallOutcomeAt === 1);
    assert.ok(outcome); assert.deepEqual(outcome[0], { lastCallOutcomeAt: 1 });
    assert.equal(outcome[1].unique, undefined); assert.equal(outcome[1].name, "outcome_calling_lookup");
});

test("the indexed fresh guard retains exact allow/block results in six businesses without changing original documents", async () => {
    const client = mongoose.connection.getClient(), at = new Date(), owner = new Types.ObjectId();
    for (const business of businesses) {
        const collection = client.db(business.databaseName).collection("leads");
        const rows = Array.from({ length: 1500 }, (_, index) => ({ _id: new Types.ObjectId(), phone: `+1202555${String(2000 + index)}`,
            assignedAgent: owner, status: "NEW", createdAt: at, comments: [] }));
        await collection.insertMany(rows);
        const head = (phone: string, extra: Record<string, unknown> = {}) => ({ _id: new Types.ObjectId(), phone, assignedAgent: owner,
            status: "NEW", createdAt: at, comments: [], ...extra });
        const clean = head("+12025550121"), blocked = head("+12025550122"), invalid = head("+12025550123"), adminOnly = head("+12025550124");
        const due = head("+12025550125", { status: "Follow up", followUpAt: new Date(+at - 1000) });
        const future = head("+12025550126", { status: "Follow up", followUpAt: new Date(+at + 3600000) });
        const foreign = head("+12025550127", { assignedAgent: new Types.ObjectId() }), badPhone = head("not-a-phone");
        const taggedDuplicate = head("+12025550128");
        await collection.insertMany([clean, blocked, invalid, adminOnly, due, future, foreign, badPhone, taggedDuplicate,
            head("1 (202) 555-0122", { status: "Archived", comments: [{ authorType: "employee", createdAt: at }] }),
            head("+12025550123", { status: "Qualified", comments: [{ authorType: "employee", createdAt: null }] }),
            head("+12025550124", { comments: [{ authorType: "admin", createdAt: at }] }),
            head("+12025550125", { comments: [{ authorType: "employee", createdAt: new Date(+at - 2000) }] }),
            head("1 (202) 555-0128", { lastCallOutcomeAt: at }),
        ]);
        const evidence = async () => crypto.createHash("sha256").update(JSON.stringify(await collection.find({}).sort({ _id: 1 }).toArray())).digest("hex");
        const before = await evidence(); let query: Record<string, unknown> | undefined;
        const observe = (event: { command: { find?: string; filter?: Record<string, unknown> } }) => {
            const filter = event.command.filter;
            if (event.command.find === "leads" && Array.isArray(filter?.$and) && filter.$and.some((part: Record<string, unknown>) =>
                Array.isArray(part.$or) && part.$or.some((branch: Record<string, unknown>) => branch.lastCallOutcomeAt))) query = filter;
        };
        client.on("commandStarted", observe);
        try {
            const guard = (id: Types.ObjectId) => runWithBusiness(business.id, () => getLeadDialBlock(String(id), String(owner), ["Synthetic"]));
            const expected = [null, "LEAD_ALREADY_COMMENTED", "LEAD_ALREADY_COMMENTED", null, null, "LEAD_NOT_CALLABLE", "LEAD_NOT_ASSIGNED", "LEAD_NOT_CALLABLE", "LEAD_ALREADY_COMMENTED"];
            const targets = [clean, blocked, invalid, adminOnly, due, future, foreign, badPhone, taggedDuplicate];
            assert.deepEqual(await Promise.all(targets.map(row => guard(row._id))), expected);
            await runWithBusiness(business.id, () => Lead.createIndexes());
            assert.deepEqual(await Promise.all(targets.map(row => guard(row._id))), expected);
            const transactional = await runWithBusiness(business.id, () => mongoose.connection.transaction(async session => {
                const results = [];
                for (const target of targets) {
                    const fresh = await Lead.findById(target._id).session(session).lean(); assert.ok(fresh);
                    results.push(await getTransactionalLeadDialBlock(fresh, String(owner), ["Synthetic"], session));
                }
                return results;
            }));
            assert.deepEqual(transactional, expected, "same-transaction reuse must preserve every allow/block result");
            await guard(blocked._id); assert.ok(query);
            const stats = await collection.find(query).explain("executionStats");
            // Four saved-work entries plus the outcome index's null-exclusion range seek.
            assert.ok(stats.executionStats.totalKeysExamined <= 5, `The fresh duplicate-work guard must not scan all phone index entries: ${JSON.stringify({
                keys: stats.executionStats.totalKeysExamined, documents: stats.executionStats.totalDocsExamined, returned: stats.executionStats.nReturned,
            })}`);
            assert.equal(await evidence(), before, "Creating a lookup index must not rewrite lead records");
        } finally { client.off("commandStarted", observe); }
    }
});

test("a snapshot cannot be reused outside a live ownership transaction", async () => {
    const session = await mongoose.startSession();
    try { await assert.rejects(getTransactionalLeadDialBlock({ _id: new Types.ObjectId() }, String(new Types.ObjectId()), [], session), /TRANSACTIONAL_LEAD_SNAPSHOT_REQUIRED/); }
    finally { await session.endSession(); }
});
