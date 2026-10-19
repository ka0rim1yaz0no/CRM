import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import crypto from "node:crypto";
import { dashboardRange, metricDelta, targetProgress, leadOverdueHours, changedSentences, activityTrend } from "./dashboardWorkspaceMath";
import { targetPeriodMatches } from "../../../shared/dashboardMetrics";
test("targets never compare a partial arbitrary range against a complete monthly target", () => {
  assert.equal(targetPeriodMatches("monthly", "2026-10-01", "2026-10-03", "2026-10-19"), false);
  assert.equal(targetPeriodMatches("monthly", "2026-10-01", "2026-11-01", "2026-11-01"), false);
  assert.equal(targetPeriodMatches("monthly", "2026-10-01", "2026-10-19", "2026-10-19"), true);
  assert.equal(targetPeriodMatches("monthly", "2028-02-01", "2028-02-29", "2028-03-02"), true);
  assert.equal(targetPeriodMatches("daily", "2026-10-19", "2026-10-20", "2026-10-20"), false);
});
test("dashboard reuses overnight shift days and validates ranges", () => {
  assert.equal(dashboardRange({}, new Date("2026-10-19T00:00:00Z")).today, "2026-10-18");
  assert.equal(dashboardRange({}, new Date("2026-10-19T00:01:00Z")).today, "2026-10-19");
  assert.throws(() => dashboardRange({ preset: "custom", from: "2026-02-30", to: "2026-03-01" }));
  assert.throws(() => dashboardRange({ preset: "custom", from: "2025-01-01", to: "2026-01-01" }));
  const range = dashboardRange({ preset: "custom", from: "2026-10-01", to: "2026-10-03" });
  assert.equal(range.previousFrom, "2026-09-28"); assert.equal(range.previousTo, "2026-09-30");
});
test("dashboard deltas, target pace, SLA and deterministic changes", () => {
  assert.equal(metricDelta(12, 10), 20); assert.equal(metricDelta(5, 0), null);
  assert.equal(targetProgress(20, 100, .3).state, "Behind"); assert.equal(targetProgress(20, 100, .1).state, "On track");
  assert.equal(targetProgress(20, 0, .1).state, "Set a target");
  const now = new Date("2026-10-19T12:00:00Z");
  assert.equal(leadOverdueHours({ status: "NEW", createdAt: "2026-10-18T10:00:00Z" }, now, 24, 0), 2);
  assert.equal(leadOverdueHours({ status: "NEW", createdAt: "2026-10-18T10:00:00Z", comments: [1] }, now, 24, 0), 0);
  assert.equal(changedSentences({ callsToday: 12, dueFollowUps: 2 }, { callsToday: 10 }, 1).length, 3);
});
test("activity comparisons use overnight shift days without fabricating stock snapshots", () => {
  const trend = activityTrend([{ _id: "fake", activity: [{ actorType: "employee", createdAt: "2026-10-16T00:00:00Z" }] }], "2026-10-15", "2026-10-16");
  assert.deepEqual(trend.map((row) => row.count), [1, 0]);
});
test("call dashboard component, API and endpoint remain byte-for-byte unchanged", () => {
  const root = new URL("../../../", import.meta.url);
  for (const [path, hash] of [
    ["src/components/CallDashboardPanel.tsx", "9B054467C0F5C28CE38AC5ECA89201F2EFAC34419D9CAA1F0F407D462CD18E8F"],
    ["src/api/callDashboard.ts", "D7A832A6D57D627A92251A8441C7020947C894BB417670FBBF90E35D509A8799"],
    ["backend/src/controllers/callDashboardController.ts", "6E794040EB9CDE149CB2354F746298AC93A387B0873D8D0759631EDF7F2977CB"],
    ["backend/src/routes/callDashboardRoutes.ts", "18BAE4DB7FE451D0275ABCB3E7BFA53F4DC7C9D1901C39666BFD8B26C3C0BF19"],
  ]) assert.equal(crypto.createHash("sha256").update(fs.readFileSync(new URL(path, root))).digest("hex").toUpperCase(), hash, path);
});
