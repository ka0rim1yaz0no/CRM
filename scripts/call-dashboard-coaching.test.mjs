import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";

const require = createRequire(import.meta.url), exported = {};
let data, offlineEvidence, offlineError = false, offlineQueries = [];
const source = readFileSync(new URL("../src/components/CallDashboardPanel.tsx", import.meta.url), "utf8")
    .replaceAll("import.meta.env", "({VITE_CRM_CALL_DASHBOARD_V2:'true',DEV:false})");
runInNewContext(ts.transpileModule(source, { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX,
} }).outputText, { exports: exported, performance: { now: () => 1000 }, Date, require: name => {
    if (name === "@tanstack/react-query") return { useQuery: () => ({ data, isLoading: false, isError: false }),
        useQueries: ({ queries }) => { offlineQueries = queries; return queries.map(() => ({ data: offlineEvidence, isPending: false, isError: offlineError })); }, useQueryClient: () => ({}) };
    if (name === "../api/callDashboard") return { getCallDashboard: () => assert.fail("Rendering must not call production") };
    if (name === "../lib/socket") return { socket: { connect: () => assert.fail("SSR must not connect") } };
    if (name === "../lib/dateTime") return { formatPhDate: () => "PH shift", formatPhTime: () => "04:00 AM" };
    return require(name);
} });

function render(coaching, business, stale = false, extra = {}, shift) {
    const now = Date.UTC(2026, 9, 30, 18), generatedAt = new Date(now - (stale ? 60_000 : 0)).toISOString();
    data = { business: { id: "synthetic-" + business, name: "Synthetic business" }, generatedAt,
        serverTime: new Date(now).toISOString(), receivedAt: 1000,
        shift: shift || { start: new Date(now - 3_600_000).toISOString(), end: new Date(now + 3_600_000).toISOString() }, employees: [{
            employeeId: "synthetic", businessId: "synthetic-" + business, name: "Synthetic Employee", role: "Sales", team: "Test only", businessName: "Synthetic business",
            status: coaching ? "OFF THE PHONE" : "ONLINE", coachingActive: coaching, statusStartedAt: new Date(now - 300_000).toISOString(),
            offPhoneCompletedMs: 0, offPhoneActiveStartedAt: null, offPhoneNonBillable: false, offPhoneNonBillableFrom: null,
            ...extra,
        }] };
    return renderToStaticMarkup(React.createElement(exported.default, { businessId: data.business.id }));
}

test("refreshed desktop and mobile Call Dashboard show Coaching and its timer in six businesses without non-billable charges", () => {
    for (let business = 0; business < 6; business++) {
        const html = render(true, business);
        assert.equal((html.match(/>COACHING<\/span>/g) || []).length, 2);
        assert.match(html, />00:05:00<\/(?:td|dd)>/);
        assert.doesNotMatch(html, /NON-BILLABLE OFF PHONE/);
        const returned = render(false, business);
        assert.doesNotMatch(returned, />COACHING<\/span>/);
        assert.equal((returned.match(/>CALL WAITING<\/span>/g) || []).length, 2);
    }
});

test("stale Call Dashboard snapshots cannot keep presenting Coaching as confirmed", () => {
    const html = render(true, 0, true);
    assert.match(html, />COACHING<\/span>/);
    assert.match(html, /Call data is stale/);
    assert.doesNotMatch(html, />00:05:00<\/(?:td|dd)>/);
    assert.doesNotMatch(html, /unverified/i);
});

test("unconfirmed bridge states keep Call Waiting and no invented timer without the removed banner", () => {
    const html=render(false,0,false,{status:'UNVERIFIED'});
    assert.equal((html.match(/CALL WAITING<\/span>/g)||[]).length,2);
    assert.doesNotMatch(html,/Some call states need fresh Bridge confirmation/);
    assert.match(html,/Call state unavailable/);
    assert.doesNotMatch(html,/unverified/i);
    assert.doesNotMatch(html,/>00:05:00<\/(?:td|dd)>/);
});

test("Online, Ready and cooldown stages keep one waiting clock across refreshed desktop/mobile views in six businesses",()=>{
    const now=Date.UTC(2026,9,30,18),ended=new Date(now-300000).toISOString();
    for(let business=0;business<6;business++)for(const status of ['ONLINE','READY','CALL WAITING']){
        const html=render(false,business,false,{status,statusStartedAt:new Date(now-10000).toISOString(),waitingStartedAt:ended});
        assert.equal((html.match(/>CALL WAITING<\/span>/g)||[]).length,2);
        assert.match(html,/>00:05:00<\/(?:td|dd)>/);assert.doesNotMatch(html,/>00:00:10<\/(?:td|dd)>/);
        assert.doesNotMatch(html,/>READY<|>ONLINE<|checking calling queue/i);
    }
    const active=render(false,0,false,{status:'ON CALL',statusStartedAt:new Date(now-90000).toISOString(),waitingStartedAt:ended,heartbeatAgeMs:0,bridgeHealth:'fresh'});
    assert.equal((active.match(/>ON CALL<\/span>/g)||[]).length,2);assert.match(active,/>00:01:30<\/(?:td|dd)>/);
});

test("recorded Offline transitions keep elapsed time without extra reads and missing evidence is explicit", () => {
    offlineEvidence = undefined;
    assert.match(render(false,0,false,{status:'OFFLINE'}),/>00:05:00<\/(?:td|dd)>/);
    assert.equal(offlineQueries.length, 0);
    const missing=render(false,0,false,{status:'OFFLINE',statusStartedAt:null});
    assert.doesNotMatch(missing,/>00:05:00<\/(?:td|dd)>/);
    assert.match(missing,/>Unavailable<\/(?:td|dd)>/);
    offlineEvidence = { state: "not-recorded" };
    assert.match(render(false,0,false,{status:'OFFLINE',statusStartedAt:null}),/>Not recorded<\/(?:td|dd)>/);
    offlineEvidence = undefined;
});

