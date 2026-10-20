import assert from "node:assert/strict";
import test from "node:test";
import { serverReadTime, withReadSnapshot } from "./readSnapshot";

test("audit server-time snapshots are fixed, isolated across concurrent reads, and never supplied by HTTP filters", async () => {
  const before = Date.now();
  const first = new Date("2026-10-15T16:00:00Z"), second = new Date("2026-10-16T16:00:00Z");
  await Promise.all([first, second].map(at => withReadSnapshot(at, async () => {
    await Promise.resolve();
    assert.equal(serverReadTime().getTime(), at.getTime());
    const copy = serverReadTime(); copy.setFullYear(2000);
    assert.equal(serverReadTime().getTime(), at.getTime(), "Callers cannot mutate the shared instant");
  })));
  assert.ok(serverReadTime().getTime() >= before, "Normal requests still use current server time");
  assert.throws(() => withReadSnapshot(new Date("invalid"), () => undefined), /Invalid/);
});
