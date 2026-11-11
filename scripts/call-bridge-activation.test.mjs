import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import ts from 'typescript';
import path from 'node:path';
import { CALLING_QUEUE_POLICY_VERSION } from '../shared/leadCallingPolicy.ts';

function fixture(options = {}) {
    let now = Date.parse('2026-10-22T00:00:00.000Z'), sequence = 0, business = 'synthetic-a';
    let responseCode = options.code;
    const stored = new Map(options.paired === false ? [] : [['crm:call-bridge:browser-device-key:v1', 'synthetic-browser-device-key']]);
    const session = new Map(), calls = [], reads = [], timers = new Map();
    let actor = { userType: 'employee', attendanceHubSession: 'synthetic-session', user: { employeeCode: 'synthetic-employee', name: 'Synthetic' } };
    let nextTimer = 0;
    const storage = map => ({ getItem: key => map.get(key) || null, setItem: (key, value) => map.set(key, value), removeItem: key => map.delete(key) });
    class Clock extends Date { constructor(value) { super(value === undefined ? now : value); } static now() { return now; } }
    const source = readFileSync(options.sourceFile || new URL('../src/api/callBridge.ts', import.meta.url), 'utf8');
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
        exports, CALLING_QUEUE_POLICY_VERSION, AbortController, Date: Clock, crypto: { randomUUID: () => `synthetic-session-${++sequence}` }, backendOrigin: '',
        window: { localStorage: storage(stored), sessionStorage: storage(session),
            setTimeout: (callback, delay) => { const id = ++nextTimer; timers.set(id, { callback, at: now + delay }); return id; },
            clearTimeout: id => timers.delete(id) }, getActiveBusinessId: () => business, getAuthUser: () => actor,
        api: {
            post: async (path, body, config) => {
                calls.push({ path, body, config }); const code = responseCode; await options.onPost?.(calls.length);
                if (code) throw { response: { status: code === 'UNAUTHORIZED' ? 403 : 409, data: { code, message: 'Synthetic session conflict' } } };
                return { data: { activated: true, switchable: true, employeeCode: body.employeeCode } };
            },
            get: async (path, config) => { reads.push({ path, config }); await options.onRead?.(reads.length, config); return { data: { ...status } }; },
        },
    });
    return { api: exports, calls, reads, status, timers, advance: ms => { now += ms; for (const [id, timer] of timers) if (timer.at <= now) { timers.delete(id); timer.callback(); } }, setCode: code => { responseCode = code; },
        switchBusiness: id => { business = id; }, session: token => { actor = { ...actor, attendanceHubSession: token }; } };
}

test('equivalent concurrent status readers share one request but completed reads are never cached', async () => {
    let release; const gate = new Promise(resolve => { release = resolve; });
    const state = fixture({ onRead: () => gate });
    const first = state.api.getCallBridgeStatus('synthetic-employee', { timeoutMs: 5000 });
    const second = state.api.getCallBridgeStatus('synthetic-employee', { timeoutMs: 10000 });
    try {
        await new Promise(resolve => setImmediate(resolve)); assert.equal(state.reads.length, 1);
        release(); const values = await Promise.all([first, second]); assert.equal(values[0].ready, true); assert.equal(values[1].ready, true);
        state.status.ready = false; assert.equal((await state.api.getCallBridgeStatus('synthetic-employee')).ready, false);
        assert.equal(state.reads.length, 2, 'the next read must recheck current server state');
    } finally { release(); await Promise.allSettled([first, second]); }
});

test('manual and automatic status reads do not share a response', async () => {
    let release; const gate = new Promise(resolve => { release = resolve; });
    const state = fixture({ onRead: () => gate });
    const reads = [state.api.getCallBridgeStatus('synthetic-employee'), state.api.getCallBridgeStatus('synthetic-employee', { mode: 'manual' })];
    try {
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(state.reads.length, 2);
        assert.equal(state.reads[0].config.params.mode, undefined);
        assert.equal(state.reads[1].config.params.mode, 'manual');
    } finally { release(); await Promise.allSettled(reads); }
});