test("historical Offline clocks use verified checkout evidence but count only the displayed shift in six businesses", () => {
    const now = Date.UTC(2026,9,30,18);
    offlineEvidence = { state: "recorded", startedAt: new Date(now - 172_923_000).toISOString() };
    for (let business = 0; business < 6; business++) {
        const html = render(false,business,false,{status:'OFFLINE',statusStartedAt:null});
        assert.equal((html.match(/>01:00:00<\/(?:td|dd)>/g) || []).length, 2);
        assert.match(html, /Recorded checkout:/); assert.doesNotMatch(html, /--:--:--/);
        assert.equal(offlineQueries.length, 1);
        assert.equal(offlineQueries[0].queryKey[1], "synthetic-" + business);
        assert.equal(offlineQueries[0].retry, false);
    }
    offlineError = true;
    assert.doesNotMatch(render(false,0,false,{status:'OFFLINE',statusStartedAt:null}),/>01:00:00</);
    offlineError = false;
    assert.doesNotMatch(render(false,0,true,{status:'OFFLINE',statusStartedAt:null}),/>01:00:00</);
    offlineEvidence = { state: "recorded", startedAt: new Date(now + 1000).toISOString() };
    assert.match(render(false,0,false,{status:'OFFLINE',statusStartedAt:null}),/>Unavailable<\/(?:td|dd)>/);
    offlineEvidence = undefined;
});

test("Offline elapsed time is zero outside the active shift after refresh and does not request historical clocks", () => {
    const now = Date.UTC(2026,9,30,18), iso = value => new Date(value).toISOString();
    offlineEvidence = { state: "recorded", startedAt: iso(now - 172_923_000) };
    for (let business = 0; business < 6; business++) {
        const before = render(false,business,false,{status:'OFFLINE',statusStartedAt:null}, {start:iso(now+3_600_000),end:iso(now+32_400_000)});
        assert.equal((before.match(/>00:00:00<\/(?:td|dd)>/g)||[]).length,4);
        assert.equal(offlineQueries.length, 0);
        const after = render(false,business,false,{status:'OFFLINE',statusStartedAt:null}, {start:iso(now-32_400_000),end:iso(now-3_600_000)});
        assert.equal((after.match(/>00:00:00<\/(?:td|dd)>/g)||[]).length,4);
        assert.equal(offlineQueries.length, 0);
        assert.doesNotMatch(after, /48:02:03|09:00:00/);
        const recorded = render(false,business,false,{status:'OFFLINE',statusStartedAt:iso(now-1_800_000)});
        assert.equal((recorded.match(/>00:30:00<\/(?:td|dd)>/g)||[]).length,2);
    }
    offlineEvidence = undefined;
});

test("nine-hour overnight shift clocks reset at the exact end and stay zero before the next shift in all six businesses", () => {
    const now = Date.UTC(2026,9,30,18), iso = value => new Date(value).toISOString();
    for (let business = 0; business < 6; business++) {
        for (const elapsed of [0, 1, 3_600_000, 12 * 3_600_000]) {
            const ended = now - elapsed;
            const shift = { start: iso(ended - 9 * 3_600_000), end: iso(ended) };
            for (const status of ['OFFLINE', 'ONLINE', 'READY', 'CALL WAITING', 'ON CALL', 'BREAK', 'LUNCH', 'OFF THE PHONE']) {
                const html = render(status === 'OFF THE PHONE',business,false,{status,
                    statusStartedAt:iso(ended - 10 * 3_600_000),waitingStartedAt:iso(ended - 10 * 3_600_000)},shift);
                assert.equal((html.match(/>00:00:00<\/(?:td|dd)>/g)||[]).length,4);
                assert.doesNotMatch(html,/>09:00:00</);
                assert.equal(offlineQueries.length, 0);
            }
        }
        const shift = { start: iso(now - 9 * 3_600_000 + 1000), end: iso(now + 1000) };
        const inside = render(false,business,false,{status:'OFFLINE',statusStartedAt:shift.start},shift);
        assert.equal((inside.match(/>08:59:59<\/(?:td|dd)>/g)||[]).length,2);
    }
});

test("Online/Call Waiting, On Call and Coaching never request the historical Offline lookup", () => {
    for (const status of ["ONLINE", "READY", "CALL WAITING", "ON CALL", "BREAK", "LUNCH", "OFF THE PHONE"]) {
        render(status === "OFF THE PHONE",0,false,{status,statusStartedAt:null});
        assert.equal(offlineQueries.length, 0);
    }
    render(false,0,false,{status:"OFFLINE",statusStartedAt:null,businessId:"different-business"});
    assert.equal(offlineQueries.length, 0);
});
test("unavailable calling never shows an apparently verified waiting timer, while rest states remain visible",()=>{
    const html=render(false,0,false,{status:'ONLINE',callStateAvailable:false});
    assert.match(html,/CALL WAITING<\/span>/);assert.doesNotMatch(html,/Some call states need fresh Bridge confirmation/);assert.match(html,/Call state unavailable/);assert.doesNotMatch(html,/>00:05:00<\/(?:td|dd)>/);
    for(const status of ['OFFLINE','BREAK','LUNCH'])assert.match(render(false,0,false,{status,callStateAvailable:false}),new RegExp('>'+status+'<\\/span>'));
});
