import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { applyApprovedPhonePlan } from './lead-phone-cleanup.mjs';
const require = createRequire(new URL('../backend/package.json', import.meta.url));
const { MongoMemoryReplSet } = require('mongodb-memory-server');
const { MongoClient, ObjectId } = require('mongodb');
test('approved cleanup is scoped, history preserving, idempotent, and skips changed or active groups', async () => {
  const replica = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  const mongo = new MongoClient(replica.getUri()); await mongo.connect();
  try {
    const key = crypto.randomBytes(32), at = new Date('2026-10-01T00:00:00Z'), groups = [];
    const fingerprint = value => crypto.createHmac('sha256', key).update(value).digest('hex');
    const leads = mongo.db('synthetic_business').collection('leads');
    for (let i = 0; i < 4; i++) {
      const records = [0, 1].map(() => ({ _id: new ObjectId(), phone: `+1202555012${i}`, status: 'NEW', assignedAgent: null,
        assignedAgentName: '', updatedAt: at, notes: 'Synthetic retained', comments: [{ body: 'Synthetic retained comment' }],
        callLogs: [{ calledAt: at }], followUpAt: at }));
      await leads.insertMany(records);
      groups.push({ canonicalId: String(records[0]._id), phoneFingerprint: fingerprint(`synthetic:${records[0].phone}`), review: i === 3 ? ['different-owners'] : [],
        records: records.map(record => ({ id: String(record._id), status: record.status, updatedAt: at, ownerId: '', ownerNameFingerprint: fingerprint(''), assignmentRevision: 0, callingDispatchRevision: 0, followUpAt: at })) });
    }
    const planBytes = JSON.stringify({ id: 'synthetic-approved-plan', businesses: [{ id: 'synthetic', databaseName: 'synthetic_business', groups }] });
    const args = { mongo, ObjectId, planBytes, expectedHash: crypto.createHash('sha256').update(planBytes).digest('hex'), approvedCount: 3,
      key, catalog: [{ id: 'synthetic', databaseName: 'synthetic_business' }], controlDatabase: 'synthetic_control', normalizePhone: value => value };
    await leads.updateOne({ _id: new ObjectId(groups[1].canonicalId) }, { $set: { updatedAt: new Date() } });
    await mongo.db('synthetic_control').collection('callbridgeschedules').insertOne({ employeeCode: 'synthetic-owner', reservedLeadId: groups[2].canonicalId, callLeaseUntil: new Date(Date.now() + 60000) });
    const result = await applyApprovedPhonePlan(args);
    assert.equal(result.archivedCount, 1); assert.equal(result.skippedChanged, 1); assert.equal(result.skippedBusy, 1);
    const saved = await leads.findOne({ _id: new ObjectId(groups[0].records[1].id) });
    assert.equal(saved.status, 'Archived'); assert.equal(saved.notes, 'Synthetic retained'); assert.equal(saved.comments.length, 1); assert.equal(saved.callLogs.length, 1);
    assert.equal(+saved.followUpAt, +at); assert.equal(String(saved.duplicateOf), groups[0].canonicalId); assert.equal(saved.activity.length, 1);
    assert.equal((await applyApprovedPhonePlan(args)).alreadyApplied, 1);
    assert.equal(await leads.countDocuments({ status: 'Archived' }), 1);
    await assert.rejects(applyApprovedPhonePlan({ ...args, expectedHash: '0'.repeat(64) }));
    await assert.rejects(applyApprovedPhonePlan({ ...args, approvedCount: 4 }));
  } finally { await mongo.close(); await replica.stop(); }
});
