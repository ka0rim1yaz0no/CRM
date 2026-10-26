import assert from 'node:assert/strict';
import { test } from 'node:test';
import { payrollReplicaMismatchDays } from './payrollReplicaEvidence';
const day = '2026-10-06', next = '2026-10-07', at = new Date('2026-10-06T15:00:00.000Z');
const event = (eventId: string, source: string, offset = 0, dayKey = day) => ({ eventId, source, timeIn: new Date(+at + offset), dayKey });
test('full synchronized evidence does not mismatch when accepted sessions omit preserved legacy events', () => {
    const full = [event('start', 'Time In'), event('legacy-start', 'Time In', 1000), event('end', 'Time Out', 9 * 3600000), event('orphan-return', 'Break In', 9 * 3600000 + 1000)];
    assert.deepEqual(payrollReplicaMismatchDays(full, [...full].reverse(), [day], () => day), []);
});
test('missing, extra, changed and duplicated punches still block the affected day', () => {
    const full = [event('start', 'Time In'), event('end', 'Time Out', 9 * 3600000)];
    for (const copies of [full.slice(0, 1), [...full, event('extra', 'Break Out', 2000)], [full[0], { ...full[1], timeIn: new Date(+full[1].timeIn + 1000) }], [...full, full[0]]]) {
        assert.deepEqual(payrollReplicaMismatchDays(full, copies, [day], () => day), [day]);
    }
});
test('ledger event identity preserves the assigned shift after midnight without changing accounting', () => {
    const full = [event('start', 'Time In'), event('end', 'Time Out', 9 * 3600000)];
    assert.deepEqual(payrollReplicaMismatchDays(full, full, [day, next], () => next), []);
    assert.deepEqual(payrollReplicaMismatchDays(full, full.slice(0, 1), [day, next], () => next), [day]);
});
test('out-of-cutoff activity is ignored and anonymous legacy copies are checked by their shift day', () => {
    const full = [event('one', 'Time In'), event('other-cutoff', 'Time In', 86400000, next)];
    const anonymous = [{ source: 'Time In', timeIn: at }];
    assert.deepEqual(payrollReplicaMismatchDays(full, anonymous, [day], () => day), []);
    assert.deepEqual(payrollReplicaMismatchDays(full, [], [day], () => day), [day]);
});
