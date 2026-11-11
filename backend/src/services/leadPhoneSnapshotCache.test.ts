import assert from "node:assert/strict";
import { test } from "node:test";
import { Types } from "mongoose";
import { cachedCanonicalPhoneSelection, cachedLeadPhoneFacts, cachedLeadPhoneCommentFacts, invalidateLeadPhoneSnapshot,
    coalesceDisplayLeadFacts, leadFactCacheBudget, leadFactCacheUsage, type PhoneFact, type PhoneCommentFact } from "./leadPhoneSnapshotCache";

test("phone fact cache coalesces reads, isolates tenants, expires, and does not retain failed reads", async () => {
    let loads = 0;
    const load = async () => { loads++; return [{ _id: new Types.ObjectId() }]; };
    await Promise.all([cachedLeadPhoneFacts("synthetic-a", load), cachedLeadPhoneFacts("synthetic-a", load)]);
    assert.equal(loads, 1);
    await cachedLeadPhoneFacts("synthetic-b", load); assert.equal(loads, 2);
    await cachedLeadPhoneFacts("synthetic-a", load, performance.now() + 3000); assert.equal(loads, 3);
    invalidateLeadPhoneSnapshot("synthetic-a"); await cachedLeadPhoneFacts("synthetic-a", load); assert.equal(loads, 4);
    await assert.rejects(cachedLeadPhoneFacts("synthetic-failed", async () => { throw new Error("Synthetic failure"); }));
    await cachedLeadPhoneFacts("synthetic-failed", load); assert.equal(loads, 5);
});

test("expired fact arrays are actually released even if their business is never read again", async context => {
    context.mock.timers.enable({ apis: ["setTimeout"] });
    const business = "synthetic-active-expiry", before = leadFactCacheUsage();
    try {
        await cachedLeadPhoneFacts(business, async () => [{ _id: new Types.ObjectId(), phone: "+12025550121" }]);
        assert.equal(leadFactCacheUsage().retainedEntries, before.retainedEntries + 1);
        context.mock.timers.tick(leadFactCacheBudget.ttlMs);
        assert.equal(leadFactCacheUsage().retainedEntries, before.retainedEntries);
        assert.equal(leadFactCacheUsage().retainedBytes, before.retainedBytes);
    } finally { invalidateLeadPhoneSnapshot(business); context.mock.timers.reset(); }
});

test("fact retention has an entry and total byte budget rather than an unbounded row-count allowance", async () => {
    const keys = Array.from({ length: 14 }, (_, index) => `synthetic-budget-${index}`);
    let loads = 0;
    const load = async () => { loads++; return [{ _id: new Types.ObjectId(), notes: "x".repeat(3 * 1024 * 1024) }]; };
    try {
        for (const key of keys) await cachedLeadPhoneFacts(key, load);
        assert.ok(leadFactCacheUsage().retainedBytes <= leadFactCacheBudget.totalBytes);
        await cachedLeadPhoneFacts(keys[0], load); assert.equal(loads, keys.length + 1, "least recently used retained facts must be evicted");
        const oversized = async () => { loads++; return [{ _id: new Types.ObjectId(), notes: "x".repeat(leadFactCacheBudget.entryBytes) }]; };
        await cachedLeadPhoneFacts(keys[0], oversized, performance.now() + 3000);
        await cachedLeadPhoneFacts(keys[0], oversized); assert.equal(loads, keys.length + 3, "an oversized result is returned correctly but not retained");
    } finally { keys.forEach(invalidateLeadPhoneSnapshot); }
});

test("simultaneous display reads share only their exact tenant and assignment scope, never a completed result", async () => {
    let finish!: (value: number[]) => void, loads = 0;
    const waiting = new Promise<number[]>(resolve => { finish = resolve; });
    const load = () => { loads++; return waiting; };
    const one = coalesceDisplayLeadFacts("display-a", "employee-a", load);
    const same = coalesceDisplayLeadFacts("display-a", "employee-a", load);
    const otherPerson = coalesceDisplayLeadFacts("display-a", "employee-b", load);
    const otherTenant = coalesceDisplayLeadFacts("display-b", "employee-a", load);
    assert.equal(loads, 3); finish([1]);
    assert.deepEqual(await Promise.all([one, same, otherPerson, otherTenant]), [[1], [1], [1], [1]]);
    await coalesceDisplayLeadFacts("display-a", "employee-a", load); assert.equal(loads, 4);
    assert.equal(leadFactCacheUsage().pendingDisplayReads, 0);
});

