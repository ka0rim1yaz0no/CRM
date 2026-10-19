import assert from "node:assert/strict";
import test from "node:test";
import { attendanceHubFilters, attendanceHubFilterChange, attendanceServerNow } from "../../../src/lib/attendanceHubState";

test("hub URL filters survive reload and KPI changes reset only pagination", () => {
  const url = new URLSearchParams("preset=custom&from=2026-10-01&to=2026-10-16&business=test-a&employee=Alex&page=3");
  const changed = attendanceHubFilterChange(url, "issue", "late");
  assert.equal(changed.get("page"), null); assert.equal(url.get("page"), "3");
  assert.equal(attendanceHubFilters(new URLSearchParams(changed.toString())).issue, "late");
  assert.equal(attendanceHubFilters(changed).business, "test-a");
  assert.equal(attendanceHubFilterChange(changed, "issue", "").get("issue"), null);
});
test("timer anchors to receipt time, not the client clock or a later cache update", () => {
  const server = "2026-10-15T15:00:00.000Z";
  const wrongClient = Date.parse(server) + 8 * 3_600_000;
  assert.equal(attendanceServerNow(server, wrongClient, wrongClient + 20_000), Date.parse(server) + 20_000);
  assert.equal(attendanceServerNow("2026-10-15T15:10:00Z", wrongClient + 10 * 60_000, wrongClient + 10 * 60_000), Date.parse(server) + 10 * 60_000);
});
