import assert from "node:assert/strict";
import { test } from "node:test";
import { Types } from "mongoose";
import { compactLeadFactsStage, expandCompactLeadFacts, readCompactLeadFacts } from "./compactLeadFacts";

test("compact facts preserve absent, null, false, zero, dates and BSON identifiers", () => {
    const id = new Types.ObjectId(), at = new Date("2026-10-31T00:00:00.237Z");
    const fields = ["_id", "phone", "followUpAt", "status", "latest", "invalid", "callCount"];
    const result = expandCompactLeadFacts<Record<string, unknown>>([{ p: 1 + 4 + 8 + 16 + 32 + 64, v: [id, null, null, "", at, false, 0] }], fields);
    assert.deepEqual(result, [{ _id: id, followUpAt: null, status: "", latest: at, invalid: false, callCount: 0 }]);
    assert.equal(Object.hasOwn(result[0]!, "phone"), false);
});

test("streamed facts decode in order without retaining the source batch and always close the cursor", async () => {
    let closed = 0;
    const value = { p: 1, v: [0] };
    const cursor = { async *[Symbol.asyncIterator]() { for (let index = 0; index < 5000; index++) { value.v[0] = index; yield value; } },
        async close() { closed++; } };
    const rows = await readCompactLeadFacts<{ count: number }>(cursor, ["count"]);
    assert.equal(rows.length, 5000); assert.equal(rows[0].count, 0); assert.equal(rows.at(-1)!.count, 4999); assert.equal(closed, 1);
});

test("cursor read, malformed data and close errors cannot return partial callable facts", async () => {
    for (const reason of ["read", "row", "close"]) {
        let closed = 0;
        const cursor = { async *[Symbol.asyncIterator]() { yield { p: 1, v: ["first"] };
            if (reason === "read") throw Error("SYNTHETIC_READ_FAILED");
            if (reason === "row") yield { p: 2, v: ["invalid"] };
        }, async close() { closed++; if (reason === "close") throw Error("SYNTHETIC_CLOSE_FAILED"); } };
        await assert.rejects(readCompactLeadFacts(cursor, ["phone"])); assert.equal(closed, 1);
    }
});

test("the transport refuses malformed rows instead of inventing calling facts", () => {
    for (const row of [{ p: -1, v: [null] }, { p: 2, v: [null] }, { p: .5, v: [null] },
        { p: 1, v: [] }, { p: NaN, v: [null] }]) assert.throws(() => expandCompactLeadFacts([row], ["phone"]));
    for (const fields of [[], ["phone", "phone"], ["$phone"], Array.from({ length: 25 }, (_, i) => `f${i}`)]) {
        assert.throws(() => compactLeadFactsStage(fields));
    }
});
