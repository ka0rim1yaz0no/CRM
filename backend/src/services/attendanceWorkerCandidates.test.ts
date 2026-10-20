import assert from "node:assert/strict";
import { afterEach, mock, test } from "node:test";
import { AttendanceLedger } from "../models/AttendanceLedger";
import { attendanceWorkerBatch, attendanceWorkerBudget, markAttendanceWorkerCandidate, resetAttendanceWorkerCursors } from "./attendanceWorkerCandidates";

afterEach(() => { mock.restoreAll(); resetAttendanceWorkerCursors(); });
test("workers request bounded projected candidate pages, continue by cursor, and wrap without skipping", async () => {
  const calls: Array<{ query: unknown; fields?: string; limit?: number; sort?: unknown; maxTime?: number }> = [];
  mock.method(AttendanceLedger, "find", (query: unknown) => {
    const call = { query } as typeof calls[number]; calls.push(call);
    const chain = { select(fields: string) { call.fields = fields; return chain; }, sort(value: unknown) { call.sort = value; return chain; },
      limit(value: number) { call.limit = value; return chain; }, maxTimeMS(value: number) { call.maxTime = value; return chain; },
      async lean() { return calls.length === 1 ? [{ _id: "candidate-a" }, { _id: "candidate-b" }] : []; } };
    return chain as never;
  });
  assert.equal((await attendanceWorkerBatch("auto-time-out", { "maintenance.active": true }, "_id revision events")).length, 2);
  markAttendanceWorkerCandidate("auto-time-out", "candidate-a");
  await attendanceWorkerBatch("auto-time-out", { "maintenance.active": true }, "_id revision events");
  assert.ok(JSON.stringify(calls[1].query).includes('"$gt":"candidate-a"'));
  await attendanceWorkerBatch("auto-time-out", { "maintenance.active": true }, "_id revision events");
  assert.ok(!JSON.stringify(calls[2].query).includes("$gt"));
  for (const call of calls) { assert.equal(call.limit, 200); assert.equal(call.fields, "_id revision events"); assert.equal(call.maxTime, 2000); }
});

test("worker budgets use monotonic time, guarantee first-candidate progress, and bound later work", () => {
  let clock = 0; const budget = attendanceWorkerBudget(() => clock);
  clock = 3000; assert.equal(budget(), true); assert.equal(budget(), false);
});
