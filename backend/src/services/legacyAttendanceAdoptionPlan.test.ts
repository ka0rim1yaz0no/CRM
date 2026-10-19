import test from "node:test";
import assert from "node:assert/strict";
import { prepareLegacyAttendanceAdoption, type LegacyAttendanceRow } from "./legacyAttendanceAdoptionPlan";
import { projectAttendance } from "./attendanceSessionState";

const policy = { shiftStart: "23:00", shiftEnd: "08:00", recoveryTime: "22:59" };
const row = (id: string, source: string, at: string): LegacyAttendanceRow => ({ id, source, at, createdAt: at, archived: false, reversed: false });

test("reviewed legacy adoption preserves an unresolved old session without manufacturing a checkout", () => {
  const records = [row("1", "Time In", "2026-10-12T15:00:00Z"), row("2", "Time In", "2026-10-13T15:00:00Z"),
    row("3", "Break Out", "2026-10-13T17:00:00Z"), row("4", "Break In", "2026-10-13T17:10:00Z"),
    row("5", "Break Out", "2026-10-13T17:20:00Z"), row("6", "Time Out", "2026-10-14T00:00:00Z")];
  const before = JSON.stringify(records);
  const plan = prepareLegacyAttendanceAdoption("fake", [{ businessId: "fake-a", employeeId: "fake", records }], policy);
  assert.equal(plan.ready, true); assert.equal(plan.blockingIssues.length, 0); assert.ok(plan.timelineIssues.length > 0);
  const projection = projectAttendance(plan.events);
  assert.equal(projection.sessions[0].endedAt, null);
  assert.equal(projection.sessions[0].lifecycle, "open");
  assert.equal(projection.sessions[0].historicalReview, true);
  assert.equal(projection.active, null);
  assert.equal(plan.events.filter((event) => event.source === "Time Out").length, 1);
  assert.equal(plan.events.filter((event) => event.source === "Break In").length, 1);
  assert.equal(JSON.stringify(records), before);
});

test("exact duplicate evidence is retained by origin while independent business copies are deduped once", () => {
  const records = [row("1", "Time In", "2026-10-15T15:00:00Z"), row("2", "Time Out", "2026-10-16T00:00:00Z")];
  const plan = prepareLegacyAttendanceAdoption("fake", [{ businessId: "a", employeeId: "a", records: [...records, { ...records[0], id: "3" }] },
    { businessId: "b", employeeId: "b", records: records.map((record) => ({ ...record, id: `b-${record.id}` })) }], policy);
  assert.equal(plan.events.length, 2); assert.equal(plan.duplicates.length, 1);
  assert.equal(plan.sourceCount, 5); assert.equal(plan.events[0].replicaOrigins?.length, 2);
  assert.equal(plan.businessStreamsDiffer, false);
});

test("adoption never asserts a missing Time In or genuinely ambiguous current break/lunch is safe", () => {
  const missing = prepareLegacyAttendanceAdoption("missing", [{ businessId: "a", employeeId: "fake", records: [row("1", "Time Out", "2026-10-15T15:00:00Z")] }], policy);
  assert.equal(missing.ready, false); assert.ok(missing.problems.includes("MISSING_TIME_IN"));
  const ambiguous = prepareLegacyAttendanceAdoption("bad", [{ businessId: "a", employeeId: "fake", records: [
    row("1", "Time In", "2026-10-15T15:00:00Z"), row("2", "Break Out", "2026-10-15T17:00:00Z"), row("3", "Lunch Break Out", "2026-10-15T17:01:00Z"),
  ] }], policy);
  assert.equal(ambiguous.ready, false); assert.ok(ambiguous.blockingIssues.length > 0);
});

test("strict rules still apply to new manual actions after historical adoption", () => {
  const plan = prepareLegacyAttendanceAdoption("fake", [{ businessId: "a", employeeId: "fake", records: [row("1", "Time In", "2026-10-15T15:00:00Z")] }], policy);
  const start = plan.events[0];
  const events = [...plan.events,
    { ...start, id: "new-lunch", source: "Lunch Break Out" as const, at: "2026-10-15T17:00:00Z", sequence: 2, legacyReviewed: undefined, legacyBoundary: undefined },
    { ...start, id: "bad-break", source: "Break Out" as const, at: "2026-10-15T17:01:00Z", sequence: 3, legacyReviewed: undefined, legacyBoundary: undefined }];
  assert.equal(projectAttendance(events).blockingIssues.length, 1);
});
