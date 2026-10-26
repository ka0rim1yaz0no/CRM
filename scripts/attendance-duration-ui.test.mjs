import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { attendanceBreakControl, attendanceDurationControls, attendanceRestActionLabel, hasAutoTimeOut, validAttendanceCutoff } from "../src/lib/attendanceDurationUi.ts";

const start = Date.parse("2026-10-20T17:00:00Z");
const event = (source, seconds, sequence = 0) => ({ source, timeIn: new Date(start + seconds * 1000).toISOString(), sequence });
const pair = (duration, out = "Break Out", back = "Break In") => [event(out, 0), event(back, duration)];

test("two independent break allowances and one lunch, no scheduled clock windows", () => {
    const cards = attendanceDurationControls([], start);
    assert.deepEqual(cards.map(({ label, state, allowanceMinutes }) => ({ label, state, allowanceMinutes })), [
        { label: "Break 1", state: "available", allowanceMinutes: 15 },
        { label: "Break 2", state: "available", allowanceMinutes: 15 },
        { label: "Lunch", state: "available", allowanceMinutes: 60 },
    ]);
});

test("one Break button starts and ends each break, then stops after two completed cycles", () => {
    const states = [[], [event("Break Out", 0)], pair(900), [...pair(900), event("Break Out", 2000)],
        [...pair(900), event("Break Out", 2000), event("Break In", 2900)]];
    assert.deepEqual(states.map((records) => {
        const selected = attendanceBreakControl(attendanceDurationControls(records, start + 3_000_000, undefined, []));
        return [selected.breakNumber, selected.control.state, selected.completed, selected.exhausted];
    }), [[1, "available", 0, false], [1, "active", 0, false], [2, "available", 1, false], [2, "active", 1, false], [2, "done", 2, true]]);
    const page = readFileSync(new URL("../src/pages/attendance/index.tsx", import.meta.url), "utf8");
    assert.match(page, /\[breakControl\.control, durationControls\[2\]\]\.map/);
    assert.match(page, /const label = index === 0 \? "Break" : "Lunch"/);
});

test("an administratively closed missing return stops timing and consumes a break without blocking the second", () => {
    const records = [{ ...event("Break Out", 100), _id: "closed-break" }];
    const before = attendanceDurationControls(records, start + 500_000, undefined, [], new Set(["closed-break"]));
    const later = attendanceDurationControls(records, start + 999_999_000, undefined, [], new Set(["closed-break"]));
    assert.deepEqual(before, later);
    assert.equal(before[0].state, "review");
    const selected = attendanceBreakControl(before);
    assert.equal(selected.control.label, "Break 2");
    assert.equal(selected.used, 1);
    assert.equal(selected.exhausted, false);
});

test("visible In starts a rest and Out ends it for both break cycles and lunch after reload", () => {
    const states = [[], [event("Break Out", 0)], pair(900), [...pair(900), event("Break Out", 2000)],
        [...pair(900), event("Break Out", 2000), event("Break In", 2900)]];
    assert.deepEqual(states.map((records) => attendanceRestActionLabel(attendanceBreakControl(
        attendanceDurationControls(JSON.parse(JSON.stringify(records)), start + 3_000_000)).control)),
    ["Break In", "Break Out", "Break In", "Break Out", "Break In"]);
    assert.deepEqual([[], [event("Lunch Break Out", 0)], pair(3600, "Lunch Break Out", "Lunch Break In")]
        .map((records) => attendanceRestActionLabel(attendanceDurationControls(records, start + 4_000_000)[2])),
    ["Lunch In", "Lunch Out", "Lunch In"]);
});

