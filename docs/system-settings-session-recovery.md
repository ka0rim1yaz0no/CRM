# System Settings Session Recovery

Local-only change, October 21, 2026. GitHub publication is authorized; online deployment is not.

## Verified Causes

- `ThemeProvider` previously fetched protected `/system-settings` when no user was signed in, including login-page business changes and logout events.
- The API client attached signed sessions but never invalidated an expired session. Protected screens kept polling, and global query defaults retried authorization failures.
- Cached legacy users without a signed token also remained on protected screens. A late failure from an older login must not invalidate a newer signed login.

## Changes

- Theme settings are requested only for a signed-in employee. Its deferred import is checked against the current auth/generation before starting a request. Admin light-mode behavior remains unchanged.
- The legacy authentication middleware adds `CRM_SESSION_REQUIRED` to its existing 401 responses. Authentication, membership and administrator checks remain enforced; system settings are not made public.
- A matching current-session 401 clears local auth once, shows a sign-in message, cancels cached polling, disconnects the socket and rerenders route guards. Existing file-session logout remains bounded. No attendance logout/action is issued, and no failed read or mutation is replayed automatically.
- Authorization failures (401/403) are not retried by the global query defaults. Forbidden actions, invalid employee-code login, integration credential failures and stale responses from another signed login do not expire a valid current session.
- Cross-tab auth removal clears the affected tab's caches/socket. Public login and business selection remain accessible. Older middleware messages are recognized for compatibility.
- Added the frontend recovery regressions to the existing checks-only CI workflow. There is no deploy step.

## Verification

- `npm run typecheck --prefix backend`: passed.
- `npm test --prefix backend` with the existing cached synthetic Mongo executable: 532 tests, 530 passed, two optional external-Mongo tests skipped, zero failures.
- `node --test scripts/*.test.mjs`: 71 passed, zero failures.
- `npm run lint`, `npm run build`, `npm run build:production --prefix backend`: passed. The existing large rich-text-editor bundle warning remains.
- Backend fixtures cover valid admin, tracker and employee settings reads in assigned businesses; invalid tokens return the explicit 401 code, employees cannot PUT settings, and an unassigned business remains forbidden. Refreshes/failures do not write attendance.
- Frontend tests cover once-only invalidation, old-response/new-login races, legacy tokenless users, employee/tracker token matching, authorization retry policy, anonymous theme requests, cross-tab cleanup and route wiring.
- The four isolated local databases were dumped before the localhost restart. Backup: `outputs/security-phase1-fixture-1792537558479`. Attendance evidence/derived snapshots and entire saved payroll fingerprints remained unchanged through restart and read-only previews in both sample businesses.
- Browser check: the old signed session returned to the login page after the local server restarted. Normal admin sign-in then opened the populated dashboard and System settings in Sample Operations; business switching to Sample Studio and a full reload retained authorized settings access. Employee login, its populated dashboard and the unchanged ten-record current shift were also inspected. No configuration save or attendance action was clicked. Proofs: `outputs/session-expired-local-login.png`, `outputs/system-settings-authorized-local.png`, `outputs/session-settings-employee-attendance-local.png` (ignored, local only).

## Limits and Manual Check

A genuinely expired or server-invalidated session can still receive one initial 401. The fix stops continuing with that invalid session; it does not bypass authentication or silently renew a login using an employee code. Concurrent requests already sent before expiry may also fail. Browser extension/integration authentication is separate.

On `http://localhost:5173`, sign in, open Settings > System, switch businesses, and refresh. Check the employee attendance page without pressing any action unless testing a disposable shift. On session expiry, sign in again once and verify normal settings/dashboard access resumes. Saved attendance and payroll must not change merely from refreshing. No production behavior or live data was inspected.