test('one status reader timing out cannot abort another caller, and a hung transport cannot pin future reads', async () => {
    let release; const gate = new Promise(resolve => { release = resolve; });
    const state = fixture({ onRead: ordinal => ordinal === 1 ? gate : undefined });
    const first = state.api.getCallBridgeStatus('synthetic-employee', { timeoutMs: 2000 }).then(() => false, () => true);
    const second = state.api.getCallBridgeStatus('synthetic-employee', { timeoutMs: 5000 }).then(() => false, () => true);
    try {
        await new Promise(resolve => setImmediate(resolve)); assert.equal(state.reads.length, 1);
        state.advance(2000); await new Promise(resolve => setImmediate(resolve)); assert.equal(await first, true);
        assert.equal(state.reads[0].config.signal.aborted, false);
        state.advance(3000); await new Promise(resolve => setImmediate(resolve)); assert.equal(await second, true);
        assert.equal(state.reads[0].config.signal.aborted, true);
        assert.equal(state.timers.size, 0, 'all-consumer cancellation must release the hard watchdog too');
        assert.equal((await state.api.getCallBridgeStatus('synthetic-employee')).ready, true); assert.equal(state.reads.length, 2);
    } finally { release(); await Promise.allSettled([first, second]); }
});

test('a stalled default status read expires at ten seconds and a failed response is never cached', async () => {
    const state = fixture({ onRead: ordinal => ordinal === 1 ? new Promise(() => {}) : ordinal === 2 ? Promise.reject(new Error('Synthetic reset')) : undefined });
    let timedOut = false;
    const pending = state.api.getCallBridgeStatus('synthetic-employee').catch(error => { timedOut = error.code === 'CALL_BRIDGE_STATUS_TIMEOUT'; });
    await new Promise(resolve => setImmediate(resolve));
    state.advance(9999); await new Promise(resolve => setImmediate(resolve)); assert.equal(timedOut, false);
    state.advance(1); await pending; assert.equal(timedOut, true); assert.equal(state.timers.size, 0);
    await assert.rejects(state.api.getCallBridgeStatus('synthetic-employee'), /Synthetic reset/);
    assert.equal((await state.api.getCallBridgeStatus('synthetic-employee')).ready, true); assert.equal(state.reads.length, 3);
});

test('twenty simulated browsers reduce concurrent status traffic without caching readiness, changing deadlines or writing records', async context => {
    const browsers = 20, rounds = 3, readers = 3;
    const countRequests = async sourceFile => {
        let requests = 0;
        for (let index = 0; index < browsers; index++) {
            let release; const state = fixture({ sourceFile, onRead: () => new Promise(resolve => { release = resolve; }) });
            state.switchBusiness(`synthetic-${index % 6}`);
            for (let round = 0; round < rounds; round++) {
                const releases = [];
                // Give each simulated reader a gate, including the uncoalesced baseline readers.
                const reading = [];
                for (let reader = 0; reader < readers; reader++) {
                    reading.push(state.api.getCallBridgeStatus('synthetic-employee'));
                    await new Promise(resolve => setImmediate(resolve)); releases.push(release);
                }
                releases.forEach(resolve => resolve()); const results = await Promise.all(reading);
                assert.ok(results.every(result => result.nextCallAllowedAt === state.status.nextCallAllowedAt && result.ready === state.status.ready));
                state.status.ready = !state.status.ready;
            }
            requests += state.reads.length; assert.equal(state.calls.length, 0); assert.equal(state.timers.size, 0);
        }
        return requests;
    };
    const uncoalescedRequests = browsers * rounds * readers;
    const statusRequests = await countRequests();
    assert.equal(statusRequests, browsers * rounds);
    const baselineSource = process.env.CRM_STATUS_BASELINE_SOURCE;
    if (baselineSource) {
        assert.equal(await countRequests(path.join(baselineSource, 'src/api/callBridge.ts')), uncoalescedRequests);
    }
    context.diagnostic(JSON.stringify({ syntheticBrowsers: browsers, businessScopes: 6, rounds, uncoalescedRequests, statusRequests, completedStatusCache: false, callsPlaced: 0, productionWrites: 0 }));
});

test('status reads never coalesce across signed sessions, employees, businesses or browser bindings', async () => {
    let release; const gate = new Promise(resolve => { release = resolve; });
    const state = fixture({ onRead: () => gate }), pending = [];
    try {
        pending.push(state.api.getCallBridgeStatus('synthetic-employee')); await new Promise(resolve => setImmediate(resolve));
        state.session('new-synthetic-session'); pending.push(state.api.getCallBridgeStatus('synthetic-employee')); await new Promise(resolve => setImmediate(resolve));
        pending.push(state.api.getCallBridgeStatus('synthetic-other')); await new Promise(resolve => setImmediate(resolve));
        state.switchBusiness('synthetic-b'); pending.push(state.api.getCallBridgeStatus('synthetic-employee')); await new Promise(resolve => setImmediate(resolve));
        state.api.beginCallBridgeBrowserSession('synthetic-employee'); pending.push(state.api.getCallBridgeStatus('synthetic-employee'));
        await new Promise(resolve => setImmediate(resolve)); assert.equal(state.reads.length, 5);
    } finally { release(); await Promise.allSettled(pending); }
});

