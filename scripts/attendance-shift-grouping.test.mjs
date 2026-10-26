import assert from 'node:assert/strict';
import test from 'node:test';
import { groupAttendanceRecordsBySlot } from '../src/lib/attendanceSlots.ts';

const record = (source, timeIn, extra = {}) => ({ source, timeIn, ...extra });
test('08:05 automatic checkout and returns remain on the overnight clock-in date', () => {
    for (const day of ['2026-10-15', '2026-10-17', '2026-10-31']) {
        const next = new Date(`${day}T00:00:00Z`); next.setUTCDate(next.getUTCDate() + 1);
        const end = `${next.toISOString().slice(0, 10)}T08:05:00+08:00`;
        const records = [record('Time In', `${day}T23:00:05+08:00`, { sequence: 0 }),
            record('Break Out', `${next.toISOString().slice(0, 10)}T07:45:00+08:00`, { sequence: 1 }),
            record('Break In', end, { sequence: 2, autoTimeOut: true }), record('Time Out', end, { sequence: 3, autoTimeOut: true })];
        const before = structuredClone(records), grouped = groupAttendanceRecordsBySlot([...records].reverse());
        assert.deepEqual(Object.keys(grouped), [day]);
        assert.deepEqual(grouped[day], records); assert.deepEqual(records, before);
    }
});
test('checkout closes fallback ownership; unrelated orphan activity is not attached to an old shift', () => {
    const records = [record('Time In', '2026-10-15T23:00:00+08:00'), record('Time Out', '2026-10-16T08:05:00+08:00'),
        record('Break In', '2026-10-16T12:00:00+08:00'), record('Time In', '2026-10-16T23:00:00+08:00')];
    const grouped = groupAttendanceRecordsBySlot(records);
    assert.equal(grouped['2026-10-15'].length, 2); assert.equal(grouped['2026-10-16'].length, 2);
});
test('a new time-in after 08:00 keeps its own shift, and missing time-ins are never invented', () => {
    const records = [record('Time Out', '2026-10-16T08:05:00+08:00'), record('Time In', '2026-10-16T08:06:00+08:00')];
    assert.deepEqual(Object.keys(groupAttendanceRecordsBySlot(records)), ['2026-10-16']);
    const stale = [record('Time In', '2026-10-14T23:00:00+08:00'), record('Time Out', '2026-10-16T08:05:00+08:00')];
    assert.equal(groupAttendanceRecordsBySlot(stale)['2026-10-14'].length, 1);
});
test('fresh session and derived ledger day keys take precedence over calendar grouping', () => {
    const records = [record('Time Out', '2026-10-16T08:05:00+08:00', { shiftDayKey: '2026-10-15' }),
        record('Time Out', '2026-10-17T08:05:00+08:00', { eventId: 'out', derived: { dayKey: '2026-10-16', eventIds: ['out'] } })];
    assert.deepEqual(Object.keys(groupAttendanceRecordsBySlot(records)), ['2026-10-15', '2026-10-16']);
    const stale = record('Time Out', '2026-10-17T08:05:00+08:00', { eventId: 'other', derived: { dayKey: '2026-10-16', eventIds: ['out'] } });
    assert.deepEqual(Object.keys(groupAttendanceRecordsBySlot([stale])), ['2026-10-17']);
});
test('fallback ownership expires at the next scheduled shift rather than absorbing later days', () => {
    const records = [record('Time In', '2026-10-16T07:50:00+08:00'), record('Break Out', '2026-10-16T23:05:00+08:00'),
        record('Time Out', '2026-10-17T08:05:00+08:00')];
    const grouped = groupAttendanceRecordsBySlot(records);
    assert.equal(grouped['2026-10-15'].length, 1); assert.equal(grouped['2026-10-16'].length, 1);
    assert.equal(grouped['2026-10-17'].length, 1);
});
