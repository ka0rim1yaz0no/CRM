import assert from "node:assert/strict";
import { test } from "node:test";
import { Types } from "mongoose";
import { cachedCanonicalPhoneSelection, cachedLeadPhoneFacts, invalidateLeadPhoneSnapshot, type PhoneFact } from "./leadPhoneSnapshotCache";

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
