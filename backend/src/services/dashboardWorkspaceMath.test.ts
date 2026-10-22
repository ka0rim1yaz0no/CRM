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
const sourceHash = (source: string) => crypto.createHash("sha256").update(source.replace(/\r\n/g, "\n")).digest("hex").toUpperCase();

test("source guard ignores checkout line endings, but still detects code changes", () => {
  assert.equal(sourceHash("fixture\r\n"), sourceHash("fixture\n"));
  assert.notEqual(sourceHash("fixture\n"), sourceHash("changed\n"));
});

test("reviewed call dashboard freshness component and unchanged API/endpoint contracts stay pinned", () => {
  const root = new URL("../../../", import.meta.url);
  for (const [path, hash] of [
    ["src/components/CallDashboardPanel.tsx", "1E61E63D4F04E1974255C53B294AC10A699E17DA3159878869AE83D687B583A5"],
    ["src/api/callDashboard.ts", "2BD61E9E093FBB952477144CCAFBB43F049FCAB87EE5A6C81282D58BB0C0D923"],
    ["backend/src/controllers/callDashboardController.ts", "8FD7BE4E0DA788F2CA2ED69CA8F05BBC2DBE5C1A2A0B8A003344D2D60E717A5C"],
    ["backend/src/routes/callDashboardRoutes.ts", "18BAE4DB7FE451D0275ABCB3E7BFA53F4DC7C9D1901C39666BFD8B26C3C0BF19"],
  ]) assert.equal(sourceHash(fs.readFileSync(new URL(path, root), "utf8")), hash, path);
});
