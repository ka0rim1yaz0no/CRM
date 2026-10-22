import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import ts from 'typescript';
import { CALLING_QUEUE_POLICY_VERSION } from '../shared/leadCallingPolicy.ts';

function fixture(options = {}) {
    let now = Date.parse('2026-10-22T00:00:00.000Z'), sequence = 0, business = 'synthetic-a';
    let responseCode = options.code;
    const stored = new Map(options.paired === false ? [] : [['crm:call-bridge:browser-device-key:v1', 'synthetic-browser-device-key']]);
    const session = new Map(), calls = [];
    const storage = map => ({ getItem: key => map.get(key) || null, setItem: (key, value) => map.set(key, value), removeItem: key => map.delete(key) });
    class Clock extends Date { constructor(value) { super(value === undefined ? now : value); } static now() { return now; } }
    const source = readFileSync(new URL('../src/api/callBridge.ts', import.meta.url), 'utf8');
    const ast = ts.createSourceFile('callBridge.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const transformed = ts.transform(ast, [context => root => {
        const visit = node => ts.isMetaProperty(node) ? ts.factory.createObjectLiteralExpression([
            ts.factory.createPropertyAssignment('env', ts.factory.createObjectLiteralExpression([
                ts.factory.createPropertyAssignment('DEV', ts.factory.createFalse()),
                ts.factory.createPropertyAssignment('VITE_CRM_CALL_TIMING_V2', ts.factory.createStringLiteral('true')),
            ])),
        ]) : ts.visitEachChild(node, visit, context);
        return ts.visitNode(root, visit);
    }]).transformed[0];
    const code = ts.createPrinter().printFile(ts.factory.updateSourceFile(transformed, transformed.statements.filter(node => !ts.isImportDeclaration(node))));
    const exports = {};
    const status = { ready: true, connected: true, state: 'idle', reason: 'Bridge ready', nextCallAllowedAt: '2026-10-22T00:00:30.000Z' };
    runInNewContext(ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText, {
        exports, CALLING_QUEUE_POLICY_VERSION, Date: Clock, crypto: { randomUUID: () => `synthetic-session-${++sequence}` }, backendOrigin: '',
        window: { localStorage: storage(stored), sessionStorage: storage(session) }, getActiveBusinessId: () => business,
        api: {
            post: async (path, body, config) => {
                calls.push({ path, body, config }); const code = responseCode; await options.onPost?.(calls.length);
                if (code) throw { response: { status: code === 'UNAUTHORIZED' ? 403 : 409, data: { code, message: 'Synthetic session conflict' } } };
                return { data: { activated: true, switchable: true, employeeCode: body.employeeCode } };
            },
            get: async () => ({ data: { ...status } }),
        },
    });
    return { api: exports, calls, status, advance: ms => { now += ms; }, setCode: code => { responseCode = code; },
        switchBusiness: id => { business = id; } };
}

for (const code of ['NEWER_BROWSER_SESSION_ACTIVE', 'CALL_BRIDGE_BUSY']) test(`${code} blocks stale auto-call readiness and backs off without replacing the session`, async () => {
    const state = fixture({ code });
    for (let attempt = 0; attempt < 10; attempt++) {
        const result = await state.api.activateCallBridgeForEmployee('synthetic-employee');
        assert.equal(result.activated, false); assert.equal(result.code, code);
    }
    assert.equal(state.calls.length, 1, 'expected conflicts must not issue another request on every polling tick');
    const status = await state.api.getCallBridgeStatus('synthetic-employee');
    assert.equal(status.ready, false); assert.equal(status.reason, 'Synthetic session conflict');
    assert.equal(status.nextCallAllowedAt, state.status.nextCallAllowedAt, 'activation recovery cannot alter the 30-second call deadline');
    state.advance(29_999);
    await state.api.activateCallBridgeForEmployee('synthetic-employee'); assert.equal(state.calls.length, 1);
    state.advance(1);
    await state.api.activateCallBridgeForEmployee('synthetic-employee'); assert.equal(state.calls.length, 2);
    assert.equal(state.calls[0].body.browserSessionId, state.calls[1].body.browserSessionId, 'retry cannot fabricate a newer login to steal the bridge');
});

test('concurrent login, heartbeat and readiness checks share one pending activation and fail closed', async () => {
    let release;
    const waiting = new Promise(resolve => { release = resolve; });
    const state = fixture({ code: 'NEWER_BROWSER_SESSION_ACTIVE', onPost: () => waiting });
    const first = state.api.activateCallBridgeForEmployee('synthetic-employee');
    const duplicate = state.api.activateCallBridgeForEmployee('synthetic-employee');
    let statusResolved = false;
    const status = state.api.getCallBridgeStatus('synthetic-employee').then(value => { statusResolved = true; return value; });
    try {
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(state.calls.length, 1); assert.equal(statusResolved, false);
        release();
        assert.equal((await first).activated, false); assert.equal((await duplicate).activated, false);
        assert.equal((await status).ready, false);
    } finally { release(); await Promise.allSettled([first, duplicate, status]); }
});

