import assert from "node:assert/strict";
import { test } from "node:test";
import { auditAttendance, badCallTimes, checkBounds, compareCheck, lastCompletedShift, percentChangeCheck, punchDays, validCheckDate, type AuditPunch } from "./dataCheckMath";
import { dataCheckCsv, dataCheckText, dataCheckVerdict, type DataCheckReport } from "../../../shared/dataCheck";
import { dataCheckEnabled, dataCheckNavigationEnabled, securityLegacyAuthEnabled } from "../config/rolloutFlags";

const policy = { shiftStart: "23:00", shiftEnd: "08:00", graceMinutes: 0, breakMinutes: 15, lunchMinutes: 60 };
const date = "2026-10-19";
const now = new Date("2026-10-20T01:00:00Z");
function event(source: string, at: string, index = 0): AuditPunch { return { id: `fake-${source}-${at}-${index}`, code: "fake-employee", source, at, sequence: index }; }
const standard = [event("Time In", "2026-10-19T15:00:00Z"), event("Break Out", "2026-10-19T16:00:00Z", 1), event("Break In", "2026-10-19T16:15:00Z", 2), event("Break Out", "2026-10-19T17:00:00Z", 3), event("Break In", "2026-10-19T17:15:00Z", 4), event("Lunch Break Out", "2026-10-19T18:00:00Z", 5), event("Lunch Break In", "2026-10-19T19:00:00Z", 6), event("Time Out", "2026-10-20T00:00:00Z", 7)];

test("data check independently totals two breaks, lunch and online without deductions", () => {
  const value = auditAttendance(standard, date, policy, now);
  assert.equal(value.present, true); assert.equal(value.deductible, 0);
  assert.equal(value.workedMs, 7.5 * 3_600_000);
  assert.deepEqual(value.intervals.break.map(rest => rest.milliseconds), [900_000, 900_000]);
  assert.equal(value.intervals.lunch[0].milliseconds, 3_600_000);
  assert.equal(value.issues.length, 0);
});

