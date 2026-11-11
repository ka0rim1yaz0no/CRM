import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import ts from 'typescript';
const source = readFileSync('src/api/leads.ts', 'utf8'), ast = ts.createSourceFile('leads.ts', source, ts.ScriptTarget.Latest, true);
const declaration = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'recordLeadCall');
const code = ts.transpileModule(declaration.getText(ast), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
function fixture(mode) {
    const timers = new Map(), calls = [], exports = {}; let next = 0;
    const window = { setTimeout(callback, ms) { const id = ++next; timers.set(id, { callback, ms }); return id; }, clearTimeout(id) { timers.delete(id); } };
    runInNewContext(code, { exports, window, AbortController, api: { post(...args) { calls.push(args);
        if (mode === 'hang') return new Promise(() => {}); if (mode === 'error') return Promise.reject(Error('Synthetic logging failure'));
        return Promise.resolve({ data: { _id: 'synthetic', comments: [] } }); } } });
    return { calls, timers, log: options => exports.recordLeadCall('synthetic', { callOutcome: 'confirmed' }, options) };
}
test('a transport that never settles cannot hold call logging past its hard deadline or retry the write', async () => {
    const f = fixture('hang'), result = f.log({ timeoutMs: 10000, businessId: 'synthetic-business', employeeSession: 'synthetic-session' });
    const rejection = assert.rejects(result, error => error.code === 'CALL_LOG_TIMEOUT');
    await new Promise(resolve => setImmediate(resolve)); assert.equal(f.timers.size, 1, 'the transport timeout alone cannot protect a stuck coordinator');
    const timer = [...f.timers.values()][0]; assert.equal(timer.ms, 10000); timer.callback(); await rejection;
    assert.equal(f.calls.length, 1); assert.equal(f.calls[0][2].signal.aborted, true); assert.equal(f.timers.size, 0);
    assert.equal(f.calls[0][2].headers['X-Business-Id'], 'synthetic-business');
    assert.equal(f.calls[0][2].headers['X-CRM-Attendance-Session'], 'synthetic-session');
});
test('normal or failed call logging clears its watchdog without changing the result or making another request', async () => {
    const ok = fixture('ok'); assert.equal((await ok.log({}))._id, 'synthetic'); assert.equal(ok.timers.size, 0); assert.equal(ok.calls.length, 1);
    const bad = fixture('error'); await assert.rejects(bad.log({}), /Synthetic logging failure/); assert.equal(bad.timers.size, 0); assert.equal(bad.calls.length, 1);
});
