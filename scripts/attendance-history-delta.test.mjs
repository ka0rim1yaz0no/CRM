import assert from "node:assert/strict";
import test from "node:test";
import { mergeAttendanceHistory, retainAttendanceSnapshot, attendanceSessionCacheKey } from "../src/lib/attendanceSessionCache.ts";

const history = () => ({ revision: 5, fingerprint: "synthetic-evidence", policyRevision: 2, historyIncluded: true,
    serverTime: "2026-10-30T23:59:00.000Z", receivedAt: 1, records: [{id:"old-punch"},{id:"current-punch"}], audit: [{commandId:"original-correction"}],
    sessions: [{id:"old",events:[{id:"old-punch"}],time:{scheduled:{online:123}}},{id:"current",events:[{id:"current-punch"}],time:{scheduled:{online:100}}}],
    dashboardDays: [{dayKey:"2026-10-29",milliseconds:{online:123}},{dayKey:"2026-10-30",milliseconds:{online:100}}] });
const delta = () => ({...history(),historyIncluded:false,statusOnly:false,serverTime:"2026-10-31T00:00:00.000Z",records:[],audit:[],
    sessions:[{id:"old",events:[],time:{scheduled:{online:123}}},{id:"current",events:[],time:{scheduled:{online:160}}}],
    changedDayKeys:["2026-10-30"],dashboardDays:[{dayKey:"2026-10-30",milliseconds:{online:160}}]});

test("confirmed deltas update current time while preserving exact historical punches, corrections and closed days in six scopes", () => {
    const cache = new Map();
    for(let index=0;index<6;index++) {
        const before=history(),beforeJson=JSON.stringify(before),incoming=delta();
        const merged=mergeAttendanceHistory(before,incoming);assert.ok(merged);
        assert.equal(merged.records,before.records);assert.equal(merged.audit,before.audit);
        assert.equal(merged.sessions[0].events,before.sessions[0].events);assert.equal(merged.sessions[1].time.scheduled.online,160);
        assert.equal(merged.dashboardDays[0],before.dashboardDays[0]);assert.equal(merged.dashboardDays[1].milliseconds.online,160);
        assert.equal(merged.historyIncluded,true);assert.equal(JSON.stringify(before),beforeJson);
        const key=attendanceSessionCacheKey("own-session",`business-${index}`,"person");retainAttendanceSnapshot(cache,key,merged,99);
        assert.equal(cache.get(key).receivedAt,99);
    }
    assert.equal(cache.size,6);
});

test("wrong revision, policy, evidence, session membership or day coverage never silently becomes an empty history", () => {
    for(const change of [{revision:6},{fingerprint:"different"},{policyRevision:3},{statusOnly:true},{sessions:[]},
        {changedDayKeys:[]},{dashboardDays:[]},{changedDayKeys:["2026-10-29"]}]) {
        assert.equal(mergeAttendanceHistory(history(),{...delta(),...change}),null);
    }
    assert.equal(mergeAttendanceHistory(undefined,delta()),null);
    assert.equal(mergeAttendanceHistory({...history(),historyIncluded:false},delta()),null);
    const full=history();assert.equal(mergeAttendanceHistory(undefined,full),full);
});

test("a late read cannot replace newer canonical evidence or move server time backward", () => {
    const cache=new Map(),key="synthetic";
    retainAttendanceSnapshot(cache,key,{...history(),revision:6},10);
    retainAttendanceSnapshot(cache,key,history(),20);
    assert.equal(cache.get(key).revision,6);assert.equal(cache.get(key).receivedAt,10);
    retainAttendanceSnapshot(cache,key,{...history(),revision:6,serverTime:"2026-10-31T01:00:00.000Z"},30);
    retainAttendanceSnapshot(cache,key,{...history(),revision:6},40);
    assert.equal(cache.get(key).serverTime,"2026-10-31T01:00:00.000Z");assert.equal(cache.get(key).receivedAt,30);
});

test("revision-zero history can merge only with matching actual policy fingerprints", () => {
    const previous={...history(),policyRevision:0,policyFingerprint:'a'.repeat(64)},incoming={...delta(),policyRevision:0,policyFingerprint:'a'.repeat(64)};
    const merged=mergeAttendanceHistory(previous,incoming);assert.ok(merged);assert.equal(merged.records,previous.records);
    assert.equal(merged.policyFingerprint,previous.policyFingerprint);
    for(const altered of [{policyFingerprint:'b'.repeat(64)},{policyFingerprint:undefined}])assert.equal(mergeAttendanceHistory(previous,{...incoming,...altered}),null);
    assert.equal(mergeAttendanceHistory({...previous,policyFingerprint:undefined},incoming),null);
    assert.equal(mergeAttendanceHistory({...history(),policyFingerprint:'a'.repeat(64)},{...delta(),policyFingerprint:'b'.repeat(64)}),null);
});
