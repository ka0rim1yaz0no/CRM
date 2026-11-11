import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {runInNewContext} from "node:vm";
import test from "node:test";
import ts from "typescript";
import { mergeAttendanceHistory } from "../src/lib/attendanceSessionCache.ts";

function compiled(file) {
    const source = readFileSync(new URL(file, import.meta.url), "utf8").replaceAll("import.meta.env", "({})");
    const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    return ts.transpileModule(ts.createPrinter().printFile(ts.factory.updateSourceFile(ast, ast.statements.filter(node => !ts.isImportDeclaration(node)))),
        {compilerOptions: {target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS}}).outputText;
}
const gateCode = compiled("../src/lib/callingAttendance.ts"), apiCode = compiled("../src/api/attendanceSession.ts");
const snapshot = (revision = 1, state = "ONLINE") => ({revision, state, fingerprint: String(revision), serverTime: `2026-10-29T00:00:0${revision}Z`});
const deferred = () => {let resolve; const promise = new Promise(done => {resolve = done;}); return {promise, resolve};};
function fixture(business = "synthetic-a") {
    const storage = new Map(), gate = {}, api = {}, gets = [], posts = [];
    let serial = 0, replies = [], auth = {userType: "employee", user: {_id: "synthetic-person", employeeCode: "synthetic-code"}, attendanceHubSession: "synthetic-session"};
    const globals = {Date, Event: class {}, crypto: {randomUUID: () => `synthetic-${++serial}`}, window: {
        localStorage: {getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value)}, dispatchEvent() {},
    }};
    runInNewContext(gateCode, {...globals, exports: gate});
    const read = deferred(), write = deferred();
    runInNewContext(apiCode, {...globals, exports: api, ...gate, getAuthUser: () => auth, getActiveBusinessId: () => business,
        attendanceSessionCacheKey: (...parts) => parts.join(":"), mergeAttendanceHistory, retainAttendanceSnapshot: (cache, key, value) => {cache.set(key, value); return value;},
        api: {get: async (url, options) => {gets.push({url, options}); return {data: replies.length ? replies.shift() : await read.promise};},
            post: async (url, command, options) => {posts.push({url, command, options}); return {data: await write.promise};}},
    });
    return {api, gate, gets, posts, read, write, auth: value => {auth = value;}, replies: values => {replies=values;}};
}
const settle = async () => {for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve));};

test("the actual attendance API holds calling before its initial read and through saved Off the Phone and Coaching responses in six businesses", async () => {
    for (let index = 0; index < 6; index++) for (const source of ["Off the Phone Out", "Coaching Out"]) {
        const state = fixture(`synthetic-${index}`), saving = state.api.performAttendanceAction("synthetic-person", source);
        assert.equal(state.gate.callingAttendanceBlock("synthetic-code"), "Saving attendance");
        state.read.resolve(snapshot()); await settle();
        assert.equal(state.posts.length, 1);
        assert.equal(state.gets[0].options.timeout, 10000); assert.equal(state.posts[0].options.timeout, 10000);
        assert.equal(state.posts[0].options.headers["X-Business-Id"], `synthetic-${index}`);
        assert.equal(state.gate.callingAttendanceBlock("synthetic-code"), "Saving attendance");
        state.write.resolve(snapshot(2, "OFF THE PHONE")); await saving;
        assert.equal(state.gate.callingAttendanceBlock("synthetic-code"), "Employee not ONLINE");
    }
});

test("a response received after an employee identity switch cannot authorize another caller", async () => {
    const state = fixture(), saving = state.api.submitAttendanceCommand("synthetic-person", {commandId: "synthetic-command"});
    state.auth({userType: "employee", user: {_id: "another-person", employeeCode: "another-code"}, attendanceHubSession: "another-session"});
    state.write.resolve(snapshot(2)); await saving;
    assert.equal(state.gate.callingAttendanceBlock("synthetic-code"), "Checking attendance");
});

test("only an active Coaching interval matching the confirmed attendance state permits manual calls", async () => {
    const fixtureState = fixture(), code = "synthetic-code";
    const startedAt = "2026-10-29T00:00:01Z";
    fixtureState.replies([{...snapshot(2, "OFF THE PHONE"), stateSince: startedAt, coachingBilling: {active: {startedAt}}},
        {...snapshot(3, "OFF THE PHONE"), stateSince: "2026-10-29T00:00:03Z", coachingBilling: {active: {startedAt}}}]);
    await fixtureState.api.getAttendanceStatus("synthetic-person");
    assert.equal(fixtureState.gate.callingAttendanceBlock(code, "manual"), "");
    assert.equal(fixtureState.gate.callingAttendanceBlock(code), "Auto Call paused during Coaching");
    const finish = fixtureState.gate.beginCallingAttendanceUpdate(code);
    assert.equal(fixtureState.gate.callingAttendanceBlock(code, "manual"), "Saving attendance");
    finish();
    assert.equal(fixtureState.gate.callingAttendanceBlock(code, "manual"), "Checking attendance");
    await fixtureState.api.getAttendanceStatus("synthetic-person");
    assert.match(fixtureState.gate.callingAttendanceBlock(code, "manual"), /requires Online or Coaching/);
});

