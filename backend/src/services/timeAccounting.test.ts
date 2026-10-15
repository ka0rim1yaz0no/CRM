import assert from "node:assert/strict";
import test from "node:test";
import { accountTime } from "./timeAccounting";

const minute = 60_000;
const at = (minutes: number) => new Date(minutes * minute);

test("golden time buckets keep break and lunch out of online", () => {
  const cases = [
    { name: "normal shift", events: [{ at: at(0), bucket: "online" as const }, { at: at(60), bucket: "offline" as const }],
      now: 90, expected: { online: 60, break: 0, lunch: 0, offPhone: 0, offline: 30 } },
    { name: "break and lunch", events: [{ at: at(0), bucket: "online" as const }, { at: at(20), bucket: "break" as const },
      { at: at(35), bucket: "online" as const }, { at: at(45), bucket: "lunch" as const }, { at: at(105), bucket: "online" as const }],
      now: 120, expected: { online: 45, break: 15, lunch: 60, offPhone: 0, offline: 0 } },
    { name: "forgot break in", events: [{ at: at(0), bucket: "online" as const }, { at: at(20), bucket: "break" as const }],
      now: 90, expected: { online: 20, break: 70, lunch: 0, offPhone: 0, offline: 0 } },
    { name: "overnight and midnight crossing", events: [{ at: at(0), bucket: "online" as const }, { at: at(50), bucket: "lunch" as const },
      { at: at(110), bucket: "online" as const }], now: 130,
      expected: { online: 60, break: 0, lunch: 60, offPhone: 0, offline: 0 } },
    { name: "overlap clipped to shift", events: [{ at: at(-20), bucket: "online" as const }, { at: at(20), bucket: "break" as const },
      { at: at(15), bucket: "break" as const }, { at: at(40), bucket: "online" as const }], now: 90,
      expected: { online: 65, break: 25, lunch: 0, offPhone: 0, offline: 0 } },
  ];
  for (const fixture of cases) {
    const result = accountTime(fixture.events, at(0), at(120), at(fixture.now));
    assert.deepEqual(Object.fromEntries(Object.entries(result.milliseconds).map(([key, value]) => [key, value / minute])),
      fixture.expected, fixture.name);
  }
});

test("open break is overdue but never silently closed", () => {
  const result = accountTime([{ at: at(0), bucket: "online" }, { at: at(20), bucket: "break" }], at(0), at(120), at(40));
  assert.equal(result.state, "break");
  assert.equal(result.overdue, true);
  assert.equal(result.remainingBreakMs, 0);
});

test("an overnight shift counts across midnight without resetting buckets", () => {
  const start = new Date("2026-10-14T15:00:00.000Z"); // 23:00 Manila
  const end = new Date("2026-10-15T00:00:00.000Z"); // 08:00 Manila
  const result = accountTime([
    { at: start, bucket: "online" },
    { at: new Date("2026-10-14T15:50:00.000Z"), bucket: "break" },
    { at: new Date("2026-10-14T16:05:00.000Z"), bucket: "online" },
  ], start, end, new Date("2026-10-14T16:30:00.000Z"));
  assert.equal(result.milliseconds.online / minute, 75);
  assert.equal(result.milliseconds.break / minute, 15);
});
