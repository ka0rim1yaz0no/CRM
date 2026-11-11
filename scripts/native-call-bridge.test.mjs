import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import test from 'node:test';
test('native Bridge validates and consumes mocked OS handoffs without calling customers',()=>{
  const result=spawnSync('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File','scripts/test-native-call-bridge.ps1'],{encoding:'utf8',timeout:30000});
  assert.equal(result.status,0,result.stderr);assert.match(result.stdout,/"nativeBridgeMockChecksPassed":true/);
});
