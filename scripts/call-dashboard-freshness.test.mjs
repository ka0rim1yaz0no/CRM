import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import ts from 'typescript';
const source = readFileSync(new URL('../src/components/CallDashboardPanel.tsx', import.meta.url), 'utf8');
const ast = ts.createSourceFile('panel.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const declaration = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'visibleStatus');
const exports = {};
runInNewContext(ts.transpileModule(`${declaration.getText(ast)}\nexports.visible = visibleStatus;`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText, { exports, dashboardV2: true, Date });
const at = Date.parse('2026-10-21T19:00:00Z');
const row = { status: 'ON CALL', statusStartedAt: new Date(at - 10000).toISOString(), detail: 'Nextiva call active',
    bridgeHealth: 'fresh', heartbeatAgeMs: 1000 };
const visible = (age, value = row) => exports.visible(value, at + age, at - 3600000, at + 3600000, at);

test('a frozen ON CALL snapshot becomes unverified when its heartbeat evidence expires', () => {
    assert.equal(visible(19000).status, 'ON CALL');
    const stale = visible(19001);
    assert.equal(stale.status, 'UNVERIFIED');
    assert.equal(stale.startedAt, 0, 'a stale call timer must not continue implying a confirmed call');
    assert.match(stale.detail, /refresh|confirm/i);
});

test('fresh calls and manual attendance tags remain unchanged', () => {
    assert.equal(visible(1000).status, 'ON CALL');
    for (const status of ['BREAK', 'LUNCH', 'OFFLINE', 'OFF THE PHONE']) {
        assert.equal(visible(1000, { ...row, status }).status, status);
    }
});

test('a stale attendance snapshot never keeps presenting an old ONLINE or OFFLINE state as current', () => {
    for (const status of ['ONLINE', 'READY', 'BREAK', 'LUNCH', 'OFFLINE', 'OFF THE PHONE']) {
        const stale = visible(45001, { ...row, status });
        assert.equal(stale.status, 'UNVERIFIED');
        assert.equal(stale.startedAt, 0);
    }
});

test('stale bridge metadata cannot show a green ON CALL badge even in a recent API response', () => {
    assert.equal(visible(0, { ...row, bridgeHealth: 'stale' }).status, 'UNVERIFIED');
});
