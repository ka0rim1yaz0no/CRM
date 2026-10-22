import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import ts from 'typescript';
import { attendanceRecordStatus, isAttendanceTimeOutUndertime } from '../src/lib/attendanceSlots.ts';

const record = (clock, source = 'Time Out', attendanceStatus = 'Undertime') => ({
  source, attendanceStatus, timeIn: `2026-10-22T${clock}+08:00`,
});

test('a stale saved Undertime label cannot mark an 08:00 or later checkout early', () => {
  for (const clock of ['08:00:00', '08:05:00', '12:00:00']) {
    const value = record(clock), before = structuredClone(value);
    assert.equal(isAttendanceTimeOutUndertime(value), false, clock);
    assert.equal(attendanceRecordStatus(value), '', clock);
    assert.deepEqual(value, before);
  }
});

test('only checkout events before the configured overnight end can be undertime', () => {
  for (const clock of ['00:00:00', '03:00:00', '07:59:59']) assert.equal(isAttendanceTimeOutUndertime(record(clock, 'Time Out', '')), true);
  for (const source of ['Time In', 'Break Out', 'Break In', 'Lunch Break Out', 'Lunch Break In', 'Off the Phone Out', 'Off the Phone In']) {
    assert.equal(isAttendanceTimeOutUndertime(record('07:00:00', source)), false, source);
    assert.equal(attendanceRecordStatus(record('07:00:00', source)), '', source);
  }
  assert.equal(isAttendanceTimeOutUndertime(record('08:30:00'), { officialShiftEndTime: '09:00' }), true);
  assert.equal(isAttendanceTimeOutUndertime(record('09:00:00'), { officialShiftEndTime: '09:00' }), false);
  assert.equal(isAttendanceTimeOutUndertime({ ...record('07:00:00'), timeIn: 'invalid' }), false);
  assert.equal(attendanceRecordStatus(record('07:00:00', 'Time Out', '')), 'Undertime');
  assert.equal(attendanceRecordStatus(record('00:12:00', 'Time In', 'Late')), 'Late');
});

test('attendance and employee profile rows share the corrected status helper', () => {
  for (const file of ['src/pages/attendance/index.tsx', 'src/pages/admin/employees/index.tsx']) {
    const source = ts.createSourceFile(file, fs.readFileSync(new URL(`../${file}`, import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const expressions = [];
    const visit = node => {
      if (ts.isVariableDeclaration(node) && node.name.getText(source) === 'displayedAttendanceStatus') expressions.push(node.initializer?.getText(source));
      ts.forEachChild(node, visit);
    };
    visit(source);
    assert.equal(expressions.length, 1, file);
    assert.match(expressions[0], /^attendanceRecordStatus\(/, file);
  }
});
