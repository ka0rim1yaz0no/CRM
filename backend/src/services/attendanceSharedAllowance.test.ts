import assert from "node:assert/strict";
import test from "node:test";
import { clickedSessionIntervals, excessClickedSessionMinutes, accountTime } from "./timeAccounting";

test("shared interval extraction preserves existing payroll minute rounding and original bucket totals", () => {
  const records = [ { source: "Break Out", timeIn: new Date("2026-10-15T17:00:00Z") }, { source: "Break In", timeIn: new Date("2026-10-15T17:15:29Z") } ];
  assert.equal(excessClickedSessionMinutes(records, "Break Out", "Break In", 15), 0);
  records[1].timeIn = new Date("2026-10-15T17:15:31Z");
  assert.equal(excessClickedSessionMinutes(records, "Break Out", "Break In", 15), 1);
  assert.equal(clickedSessionIntervals(records, "Break Out", "Break In")[0].milliseconds, 931000);
  const accounted = accountTime([{ at: records[0].timeIn, bucket: "break" }, { at: records[1].timeIn, bucket: "online" }], records[0].timeIn, records[1].timeIn, records[1].timeIn);
  assert.equal(accounted.milliseconds.break, 931000);
  assert.equal(accounted.intervals.reduce((sum, interval) => sum + interval.end.getTime() - interval.start.getTime(), 0), 931000);
});