test('a successful retry restores readiness, without caching away normal bridge heartbeats', async () => {
    const state = fixture({ code: 'CALL_BRIDGE_BUSY' });
    await state.api.activateCallBridgeForEmployee('synthetic-employee');
    state.setCode(null); state.advance(30_000);
    assert.equal((await state.api.activateCallBridgeForEmployee('synthetic-employee')).activated, true);
    assert.equal((await state.api.getCallBridgeStatus('synthetic-employee')).ready, true);
    await state.api.activateCallBridgeForEmployee('synthetic-employee');
    assert.equal(state.calls.length, 3, 'successful sessions must keep their regular heartbeat');
});

test('an explicit fresh login or another business has its own activation scope', async () => {
    const state = fixture({ code: 'NEWER_BROWSER_SESSION_ACTIVE' });
    await state.api.activateCallBridgeForEmployee('synthetic-employee');
    state.api.beginCallBridgeBrowserSession('synthetic-employee'); state.setCode(null);
    assert.equal((await state.api.activateCallBridgeForEmployee('synthetic-employee')).activated, true);
    assert.notEqual(state.calls[0].body.browserSessionId, state.calls[1].body.browserSessionId);
    state.switchBusiness('synthetic-b');
    assert.equal((await state.api.activateCallBridgeForEmployee('synthetic-employee')).activated, true);
    assert.notEqual(state.calls[1].body.browserSessionId, state.calls[2].body.browserSessionId);
});

test('authorization and unknown conflicts are not disguised as successful activation', async () => {
    for (const code of ['UNAUTHORIZED', 'UNRECOGNIZED_CONFLICT']) {
        const state = fixture({ code });
        await assert.rejects(state.api.activateCallBridgeForEmployee('synthetic-employee'));
        assert.equal((await state.api.getCallBridgeStatus('synthetic-employee')).ready, false);
    }
});

test('legacy unpaired browsers retain existing read-only bridge status behavior', async () => {
    const state = fixture({ paired: false });
    assert.equal((await state.api.activateCallBridgeForEmployee('synthetic-employee')).switchable, false);
    assert.equal(state.calls.length, 0);
    assert.equal((await state.api.getCallBridgeStatus('synthetic-employee')).ready, true);
});

test('rejected ownership becomes a synchronous fence before reserve or physical dial', async () => {
    const state = fixture({ code: 'NEWER_BROWSER_SESSION_ACTIVE' });
    assert.equal(state.api.canUseCallBridgeBrowserSession('synthetic-employee'), true);
    await state.api.activateCallBridgeForEmployee('synthetic-employee');
    assert.equal(state.api.canUseCallBridgeBrowserSession('synthetic-employee'), false);
    state.setCode(null); state.advance(30_000);
    await state.api.activateCallBridgeForEmployee('synthetic-employee');
    assert.equal(state.api.canUseCallBridgeBrowserSession('synthetic-employee'), true);
});

test('a delayed rejection from an old business cannot poison a newer accepted session', async () => {
    let release;
    const waiting = new Promise(resolve => { release = resolve; });
    const state = fixture({ code: 'NEWER_BROWSER_SESSION_ACTIVE', onPost: ordinal => ordinal === 1 ? waiting : undefined });
    const old = state.api.activateCallBridgeForEmployee('synthetic-employee');
    try {
        state.switchBusiness('synthetic-b'); state.setCode(null);
        assert.equal((await state.api.activateCallBridgeForEmployee('synthetic-employee')).activated, true);
        release(); await old;
        assert.equal(state.api.canUseCallBridgeBrowserSession('synthetic-employee'), true);
        assert.equal((await state.api.getCallBridgeStatus('synthetic-employee')).ready, true);
    } finally { release(); await old; }
});

test('a healthy heartbeat in flight does not cancel an already accepted caller', async () => {
    let release;
    const waiting = new Promise(resolve => { release = resolve; });
    const state = fixture({ onPost: ordinal => ordinal === 2 ? waiting : undefined });
    await state.api.activateCallBridgeForEmployee('synthetic-employee');
    const heartbeat = state.api.activateCallBridgeForEmployee('synthetic-employee');
    try { assert.equal(state.api.canUseCallBridgeBrowserSession('synthetic-employee'), true); }
    finally { release(); await heartbeat; }
});

test('activation pins the captured business and signed session, rejecting an obsolete scope', async () => {
    const state = fixture();
    await state.api.activateCallBridgeForEmployee('synthetic-employee', { businessId: 'synthetic-a', employeeSession: 'synthetic-session' });
    assert.equal(state.calls[0].config.headers['X-Business-Id'], 'synthetic-a');
    assert.equal(state.calls[0].config.headers['X-CRM-Attendance-Session'], 'synthetic-session');
    state.switchBusiness('synthetic-b');
    await assert.rejects(state.api.activateCallBridgeForEmployee('synthetic-employee', { businessId: 'synthetic-a', employeeSession: 'synthetic-session' }), /active business changed/);
    assert.equal(state.calls.length, 1, 'an obsolete activation must not be submitted in the new business');
});
