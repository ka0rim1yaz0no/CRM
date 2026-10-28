import assert from "node:assert/strict";
import test from "node:test";
import { calculateHubDay, type HubEvent, type HubSettings } from "./attendanceHubMath";

const settings: HubSettings = { officialShiftStartTime: "23:00", officialShiftEndTime: "08:00", lateGraceMinutes: 0,
  attendanceTimeZone: "Asia/Manila", breakMinutes: 15, lunchMinutes: 60 };
const day = "2026-10-19", now = new Date("2026-10-21T00:00:00Z");
const events = (entries: Array<[HubEvent["source"], string]>): HubEvent[] => entries.map(([source, at], sequence) => ({ id: `event-${sequence}`, source, at: new Date(at), sequence }));

for (const enabled of [false, true]) {
  test(`off-phone checkout warning state is session-scoped with accuracy=${enabled}`, async t => {
    const saved = { duration: process.env.CRM_ATTENDANCE_DURATION_MODEL, accuracy: process.env.CRM_ATTENDANCE_ACCURACY_FIXES };
    process.env.CRM_ATTENDANCE_DURATION_MODEL = String(enabled);
    process.env.CRM_ATTENDANCE_ACCURACY_FIXES = String(enabled);
    try {
      for (const checkout of ["Time Out", "Logout"] as const) {
        await t.test(`${checkout} closes ordinary and non-billable off-phone warnings`, () => {
          for (const source of ["Off the Phone Out", "Non-Billable Off the Phone Out"] as const) {
            const rows = events([["Time In", "2026-10-19T15:00:00Z"], [source, "2026-10-19T23:49:59Z"], [checkout, "2026-10-20T00:00:00Z"]]);
            const original = structuredClone(rows), result = calculateHubDay(day, rows, settings, now);
            assert.ok(!result.review.includes("Unclosed Off the Phone"));
            assert.equal(result.timeOut, "2026-10-20T00:00:00.000Z");
            assert.equal(result.nonBillableOffPhoneMinutes, source.startsWith("Non-Billable") ? 11 : 0);
            assert.equal(result.milliseconds.offPhone, 601_000);
            assert.equal(result.milliseconds.nonBillableOffPhone, source.startsWith("Non-Billable") ? 601_000 : 0);
            assert.deepEqual(rows, original);
            assert.equal(result.events.length, 3);
          }
        });
      }
      await t.test("checkout does not carry the old off-phone state into a later session", () => {
        const result = calculateHubDay(day, events([["Time In", "2026-10-19T15:00:00Z"], ["Off the Phone Out", "2026-10-19T16:00:00Z"],
          ["Time Out", "2026-10-19T16:05:00Z"], ["Time In", "2026-10-19T16:10:00Z"], ["Off the Phone Out", "2026-10-19T17:00:00Z"],
          ["Off the Phone In", "2026-10-19T17:05:00Z"], ["Time Out", "2026-10-20T00:00:00Z"]]), settings, now);
        assert.ok(!result.review.includes("Off the Phone Out without In"));
        assert.equal(result.milliseconds.offPhone, 600_000);
        assert.equal(result.milliseconds.offline, 300_000);
      });
      await t.test("missing checkout and unreturned break/lunch warnings and charges remain", () => {
        const open = calculateHubDay(day, events([["Time In", "2026-10-19T15:00:00Z"], ["Off the Phone Out", "2026-10-19T23:58:00Z"]]), settings, now);
        assert.ok(open.review.includes("Unclosed Off the Phone"));
        assert.ok(open.review.includes("Open session"));
        assert.equal(open.timeOut, null);
        for (const source of ["Break Out", "Lunch Break Out"] as const) {
          const rest = calculateHubDay(day, events([["Time In", "2026-10-19T15:00:00Z"], [source, "2026-10-19T22:00:00Z"], ["Time Out", "2026-10-20T00:00:00Z"]]), settings, now);
          assert.ok(rest.review.includes(source === "Break Out" ? "Unclosed break" : "Unclosed lunch"));
          assert.ok(source === "Break Out" ? rest.milliseconds.overBreak > 0 : rest.milliseconds.overLunch > 0);
        }
      });
      await t.test("real missing off-phone starts and duplicate starts still need review", () => {
        const missing = calculateHubDay(day, events([["Time In", "2026-10-19T15:00:00Z"], ["Off the Phone In", "2026-10-19T16:00:00Z"], ["Time Out", "2026-10-20T00:00:00Z"]]), settings, now);
        assert.ok(missing.review.includes("Off the Phone In without Out"));
        const duplicate = calculateHubDay(day, events([["Time In", "2026-10-19T15:00:00Z"], ["Off the Phone Out", "2026-10-19T16:00:00Z"], ["Off the Phone Out", "2026-10-19T16:01:00Z"], ["Time Out", "2026-10-20T00:00:00Z"]]), settings, now);
        assert.ok(duplicate.review.includes("Off the Phone Out without In"));
      });
    } finally {
      if (saved.duration === undefined) delete process.env.CRM_ATTENDANCE_DURATION_MODEL; else process.env.CRM_ATTENDANCE_DURATION_MODEL = saved.duration;
      if (saved.accuracy === undefined) delete process.env.CRM_ATTENDANCE_ACCURACY_FIXES; else process.env.CRM_ATTENDANCE_ACCURACY_FIXES = saved.accuracy;
    }
  });
}