test('a stalled shared activation expires and recovers in six businesses without refreshing or replacing the browser session', async () => {
    for (let index = 0; index < 6; index++) {
        let complete;
        const gate = new Promise(resolve => { complete = resolve; });
        const state = fixture({ onPost: ordinal => ordinal === 1 ? gate : undefined });
        state.switchBusiness(`synthetic-recovery-${index}`);
        let settled = false;
        const first = state.api.activateCallBridgeForEmployee('synthetic-employee', { timeoutMs: 3000 }).then(() => { settled = true; return false; }, () => { settled = true; return true; });
        const shared = state.api.activateCallBridgeForEmployee('synthetic-employee', { timeoutMs: 10000 }).catch(() => null);
        try {
            await new Promise(resolve => setImmediate(resolve)); assert.equal(state.calls.length, 1);
            state.advance(2999); await new Promise(resolve => setImmediate(resolve)); assert.equal(settled, false);
            state.advance(1); await new Promise(resolve => setImmediate(resolve));
            assert.equal(settled, true, 'a stalled transport must not pin every later caller until browser refresh');
            assert.equal(await first, true); await shared;
            assert.equal(state.calls[0].config.signal.aborted, true);
            assert.equal((await state.api.getCallBridgeStatus('synthetic-employee')).ready, false);
            assert.equal((await state.api.activateCallBridgeForEmployee('synthetic-employee')).activated, true);
            assert.equal(state.calls.length, 2);
            assert.equal(state.calls[0].body.browserSessionId, state.calls[1].body.browserSessionId);
            complete(); await new Promise(resolve => setImmediate(resolve));
            const status = await state.api.getCallBridgeStatus('synthetic-employee');
            assert.equal(status.ready, true); assert.equal(status.nextCallAllowedAt, state.status.nextCallAllowedAt);
        } finally { complete(); await Promise.allSettled([first, shared]); }
    }
});

test('successful activation is shared for ten seconds without extending the authoritative call deadline', async () => {
    const state = fixture();
    for (let index = 0; index < 100; index++) assert.equal((await state.api.activateCallBridgeForEmployee('synthetic-employee')).activated, true);
    assert.equal(state.calls.length, 1); const deadline = state.status.nextCallAllowedAt;
    state.advance(9999); await state.api.activateCallBridgeForEmployee('synthetic-employee'); assert.equal(state.calls.length, 1);
    state.advance(1); await state.api.activateCallBridgeForEmployee('synthetic-employee'); assert.equal(state.calls.length, 2);
    assert.equal(state.status.nextCallAllowedAt, deadline);
    state.setCode('NEWER_BROWSER_SESSION_ACTIVE'); state.advance(10000);
    assert.equal((await state.api.activateCallBridgeForEmployee('synthetic-employee')).activated, false);
    assert.equal(state.api.canUseCallBridgeBrowserSession('synthetic-employee'), false);
});

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
    const retryMs = code === 'CALL_BRIDGE_BUSY' ? 5000 : 30000;
    state.advance(retryMs - 1);
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

test('a successful retry restores readiness and keeps a bounded browser-binding renewal', async () => {
    const state = fixture({ code: 'CALL_BRIDGE_BUSY' });
    await state.api.activateCallBridgeForEmployee('synthetic-employee');
    state.setCode(null); state.advance(30_000);
    assert.equal((await state.api.activateCallBridgeForEmployee('synthetic-employee')).activated, true);
    assert.equal((await state.api.getCallBridgeStatus('synthetic-employee')).ready, true);
    await state.api.activateCallBridgeForEmployee('synthetic-employee');
    assert.equal(state.calls.length, 2, 'duplicate successful activation is shared within ten seconds');
    state.advance(10000); await state.api.activateCallBridgeForEmployee('synthetic-employee');
    assert.equal(state.calls.length, 3, 'the browser binding renews before its thirty-second freshness limit');
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
    state.advance(10000);
    const heartbeat = state.api.activateCallBridgeForEmployee('synthetic-employee');
    try { assert.equal(state.calls.length, 2); assert.equal(state.api.canUseCallBridgeBrowserSession('synthetic-employee'), true); }
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
