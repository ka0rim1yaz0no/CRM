import fs from 'node:fs/promises';
import crypto from 'node:crypto';

const uiOnlyFlags = new Set(['VITE_CRM_PROFILE_V2', 'VITE_CRM_UPDATE_PROMPT']);
const numbers = new Map([['CRM_SECURITY_TRUST_PROXY_HOPS', '1'], ['CRM_SECURITY_LOGIN_IP_MAX', '100'], ['CRM_SECURITY_LOGIN_MAX', '10']]);

export function validateGuardedProfile(profile) {
  if (profile?.version !== 1 || profile.scope !== 'all-configured-businesses' || profile.activation !== 'explicit-quiet-window-required') throw new Error('Invalid guarded release scope');
  for (const name of ['frontend', 'backend']) if (!profile[name] || typeof profile[name] !== 'object' || Array.isArray(profile[name])) throw new Error('Release environments are required');
  for (const [name, value] of Object.entries(profile.frontend)) {
    if (name === 'VITE_API_URL' && value === '/api' || name === 'VITE_SOCKET_URL' && value === '/') continue;
    if (!/^VITE_CRM_[A-Z0-9_]+$/.test(name) || value !== 'true') throw new Error('Unexpected frontend rollout setting');
    if (!uiOnlyFlags.has(name) && profile.backend[name.slice(5)] !== value) throw new Error('Frontend/backend rollout mismatch');
  }
  for (const [name, value] of Object.entries(profile.backend)) {
    if (!/^CRM_[A-Z0-9_]+$/.test(name) || /PASSWORD|SECRET|TOKEN|MONGODB|CREDENTIAL_KEY/.test(name)) throw new Error('Private configuration must remain server-side');
    if (numbers.has(name) ? value !== numbers.get(name) : !['true', 'false'].includes(value)) throw new Error('Unexpected backend rollout setting');
  }
  for (const name of ['VITE_CRM_DASHBOARD_V2', 'VITE_CRM_ATTENDANCE_HUB', 'VITE_CRM_PROFILE_V2', 'VITE_CRM_ATTENDANCE_INTEGRITY', 'VITE_CRM_ATTENDANCE_DURATION_MODEL', 'VITE_CRM_CALL_TIMING_V2', 'VITE_CRM_CALL_DASHBOARD_V2']) {
    if (profile.frontend[name] !== 'true') throw new Error('Required local design/behavior is missing');
  }
  for (const name of ['CRM_PAYROLL_ACCURACY', 'CRM_ATTENDANCE_ACCURACY_FIXES', 'CRM_ATTENDANCE_ACTIVE_SESSION', 'CRM_ATTENDANCE_AUTO_TIMEOUT', 'CRM_ATTENDANCE_STRICT_FLAGS', 'CRM_SECURITY_CREDENTIAL_VAULT', 'CRM_SECURITY_DATA_MINIMIZATION', 'CRM_SECURITY_HARDENING', 'CRM_SECURITY_UPLOAD_AUTH', 'CRM_SECURITY_ENV_CODES', 'CRM_SECURITY_LEGACY_AUTH']) {
    if (profile.backend[name] !== 'true') throw new Error('Required guarded backend feature is missing');
  }
  for (const name of ['CRM_DATA_CHECK_NAV', 'CRM_ATTENDANCE_RECOVERY_CUTOFF', 'CRM_ATTENDANCE_BREAK_GAP']) if (profile.backend[name] !== 'false') throw new Error('An intentionally disabled behavior was changed');
  if (profile.frontend.VITE_API_URL !== '/api' || profile.frontend.VITE_SOCKET_URL !== '/') throw new Error('Production URLs must be same-origin');
  return profile;
}

export async function readGuardedProfile(file = new URL('../release/guarded-profile.json', import.meta.url)) {
  return validateGuardedProfile(JSON.parse(await fs.readFile(file, 'utf8')));
}

export function guardedProfileDigest(profile) { return crypto.createHash('sha256').update(JSON.stringify(validateGuardedProfile(profile))).digest('hex'); }

export function guardedBuildEnvironment(inherited, profile) {
  const environment = Object.fromEntries(Object.entries(inherited).filter(([name]) => !name.startsWith('VITE_')));
  return { ...environment, ...validateGuardedProfile(profile).frontend, NODE_ENV: 'production' };
}
