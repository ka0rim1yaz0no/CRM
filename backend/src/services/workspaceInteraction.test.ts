import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { canSelectSearchResult } from "../../../shared/workspaceSearch";
import { employeeBusinessDestination } from "../../../shared/workspaceNavigation";
import { formatPhDateTimeInput, parsePhDateTimeInput } from "../../../src/lib/dateTime";
import { QueryClient } from "@tanstack/react-query";
import { refreshEmployeeWorkspace } from "../../../src/lib/employeeWorkspaceCache";

test("search never opens a stale result while typing or fetching", () => {
  assert.equal(canSelectSearchResult("South", "North", false), false);
  assert.equal(canSelectSearchResult("South", "South", true), false);
  assert.equal(canSelectSearchResult(" S ", "S", false), false);
  assert.equal(canSelectSearchResult(" South ", "South", false), true);
});

test("updated navigation is structural rather than dependent on a company's theme", () => {
  const css = fs.readFileSync(new URL("../../../src/index.css", import.meta.url), "utf8");
  assert.match(css, /\.admin-sidebar-nav-command,\s*\.admin-sidebar-account-command\s*\{\s*display: block;/);
  assert.match(css, /\.admin-sidebar-nav-legacy,\s*\.admin-sidebar-account-legacy\s*\{\s*display: none;/);
});

test("business switch keeps safe employee sections but never carries tenant document ids", () => {
  assert.equal(employeeBusinessDestination("/profile", "?tab=leave&notice=tenant-document"), "/profile?tab=leave");
  assert.equal(employeeBusinessDestination("/attendance", "?employee=another-person"), "/attendance");
  assert.equal(employeeBusinessDestination("/leads", "?lead=old-tenant-document"), "/dashboard");
  assert.equal(employeeBusinessDestination("/profile", "?tab=invalid"), "/profile");
});

test("employee call-count filters use Manila dates independently of the browser timezone", () => {
  assert.equal(parsePhDateTimeInput("2026-10-31T23:00")?.toISOString(), "2026-10-31T15:00:00.000Z");
  assert.equal(parsePhDateTimeInput("2026-11-01T08:00")?.toISOString(), "2026-11-01T00:00:00.000Z");
  assert.equal(formatPhDateTimeInput("2026-10-31T19:00:00Z"), "2026-11-01T03:00");
});

test("manual attendance refreshes related employee pages without invalidating another employee", () => {
  const client = new QueryClient();
  for (const key of ["employee", "employee-profile", "employee-dashboard-attendance", "employee-recent-activity"]) {
    client.setQueryData([key, "fake-a"], { state: "OFFLINE" });
    client.setQueryData([key, "fake-b"], { state: "OFFLINE" });
  }
  refreshEmployeeWorkspace(client, "fake-a");
  for (const key of ["employee", "employee-profile", "employee-dashboard-attendance", "employee-recent-activity"]) {
    assert.equal(client.getQueryState([key, "fake-a"])?.isInvalidated, true);
    assert.equal(client.getQueryState([key, "fake-b"])?.isInvalidated, false);
  }
  client.clear();
});

test("workspace refresh covers live attendance, lead counts, calls and tasks without another employee's cache", () => {
  const client = new QueryClient();
  const own = [
    ["attendance-session", "business-a", "fake-a"], ["employee-attendance", "business-a", "fake-a"],
    ["employee-dashboard-tasks", "fake-a", "business-a"], ["employee-dashboard-lead-counts", "fake-a", "business-a"],
    ["employee-dashboard-lead-queue", "fake-a", "business-a"], ["employee-dashboard-lead-logs", "business-a", "fake-a"],
    ["employee-dashboard-announcements", "business-a", "fake-a"], ["employee-agent-lead-dashboard", "business-a", "fake-a"],
    ["lead-call-summary", "me", "fake-a", "business-a"],
  ];
  const other = [["attendance-session", "business-a", "fake-b"], ["lead-call-summary", "me", "fake-b"],
    ["employee-dashboard-lead-counts", "fake-b", "business-a"], ["employee-agent-lead-dashboard", "business-a", "fake-b"]];
  for (const key of [...own, ...other]) client.setQueryData(key, { fake: true });
  refreshEmployeeWorkspace(client, "fake-a");
  for (const key of own) assert.equal(client.getQueryState(key)?.isInvalidated, true, String(key));
  for (const key of other) assert.equal(client.getQueryState(key)?.isInvalidated, false, String(key));
  client.clear();
});
