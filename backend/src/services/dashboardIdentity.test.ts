import test from "node:test";
import assert from "node:assert/strict";
import { uniqueDashboardRows } from "../../../shared/dashboardIdentity";
test("dashboard identity uses employee codes, never similar employee names", () => {
  const first = { employeeId: "fake-a", employeeCode: "90000002", employeeName: "Alex Sample" };
  const second = { employeeId: "fake-b", employeeCode: "90000003", employeeName: "Alex Sample" };
  assert.deepEqual(uniqueDashboardRows([first, second, { ...first, employeeId: "duplicate-copy" }], (row) => row.employeeCode), [first, second]);
  assert.equal(uniqueDashboardRows([{ employeeId: "fake-a" }, { employeeId: "fake-b" }], () => "").length, 2);
});
