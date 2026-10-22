import assert from "node:assert/strict";
import { test } from "node:test";
import { Types } from "mongoose";
import { cachedLeadPhoneFacts, invalidateLeadPhoneSnapshot, type PhoneFact } from "./leadPhoneSnapshotCache";

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
