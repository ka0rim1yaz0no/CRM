import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

test('native Bridge validates and consumes mocked OS handoffs without calling customers', () => {
  const windows = process.platform === 'win32';
  const args = ['-NoLogo', '-NoProfile', '-NonInteractive'];
  if (windows) args.push('-ExecutionPolicy', 'Bypass');
  args.push('-File', fileURLToPath(new URL('./test-native-call-bridge.ps1', import.meta.url)));
  const result = spawnSync(windows ? 'powershell.exe' : 'pwsh', args, { encoding: 'utf8', timeout: 30000 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /"nativeBridgeMockChecksPassed":true/);
});