test("a lead write during a shared display read reloads facts and a failed read is never retained", async () => {
    let finish!: (value: number[]) => void, loads = 0;
    const load = () => ++loads === 1 ? new Promise<number[]>(resolve => { finish = resolve; }) : Promise.resolve([2]);
    const pending = coalesceDisplayLeadFacts("display-race", "employee", load);
    invalidateLeadPhoneSnapshot("display-race"); finish([1]);
    assert.deepEqual(await pending, [2]); assert.equal(loads, 2);
    await assert.rejects(coalesceDisplayLeadFacts("display-failure", "employee", async () => { throw Error("SYNTHETIC_FAILURE"); }));
    assert.deepEqual(await coalesceDisplayLeadFacts("display-failure", "employee", async () => [3]), [3]);
    assert.equal(leadFactCacheUsage().pendingDisplayReads, 0);
});

test("a write during a pending snapshot discards and reloads the stale facts", async () => {
    let finish!: (records: PhoneFact[]) => void, loads = 0;
    const newest = [{ _id: new Types.ObjectId() }];
    const load = () => ++loads === 1 ? new Promise<PhoneFact[]>(resolve => { finish = resolve; }) : Promise.resolve(newest);
    const pending = cachedLeadPhoneFacts("synthetic-race", load);
    invalidateLeadPhoneSnapshot("synthetic-race"); finish([]);
    assert.deepEqual(await pending, newest); assert.equal(loads, 2);
});

test("canonical selections reuse unchanged facts but reevaluate exactly when a callback becomes due", () => {
    const now = new Date("2026-10-29T00:00:00Z");
    const older = { _id: new Types.ObjectId(), phone: "+12025550121", status: "Follow up", createdAt: new Date(+now - 10000), followUpAt: new Date(+now + 10000) };
    const dueSoon = { _id: new Types.ObjectId(), phone: "2025550121", status: "Follow up", createdAt: now, followUpAt: new Date(+now + 5000) };
    const facts: PhoneFact[] = [older, dueSoon], before = JSON.stringify(facts);
    const first = cachedCanonicalPhoneSelection(facts, now);
    assert.equal(first.canonical[0], older);
    assert.equal(cachedCanonicalPhoneSelection(facts, new Date(+now + 4999)), first);
    const due = cachedCanonicalPhoneSelection(facts, new Date(+now + 5000));
    assert.notEqual(due, first); assert.equal(due.canonical[0], dueSoon);
    assert.equal(cachedCanonicalPhoneSelection(facts, new Date(+now + 5001)), due);
    assert.equal(cachedCanonicalPhoneSelection(facts, now).canonical[0], older, "a backward server read must not reuse a future winner");
    assert.equal(JSON.stringify(facts), before);
});

test("tenant fact arrays and refreshed facts never share a canonical selection", () => {
    const now = new Date("2026-10-29T00:00:00Z"), a = [{ _id: new Types.ObjectId(), phone: "+12025550121", status: "NEW" }];
    const first = cachedCanonicalPhoneSelection(a, now);
    assert.equal(cachedCanonicalPhoneSelection(a, new Date(+now + 1)), first);
    const otherTenant = [{ ...a[0], _id: new Types.ObjectId() }];
    const second = cachedCanonicalPhoneSelection(otherTenant, now);
    assert.notEqual(second, first); assert.equal(second.ids.has(String(a[0]._id)), false);
    const refreshed = a.map(lead => ({ ...lead, notes: "New saved activity" }));
    assert.notEqual(cachedCanonicalPhoneSelection(refreshed, now), first);
});

test("queue display comment facts coalesce only within each business and invalidate with lead writes", async () => {
    for (let index = 0; index < 6; index++) {
        const business = `comment-scope-${index}`;
        let loads = 0;
        const load = async () => { loads++; return [{ phone: "+12025550121", latest: null, invalid: false }]; };
        await Promise.all([cachedLeadPhoneCommentFacts(business, load), cachedLeadPhoneCommentFacts(business, load)]);
        assert.equal(loads, 1);
        await cachedLeadPhoneCommentFacts(business, load, performance.now() + 3000); assert.equal(loads, 2);
        invalidateLeadPhoneSnapshot(business);
        await cachedLeadPhoneCommentFacts(business, load); assert.equal(loads, 3);
    }
});

test("pending comment facts cannot survive an intervening write or a failed lookup", async () => {
    let finish!: (facts: PhoneCommentFact[]) => void, loads = 0;
    const newest = [{ phone: "+12025550121", latest: new Date(), invalid: false }];
    const load = () => ++loads === 1 ? new Promise<PhoneCommentFact[]>(resolve => { finish = resolve; }) : Promise.resolve(newest);
    const pending = cachedLeadPhoneCommentFacts("comment-race", load);
    invalidateLeadPhoneSnapshot("comment-race"); finish([]);
    assert.deepEqual(await pending, newest); assert.equal(loads, 2);
    await assert.rejects(cachedLeadPhoneCommentFacts("comment-failed", async () => { throw Error("Synthetic read failure"); }));
    assert.deepEqual(await cachedLeadPhoneCommentFacts("comment-failed", async () => newest), newest);
});