test("completed break excess displays server nearest-minute values without recomputing", () => {
    for (const [seconds, excess] of [[900, 0], [901, 0], [929, 0], [930, 60_000], [960, 60_000]]) {
        const records = pair(seconds);
        const rows = excess ? [{ startedAt: records[0].timeIn, endedAt: records[1].timeIn, durationMs: seconds * 1000, overMs: excess }] : [];
        const card = attendanceDurationControls(records, start + 9_000_000, undefined, rows)[0];
        assert.equal(card.state, "done");
        assert.equal(card.durationMs, seconds * 1000);
        assert.equal(card.excessMs, excess);
    }
});

test("active break uses raw elapsed time, not completed-minute rounding", () => {
    const card = attendanceDurationControls([event("Break Out", 0)], start + 901_000)[0];
    assert.equal(card.state, "active");
    assert.equal(card.durationMs, 901_000);
    assert.equal(card.excessMs, 1000);
});

test("both completed breaks and a 61-minute lunch retain independent excess", () => {
    const records = [...pair(960), event("Break Out", 2000), event("Break In", 3020),
        event("Lunch Break Out", 4000), event("Lunch Break In", 7660)];
    const rows = [[0, 1, 60_000], [2, 3, 120_000], [4, 5, 60_000]].map(([out, back, overMs]) => ({
        startedAt: records[out].timeIn, endedAt: records[back].timeIn,
        durationMs: Date.parse(records[back].timeIn) - Date.parse(records[out].timeIn), overMs,
    }));
    const cards = attendanceDurationControls(records.reverse(), start + 10_000_000, undefined, rows);
    assert.deepEqual(cards.map((card) => card.excessMs), [60_000, 120_000, 60_000]);
    assert.deepEqual(cards.map((card) => card.state), ["done", "done", "done"]);
});

test("policy allowances and matching server excess take precedence", () => {
    const records = pair(960);
    const row = { startedAt: records[0].timeIn, endedAt: records[1].timeIn, durationMs: 950_000, overMs: 120_000 };
    assert.equal(attendanceDurationControls(records, start, undefined, [row])[0].excessMs, 120_000);
    assert.equal(attendanceDurationControls(records, start, undefined, [row])[0].durationMs, 950_000);
    assert.equal(attendanceDurationControls(records, start, undefined, [])[0].excessMs, 0);
    assert.equal(attendanceDurationControls(records, start)[0].excessMs, null);
    assert.equal(attendanceDurationControls(records, start, { breakMinutes: 20, lunchMinutes: 45 })[0].allowanceMinutes, 20);
    assert.equal(attendanceDurationControls([], start, { breakMinutes: 20, lunchMinutes: 45 })[2].allowanceMinutes, 45);
});

test("refreshing edited records changes duration; closed sessions never keep a running timer", () => {
    assert.equal(attendanceDurationControls(pair(900), start)[0].durationMs, 900_000);
    assert.equal(attendanceDurationControls(pair(1200), start)[0].durationMs, 1_200_000);
    const records = [event("Break Out", 0), event("Break In", 900, 1), event("Time Out", 900, 2)];
    assert.deepEqual(attendanceDurationControls(records, start + 999_000), attendanceDurationControls(records, start + 99_999_000));
    const missing = attendanceDurationControls([event("Break Out", 0), event("Time Out", 900)], start + 99_999_000)[0];
    assert.equal(missing.state, "review");
    assert.equal(missing.excessMs, null);
});

test("shift-day counts survive another Time In and never pair returns across sessions", () => {
    const records = [event("Time In", 0), event("Break Out", 100), event("Break In", 1000), event("Time Out", 2000),
        event("Time In", 3000), event("Break Out", 4000)];
    const controls = attendanceDurationControls(records, start + 4_500_000, undefined, []);
    assert.deepEqual(controls.map((control) => control.state), ["done", "active", "available"]);
    const missing = attendanceDurationControls([event("Time In", 0), event("Break Out", 100), event("Time Out", 2000),
        event("Time In", 3000), event("Break In", 4000)], start + 4_500_000);
    assert.equal(missing[0].state, "review");
    assert.equal(missing[1].state, "available");
});

