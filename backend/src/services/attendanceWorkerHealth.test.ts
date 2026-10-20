import assert from "node:assert/strict";
import { afterEach, mock, test } from "node:test";
import { attendanceWorkerCounter, attendanceWorkerFailure, attendanceWorkersSnapshot, trackAttendanceWorker } from "./attendanceWorkerHealth";
const saved = process.env.CRM_ATTENDANCE_ACCURACY_FIXES;
afterEach(() => { mock.restoreAll(); if (saved === undefined) delete process.env.CRM_ATTENDANCE_ACCURACY_FIXES; else process.env.CRM_ATTENDANCE_ACCURACY_FIXES = saved; });
test("worker health reports failures/counters without leaking raw document errors", async () => {
  process.env.CRM_ATTENDANCE_ACCURACY_FIXES = "true";
  const lines: unknown[][] = []; mock.method(console, "warn", (...args: unknown[]) => { lines.push(args); });
  await assert.rejects(trackAttendanceWorker("recovery", async () => {
    attendanceWorkerCounter("recovery", "scanned");
    throw new Error("synthetic-private@example.invalid should never appear in output");
  }));
  const report = attendanceWorkersSnapshot().find(item => item.name === "recovery")!;
  assert.equal(report.counters.scanned, 1); assert.equal(report.counters.failed, 1); assert.equal(report.running, false);
  assert.ok(report.lastRunAt); assert.equal(report.lastErrorCode, "ATTENDANCE_OPERATION_FAILED");
  assert.ok(!JSON.stringify(lines).includes("synthetic-private"));
  const clone = attendanceWorkersSnapshot(); clone[0].counters.scanned = 99;
  assert.notEqual(attendanceWorkersSnapshot()[0].counters.scanned, 99);
});
test("flag-off worker telemetry makes no log/counter behavior changes", () => {
  process.env.CRM_ATTENDANCE_ACCURACY_FIXES = "false";
  const before = attendanceWorkersSnapshot(); let logs = 0;
  mock.method(console, "warn", () => { logs++; });
  attendanceWorkerCounter("outbox", "failed"); attendanceWorkerFailure("outbox", "fake", new Error("fake"));
  assert.equal(logs, 0); assert.deepEqual(attendanceWorkersSnapshot(), before);
});
