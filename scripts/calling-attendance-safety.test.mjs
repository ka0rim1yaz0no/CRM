import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";

function fixture(storage = new Map(), blocked = false) {
    let serial = 0, now = 1000, events = 0;
    const exports = {};
    class Clock extends Date { static now() { return now; } }
    const source = readFileSync(new URL("../src/lib/callingAttendance.ts", import.meta.url), "utf8");
    runInNewContext(ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText,
        { exports, crypto: { randomUUID: () => `hold-${++serial}` }, Date: Clock, Event: class {}, window: {
            localStorage: { getItem: key => storage.get(key), setItem: (key, value) => { if (blocked) throw Error("Blocked storage"); storage.set(key, value); } },
            dispatchEvent: () => { events++; },
        } });
    return { api: exports, storage, events: () => events, advance: value => { now += value; } };
}
const online = (revision = 1, serverTime = "2026-10-29T00:00:00Z") => ({ revision, serverTime, state: "ONLINE" });

test("pending attendance and the confirmed off-phone state stop same-tab and cross-tab dialing", () => {
    const first = fixture(), second = fixture(first.storage), code = "synthetic-employee";
    first.api.observeCallingAttendance(code, online(), "");
    const finish = first.api.beginCallingAttendanceUpdate(code);
    assert.equal(first.api.callingAttendanceBlock(code), "Saving attendance");
    assert.equal(second.api.callingAttendanceBlock(code), "Saving attendance");
    finish({ ...online(2), state: "OFF THE PHONE" });
    assert.equal(first.api.callingAttendanceBlock(code), "Employee not ONLINE");
    assert.equal(second.api.callingAttendanceBlock(code), "Employee not ONLINE");
    const generation = second.api.callingAttendanceGeneration(code);
    second.api.observeCallingAttendance(code, online(3), generation);
    assert.equal(first.api.callingAttendanceBlock(code), "");
});

test("a stale online read cannot erase a hold or a later confirmed revision", () => {
    const {api} = fixture(), code = "synthetic-race";
    api.observeCallingAttendance(code, online(), "");
    const staleGeneration = api.callingAttendanceGeneration(code), finish = api.beginCallingAttendanceUpdate(code);
    api.observeCallingAttendance(code, online(), staleGeneration);
    assert.equal(api.callingAttendanceBlock(code), "Saving attendance");
    finish({ ...online(2), state: "OFF THE PHONE" });
    api.observeCallingAttendance(code, online(1), api.callingAttendanceGeneration(code));
    assert.equal(api.callingAttendanceBlock(code), "Employee not ONLINE");
});

test("lost responses stay blocked until a new authoritative read; dead-tab holds are recoverable", () => {
    const {api, advance} = fixture(), code = "synthetic-recovery";
    const finish = api.beginCallingAttendanceUpdate(code); finish();
    assert.equal(api.callingAttendanceBlock(code), "Checking attendance");
    api.observeCallingAttendance(code, online(), api.callingAttendanceGeneration(code));
    assert.equal(api.callingAttendanceBlock(code), "");
    api.beginCallingAttendanceUpdate(code); advance(60001);
    assert.equal(api.callingAttendancePending(code), false);
    assert.equal(api.callingAttendanceBlock(code), "Checking attendance");
    api.observeCallingAttendance(code, online(2), api.callingAttendanceGeneration(code));
    assert.equal(api.callingAttendanceBlock(code), "");
});

test("unchanged online polls do not broadcast a refetch loop and blocked storage retains the hold", () => {
    const state = fixture(), code = "synthetic-notify";
    state.api.observeCallingAttendance(code, online(), "");
    const events = state.events();
    for (let i = 1; i < 20; i++) state.api.observeCallingAttendance(code, online(1, new Date(Date.parse(online().serverTime) + i * 1000).toISOString()), "");
    assert.equal(state.events(), events);
    const unavailable = fixture(state.storage, true);
    unavailable.api.beginCallingAttendanceUpdate(code);
    assert.equal(unavailable.api.callingAttendanceBlock(code), "Saving attendance");
    assert.equal(unavailable.api.callingAttendanceBlock("another-employee"), "");
});
