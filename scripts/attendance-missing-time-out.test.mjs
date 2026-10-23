import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { attendanceInputValue, buildAttendanceDraftChanges } from '../src/lib/attendanceCommandDraft.ts';
const source = readFileSync(new URL('../src/lib/attendanceMissingTimeOut.ts', import.meta.url), 'utf8');
const exports = {};
runInNewContext(ts.transpileModule(source.replace(/^import .*;\r?\n/gm, ''), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText,
    { exports, attendanceInputValue, buildAttendanceDraftChanges });
const { missingTimeOutSessions, missingTimeOutDraft, missingTimeOutChanges } = exports;
const day = '2026-10-22';
const event = (source, at, id = source) => ({ id, source, at, commandId: id, sequence: 0 });
const session = { id: 'old', startedAt: `${day}T15:00:00Z`, endedAt: null, lifecycle: 'open',
    shift: { dayKey: day, start: `${day}T15:00:00Z`, end: '2026-10-23T00:00:00Z' }, events: [event('Time In', `${day}T15:00:00Z`)] };
const snapshot = (sessions = [session]) => ({ sessions, serverTime: '2026-10-23T01:00:00Z' });
test('missing checkout uses server-assigned overnight shift end, never browser time or a hardcoded schedule', () => {
    assert.equal(missingTimeOutDraft(snapshot(), day, 'old').value, '2026-10-23T08:00:00');
    const custom = { ...session, shift: { ...session.shift, end: '2026-10-22T22:00:00Z' } };
    assert.equal(missingTimeOutDraft(snapshot([custom]), day, 'old').value, '2026-10-23T06:00:00');
    assert.equal(missingTimeOutSessions(snapshot(), '2026-10-21').length, 0);
});
test('existing manual, automatic and legacy checkouts are not offered as missing', () => {
    for (const source of ['Time Out', 'Logout']) {
        const closed = { ...session, events: [...session.events, event(source, '2026-10-23T00:00:00Z')] };
        assert.equal(missingTimeOutSessions(snapshot([closed]), day).length, 0);
        assert.throws(() => missingTimeOutChanges(snapshot([closed]), day, 'old', '2026-10-23T08:00:00', false), /already has a Time Out/);
    }
});
test('unclosed rests require explicit approval and one atomic reviewed correction', () => {
    for (const [out, incoming] of [['Break Out', 'Break In'], ['Lunch Break Out', 'Lunch Break In'], ['Off the Phone Out', 'Off the Phone In']]) {
        const open = snapshot([{ ...session, events: [...session.events, event(out, `${day}T23:30:00Z`)] }]);
        assert.throws(() => missingTimeOutChanges(open, day, 'old', '2026-10-23T08:00:00', false), /Confirm closing/);
        const changes = missingTimeOutChanges(open, day, 'old', '2026-10-23T08:00:00', true);
        assert.deepEqual(Array.from(changes, item => [item.source, item.at]), [[incoming, '2026-10-23T00:00:00.000Z'], ['Time Out', '2026-10-23T00:00:00.000Z']]);
    }
});
test('historical repair cannot consume a newer session, future timestamp or earlier activity', () => {
    const current = { ...session, id: 'current', startedAt: '2026-10-23T00:30:00Z', shift: { ...session.shift, dayKey: '2026-10-23' } };
    const data = snapshot([session, current]);
    assert.throws(() => missingTimeOutChanges(data, day, 'old', '2026-10-23T08:30:00', false), /before the next session/);
    assert.throws(() => missingTimeOutChanges(data, day, 'old', '2026-10-23T10:00:00', false), /future/);
    assert.throws(() => missingTimeOutChanges(data, day, 'old', '2026-10-22T22:59:00', false), /last action/);
    assert.equal(missingTimeOutChanges(data, day, 'old', '2026-10-23T08:00:00', false).length, 1);
    const active = { ...snapshot(), serverTime: `${day}T18:00:00Z` };
    assert.equal(missingTimeOutDraft(active, day, 'old').value, '2026-10-23T02:00:00');
});
