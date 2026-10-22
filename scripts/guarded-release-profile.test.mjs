import assert from 'node:assert/strict';
import { test } from 'node:test';
import { guardedBuildEnvironment, guardedProfileDigest, readGuardedProfile, validateGuardedProfile } from './guarded-release-profile.mjs';

test('prepared profile explicitly matches admin dashboard, attendance, payroll, security and current call guards', async () => {
  const profile = await readGuardedProfile();
  assert.equal(profile.scope, 'all-configured-businesses');
  assert.match(guardedProfileDigest(profile), /^[a-f0-9]{64}$/);
  assert.equal(profile.backend.CRM_DATA_CHECK_NAV, 'false');
});

test('prepared profile rejects missing or mismatched design and attendance switches', async () => {
  for (const change of [value => { delete value.frontend.VITE_CRM_DASHBOARD_V2; }, value => { value.backend.CRM_ATTENDANCE_HUB = 'false'; },
    value => { delete value.backend.CRM_SECURITY_UPLOAD_AUTH; }, value => { value.backend.CRM_ATTENDANCE_RECOVERY_CUTOFF = 'true'; },
    value => { value.backend.CRM_DATA_CHECK_NAV = 'true'; }, value => { value.frontend.VITE_API_URL = 'https://external.invalid/api'; }]) {
    const profile = await readGuardedProfile(); change(profile); assert.throws(() => validateGuardedProfile(profile));
  }
});

test('prepared profile never embeds private runtime configuration or a fixture-specific tenant', async () => {
  for (const change of [value => { value.backend.MONGODB_URI = 'synthetic-uri'; }, value => { value.backend.CRM_ADMIN_SESSION_SECRET = 'synthetic-secret'; },
    value => { value.backend.CRM_CREDENTIAL_KEY = 'synthetic-key'; }, value => { value.scope = 'fixture-a'; }]) {
    const profile = await readGuardedProfile(); change(profile); assert.throws(() => validateGuardedProfile(profile));
  }
});

test('production build strips inherited local Vite values and does not mutate the parent environment', async () => {
  const inherited = { PATH: 'synthetic-path', VITE_BACKEND_PORT: '9999', VITE_CRM_LOCAL_REVIEW: 'true', VITE_API_URL: 'http://localhost:4101', VITE_CRM_ATTENDANCE_HUB: 'false' };
  const result = guardedBuildEnvironment(inherited, await readGuardedProfile());
  assert.equal(result.VITE_API_URL, '/api'); assert.equal(result.VITE_CRM_ATTENDANCE_HUB, 'true');
  assert.equal(result.VITE_CRM_LOCAL_REVIEW, undefined); assert.equal(result.VITE_BACKEND_PORT, undefined);
  assert.equal(inherited.VITE_CRM_ATTENDANCE_HUB, 'false'); assert.equal(result.PATH, 'synthetic-path');
});

test('automatic calling release requires both timing flags on and rejects either off configuration', async () => {
  for (const [frontend, backend] of [['false', 'false'], ['true', 'false'], ['false', 'true']]) {
    const profile = await readGuardedProfile();
    profile.frontend.VITE_CRM_CALL_TIMING_V2 = frontend; profile.backend.CRM_CALL_TIMING_V2 = backend;
    assert.throws(() => validateGuardedProfile(profile));
  }
});
