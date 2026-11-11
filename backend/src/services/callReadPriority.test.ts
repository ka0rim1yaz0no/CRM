import assert from "node:assert/strict";
import { test } from "node:test";
import { createCallReadPriority } from "./callReadPriority";

function fixture(start = 0) {
    let now = start, monotonic = 0;
    const waits: number[] = [], timers: Array<{ callback: () => void; at: number; cancelled: boolean }> = [];
    const clock = { now: () => now, monotonic: () => monotonic,
        async pause(ms: number) { waits.push(ms); now += ms; monotonic += ms; },
        expire(callback: () => void, ms: number) { const timer = { callback, at: now + ms, cancelled: false }; timers.push(timer); return () => { timer.cancelled = true; }; } };
    return { clock, waits, timers, set: (time: number) => { now = time; }, elapsed: () => monotonic };
}

test("ordinary reads and distant preparations are never delayed", async () => {
    const f = fixture(), q = createCallReadPriority(f.clock);
    assert.equal(await q.waitForReadBudget(), false);
    const lease = q.reserve(30000); assert.equal(await q.waitForReadBudget(), false);
    lease.close(); assert.equal(q.pendingCount(), 0); assert.equal(f.waits.length, 0);
});

test("20 simultaneous deadline preparations hold display reads only through the bounded handoff window", async () => {
    const f = fixture(), q = createCallReadPriority(f.clock), leases = Array.from({ length: 20 }, () => q.reserve(30000));
    f.set(29750); assert.equal(await q.waitForReadBudget(), true);
    assert.equal(f.elapsed(), 2750); assert.ok(f.waits.every(ms => ms <= 25));
    assert.equal(q.pendingCount(), 0); leases.forEach(lease => lease.close());
});

test("a cancelled or refreshed preparation releases its priority before any deadline", async () => {
    const f = fixture(), q = createCallReadPriority(f.clock), lease = q.reserve(30000);
    f.set(29750); lease.close(); lease.close(); assert.equal(await q.waitForReadBudget(), false);
    assert.equal(q.pendingCount(), 0); assert.equal(f.timers[0].cancelled, true);
});

test("closing at the deadline retains only the bounded native handoff grace", async () => {
    const f = fixture(), q = createCallReadPriority(f.clock), lease = q.reserve(30000);
    f.set(30000); lease.close(); assert.equal(await q.waitForReadBudget(), true);
    assert.equal(f.elapsed(), 2500); assert.equal(q.pendingCount(), 0);
});

test("staggered callers cannot starve an individual display read for more than three seconds", async () => {
    const f = fixture(), q = createCallReadPriority(f.clock);
    for (let deadline = 30000; deadline <= 36000; deadline += 500) q.reserve(deadline);
    f.set(29750); assert.equal(await q.waitForReadBudget(), true); assert.equal(f.elapsed(), 3000);
});

test("a frozen or backwards wall clock cannot bypass the monotonic read-delay limit", async () => {
    const f = fixture(29750); let monotonic = 0;
    const q = createCallReadPriority({ ...f.clock, monotonic: () => monotonic, async pause(ms) { monotonic += ms; } });
    q.reserve(30000); assert.equal(await q.waitForReadBudget(), true); assert.equal(monotonic, 3000);
});

test("idle preparations expire and malformed deadlines cannot acquire priority", async () => {
    const f = fixture(), q = createCallReadPriority(f.clock);
    assert.throws(() => q.reserve(NaN), /INVALID_CALL_PRIORITY_DEADLINE/);
    q.reserve(30000); f.timers[0].callback(); assert.equal(q.pendingCount(), 0);
});
