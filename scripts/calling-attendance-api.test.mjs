import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {runInNewContext} from "node:vm";
import test from "node:test";
import ts from "typescript";

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
    let serial = 0, auth = {userType: "employee", user: {_id: "synthetic-person", employeeCode: "synthetic-code"}, attendanceHubSession: "synthetic-session"};
    const globals = {Date, Event: class {}, crypto: {randomUUID: () => `synthetic-${++serial}`}, window: {
        localStorage: {getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value)}, dispatchEvent() {},
    }};
    runInNewContext(gateCode, {...globals, exports: gate});
    const read = deferred(), write = deferred();
    runInNewContext(apiCode, {...globals, exports: api, ...gate, getAuthUser: () => auth, getActiveBusinessId: () => business,
        attendanceSessionCacheKey: (...parts) => parts.join(":"), retainAttendanceSnapshot: (cache, key, value) => {cache.set(key, value); return value;},
        api: {get: async (url, options) => {gets.push({url, options}); return {data: await read.promise};},
            post: async (url, command, options) => {posts.push({url, command, options}); return {data: await write.promise};}},
    });
    return {api, gate, gets, posts, read, write, auth: value => {auth = value;}};
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

test("admin attendance edits never install the edited employee's state in an administrator caller gate", async () => {
    const state = fixture(); state.auth({userType: "admin", user: {employeeCode: "synthetic-admin"}, sessionToken: "synthetic-admin-session"});
    const saving = state.api.submitAttendanceCommand("synthetic-person", {commandId: "synthetic-command"});
    assert.equal(state.gate.callingAttendancePending("synthetic-code"), false);
    state.write.resolve(snapshot(2, "OFFLINE")); await saving;
    assert.equal(state.gate.callingAttendanceBlock("synthetic-code"), "");
});
