import assert from "node:assert/strict";
import { test } from "node:test";
import type { ClientSession } from "mongoose";
import { lockPayrollAttendance, payrollAttendanceFenceKeys } from "./payrollAttendanceFence";

test("fence keys deduplicate, sort and preserve separate business identities without delimiter collisions", () => {
  const a = { businessId: "a:b", employeeCode: "c" }, b = { businessId: "a", employeeCode: "b:c" };
  const keys = payrollAttendanceFenceKeys([a, b, a]);
  assert.equal(keys.length, 2); assert.deepEqual(keys, [...keys].sort());
  assert.deepEqual(keys.map(key => JSON.parse(key)).sort(), [["a", "b:c"], ["a:b", "c"]]);
});

test("coordination cannot run outside an active transaction or silently downgrade to an unguarded write", async () => {
  await assert.rejects(lockPayrollAttendance([{ businessId: "fake-a", employeeCode: "fake" }], { inTransaction: () => false } as ClientSession), /active transaction/);
});
