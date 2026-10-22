import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertSourceUnchanged, mayRestoreSourceDatabase, shouldResumeSourceProcess, waitForAttendanceDelivery } from './attendance-rollout-guard.mjs';

const snapshot = () => ({ fake_root: [{ collection: 'fake_punches', count: 2, sha256: 'a'.repeat(64) }], fake_business: [] });
const clock = () => { let ms = 0; return { now: () => ms, wait: async delta => { ms += delta; } }; };

test('rollout: bounded worker progress beyond forty seconds can finish without skipping a pending business', async () => {
  const timer = clock(); let reads = 0;
  const result = await waitForAttendanceDelivery({ ...timer, pollMs: 15_000, read: async () => Math.max(0, 6 - reads++) });
  assert.equal(result.pending, 0); assert.equal(result.elapsedMs, 90_000); assert.equal(reads, 7);
});

test('rollout: persistent or oscillating pending work fails closed instead of declaring readiness', async () => {
  await assert.rejects(waitForAttendanceDelivery({ ...clock(), pollMs: 10, stallMs: 30, timeoutMs: 100, read: async () => 1 }), { code: 'SYNC_READINESS_STALLED' });
  let reads = 0;
  await assert.rejects(waitForAttendanceDelivery({ ...clock(), pollMs: 10, stallMs: 30, timeoutMs: 100, read: async () => 1 + (reads++ % 2) }), { code: 'SYNC_READINESS_STALLED' });
});

test('rollout: overall deadline remains bounded even while deliveries make progress', async () => {
  let pending = 100;
  await assert.rejects(waitForAttendanceDelivery({ ...clock(), pollMs: 10, stallMs: 50, timeoutMs: 30, read: async () => pending-- }), { code: 'SYNC_READINESS_TIMEOUT' });
});

test('rollout: invalid snapshots, unknown counts and failed database reads cannot pass readiness', async () => {
  for (const pending of [undefined, null, NaN, Infinity, -1, 0.5, '0']) {
    await assert.rejects(waitForAttendanceDelivery({ ...clock(), read: async () => pending }), { code: 'INVALID_SYNC_SNAPSHOT' });
  }
  await assert.rejects(waitForAttendanceDelivery({ ...clock(), read: async () => { throw new Error('Synthetic unavailable database'); } }), /Synthetic unavailable/);
  assert.equal((await waitForAttendanceDelivery({ ...clock(), read: async () => 0 })).samples, 1);
});

test('rollout: new, changed or deleted records and collections invalidate the reviewed source copy', () => {
  assert.doesNotThrow(() => assertSourceUnchanged(snapshot(), structuredClone(snapshot())));
  for (const edit of [value => { value.fake_root[0].count++; }, value => { value.fake_root[0].sha256 = 'b'.repeat(64); },
    value => { value.fake_root = []; }, value => { delete value.fake_business; }, value => { value.fake_business.push({ collection: 'new_fake_collection', count: 0, sha256: 'c'.repeat(64) }); }]) {
    const current = snapshot(); edit(current);
    assert.throws(() => assertSourceUnchanged(snapshot(), current), { code: 'SOURCE_CHANGED_SINCE_COPY' });
  }
  assert.throws(() => assertSourceUnchanged({}, {}), { code: 'SOURCE_CHANGED_SINCE_COPY' });
});

test('rollout: old database rollback is forbidden from the moment public exposure might start', () => {
  assert.equal(mayRestoreSourceDatabase({ publicExposureStarted: false }), true);
  for (const publicExposureStarted of [true, undefined, null, 'false']) assert.equal(mayRestoreSourceDatabase({ publicExposureStarted }), false);
});

test('rollout: failed preflight never restarts an online call API or changes an unknown process state', () => {
  assert.equal(shouldResumeSourceProcess({ publicExposureStarted: false, sourceWasPaused: true, sourceStatus: 'stopped' }), true);
  for (const sourceStatus of ['online', 'launching', 'errored', undefined]) {
    assert.equal(shouldResumeSourceProcess({ publicExposureStarted: false, sourceWasPaused: true, sourceStatus }), false);
  }
  assert.equal(shouldResumeSourceProcess({ publicExposureStarted: false, sourceWasPaused: false, sourceStatus: 'stopped' }), false);
  assert.equal(shouldResumeSourceProcess({ publicExposureStarted: true, sourceWasPaused: true, sourceStatus: 'stopped' }), false);
});