test("independent data check never deducts Coaching or spends its separate Off the Phone allowance", () => {
  const previous = process.env.CRM_OFF_PHONE_PAID_LIMIT_FROM;
  process.env.CRM_OFF_PHONE_PAID_LIMIT_FROM = "2026-10-01T00:00:00Z";
  try {
    const events = [event("Time In", "2026-10-19T15:00:00Z"), event("Coaching Out", "2026-10-19T15:10:00Z", 1),
      event("Coaching In", "2026-10-19T15:40:00Z", 2), event("Off the Phone Out", "2026-10-19T16:00:00Z", 3),
      event("Off the Phone In", "2026-10-19T16:20:00Z", 4), event("Time Out", "2026-10-20T00:00:00Z", 5)];
    assert.equal(auditAttendance(events, date, policy, now).deductible, 0);
  } finally {
    if (previous === undefined) delete process.env.CRM_OFF_PHONE_PAID_LIMIT_FROM;
    else process.env.CRM_OFF_PHONE_PAID_LIMIT_FROM = previous;
  }
});
test("data check preserves nearest-minute rounding and detects a third break", () => {
  const minute = [...standard]; minute[2] = { ...minute[2], at: "2026-10-19T16:15:01Z" };
  assert.equal(auditAttendance(minute, date, policy, now).overBreak, 0);
  minute[2] = { ...minute[2], at: "2026-10-19T16:15:30Z" };
  assert.equal(auditAttendance(minute, date, policy, now).overBreak, 1);
  minute.splice(5, 0, event("Break Out", "2026-10-19T17:30:00Z", 5), event("Break In", "2026-10-19T17:46:00Z", 6));
  const value = auditAttendance(minute, date, policy, now);
  assert.equal(value.starts.break, 3); assert.equal(value.overBreak, 2);
});
test("data check measures late, lunch excess, early out and open records independently", () => {
  const events = [event("Time In", "2026-10-19T15:07:00Z"), event("Lunch Break Out", "2026-10-19T18:00:00Z", 1), event("Lunch Break In", "2026-10-19T19:01:00Z", 2), event("Time Out", "2026-10-19T23:50:00Z", 3)];
  const result = auditAttendance(events, date, policy, now);
  assert.deepEqual([result.late, result.overLunch, result.under, result.deductible], [7, 1, 10, 18]);
  const open = auditAttendance(events.slice(0, 2), date, policy, now);
  assert.equal(open.open, true); assert.equal(open.unclosedRests, 1); assert.equal(open.overLunch, 0); assert.equal(open.under, 0);
});
test("missing returns never pair across a checkout and another time in", () => {
  const events = [event("Time In", "2026-10-19T15:00:00Z"), event("Break Out", "2026-10-19T16:00:00Z", 1), event("Time Out", "2026-10-19T16:01:00Z", 2), event("Time In", "2026-10-19T17:00:00Z", 3), event("Break In", "2026-10-19T17:30:00Z", 4)];
  const result = auditAttendance(events, date, policy, now);
  assert.equal(result.overBreak, 0); assert.equal(result.intervals.break[0].end, null); assert.equal(result.unclosedRests, 1); assert.ok(result.issues.length >= 2);
});
test("Manila boundaries include 23:00 and 07:59, flag 22:59, and keep 08:00 checkout on its opening shift", () => {
  const bounds = checkBounds(date, policy);
  assert.equal(bounds.start.toISOString(), "2026-10-19T15:00:00.000Z"); assert.equal(bounds.end.toISOString(), "2026-10-20T00:00:00.000Z");
  for (const [clock, present, issue] of [["2026-10-19T14:59:00Z", false, true], ["2026-10-19T15:00:00Z", true, false], ["2026-10-19T23:59:00Z", true, false], ["2026-10-20T00:00:00Z", false, false]] as const) {
    const result = auditAttendance([event("Time In", clock)], date, policy, now); assert.equal(result.present, present); assert.equal(result.issues.length > 0, issue);
  }
  const groups = punchDays([standard[0], standard.at(-1)!], policy);
  assert.equal(groups.get(`fake-employee:${date}`)?.length, 2);
  assert.equal(lastCompletedShift(policy, new Date("2026-10-20T00:00:00Z")), date);
  assert.equal(lastCompletedShift(policy, new Date("2026-10-19T23:59:00Z")), "2026-10-18");
});
test("event integrity finds duplicate, out-of-order and wrong-slot evidence", () => {
  const events = [standard[0], { ...standard[0], id: "duplicate", sequence: 1 }, { ...standard[1], slotKey: "2026-10-18", sequence: 2 }, { ...standard[2], at: "2026-10-19T15:30:00Z", sequence: 3 }];
  assert.ok(auditAttendance(events, date, policy, now).issues.length >= 3);
});
test("call anomalies find negative, reversed, over-limit and never-ended calls without treating a recent open call as invalid", () => {
  const calls = [{ start: "2026-10-19T15:00:00Z", end: "2026-10-19T14:59:00Z" }, { start: "2026-10-19T15:00:00Z", end: "2026-10-19T18:00:00Z" }, { start: "2026-10-19T15:00:00Z", durationSeconds: -1 }, { start: "2026-10-20T00:59:00Z", durationSeconds: 60 }];
  assert.equal(badCallTimes(calls, now, 7200).length, 3);
});
test("checks distinguish stale warnings, true mismatches, missing evidence and cross-business differences", () => {
  const match = compareCheck("match", "Attendance", "fake-a", "Matching", 1, 1, "Independent");
  const stale = compareCheck("stale", "Attendance", "fake-a", "Stale rows", 0, 1, "Stored stale", [], false, true);
  const mismatch = compareCheck("cross", "Consistency", "all", "Cross business", 0, 1, "Different raw events");
  assert.equal(dataCheckVerdict([match]), "PASS"); assert.equal(dataCheckVerdict([match, stale]), "WARN"); assert.equal(dataCheckVerdict([mismatch]), "FAIL");
  assert.equal(compareCheck("missing", "Calls", "fake-a", "No history", null, null, "Not recorded").status, "cannot-verify");
  assert.equal(compareCheck("samples", "Calls", "fake-a", "Sample cap", 0, 1, "Synthetic", Array.from({ length: 20 }, (_, i) => ({ recordId: String(i), employeeCode: "fake", timestamp: now.toISOString() }))).samples.length, 10);
});
test("date validation is strict and exports quote cells, neutralize spreadsheet formulas and omit matching rows", () => {
  assert.equal(validCheckDate("2026-02-30"), false); assert.equal(validCheckDate([date]), false); assert.equal(validCheckDate(date), true);
  const report: DataCheckReport = { date, business: "fake-a", generatedAt: now.toISOString(), expiresAt: now.toISOString(), cached: false, verdict: "FAIL", counts: { match: 1, mismatch: 1, "cannot-verify": 0 }, businesses: [], boundaryProof: "shared", checks: [compareCheck("one", "Leads", "fake-a", '=HYPERLINK("fake")', 0, 1, "Synthetic"), compareCheck("two", "Leads", "fake-a", "matching row", 1, 1, "Synthetic")] };
  assert.match(dataCheckCsv(report), /'=/); assert.doesNotMatch(dataCheckCsv(report), /matching row/); assert.match(dataCheckText(report), /Data Check FAIL/);
});
test("Data Check and signed legacy authentication default off in production and support an explicit local rollback", () => {
  const before = { node: process.env.NODE_ENV, check: process.env.CRM_DATA_CHECK, legacy: process.env.CRM_SECURITY_LEGACY_AUTH };
  try {
    delete process.env.CRM_DATA_CHECK; delete process.env.CRM_SECURITY_LEGACY_AUTH;
    for (const environment of ["development", "test", "production"]) {
      process.env.NODE_ENV = environment;
      assert.equal(dataCheckEnabled(), environment !== "production"); assert.equal(securityLegacyAuthEnabled(), environment !== "production");
    }
    process.env.CRM_DATA_CHECK = "true"; assert.equal(dataCheckEnabled(), true);
    process.env.NODE_ENV = "development"; process.env.CRM_SECURITY_LEGACY_AUTH = "false"; assert.equal(securityLegacyAuthEnabled(), false);
  } finally {
    for (const [key, value] of [["NODE_ENV", before.node], ["CRM_DATA_CHECK", before.check], ["CRM_SECURITY_LEGACY_AUTH", before.legacy]]) {
      if (value === undefined) delete process.env[key!]; else process.env[key!] = value;
    }
  }
});
test("undefined percentage is verified only with explicit dashboard evidence, not confused with unavailable data", () => {
  assert.equal(percentChangeCheck("fake", null, 0, 0).status, "match");
  assert.equal(percentChangeCheck("fake", null, 5, 0).status, "match");
  assert.equal(percentChangeCheck("fake", undefined, 0, 0).status, "cannot-verify");
  assert.equal(percentChangeCheck("fake", 0, 5, 0).status, "mismatch");
  assert.equal(percentChangeCheck("fake", 20, 12, 10).status, "match");
  assert.equal(percentChangeCheck("fake", null, 12, 10).status, "mismatch");
  assert.match(percentChangeCheck("fake", 0, 1001, 1000).explanation, /Rounding hides a nonzero change/);
});
test("Data Check navigation is hidden by default in every environment and can be restored explicitly", () => {
  const environment = process.env.NODE_ENV, flag = process.env.CRM_DATA_CHECK_NAV;
  try {
    delete process.env.CRM_DATA_CHECK_NAV;
    for (const value of ["development", "test", "production"]) { process.env.NODE_ENV = value; assert.equal(dataCheckNavigationEnabled(), false); }
    process.env.CRM_DATA_CHECK_NAV = "true"; assert.equal(dataCheckNavigationEnabled(), true);
    process.env.CRM_DATA_CHECK_NAV = "false"; assert.equal(dataCheckNavigationEnabled(), false);
  } finally {
    if (environment === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = environment;
    if (flag === undefined) delete process.env.CRM_DATA_CHECK_NAV; else process.env.CRM_DATA_CHECK_NAV = flag;
  }
});
