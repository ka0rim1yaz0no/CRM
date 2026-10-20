import assert from "node:assert/strict";
import { test } from "node:test";
import mongoose from "mongoose";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import { AttendanceLedger } from "../models/AttendanceLedger";
import { activeAttendanceWorkerFilter, attendanceWorkerBatch, markAttendanceWorkerCandidate, resetAttendanceWorkerCursors } from "./attendanceWorkerCandidates";

test("seeded Mongo: candidate pages exclude closed history, preserve legacy active sessions, and use additive indexes", async context => {
  const mongo = await MongoMemoryReplSet.create({ binary: { downloadDir: "node_modules/.cache/mongodb-memory-server" }, replSet: { count: 1 } });
  try {
    await mongoose.connect(mongo.getUri("synthetic_worker_candidates"));
    await AttendanceLedger.createIndexes();
    await AttendanceLedger.collection.insertMany(Array.from({ length: 802 }, (_, index) => ({ _id: `synthetic-${String(index).padStart(4, "0")}`,
      employeeCode: `fake-${index}`, businessIds: ["fake-a", "fake-b"], canonicalBusinessId: "fake-a", revision: 1,
      events: [{ source: "Time In" }, ...(index < 600 ? [{ source: "Time Out" }] : [])], corrections: [], closures: [],
      ...(index === 801 ? {} : { maintenance: { active: index >= 600 } }), jobs: [{ done: index !== 601, businessId: "fake-a", revision: 1 }] })) as never);
    const filter = activeAttendanceWorkerFilter();
    const first = await attendanceWorkerBatch("candidate-proof", filter, "_id revision");
    assert.equal(first.length, 200); assert.ok(first.every(row => !Object.hasOwn(row, "events")));
    markAttendanceWorkerCandidate("candidate-proof", first.at(-1)!._id);
    const second = await attendanceWorkerBatch("candidate-proof", filter, "_id revision");
    assert.equal(second.length, 2); assert.ok(second.some(row => row._id === "synthetic-0801"));
    assert.equal(new Set([...first, ...second].map(row => row._id)).size, 202);
    const plan = await AttendanceLedger.collection.find({ "maintenance.active": true }, { projection: { _id: 1 } }).sort({ _id: 1 }).limit(200)
      .hint({ "maintenance.active": 1, _id: 1 }).explain("executionStats");
    const pendingPlan = await AttendanceLedger.collection.find({ "jobs.done": false }, { projection: { _id: 1 } }).limit(200)
      .hint({ "jobs.done": 1, _id: 1 }).explain("executionStats");
    assert.match(JSON.stringify(plan.queryPlanner.winningPlan), /IXSCAN/);
    assert.match(JSON.stringify(pendingPlan.queryPlanner.winningPlan), /IXSCAN/);
    assert.ok(plan.executionStats.totalDocsExamined <= 200); assert.ok(pendingPlan.executionStats.totalDocsExamined <= 1);
    assert.equal(pendingPlan.executionStats.nReturned, 1);
    const compatibility = await AttendanceLedger.collection.find(filter, { projection: { _id: 1, revision: 1 } }).sort({ _id: 1 }).limit(200).explain("executionStats");
    context.diagnostic(`802 seeded ledgers: indexed active scan examined ${plan.executionStats.totalDocsExamined}; pending scan examined ${pendingPlan.executionStats.totalDocsExamined}; compatibility query examined ${compatibility.executionStats.totalDocsExamined}, returned ${compatibility.executionStats.nReturned}, ${compatibility.executionStats.executionTimeMillis}ms.`);
  } finally { resetAttendanceWorkerCursors(); await mongoose.disconnect(); await mongo.stop(); }
});