test("cutoff accepts only HH:MM and Auto never infers from a clock time", () => {
    for (const value of ["00:00", "08:05", "23:59"]) assert.equal(validAttendanceCutoff(value), true);
    for (const value of ["", "8:05", "24:00", "08:60", "08:05:00", " 08:05"]) assert.equal(validAttendanceCutoff(value), false);
    assert.equal(hasAutoTimeOut({ events: [{ source: "Time Out", at: "2026-10-20T00:05:00Z" }] }), false);
    assert.equal(hasAutoTimeOut({ autoTimeOut: true, events: [] }), true);
    assert.equal(hasAutoTimeOut({ events: [{ source: "Time Out", autoTimeOut: true }] }), true);
    assert.equal(hasAutoTimeOut({ events: [{ source: "Break In", autoTimeOut: true }] }), false);
});

test("frontend rollout is explicit true only and retains the legacy controls", () => {
    const api = readFileSync(new URL("../src/api/attendanceSession.ts", import.meta.url), "utf8");
    assert.match(api, /attendanceDurationModelEnabled = import\.meta\.env\.VITE_CRM_ATTENDANCE_DURATION_MODEL === "true";/);
    const page = readFileSync(new URL("../src/pages/attendance/index.tsx", import.meta.url), "utf8");
    assert.match(page, /confirmedSession\?\.allowedActions/);
    assert.match(page, /if \(!confirmedSession\?\.allowedActions\) return true/);
    assert.match(page, /confirmedSession\?\.records\.filter\(\(event\) => displayedShiftEventIds\.has\(event\.id\)\)/);
    assert.match(page, /!confirmedSession \|\| sessionQuery\.isError \|\| confirmedSession\.reviewState !== "verified"/);
    assert.match(page, /\{activeBreakRecord && \(/);
    assert.match(page, /attendanceDurationModelEnabled && <div[^>]*aria-label="Break and lunch"/);
    const settings = readFileSync(new URL("../src/pages/admin/settings/index.tsx", import.meta.url), "utf8");
    assert.match(settings, /!attendanceDurationModelEnabled && <>/);
});

test("Break and Lunch keep matching button heights and display their next action", () => {
    const page = readFileSync(new URL("../src/pages/attendance/index.tsx", import.meta.url), "utf8");
    const buttons = page.slice(page.indexOf("const durationButtons ="), page.indexOf("const actionButtons ="));
    assert.match(buttons, /inline-flex h-12 min-w-0 items-center/);
    assert.match(buttons, /const actionLabel = attendanceRestActionLabel\(control\)/);
    assert.match(buttons, /<span>\{actionLabel\}<\/span>/);
    assert.match(buttons, /aria-label=\{`\$\{actionLabel\}: \$\{action\}`\}/);
    assert.doesNotMatch(buttons, /h-32|"Available"|of 2 used|Over by|Excess pending refresh/);
    assert.match(buttons, /aria-pressed=\{active\}/);
});

test("duration layout puts Off the Phone on its own row below Break and Lunch without changing legacy controls", () => {
    const page = readFileSync(new URL("../src/pages/attendance/index.tsx", import.meta.url), "utf8");
    const layout = page.slice(page.indexOf("const displayedMessage ="));
    assert.match(layout, /attendanceDurationModelEnabled \? actionButtons\.filter\(\(button\) => button\.key !== "OFF THE PHONE"\) : actionButtons/);
    assert.ok(layout.indexOf('aria-label="Break and lunch"') < layout.indexOf('aria-label="Off the Phone"'));
    assert.match(layout, /aria-label="Off the Phone">\s*\{attendanceDurationModelEnabled && actionButtons\.filter\(\(button\) => button\.key === "OFF THE PHONE"\)\}/);
    assert.match(layout, /data-attendance-action="NON_BILLABLE_OFF_PHONE"/);
    assert.match(layout, /border-red-600 bg-red-600/);
});
