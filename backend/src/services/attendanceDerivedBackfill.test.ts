import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { mongo } from "mongoose";
import { attendanceDerivedBackfillWindow, summarizeAttendanceDerivedBackfill } from "./attendanceDerivedBackfill";
import { deriveAttendanceDays } from "./attendanceDerived";
import { assignAttendanceShift } from "./attendanceShift";
import { backfillAttendanceDerivedDryRun, parseAttendanceDerivedBackfillArguments } from "../scripts/backfillAttendanceDerived";
import type { SessionEvent } from "./attendanceSessionState";

const policy = { breakMinutes: 15, lunchMinutes: 60, graceMinutes: 0, shiftStart: "23:00", shiftEnd: "08:00", revision: 1 };
const now = new Date("2026-10-20T03:00:00Z");
function fixture() {
  const rows = [["Time In", "2026-10-15T15:00:00Z"], ["Break Out", "2026-10-15T17:00:00Z"],
    ["Break In", "2026-10-15T17:20:00Z"], ["Time Out", "2026-10-16T00:00:00Z"]] as const;
  const events: SessionEvent[] = rows.map(([source, at], sequence) => ({ id: `fake-${sequence}`, source, at, sequence,
    commandId: `fake-command-${sequence}`, recordedAt: at, ...(source === "Time In" ? { shift: assignAttendanceShift(new Date(at)) } : {}) }));
  return { ledger: { events, revision: 1 }, records: events.map((event) => ({ id: event.id, eventId: event.id, source: event.source, timeIn: new Date(event.at) })) };
}

test("dry-run reports missing derivatives and per-business count-only before/after totals without changing evidence", () => {
  const employee = fixture();
  const before = structuredClone(employee);
  const a = summarizeAttendanceDerivedBackfill("fake-a", [employee], policy, now);
  const b = summarizeAttendanceDerivedBackfill("fake-b", [employee], policy, now);
  assert.equal(a.daysChecked, 1); assert.equal(a.differingDays, 1); assert.equal(a.differingRecords, 4);
  assert.equal(a.missingDerivedRecords, 4); assert.equal(a.canonicalDaysDiffering, 1);
  assert.equal(a.before.excessBreakMinutes, 0); assert.equal(a.after.excessBreakMinutes, 5);
  assert.equal(a.writes, 0); assert.equal(b.after.excessBreakMinutes, 5);
  assert.deepEqual(employee, before);
  assert.equal(JSON.stringify(a).includes("fake-command"), false); assert.equal(JSON.stringify(a).includes("fake-0"), false);
});

test("already-current repeated per-event snapshots count only once per day and ignore timestamp metadata", () => {
  const employee = fixture();
  const derived = deriveAttendanceDays(employee.ledger, policy, now);
  const staleMetadata = { ...derived[0], computedAt: "2000-01-01T00:00:00Z", revision: 0, policyRevision: 0 };
  const report = summarizeAttendanceDerivedBackfill("fake-a", [{ ledger: { ...employee.ledger, derived: [staleMetadata] },
    records: employee.records.map((record) => ({ ...record, derived: JSON.parse(JSON.stringify(staleMetadata)) })) }], policy, now);
  assert.equal(report.differingRecords, 0); assert.equal(report.differingDays, 0); assert.equal(report.canonicalDaysDiffering, 0);
  assert.equal(report.before.excessBreakMinutes, 5); assert.equal(report.after.excessBreakMinutes, 5);
});

test("legacy dry-run computes provisional durations but counts adoption review and never creates a ledger", () => {
  const employee = fixture();
  const report = summarizeAttendanceDerivedBackfill("fake-a", [{ records: employee.records }], policy, now);
  assert.equal(report.legacyEmployeesRequiringReview, 1); assert.equal(report.after.excessBreakMinutes, 5);
  assert.equal(report.canonicalDaysDiffering, 0); assert.equal(report.writes, 0);
});

test("60-day Manila window excludes old assigned shifts while preserving the oldest complete overnight day", () => {
  const window = attendanceDerivedBackfillWindow(now);
  assert.equal(window.fromDay, "2026-08-22"); assert.equal(window.throughDay, "2026-10-20");
  const employee = fixture();
  for (const event of employee.ledger.events) event.at = event.at.replace("2026-10-15", "2026-08-21").replace("2026-10-16", "2026-08-22");
  employee.ledger.events[0].shift = assignAttendanceShift(new Date(employee.ledger.events[0].at));
  employee.records = employee.ledger.events.map((event) => ({ id: event.id, eventId: event.id, source: event.source, timeIn: new Date(event.at) }));
  assert.equal(summarizeAttendanceDerivedBackfill("fake-a", [employee], policy, now).daysChecked, 0);
  for (const event of employee.ledger.events) event.at = event.at.replace("2026-08-22", "2026-08-23").replace("2026-08-21", "2026-08-22");
  employee.ledger.events[0].shift = assignAttendanceShift(new Date(employee.ledger.events[0].at));
  employee.records = employee.ledger.events.map((event) => ({ id: event.id, eventId: event.id, source: event.source, timeIn: new Date(event.at) }));
  assert.equal(summarizeAttendanceDerivedBackfill("fake-a", [employee], policy, now).daysChecked, 1);
});

test("CLI requires explicit dry-run and destinations; every apply/backup option is rejected before connecting", () => {
  const valid = ["--dry-run", "--uri", "mongodb://127.0.0.1:1/fake", "--ledger-database", "fake", "--business", "fake-a=fake_a", "--as-of", now.toISOString()];
  assert.equal(parseAttendanceDerivedBackfillArguments(valid).businesses[0].id, "fake-a");
  for (const invalid of [[], valid.slice(1), [...valid, "--apply"], [...valid, "--backup", "fake-backup"], [...valid, "--business", "fake-a=fake_other"],
    [...valid, "--as-of", "invalid"]]) assert.throws(() => parseAttendanceDerivedBackfillArguments(invalid));
});

test("dry-run entry point only reads fake collections and closes its client, printing no identities", async () => {
  const employee = fixture();
  const calls: string[] = [];
  const connect = mock.method(mongo.MongoClient.prototype, "connect", async () => { calls.push("connect"); });
  const close = mock.method(mongo.MongoClient.prototype, "close", async () => { calls.push("close"); });
  const database = mock.method(mongo.MongoClient.prototype, "db", (name: string) => ({ collection(collection: string) {
    calls.push(`${name}:${collection}`);
    if (collection === "attendancepolicies") return { findOne: async () => policy };
    if (collection === "attendanceledgers") return { findOne: async () => employee.ledger };
    if (collection === "employees") return { find: () => [{ _id: new mongo.ObjectId(), employeeCode: "never-print-this-code" }] };
    if (collection === "attendances") return { find: () => ({ toArray: async () => employee.records.map((record) => ({ ...record, _id: new mongo.ObjectId() })) }) };
    throw new Error("Unexpected fake collection");
  } }));
  try {
    const result = await backfillAttendanceDerivedDryRun(["--dry-run", "--uri", "mongodb://127.0.0.1:1/fake", "--ledger-database", "fake",
      "--business", "fake-a=fake_a", "--as-of", now.toISOString()]);
    assert.equal(result.writes, 0); assert.equal(result.days, 60); assert.equal(result.businesses[0].after.excessBreakMinutes, 5);
    assert.equal(JSON.stringify(result).includes("never-print"), false); assert.equal(calls.at(-1), "close");
    assert.equal(connect.mock.callCount(), 1); assert.equal(close.mock.callCount(), 1);
  } finally { database.mock.restore(); close.mock.restore(); connect.mock.restore(); }
});