test("admin attendance edits never install the edited employee's state in an administrator caller gate", async () => {
    const state = fixture(); state.auth({userType: "admin", user: {employeeCode: "synthetic-admin"}, sessionToken: "synthetic-admin-session"});
    const saving = state.api.submitAttendanceCommand("synthetic-person", {commandId: "synthetic-command"});
    assert.equal(state.gate.callingAttendancePending("synthetic-code"), false);
    state.write.resolve(snapshot(2, "OFFLINE")); await saving;
    assert.equal(state.gate.callingAttendanceBlock("synthetic-code"), "");
});

test("compact calling status coalesces concurrent reads but is refreshed again for the next safety check", async () => {
    for (let index = 0; index < 6; index++) {
        const state = fixture(`compact-${index}`);
        const first = state.api.getAttendanceStatus("synthetic-person"), second = state.api.getAttendanceStatus("synthetic-person");
        assert.equal(state.gets.length, 1); assert.equal(state.gets[0].options.params.view, "status");
        assert.equal(state.gets[0].options.headers["X-Business-Id"], `compact-${index}`);
        state.read.resolve(snapshot()); await first; await second;
        await state.api.getAttendanceStatus("synthetic-person"); assert.equal(state.gets.length, 2);
        const saving = state.api.performAttendanceAction("synthetic-person", "Coaching Out"); await settle();
        assert.equal(state.gets.length, 3, "compact reads cannot populate or erase the full-history cache");
        state.write.resolve(snapshot(2, "OFF THE PHONE")); await saving;
        assert.equal(state.gate.callingAttendanceBlock("synthetic-code"), "Employee not ONLINE");
    }
});

test("an obsolete compact response cannot reopen calling after an account change", async () => {
    const state = fixture();
    state.gate.observeCallingAttendance("synthetic-code",snapshot(2,"OFF THE PHONE"),state.gate.callingAttendanceGeneration("synthetic-code"));
    const pending = state.api.getAttendanceStatus("synthetic-person");
    state.auth({userType:"employee",user:{_id:"other",employeeCode:"other-code"},attendanceHubSession:"other-session"});
    state.read.resolve(snapshot(3)); await pending;
    assert.equal(state.gate.callingAttendanceBlock("synthetic-code"), "Employee not ONLINE");
});

test("the real full-history API merges verified deltas and falls back once with the captured signed business headers", async () => {
    const state=fixture();
    const full={...snapshot(),historyIncluded:true,policyRevision:2,records:[{id:"saved-punch"}],audit:[{commandId:"saved-correction"}],
        sessions:[{id:"session",events:[{id:"saved-punch"}]}],dashboardDays:[{dayKey:"2026-10-29",milliseconds:{online:100}}]};
    const delta={...full,historyIncluded:false,statusOnly:false,serverTime:"2026-10-29T00:00:02Z",records:[],audit:[],sessions:[{id:"session",events:[]}],
        changedDayKeys:["2026-10-29"],dashboardDays:[{dayKey:"2026-10-29",milliseconds:{online:200}}]};
    state.replies([full,delta,{...delta,fingerprint:"mismatch"},{...full,revision:2,fingerprint:"2"}]);
    await state.api.getAttendanceSession("synthetic-person");
    const merged=await state.api.getAttendanceSession("synthetic-person");
    assert.equal(state.gets[1].options.params.knownRevision,1);assert.equal(state.gets[1].options.params.knownPolicyRevision,2);
    assert.equal(merged.records,full.records);assert.equal(merged.audit,full.audit);assert.equal(merged.dashboardDays[0].milliseconds.online,200);
    const fallback=await state.api.getAttendanceSession("synthetic-person");assert.equal(fallback.revision,2);assert.equal(state.gets.length,4);
    assert.equal(state.gets[3].options.params,undefined);assert.equal(state.gets[3].options.headers["X-Business-Id"],"synthetic-a");
    assert.equal(state.gets[3].options.headers["X-CRM-Attendance-Session"],"synthetic-session");
});
