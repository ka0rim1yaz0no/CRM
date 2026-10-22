import { performance } from 'node:perf_hooks';
import { setTimeout as sleep } from 'node:timers/promises';
import { isDeepStrictEqual } from 'node:util';

function failure(code) { return Object.assign(new Error(code), { code }); }

export function assertSourceUnchanged(expected, current) {
  const valid = value => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length > 0 &&
    Object.values(value).every(rows => Array.isArray(rows) && rows.every(row => typeof row.collection === 'string' &&
      Number.isSafeInteger(row.count) && row.count >= 0 && /^[a-f0-9]{64}$/.test(row.sha256)));
  if (!valid(expected) || !valid(current) || !isDeepStrictEqual(expected, current)) throw failure('SOURCE_CHANGED_SINCE_COPY');
}

export async function waitForAttendanceDelivery({ read, now = () => performance.now(),
  wait = ms => sleep(ms), pollMs = 1_000, timeoutMs = 600_000, stallMs = 120_000 }) {
  if (![pollMs, timeoutMs, stallMs].every(value => Number.isSafeInteger(value) && value > 0)) throw failure('INVALID_READINESS_LIMIT');
  const started = now(); let lastProgress = started; let lowest = Infinity; let samples = 0;
  for (;;) {
    const pending = await read(); const sampledAt = now(); samples++;
    if (!Number.isSafeInteger(pending) || pending < 0 || sampledAt < started || !Number.isFinite(sampledAt)) throw failure('INVALID_SYNC_SNAPSHOT');
    if (sampledAt - started >= timeoutMs) throw failure('SYNC_READINESS_TIMEOUT');
    if (!pending) return { pending: 0, samples, elapsedMs: sampledAt - started };
    if (pending < lowest) { lowest = pending; lastProgress = sampledAt; }
    if (sampledAt - lastProgress >= stallMs) throw failure('SYNC_READINESS_STALLED');
    await wait(Math.min(pollMs, timeoutMs - (sampledAt - started), stallMs - (sampledAt - lastProgress)));
  }
}

export function mayRestoreSourceDatabase({ publicExposureStarted }) {
  // Unknown state fails closed: accepting a write makes the new database authoritative.
  return publicExposureStarted === false;
}

export function shouldResumeSourceProcess({ publicExposureStarted, sourceWasPaused, sourceStatus }) {
  return mayRestoreSourceDatabase({ publicExposureStarted }) && sourceWasPaused === true && sourceStatus === 'stopped';
}
