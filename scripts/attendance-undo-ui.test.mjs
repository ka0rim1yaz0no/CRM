import assert from 'node:assert/strict';
import { test } from 'node:test';
import { attendanceCorrectionError, attendanceEventsForDay, attendanceUndoAvailability, attendanceUndoPlan } from '../src/lib/attendanceUndo.ts';

const event = (id, source, commandId = id) => ({ id, source, commandId, at: '2026-10-22T18:00:00.000Z', sequence: 0 });
function snapshot(records) {
  return { records, serverTime: '2026-10-22T19:00:00Z', audit: [...new Set(records.map(item => item.commandId))].map(commandId => ({ commandId, operation: 'action', actor: { role: 'employee', code: 'synthetic' } })),
    sessions: [{ id: 'synthetic-session', lifecycle: 'open', shift: { dayKey: '2026-10-22', resetDeadline: '2026-10-23T14:59:00Z' }, events: records }] };
}
test('latest manual action supports both last-action and row Undo without retargeting another shift', () => {
  const records = [event('in', 'Time In'), event('out', 'Break Out'), event('back', 'Break In')], data = snapshot(records);
  assert.equal(attendanceUndoAvailability(data, attendanceEventsForDay(data, '2026-10-22').at(-1), '2026-10-22').allowed, true);
  assert.equal(attendanceUndoAvailability(data, records[2], '2026-10-22').allowed, true);
  assert.equal(attendanceUndoAvailability(data, records[1], '2026-10-22').allowed, true);
  const newer = event('newer', 'Lunch Break Out'); data.records.push(newer);
  data.sessions.push({ id: 'synthetic-newer', lifecycle: 'open', shift: { dayKey: '2026-10-23', resetDeadline: '2026-10-24T14:59:00Z' }, events: [newer] });
  // Keep the displayed historical session independent of the newer shift.
  data.sessions[0].events = records.slice(0, 3);
  const selected = attendanceEventsForDay(data, '2026-10-22').at(-1);
  assert.equal(selected.id, 'back'); assert.equal(attendanceUndoAvailability(data, selected, '2026-10-22').allowed, true);
});

test('earlier completed break/lunch can be reversed as one reviewed pair without touching newer events', () => {
  for (const [out, back] of [['Break Out','Break In'], ['Lunch Break Out','Lunch Break In'], ['Off the Phone Out','Off the Phone In'], ['Coaching Out','Coaching In']]) {
    const records = [event('in','Time In'),event('out',out),event('back',back),event('later','Time Out')], data = snapshot(records);
    for (const target of records.slice(1,3)) {
      const plan = attendanceUndoPlan(data, target, '2026-10-22');
      assert.equal(plan.paired,true); assert.deepEqual(plan.events.map(event => event.id), ['out','back']);
      assert.equal(data.records.length,4, 'planning must not mutate evidence');
    }
  }
});

test('latest return can still be undone alone; a paired correction cannot split an atomic checkout', () => {
  const records = [event('in','Time In'),event('out','Break Out'),event('back','Break In')], data = snapshot(records);
  assert.deepEqual(attendanceUndoPlan(data,records[2]).events.map(event => event.id), ['back']);
  assert.equal(attendanceUndoPlan(data,records[2]).paired,false);
  const atomic = snapshot([event('in','Time In'),event('away','Off the Phone Out'),event('back','Off the Phone In','checkout'),event('end','Time Out','checkout')]);
  assert.equal(attendanceUndoPlan(atomic,atomic.records[1]).paired,false);
});
test('lunch and atomic off-phone checkout undo keep their explicit command group', () => {
  const lunch = event('lunch', 'Lunch Break Out'); assert.equal(attendanceUndoAvailability(snapshot([event('in','Time In'), lunch]), lunch).allowed, true);
  const returned = event('return', 'Off the Phone In', 'checkout'), out = event('out', 'Time Out', 'checkout'), data = snapshot([event('in','Time In'),returned,out]);
  assert.equal(attendanceUndoAvailability(data, returned).allowed, true); assert.equal(attendanceUndoAvailability(data, out).allowed, true);
});
test('automatic, imported, corrected, removed, cross-shift and system-closed records never advertise a simple Undo', () => {
  const target = event('out','Time Out'), data = snapshot([target]);
  for (const mutate of [
    d => { d.audit = []; }, d => { d.audit[0].operation = 'correct'; }, d => { d.audit[0].actor.role = 'system'; },
    d => { d.records[0].autoTimeOut = true; }, d => { d.sessions[0].lifecycle = 'system-closed'; }, d => { d.records = []; },
  ]) { const copy = structuredClone(data); mutate(copy); assert.equal(attendanceUndoAvailability(copy, target).allowed, false); }
  const other = event('other','Time In','out'); data.records.push(other);
  data.sessions[0].events = [target]; data.sessions.push({ shift: { dayKey: '2026-10-23' }, events: [other] });
  assert.equal(attendanceUndoAvailability(data, target, '2026-10-22').allowed, false);
});
test('checkout undo window uses server time; earlier rest pairs remain reviewable without reopening an old shift', () => {
  const target = event('out','Time Out'), data = snapshot([target]);
  data.serverTime = '2026-10-23T14:58:59.999Z'; assert.equal(attendanceUndoAvailability(data, target).allowed, true);
  data.serverTime = '2026-10-23T14:59:00.000Z'; assert.equal(attendanceUndoAvailability(data, target).allowed, false);
  const earlier = snapshot([event('in','Time In'),event('rest','Break Out'),event('return','Break In'),event('end','Time Out')]);
  earlier.serverTime = '2026-10-24T20:00:00Z';
  assert.equal(attendanceUndoPlan(earlier,earlier.records[1]).paired,true);
});
test('validation messages include actionable dependency details without exposing event IDs', () => {
  const text = attendanceCorrectionError({ response: { data: { message: 'The resulting timeline is invalid.', details: [
    { eventId: 'private-event-id', message: 'No open BREAK matches this return.' }, { message: 'No open BREAK matches this return.' }, { message: 5 },
  ] } } });
  assert.equal(text, 'The resulting timeline is invalid. No open BREAK matches this return.'); assert.ok(!text.includes('private-event-id'));
});

test('both Undo entry points preserve the entire reviewed Add Time Out command for server restoration', () => {
  const back=event('returned','Lunch Break In','checkout'),out=event('checkout','Time Out','checkout'),data=snapshot([event('in','Time In'),back,out]);
  data.audit.find(row=>row.commandId==='checkout').operation='add-time-out';
  data.audit.find(row=>row.commandId==='checkout').actor.role='admin';
  data.serverTime='2026-10-25T18:00:00Z';
  for(const target of [attendanceEventsForDay(data,'2026-10-22').at(-1),back,out]){
    assert.equal(attendanceUndoAvailability(data,target,'2026-10-22').allowed,true);
    const plan=attendanceUndoPlan(data,target,'2026-10-22');assert.equal(plan.paired,false);
    assert.deepEqual(plan.events.map(row=>row.id),['returned','checkout']);
  }
});
