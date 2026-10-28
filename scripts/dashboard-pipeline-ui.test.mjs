import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";

const exports = {}, require = createRequire(import.meta.url);
const callInsights = {};
runInNewContext(ts.transpileModule(readFileSync(new URL("../src/lib/dashboardCallInsights.ts", import.meta.url), "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText, { exports: callInsights });
runInNewContext(ts.transpileModule(readFileSync(new URL("../src/components/DashboardInsights.tsx", import.meta.url), "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
}).outputText, { exports, require: name => name === "../lib/dashboardCallInsights" ? callInsights : require(name) });
const render = (pipeline, calls = [], policy) => renderToStaticMarkup(exports.default({ data: { calls, policy, trend: [], dashboard: {
    pipeline, agents: [{ newLeads: 7, followUps: 9, qualified: 11 }],
} } }));

test("Insights renders business-wide canonical counts rather than stale per-agent sums for six business fixtures", () => {
    for (let business = 0; business < 6; business++) {
        const html = render({ newLeads: 1, followUps: business + 2, qualified: 3 });
        assert.match(html, /aria-label="New: 1"/);
        assert.match(html, new RegExp(`aria-label="Follow up: ${business + 2}"`));
        assert.match(html, /aria-label="Qualified: 3"/);
        assert.doesNotMatch(html, /aria-label="New: 7"/);
    }
});

test("hour bars run from the shift's 11 PM into midnight without moving or duplicating counts", () => {
    const calls = [{ _id: { hour: 23 }, count: 7, seconds: 0 }, { _id: { hour: 0 }, count: 5, seconds: 0 },
        { _id: { hour: 8 }, count: 99, seconds: 600 }, { _id: { hour: 22 }, count: 90, seconds: 900 }];
    const html = render(undefined, calls);
    assert.ok(html.indexOf('aria-label="11 PM: 7') < html.indexOf('aria-label="12 AM: 5'));
    assert.ok(html.indexOf('aria-label="12 AM: 5') < html.indexOf('aria-label="1 AM: 0'));
    assert.match(html, /12 calls \| Talk time not recorded/); assert.doesNotMatch(html, /0 talk minutes/);
    assert.equal((html.match(/preserveAspectRatio="none"/g) || []).length, 1, "hour bars must share the full-width label grid at every viewport");
    assert.equal((html.match(/tabindex="0"/g) || []).length, 9 + 3);
    assert.doesNotMatch(html, /aria-label="8 AM:|aria-label="10 PM:/);
    assert.match(html, /Shift 11 PM - 8 AM PH/);
    const custom = render(undefined, calls, { shiftStart: "22:30" });
    assert.ok(custom.indexOf('aria-label="10 PM: 0') < custom.indexOf('aria-label="11 PM: 7'));
});

test("short provider-recorded durations are shown as seconds, never rounded down to zero", () => {
    assert.match(render(undefined, [{ _id: { hour: 0 }, count: 1, seconds: 19 }]), /19s recorded talk time/);
    assert.match(render(undefined, [{ _id: { hour: 0 }, count: 1, seconds: 61 }]), /1m 1s recorded talk time/);
    assert.match(render(undefined), /No recorded talk time/);
    assert.deepEqual(Array.from(callInsights.dashboardHourOrder('invalid')), [23, ...Array.from({length:8},(_,i)=>i)]);
});

test("shift-only hour bins follow configured overnight, daytime and full-day boundaries", () => {
    assert.deepEqual(Array.from(callInsights.dashboardHourOrder('23:00','08:00')), [23,0,1,2,3,4,5,6,7]);
    assert.deepEqual(Array.from(callInsights.dashboardHourOrder('08:00','17:00')), [8,9,10,11,12,13,14,15,16]);
    assert.deepEqual(Array.from(callInsights.dashboardHourOrder('22:30','08:00')), [22,23,0,1,2,3,4,5,6,7]);
    assert.equal(callInsights.dashboardHourOrder('00:00','00:00').length,24);
    assert.equal(callInsights.phShiftTimeLabel('22:30'),'10:30 PM');
});

test("authoritative zero values stay zero while legacy responses remain compatible", () => {
    assert.match(render({ newLeads: 0, followUps: 0, qualified: 0 }), /aria-label="New: 0"/);
    assert.match(render(undefined), /aria-label="New: 7"/);
});
