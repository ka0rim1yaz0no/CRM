import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { after, before, beforeEach, test } from 'node:test';
import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import type { SessionEvent } from './attendanceSessionState';

const prefix = `replica_review_${crypto.randomUUID().replaceAll('-', '')}`;
process.env.NODE_ENV = 'test';
process.env.CRM_PAYROLL_ACCURACY = 'true';
process.env.CRM_ATTENDANCE_DURATION_MODEL = 'true';
process.env.CRM_ATTENDANCE_ACCURACY_FIXES = 'true';
process.env.CRM_ATTENDANCE_BREAK_GAP = 'false';
process.env.DEFAULT_BUSINESS_ID = 'replica-a';
process.env.DEFAULT_BUSINESS_DATABASE = `${prefix}_a`;
process.env.CONTROL_DATABASE_NAME = `${prefix}_control`;
process.env.BUSINESS_DATABASES = JSON.stringify(['a', 'b'].map(id => ({ id: `replica-${id}`, name: `Synthetic ${id}`, databaseName: `${prefix}_${id}` })));
const { Employee } = await import('../models/Employee');
const { Attendance } = await import('../models/Attendance');
const { AttendanceLedger, AttendancePolicy } = await import('../models/AttendanceLedger');
const { PayrollRecord } = await import('../models/Payroll');
const { SystemSettings } = await import('../models/SystemSettings');
const { attendancePayrollDtr } = await import('../controllers/payrollController');
const { runWithBusiness, getConfiguredBusinesses } = await import('../config/tenancy');
const { assignAttendanceShift } = await import('./attendanceShift');
const { withReadSnapshot } = await import('./readSnapshot');
const period = 'Oct 6, 2026 - Oct 6, 2026', start = Date.parse('2026-10-06T15:00:00Z');
const codes = ['replica-a', 'replica-b'];
let mongo: MongoMemoryReplSet;
let ids: mongoose.Types.ObjectId[] = [];
let events: SessionEvent[] = [];
before(async () => {
    mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    const uri = mongo.getUri(prefix);
    assert.match(uri, /^mongodb:\/\/127\.0\.0\.1:/);
    await mongoose.connect(uri);
    assert.ok(getConfiguredBusinesses().every(business => business.databaseName.startsWith(prefix)));
});
after(async () => { await mongoose.disconnect(); await mongo?.stop(); });
beforeEach(async () => {
    ids = [];
    await AttendanceLedger.deleteMany({}); await AttendancePolicy.deleteMany({});
    await AttendancePolicy.create({ _id: 'global-attendance', shiftStart: '23:00', shiftEnd: '08:00', graceMinutes: 0, breakMinutes: 15, lunchMinutes: 60, revision: 1 });
    events = [
        { id: 'in', commandId: 'in', source: 'Time In', at: new Date(start).toISOString(), sequence: 0, recordedAt: new Date(start).toISOString(), shift: assignAttendanceShift(new Date(start)) },
        { id: 'out', commandId: 'out', source: 'Time Out', at: new Date(start + 9 * 3600000).toISOString(), sequence: 1, recordedAt: new Date(start + 9 * 3600000).toISOString() },
        { id: 'legacy-return', commandId: 'legacy-return', source: 'Break In', at: new Date(start + 9 * 3600000 + 1).toISOString(), sequence: 2, recordedAt: new Date(start + 9 * 3600000 + 1).toISOString(), legacyReviewed: true }
    ];
    for (const business of codes) await runWithBusiness(business, async () => {
        await Employee.deleteMany({}); await Attendance.deleteMany({}); await PayrollRecord.deleteMany({}); await SystemSettings.deleteMany({});
        await SystemSettings.create({ key: 'system', officialShiftStartTime: '23:00', officialShiftEndTime: '08:00' });
        const employee = await Employee.create({ employeeCode: 'synthetic-replica', name: 'Synthetic Evidence Employee', status: 'Active' }); ids.push(employee._id);
        await Attendance.insertMany(events.map(event => ({ employee: employee._id, eventId: event.id, source: event.source, timeIn: new Date(event.at), sequence: event.sequence, isArchived: false, isEffective: true })));
        await PayrollRecord.create({ employeeName: employee.name, employeeId: employee.employeeCode, department: 'Synthetic', payType: 'Semi-monthly', payPeriod: period, grossPay: 15000, deductions: 50, netPay: 14950, status: 'Paid', paidOn: 'Oct 10, 2026' });
    });
    await AttendanceLedger.create({ _id: 'synthetic-evidence', employeeCode: 'synthetic-replica', businessIds: codes, canonicalBusinessId: codes[0], revision: 1, events, corrections: [], closures: [], jobs: [] });
});
async function dtr(index: number) {
    return withReadSnapshot(new Date('2026-10-08T00:00:00Z'), () => runWithBusiness(codes[index], () => attendancePayrollDtr(ids[index], period)));
}
test('synchronized preserved legacy evidence no longer creates false review in either business, with original pay and punches untouched', async () => {
    for (let index = 0; index < codes.length; index++) {
        const before = await runWithBusiness(codes[index], async () => ({ payroll: await PayrollRecord.find({}).lean(), attendance: await Attendance.find({}).lean() }));
        const result = await dtr(index);
        assert.equal(result.rows[0].status, 'Present'); assert.equal(result.summary.incompleteShiftDays, 0); assert.equal(result.summary.deductibleMinutes, 0);
        const after = await runWithBusiness(codes[index], async () => ({ payroll: await PayrollRecord.find({}).lean(), attendance: await Attendance.find({}).lean() }));
        assert.deepEqual(after, before);
    }
});
test('a genuine missing or modified copy still requires review across both businesses', async () => {
    await runWithBusiness(codes[1], () => Attendance.deleteOne({ eventId: 'out' }));
    for (let index = 0; index < codes.length; index++) assert.equal((await dtr(index)).summary.incompleteShiftDays, 1);
});
test('reversed legacy evidence is not required in active business copies', async () => {
    await AttendanceLedger.updateOne({ _id: 'synthetic-evidence' }, { $set: { corrections: [{ commandId: 'undo', targets: ['legacy-return'], actor: 'synthetic-admin', reason: 'Synthetic reversal', at: '2026-10-07T02:00:00Z' }] } });
    for (const business of codes) await runWithBusiness(business, () => Attendance.updateOne({ eventId: 'legacy-return' }, { $set: { isEffective: false } }));
    for (let index = 0; index < codes.length; index++) assert.equal((await dtr(index)).summary.incompleteShiftDays, 0);
});
