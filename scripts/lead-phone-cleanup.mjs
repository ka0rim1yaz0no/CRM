import crypto from 'node:crypto';

const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const stamp = value => value ? new Date(value).toISOString() : null;

// Only a fingerprinted, explicitly approved dry-run plan can authorize writes.
// Every group is rechecked in its own transaction against call dispatch fences.
export async function applyApprovedPhonePlan({ mongo, ObjectId, planBytes, expectedHash, approvedCount, key, catalog, controlDatabase, normalizePhone }) {
  if (digest(planBytes) !== expectedHash) throw new Error('PLAN_HASH_MISMATCH');
  const plan = JSON.parse(planBytes);
  const groups = plan.businesses.flatMap(b => b.groups.filter(g => !g.review.length).map(group => ({ business: b, group })));
  if (groups.reduce((sum, { group }) => sum + group.records.length - 1, 0) !== approvedCount) throw new Error('APPROVAL_COUNT_MISMATCH');
  const fingerprint = value => crypto.createHmac('sha256', key).update(value).digest('hex');
  const result = { planId: plan.id, approvedCount, archivedCount: 0, skippedChanged: 0, skippedBusy: 0, alreadyApplied: 0, businesses: [] };
  for (const business of plan.businesses) {
    if (!catalog.some(item => item.id === business.id && item.databaseName === business.databaseName)) throw new Error('BUSINESS_CATALOG_CHANGED');
    const leads = mongo.db(business.databaseName).collection('leads');
    const inventory = await leads.find({ status: { $ne: 'Archived' } }, { projection: { phone: 1 } }).toArray();
    const members = new Map();
    for (const record of inventory) {
      const phone = normalizePhone(record.phone); if (!phone) continue;
      const hash = fingerprint(`${business.id}:${phone}`), ids = members.get(hash) || [];
      ids.push(String(record._id)); members.set(hash, ids);
    }
    const summary = { businessId: business.id, archivedCount: 0, skippedChanged: 0, skippedBusy: 0, alreadyApplied: 0 };
    for (const group of business.groups.filter(item => !item.review.length)) {
      const session = mongo.startSession();
      try {
        const outcome = await session.withTransaction(async () => {
          const records = await leads.find({ _id: { $in: group.records.map(record => new ObjectId(record.id)) } }, { session,
            projection: { phone: 1, status: 1, updatedAt: 1, assignedAgent: 1, assignedAgentName: 1, assignmentRevision: 1,
              callingDispatchRevision: 1, followUpAt: 1, duplicateArchivePlan: 1 } }).toArray();
          const extraIds = group.records.filter(record => record.id !== group.canonicalId).map(record => record.id);
          if (records.length === group.records.length && records.filter(record => extraIds.includes(String(record._id))).every(record => record.status === 'Archived' && record.duplicateArchivePlan === plan.id)) return 'alreadyApplied';
          if (records.length !== group.records.length || (members.get(group.phoneFingerprint) || []).sort().join(',') !== group.records.map(record => record.id).sort().join(',')) return 'skippedChanged';
          for (const record of records) {
            const expected = group.records.find(item => item.id === String(record._id));
            const phone = normalizePhone(record.phone);
            if (!expected || !phone || fingerprint(`${business.id}:${phone}`) !== group.phoneFingerprint || record.status !== expected.status ||
                stamp(record.updatedAt) !== stamp(expected.updatedAt) || String(record.assignedAgent || '') !== expected.ownerId ||
                fingerprint(String(record.assignedAgentName || '')) !== expected.ownerNameFingerprint ||
                (record.assignmentRevision || 0) !== expected.assignmentRevision || (record.callingDispatchRevision || 0) !== expected.callingDispatchRevision ||
                stamp(record.followUpAt) !== stamp(expected.followUpAt)) return 'skippedChanged';
          }
          const now = new Date(), control = mongo.db(controlDatabase).collection('callbridgeschedules');
          const schedules = await control.find({ $or: [{ callLeaseUntil: { $gt: now } }, { dialIntentUntil: { $gt: now } }, { nextCallAllowedAt: { $gt: now } },
            { $expr: { $gt: [{ $ifNull: ['$lastCallStartedAt', new Date(0)] }, { $ifNull: ['$lastCallEndedAt', new Date(0)] }] } }] }, { session }).toArray();
          const phone = normalizePhone(records[0].phone), ids = new Set(group.records.map(record => record.id));
          if (schedules.some(slot => ids.has(String(slot.reservedLeadId || '')) || ids.has(String(slot.lastObservedLeadId || '')) ||
              (slot.reservedBusinessId === business.id && normalizePhone(slot.reservedPhone) === phone))) return 'skippedBusy';
          const canonical = records.find(record => String(record._id) === group.canonicalId);
          if (!canonical) throw new Error('CANONICAL_MISSING');
          // Dispatch writes this same revision in its transaction. Either it wins
          // and the retry skips a busy group, or it sees the archived extra.
          await leads.updateOne({ _id: canonical._id }, { $inc: { callingDispatchRevision: 1 } }, { session });
          for (const record of records.filter(item => String(item._id) !== group.canonicalId)) {
            await leads.updateOne({ _id: record._id, status: record.status }, {
              $set: { status: 'Archived', duplicateOf: canonical._id, duplicateArchivedAt: now, duplicateArchivePlan: plan.id, updatedAt: now },
              $unset: { activePhoneKey: '' }, $inc: { callingDispatchRevision: 1 },
              $push: { activity: { label: 'Duplicate telephone archived', detail: `Approved phone duplicate cleanup (${plan.id}); original ownership and history retained.`,
                status: 'Done', actorName: 'System', actorType: 'system', createdAt: now } },
            }, { session });
          }
          return 'archivedCount';
        }, { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' }, maxCommitTimeMS: 10000 });
        const count = group.records.length - 1;
        if (outcome) { summary[outcome] += count; result[outcome] += count; }
      } finally { await session.endSession(); }
    }
    result.businesses.push(summary);
  }
  return result;
}
