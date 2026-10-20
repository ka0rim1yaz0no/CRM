import assert from "node:assert/strict";
import test from "node:test";
import { QueryClient } from "@tanstack/react-query";
import { refreshAttendanceWorkspace } from "../../../src/lib/employeeWorkspaceCache";

test("manual attendance refresh invalidates shift lists, details and all assigned-business caches", async () => {
  const client = new QueryClient();
  const keys = [
    ["attendance-session", "synthetic-a", "employee-a"],
    ["attendance-session", "synthetic-b", "employee-b"],
    ["employee-attendance", "synthetic-a", "employee-a"],
    ["employee-attendance", "batch", ["employee-b"]],
    ["employee-dashboard-attendance", "employee-b", "synthetic-b"],
    ["attendance-hub", "fake-admin", "synthetic-b", { shiftView: "today" }],
    ["attendance-hub-day", "synthetic-b", "2026-10-19", "99009991"],
    ["attendance-hub-live", "synthetic-b"],
    ["payroll-records", { businessId: "synthetic-a" }],
    ["payroll-stats"],
    ["payroll-dtr", "employee-b", "synthetic-period"],
    ["payroll-payslip-dtr", "employee-a", "synthetic-period"],
  ];
  try {
    for (const key of keys) client.setQueryData(key, { synthetic: true });
    client.setQueryData(["unrelated-inventory"], []);
    await refreshAttendanceWorkspace(client);
    for (const key of keys) assert.equal(client.getQueryState(key)?.isInvalidated, true, JSON.stringify(key));
    assert.equal(client.getQueryState(["unrelated-inventory"])?.isInvalidated, false);
  } finally { client.clear(); }
});
