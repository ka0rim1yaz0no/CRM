import assert from 'node:assert/strict';
import { test } from 'node:test';
import { knownCallingQueueDependencies, restoreCallingQueueDependencies } from '../src/lib/callingQueueResponse.ts';

const scope = { employeeId: 'synthetic-owner', businessId: 'synthetic-business' };
const page = () => ({ leads: [{ _id: 'fresh' }], callingQueue: { scope: { ...scope, employeeCode: 'synthetic-code' },
    refreshDependencies: { version: 1, leadIds: ['own','hidden'], phones: ['+12025550100'] },
    refreshDependenciesFingerprint: 'a'.repeat(64), version: 'old', serverTime: '2026-10-31T00:00:00Z', nextLeadId: 'own', entries: [] } });

test('six business scopes restore only proven dependency metadata, never previous decisions or clocks', () => {
    for (let business = 0; business < 6; business++) {
        const current = { ...scope, businessId: 'synthetic-' + business }, previous = page(); previous.callingQueue.scope.businessId = current.businessId;
        const before = JSON.stringify(previous), incoming = { ...page(), leads: [{_id:'new'}], callingQueue: { ...previous.callingQueue,
            version:'new', serverTime:'2026-10-31T00:00:01Z', nextLeadId:'new', entries:[{leadId:'new',callable:false}],
            refreshDependencies:undefined, refreshDependenciesUnchanged:true } };
        const restored = restoreCallingQueueDependencies(current, previous, incoming);
        assert.equal(restored.callingQueue.refreshDependencies, previous.callingQueue.refreshDependencies);
        assert.equal(restored.callingQueue.entries, incoming.callingQueue.entries); assert.equal(restored.leads, incoming.leads);
        assert.equal(restored.callingQueue.version,'new'); assert.equal(restored.callingQueue.serverTime,incoming.callingQueue.serverTime);
        assert.equal(JSON.stringify(previous),before);
    }
});

test('wrong scope, missing baseline, invalid fingerprints and unexpected metadata never reuse cached data', () => {
    const previous=page(), reduced={...page(),callingQueue:{...page().callingQueue,refreshDependencies:undefined,refreshDependenciesUnchanged:true}};
    for (const cached of [undefined, {}, {...previous,callingQueue:{...previous.callingQueue,scope:{...scope,employeeId:'other'}}},
        {...previous,callingQueue:{...previous.callingQueue,refreshDependenciesFingerprint:'b'.repeat(64)}},
        {...previous,callingQueue:{...previous.callingQueue,refreshDependencies:undefined}}])
        assert.throws(()=>restoreCallingQueueDependencies(scope,cached,reduced));
    assert.throws(()=>restoreCallingQueueDependencies({...scope,businessId:'other'},previous,reduced));
    assert.throws(()=>restoreCallingQueueDependencies(scope,previous,{...reduced,callingQueue:{...reduced.callingQueue,refreshDependencies:previous.callingQueue.refreshDependencies}}));
    assert.equal(knownCallingQueueDependencies(scope,{...previous,callingQueue:{...previous.callingQueue,refreshDependenciesFingerprint:'invalid'}}),undefined);
    const legacy=page();delete legacy.callingQueue.refreshDependenciesFingerprint;assert.equal(restoreCallingQueueDependencies(scope,undefined,legacy),legacy);
});
