import assert from "node:assert/strict";
import test from "node:test";
import { groupDashboardSnapshots, type DashboardSnapshot } from "./callDashboardAggregation";

test("three business memberships produce one employee and one copy of a shared punch", () => {
  const timeIn = new Date("2026-10-14T15:00:00Z");
  const employee = { _id: "local-a", name: "Test Employee", employeeCode: "test-1", role: "Sales", team: "A" };
  const snapshots: DashboardSnapshot[] = ["a", "b", "c"].map((id) => ({
    employee: { ...employee, _id: `local-${id}` }, business: { id, name: id },
    events: [{ eventId: "shared-event", source: "Time In", timeIn }],
  }));
  const grouped = groupDashboardSnapshots(snapshots);
  assert.equal(grouped.size, 1);
  assert.equal(grouped.get("test-1")?.businesses.length, 3);
  assert.equal(grouped.get("test-1")?.events.length, 1);
  assert.equal(grouped.get("test-1")?.eventsByBusiness.size, 3);
  assert.equal(groupDashboardSnapshots(snapshots, "b").size, 1);
  assert.equal(groupDashboardSnapshots(snapshots, "missing").size, 0);
});

test("the selected business includes only its members even when another business has newer events", () => {
  const at = new Date("2026-10-16T15:00:00Z");
  const snapshots: DashboardSnapshot[] = [
    { employee: { _id: "a-1", name: "Shared", employeeCode: "shared", role: "Sales", team: "A" },
      business: { id: "a", name: "A" }, events: [{ eventId: "in", source: "Time In", timeIn: at }] },
    { employee: { _id: "b-1", name: "Shared", employeeCode: "shared", role: "Sales", team: "B" },
      business: { id: "b", name: "B" }, events: [{ eventId: "in", source: "Time In", timeIn: at }] },
    { employee: { _id: "b-2", name: "Only B", employeeCode: "only-b", role: "Sales", team: "B" },
      business: { id: "b", name: "B" }, events: [] },
  ];
  assert.deepEqual([...groupDashboardSnapshots(snapshots, "a").keys()], ["shared"]);
  assert.deepEqual([...groupDashboardSnapshots(snapshots, "b").keys()], ["shared", "only-b"]);
  assert.equal(groupDashboardSnapshots(snapshots, "a").get("shared")?.events.length, 1);
});
