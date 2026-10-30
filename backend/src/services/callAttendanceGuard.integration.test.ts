import assert from "node:assert/strict";
import crypto from "node:crypto";
import {after, before, test} from "node:test";
import mongoose from "mongoose";
import {MongoMemoryReplSet} from "mongodb-memory-server";
import type {AttendanceSource} from "../models/Attendance";

const prefix = `dial_attendance_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
const businesses = Array.from({length: 6}, (_, index) => ({id: `dial-${index}`, databaseName: `${prefix}_${index}`}));
Object.assign(process.env, {NODE_ENV: "test", CRM_ATTENDANCE_INTEGRITY: "true", DEFAULT_BUSINESS_ID: businesses[0].id,
    DEFAULT_BUSINESS_DATABASE: businesses[0].databaseName, CONTROL_DATABASE_NAME: `${prefix}_control`, BUSINESS_DATABASES: JSON.stringify(businesses)});
const {runWithBusiness} = await import("../config/tenancy");
const {Employee} = await import("../models/Employee");
const {AttendanceLedger} = await import("../models/AttendanceLedger");
const {setBusinessAccessForEmployeeCode, getAttendanceBusinessIdentity} = await import("../models/BusinessUserAccess");
const {attendanceAllowsCall} = await import("./callAttendanceGuard");
const code = "91000888", people: Array<{_id: mongoose.Types.ObjectId; employeeCode: string; availabilityStatus: string}> = [];
let mongo: MongoMemoryReplSet, key = "";
const start = "2026-10-28T15:00:00.000Z";
const timeIn = {id: "in", source: "Time In" as const, at: start, recordedAt: start, commandId: "fixture", sequence: 1};
before(async () => {
    mongo = await MongoMemoryReplSet.create({replSet: {count: 1}});
    await mongoose.connect(mongo.getUri(prefix), {autoIndex: false, autoCreate: false});
    for (const business of businesses) await runWithBusiness(business.id, async () => {
        const employee = await Employee.create({employeeCode: code, name: "Synthetic Sales", role: "Sales Agent", availabilityStatus: "ONLINE"});
        people.push({_id: employee._id, employeeCode: code, availabilityStatus: "ONLINE"});
        await mongoose.connection.getClient().db(business.databaseName).collection("payrollrecords").insertOne({status: "Paid", netPay: 99, paidOn: new Date("2026-10-21")});
    });
    await setBusinessAccessForEmployeeCode(code, businesses.map(row => row.id));
    key = `access:${(await getAttendanceBusinessIdentity(code))!.id}`;
    await AttendanceLedger.create({_id: key, employeeCode: code, canonicalBusinessId: businesses[0].id, businessIds: businesses.map(row => row.id),
        revision: 1, fence: 0, events: [timeIn], corrections: [], closures: [], audit: [], commands: [], jobs: []});
});
after(async () => {await mongoose.disconnect(); await mongo?.stop();});

test("canonical rest and checkout states block stale ONLINE business projections in all six businesses", async () => {
    for (const source of ["Off the Phone Out", "Non-Billable Off the Phone Out", "Coaching Out", "Break Out", "Lunch Break Out", "Time Out"] as AttendanceSource[]) {
        await AttendanceLedger.updateOne({_id: key}, {$set: {events: [timeIn, {id: "pause", source, at: "2026-10-28T16:00:00.000Z", recordedAt: "2026-10-28T16:00:00.000Z", commandId: "pause", sequence: 2}]}});
        for (const [index, business] of businesses.entries()) {
            assert.equal(await runWithBusiness(business.id, () => attendanceAllowsCall(people[index])), false, source);
            assert.equal((await runWithBusiness(business.id, () => Employee.findById(people[index]._id).lean()))?.availabilityStatus, "ONLINE", "guard does not rewrite a projection to hide lag");
        }
    }
});

test("pending attendance locks block dispatch; a transactional fence preserves punches and paid payroll", async () => {
    await AttendanceLedger.updateOne({_id: key}, {$set: {events: [timeIn], lockUntil: new Date(Date.now() + 60000)}});
    assert.equal(await runWithBusiness(businesses[0].id, () => attendanceAllowsCall(people[0])), false);
    await AttendanceLedger.updateOne({_id: key}, {$set: {lockUntil: null}});
    const before = await AttendanceLedger.findById(key).lean(); assert.ok(before);
    for (const [index, business] of businesses.entries()) {
        const allowed = await runWithBusiness(business.id, () => mongoose.connection.transaction(session => attendanceAllowsCall(people[index], session)));
        assert.equal(allowed, true);
        const paid = await mongoose.connection.getClient().db(business.databaseName).collection("payrollrecords").findOne({});
        assert.equal(paid?.status, "Paid"); assert.equal(paid?.netPay, 99);
    }
    const after = await AttendanceLedger.findById(key).lean(); assert.ok(after);
    for (const field of ["events", "corrections", "closures", "revision", "audit", "commands", "jobs"] as const) assert.deepEqual(after[field], before[field]);
    assert.equal(after.fence, before.fence + 6);
});

test("missing canonical attendance fails closed instead of trusting an old ONLINE employee copy", async () => {
    const absent = {_id: new mongoose.Types.ObjectId(), employeeCode: "91000999", availabilityStatus: "ONLINE"};
    assert.equal(await runWithBusiness(businesses[0].id, () => attendanceAllowsCall(absent)), false);
});
