import assert from "node:assert/strict";
import test from "node:test";
import { attendanceViewRange, manilaCalendarDate, shiftDateOffset } from "../../../shared/attendanceView";
import { hubDayKey } from "./attendanceHubMath";
import { dashboardSectionView, dashboardView, dashboardViews } from "../../../shared/dashboardLayout";

test("Today requests the Manila calendar date, without regrouping the overnight shift", () => {
  const now = new Date("2026-10-19T18:00:00Z");
  assert.equal(manilaCalendarDate(now), "2026-10-20");
  assert.deepEqual(attendanceViewRange("today", now), { from: "2026-10-20", to: "2026-10-20" });
  assert.equal(hubDayKey(now, { officialShiftStartTime: "23:00", officialShiftEndTime: "08:00", attendanceTimeZone: "Asia/Manila", lateGraceMinutes: 0 }), "2026-10-19");
});
test("Today rolls over exactly at PH midnight across month and year boundaries", () => {
  assert.equal(manilaCalendarDate(new Date("2026-12-31T15:59:59.999Z")), "2026-12-31");
  assert.equal(manilaCalendarDate(new Date("2026-12-31T16:00:00.000Z")), "2027-01-01");
  assert.equal(manilaCalendarDate(new Date("2028-02-29T16:00:00Z")), "2028-03-01");
});
test("specific dates reject impossible/future dates and keep leap days", () => {
  const now = new Date("2028-03-01T00:00:00Z");
  assert.deepEqual(attendanceViewRange("date", now, "2028-02-29"), { from: "2028-02-29", to: "2028-02-29" });
  for (const value of [undefined, "", "2027-02-29", "2028-02-30", "2028-03-02", "bad"]) assert.throws(() => attendanceViewRange("date", now, value), /Invalid shift date/);
});
test("historical windows are bounded, contiguous, nonoverlapping and newest first", () => {
  const now = new Date("2026-10-20T00:00:00Z");
  const first = attendanceViewRange("all", now);
  const second = attendanceViewRange("all", now, undefined, 2);
  assert.equal(first.to, "2026-10-20");
  assert.equal(shiftDateOffset(second.to, 1), first.from);
  assert.equal(Date.parse(first.to) - Date.parse(first.from), 30 * 86_400_000);
  for (const page of [0, -1, 1.5, 1201, NaN]) assert.throws(() => attendanceViewRange("all", now, undefined, page), /Invalid history page/);
});
test("dashboard supporting tabs preserve sections without placing calls inside a tab", () => {
  assert.equal(dashboardView(null), "calls");
  assert.equal(dashboardView("constructor"), "calls");
  for (const view of dashboardViews) assert.equal(dashboardView(view), view);
  assert.equal(dashboardSectionView("Monthly Data"), "performance");
  assert.equal(dashboardSectionView("Employee Attendance"), "attendance");
  assert.equal(dashboardSectionView("Recent Lead Activity"), "activity");
});
