import assert from "node:assert/strict";
import { test } from "node:test";
import { deadlineChangeFeeds } from "./callDeadlineChanges";

function fixture() {
    const streams: Array<{ business: string; events: unknown[]; reads: number; closes: number; fail: () => void; release?: () => void }> = [];
    const registry = deadlineChangeFeeds(business => {
        const row = { business, events: [] as unknown[], reads: 0, closes: 0, fail: () => {}, release: undefined as (() => void) | undefined };
        streams.push(row);
        return { on(_event, listener) { row.fail = listener; }, async tryNext() {
            row.reads++;
            if (row.release) await new Promise<void>(resolve => { row.release = resolve; });
            return row.events.shift() as { operationType: string } || null;
        }, async close() { row.closes++; } };
    });
    return { streams, registry };
}

test("20 same-business preparations share one unfinished read but retain independent change revisions", async () => {
    const f = fixture(), leases = Array.from({ length: 20 }, () => f.registry.acquire("synthetic-a"));
    assert.equal(f.streams.length, 1);
    assert.deepEqual(await Promise.all(leases.map(lease => lease.poll())), Array(20).fill(0));
    assert.equal(f.streams[0].reads, 1);
    f.streams[0].events.push({ operationType: "update", updateDescription: { updatedFields: { status: "Dead" } } });
    assert.equal(await leases[0].poll(), 1);
    assert.deepEqual(await Promise.all(leases.slice(1).map(lease => lease.poll())), Array(19).fill(1));
    await Promise.all(leases.map(lease => lease.close())); assert.equal(f.streams[0].closes, 1);
});

test("businesses never share feeds and a completed poll is not cached", async () => {
    const f = fixture(), one = f.registry.acquire("synthetic-a"), two = f.registry.acquire("synthetic-b");
    await Promise.all([one.poll(), two.poll()]);
    assert.equal(f.streams.length, 2); await one.poll(); assert.equal(f.streams[0].reads, 2);
    await one.close(); await two.close();
});

test("raw inserts, removals, replacements and every non-fence update advance all readers", async () => {
    const f = fixture(), lease = f.registry.acquire("synthetic-a"), stream = f.streams[0];
    const changes = [{ operationType: "insert" }, { operationType: "delete" }, { operationType: "replace" },
        { operationType: "update", updateDescription: { removedFields: ["comments"] } },
        { operationType: "update", updateDescription: { updatedFields: { callingDispatchRevision: 1, phone: "synthetic" } } }];
    stream.events.push({ operationType: "update", updateDescription: { updatedFields: { callingDispatchRevision: 1 } } });
    assert.equal(await lease.poll(), 0);
    for (const [index, change] of changes.entries()) { stream.events.push(change); assert.equal(await lease.poll(), index + 1); }
    await lease.close();
});

test("a stream error fails all waiting readers closed and releasing one lease cannot close another", async () => {
    const f = fixture(), one = f.registry.acquire("synthetic-a"), two = f.registry.acquire("synthetic-a"), stream = f.streams[0];
    await one.close(); assert.equal(stream.closes, 0); stream.fail();
    await assert.rejects(two.poll(), /CALL_PREPARATION_UNVERIFIED/); await two.close(); assert.equal(stream.closes, 1);
    const fresh = f.registry.acquire("synthetic-a"); assert.equal(f.streams.length, 2); assert.equal(await fresh.poll(), 0);
    await fresh.close();
});

test("an error during an empty cursor reply cannot be mistaken for fresh confirmation", async () => {
    let fail = () => {};
    const f = deadlineChangeFeeds(() => ({ on(_event, listener) { fail = listener; }, async tryNext() { fail(); return null; }, async close() {} }));
    const one = f.acquire("synthetic-a"), two = f.acquire("synthetic-a");
    await assert.rejects(one.poll(), /CALL_PREPARATION_UNVERIFIED/); await assert.rejects(two.poll(), /CALL_PREPARATION_UNVERIFIED/);
    await one.close(); await two.close();
});

test("busy change streams stop boundedly, old leases cannot reopen, and close is idempotent", async () => {
    const f = fixture(), lease = f.registry.acquire("synthetic-a"), stream = f.streams[0];
    stream.events.push(...Array.from({ length: 1000 }, () => ({ operationType: "insert" })));
    await assert.rejects(lease.poll(), /CALL_PREPARATION_BUSY/); await lease.close(); await lease.close();
    assert.equal(stream.closes, 1); await assert.rejects(lease.poll(), /CALL_PREPARATION_UNVERIFIED/);
});

test("a late cursor reply from a closed feed cannot become a new plan's confirmation", async () => {
    const f = fixture(), old = f.registry.acquire("synthetic-a"), stream = f.streams[0];
    stream.release = () => {};
    const pending = old.poll(); await old.close();
    const next = f.registry.acquire("synthetic-a"); assert.equal(await next.poll(), 0);
    stream.release!(); await assert.rejects(pending, /CALL_PREPARATION_UNVERIFIED/);
    assert.equal(stream.closes, 1); assert.equal(f.streams[1].closes, 0); await next.close();
});
