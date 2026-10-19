import assert from "node:assert/strict";
import test from "node:test";
import { attendanceBreakAllowanceLabel, attendanceIssueLabel } from "../../../src/lib/attendanceHubLabels";

test("break labels follow the business allowance for both breaks", () => {
  assert.equal(attendanceBreakAllowanceLabel(15), "2 x 15m (30m total)");
  assert.equal(attendanceBreakAllowanceLabel(10), "2 x 10m (20m total)");
  assert.equal(attendanceBreakAllowanceLabel(20), "2 x 20m (40m total)");
});

test("undertime is displayed clearly while preserving server status keys", () => {
  assert.equal(attendanceIssueLabel("UNDER TIME"), "UNDERTIME");
  assert.equal(attendanceIssueLabel("OPEN SESSION"), "OPEN SESSION");
  assert.equal(attendanceIssueLabel("EXCUSED"), "EXCUSED");
});
