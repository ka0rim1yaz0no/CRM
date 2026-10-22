import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

test('bridge reports raw call-state transitions without accessing the installed bridge', { skip: process.platform !== 'win32' }, () => {
    const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', fileURLToPath(new URL('./test-call-bridge-sampling.ps1', import.meta.url))],
        { encoding: 'utf8', timeout: 15000 });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /Synthetic bridge sampling transitions passed/);
});
