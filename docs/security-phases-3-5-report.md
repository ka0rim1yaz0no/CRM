# Security Phases 3-5: Local Completion Report

Date: 2026-10-21, Asia/Manila. Phase 0 and Phase 1 are recorded separately. Phase 2 remains skipped as instructed in `security.txt`.

## Boundary

All remaining specified phases were implemented locally. The actual application is running at **http://localhost:5173**, with its loopback backend on port 4101 and disposable synthetic MongoDB on port 27099. No frontend was started on port 5174.

No production server, online CRM, GitHub account/repository setting, Git remote, commit or push was changed. The GitHub Actions YAML was edited as a local file only; no hosted workflow was run. Public upstream documentation was read to verify library options and the scanner commit. Package installs and security checks used the npm registry, not the online CRM.

No `.env` files, real keys, existing uploads, application logs, real employee/customer records, or original local database on port 27017 were inspected. Tests and local examples use identified synthetic fixture data. New fake image files were created deliberately for testing; no real uploaded file was opened.

## Phase 3: Employee Data Minimization

- Login and business-switch responses use an explicit employee-field whitelist. They do not return bank details, personal address/contact notes, salary or the complete database document.
- Employee directory list endpoints default to summaries, including for admins. Personal and bank data are omitted from the default list. A signed full admin may explicitly request `summary=false` when a workflow needs details.
- Full employee profiles require a signed owner attendance session or signed full-admin session. Forged role/code headers are insufficient. Owner-only profile/bank edit guards now use that same signed identity check, preventing their responses from bypassing the read restriction.
- Summary profile requests contain only whitelisted fields. The schema has no government-ID field; future undeclared database fields are not automatically exposed through the whitelist.
- Admin HR and Payroll explicitly request the detailed lists they need. This avoids silently clearing personal/bank fields when an existing edit form saves a list-derived employee.
- The central frontend API now carries the existing signed employee session, preserving own-profile and business-switch workflows. Normal login and business-switch cache clearing was retained.

Files: `backend/src/config/rolloutFlags.ts`, `backend/src/services/employeePrivacy.ts`, `backend/src/controllers/authController.ts`, `backend/src/controllers/employeeController.ts`, `backend/src/services/securityCredentialCompatibility.integration.test.ts`, `src/lib/api.ts`, `src/api/employees.ts`, `src/pages/admin/hr/index.tsx`, `src/pages/admin/payroll/index.tsx`.

Checkpoint: 418 backend tests, 416 passed / 0 failed / 2 existing skips. Backend and frontend typechecks passed after correcting a duplicate summary-option declaration. Three privacy regression cases were added, including an explicit failure when a bank field appears in a non-owner response. Summary means employee summaries in this phase; unrelated lead, task and knowledge-base API contracts were not replaced with invented summary shapes.

## Phase 4: Hardening

- Added Helmet and express-rate-limit. Login permits 10 failed attempts per 15-minute window, independently per IP and per code; successful requests are removed from the failure budget. Lockout returns 429 with Retry-After and expires automatically. Codes are hashed in rate-limit identifiers and are not echoed in errors.
- Other API requests have a moderate per-minute limit. Signed users receive separate buckets so authenticated employees behind one office IP do not all share a single API budget. Anonymous traffic falls back to an IPv6-aware IP bucket.
- The normal request-body default is 2 MB when enabled. Only exact upload handlers receive larger budgets: 70 MB JSON envelopes for 50 MB Media/message/document files, 20 MB for screenshots/photos, and 4 MB for employee profile/create/edit requests supporting existing 2 MB inline profile images. Knowledge-base raw image uploads are limited separately to 20 MB. Existing per-file validation still applies.
- `/uploads` is no longer publicly served when enabled. Legacy raw static paths are full-admin-only because those paths lack resource-level ownership information. Staff screenshot routes accept signed full-admin or tracker sessions, not employee sessions.
- Media, knowledge-base files and message attachments require signed sessions. Employees must belong to the selected business and have an active employee record. Media retains its business-record lookup; message attachments retain conversation-participant checks. A tracker cookie cannot open arbitrary legacy uploads.
- Native image/video/document URLs use an HttpOnly, SameSite=Lax file-session cookie issued after login. Production cookies are Secure. Cookies authenticate file reads only and do not authorize attendance/profile writes. Logout clears the cookie; the next login waits for that clear to avoid a late logout response clearing a new login.
- Knowledge-base/message uploads require a signed session, not forged identity headers. Existing screenshot-agent upload authorization was not replaced with interactive employee login requirements.
- File responses are private/no-store. URL helpers append the selected business without putting a session token in a URL. Legacy knowledge-base images in sanitized rich text are converted to protected file URLs, including inline images, so employee content continues to render.
- Removed built-in tracker/denied employee codes from the authentication/tracker source. Those identities are supplied through environment configuration. Production opt-in requires an explicit `full` classification to elevate a configured admin; an omitted access classification fails closed as tracker-only.
- Updated the vulnerable IP-proxy dependency within its supported dependency range.

Files: `backend/src/app.ts`, `backend/src/config/adminUsers.ts`, `backend/src/config/adminDashboardSession.test.ts`, `backend/src/config/rolloutFlags.ts`, `backend/src/middleware/securityHardening.ts`, `backend/src/middleware/securityFileSession.ts`, `backend/src/middleware/securityHardening.test.ts`, `backend/src/controllers/authController.ts`, `backend/src/controllers/browserActivityController.ts`, `backend/src/controllers/knowledgeBaseController.ts`, `backend/src/controllers/mediaController.ts`, `backend/src/controllers/messageController.ts`, `backend/src/routes/authRoutes.ts`, `backend/src/routes/knowledgeBaseRoutes.ts`, `backend/src/services/payrollUploads.integration.test.ts`, `backend/src/services/credentialVault.integration.test.ts`, `backend/src/services/securityCredentialCompatibility.integration.test.ts`, `backend/src/services/securityPresentation.test.ts`, backend package manifests, `src/api/auth.ts`, `src/api/authStorage.ts`, `src/lib/api.ts`, `src/lib/backendUrl.ts`, `src/lib/fileBusinessUrl.ts`, `src/lib/richText.ts`, and the file URL helpers in:

- `src/pages/admin/tracker/index.tsx`
- `src/pages/admin/knowledge-base/index.tsx`
- `src/pages/admin/knowledge-base/productForm.tsx`
- `src/pages/admin/knowledge-base/announcementForm.tsx`
- `src/pages/admin/knowledge-base/richTextEditor.ts`
- `src/pages/knowledge-base/index.tsx`
- `src/pages/knowledge-base/detail.tsx`
- `src/pages/announcements/index.tsx`

Tests added/extended cover successful/denied/missing/tampered/expired/wrong-role file sessions, unassigned businesses, header spoofing, both rate-limit dimensions, expiry, success budgets, exact body-size exceptions, production defaults, rollback, environment role classification, selected-business file URLs, raw photo upload, protected Media/message downloads and logout/login races. All 16 focused hardening/upload/compatibility tests passed at the first full integration checkpoint; the full checkpoint was 424 tests / 422 passed / 0 failed / 2 existing skips. Two presentation tests and a signed business-switch test were subsequently included in the final full run. Both typechecks passed.

## Phase 5: Build and Repository Hygiene

- Lint is now blocking in the local CI file; no new blanket suppressions were added.
- TruffleHog is pinned to commit `e63326d6545de8f425d93ce24078c6e68d83f70e`, verified against the upstream [v3.99.3 release commit](https://github.com/trufflesecurity/trufflehog/commit/e63326d6545de8f425d93ce24078c6e68d83f70e), instead of `main`. This pins the action revision, not a claim that a hosted secret scan ran locally.
- `npm start` in `backend` compiles with TypeScript then starts `node dist/server.js`. `npm run start:compiled` starts a previously built release without tsx. Build tooling resolves emitted local ESM imports using the TypeScript parser, includes the shared calculation modules, and preserves source `.mjs` worker files. Output stays inside the ignored backend `dist` directory. Generated build output is cleaned only after validating that it is the expected non-redirected build directory.
- A native Node production-entry smoke test starts the real compiled server against its own fresh synthetic replica set. It checks admin/employee login, safe login data, own-profile access, both dashboards and attendance sessions in two businesses. It uses an explicitly nonexistent dotenv configuration path and never loads the real `.env`.
- Removed unused frontend direct dependencies `@google/genai` and `dotenv` after finding no imports in frontend sources, root scripts or Vite configuration. Backend dotenv remains because the real server imports it.
- Updated compatible DOMPurify, source-map-js and tsx/esbuild dependency versions. Both complete package audits now report zero known vulnerabilities. This is a point-in-time registry result, not proof that no vulnerability exists.
- RingCentral files were inventoried, not deleted: [security-ringcentral-inventory.md](security-ringcentral-inventory.md). Old provider branches, no-op monitor status and historical device filters remain distinct from truly unreferenced recording/outcome files.

Files: `.github/workflows/ci.yml`, root/backend package manifests and locks, `backend/tsconfig.build.json`, `backend/scripts/prepare-build.mjs`, `backend/scripts/resolve-built-imports.mjs`, `backend/scripts/production-smoke.mjs`, `backend/src/controllers/knowledgeBaseController.ts` (stable upload location for compiled/source execution), `scripts/credential-vault-ui.test.mjs`, and the security reports.

Build/CI tooling changes are local configuration, not runtime rollout switches. Native production building caught and corrected the shared-module output layout before it was accepted. No hosted CI, deployment or repository secret scan was triggered.

## Final Commands and Real Results

| Directory / command | Result |
| --- | --- |
| `backend`: `node --import tsx --test --test-reporter=spec "src/**/*.test.ts"` | **427 tests: 425 passed, 0 failed, 2 skipped**, 70.11 seconds |
| `backend`: `npm run typecheck` | Passed |
| Root: `npx tsc -b` | Passed |
| Root: `npm run lint` | Passed, zero errors/warnings |
| Root: `node --test scripts/credential-vault-ui.test.mjs scripts/attendance-duration-ui.test.mjs` | **38 passed**, zero failed |
| `backend`: `npm run build:production` | Passed, native ESM output generated |
| `backend`: `node --input-type=module -e "await import('./dist/backend/src/app.js')"` | Passed without tsx |
| `backend`: `npm run test:production` | Passed against the actual compiled production entry and two synthetic businesses |
| Root: `npm run build -- --outDir dist-local-employee-review` | Passed with local API/socket and attendance feature settings; existing rich-text chunk >500 KB warning remains |
| Root and `backend`: `npm audit --json` | Both exited 0, zero known vulnerabilities |
| Root: `git diff --check` | Passed; a Windows CRLF normalization notice is not a diff failure |

The two pre-existing skips still require an externally configured `CRM_INTEGRATION_MONGO_URI`: call-bridge reservation and employee availability integration suites. No external database URI was supplied. New real-Mongo tests use their own disposable replica sets instead.

## Verified on Actual Localhost

A BSON mongodump of all four synthetic databases preceded the restart. All 79 collection counts and the canonical attendance fingerprint matched immediately after restore. The single known dummy vault credential was deliberately re-saved with its same verified dummy value under the new disposable runtime key; no real key was read/exported and no real credential was changed. Do not generalize this fixture-only re-key procedure to persistent credentials.

Fresh HTTP checks through localhost:5173 verified both businesses: safe login/list responses, owner profile success, another employee's full profile denied, dashboard success, protected image denial without authentication, cookie-authenticated image success, raw knowledge-base photo upload, preserved dummy vault reveal and unchanged attendance ledgers. Fake preview images/product entries were added to each synthetic business as examples; no attendance punches were reset or invented.

The existing fake test employee still has 22 effective events in the October 20 overnight shift. Both businesses retain the same first/second short-break durations, one lunch, zero completed break/lunch excess, 94 late minutes, stored payroll and no pending delivery. The existing 08:05 setting and previously seeded auto-checkout evidence remain unchanged; this security work did not alter attendance calculations, buttons or the worker policy.

Browser checks actually observed at desktop 1280x720:

1. Admin login and admin/call dashboards loaded after the final restart.
2. A protected Media image loaded in Sample Operations (`complete=true`, natural width >0).
3. Admin employee details still showed the expected fake salary and employment fields after summary minimization.
4. Admin logout followed by employee login succeeded; employee dashboard and own Profile loaded.
5. The employee's knowledge-base page and detail loaded; a legacy inline image was rewritten to the protected API path, carried `businessId=fixture-b` and loaded successfully.
6. Employee business switch to Sample Studio succeeded with the signed session. Attendance loaded and Refresh kept OFFLINE status, the saved records, the available Time In action and already-consumed Break/Lunch controls.

Proof: `outputs/security-all-phases-attendance.png`. Only synthetic data appears. Browser coverage was the actual in-app browser, not a claim about every browser/device or live telephony. An old local token needed re-login after the intentionally restarted backend; this is expected for the disposable in-memory signing secret.

## Flags and Future Rollout Configuration

All runtime flags below default ON in development/test and OFF in production. The running disposable local app uses development defaults. **No production flags were changed.**

```text
CRM_SECURITY_CREDENTIAL_VAULT=true
CRM_SECURITY_DATA_MINIMIZATION=true
CRM_SECURITY_HARDENING=true
CRM_SECURITY_UPLOAD_AUTH=true
CRM_SECURITY_ENV_CODES=true
CRM_CREDENTIAL_KEY=<retained secure material of at least 32 bytes>
CRM_ADMIN_SESSION_SECRET=<existing retained secure signing material>
CRM_ADMIN_ONE_CODE=<existing configured admin code>
CRM_ADMIN_ONE_ACCESS=full
CRM_ADMIN_TWO_CODE=<configured code if this slot is used>
CRM_ADMIN_TWO_ACCESS=<full or tracker>
CRM_ADMIN_THREE_CODE=<configured code if this slot is used>
CRM_ADMIN_THREE_ACCESS=<full or tracker>
CRM_TRACKER_ADMIN_CODES=<comma-separated tracker-only codes>
CRM_DENIED_EMPLOYEE_CODES=<comma-separated denied employee codes>
```

Do not paste actual keys or codes into chat or Git. Before any future deployment, supply environment tracker/deny lists that preserve the existing policy: the old literal codes are intentionally no longer fallback values in source. In opted-in production, a missing admin access classification does not grant full access.

Optional settings and defaults:

```text
CRM_SECURITY_LOGIN_MAX=10
CRM_SECURITY_LOGIN_WINDOW_MS=900000
CRM_SECURITY_API_MAX=600
CRM_SECURITY_TRUST_PROXY_HOPS=0
REQUEST_BODY_LIMIT=2mb
```

Set trusted proxy hops to 1 only when exactly one trusted reverse proxy is present; the code permits bounded integer values 0-2, not unconditional trust. Per-file limits still apply. An existing explicit REQUEST_BODY_LIMIT overrides the small default and must be reviewed before a hardening rollout. FILE_UPLOAD_LIMIT no longer enlarges every ordinary JSON route when hardening is enabled.

Future rollout order, requiring separate approval: retain a verified database backup and all current keys; configure admin/tracker/deny roles explicitly; build/test with flags off; enable and test vault with its retained key; enable minimization with compatible clients; have users sign in to establish file cookies, then enable file protection; enable body/rate/header hardening with correct proxy and office-traffic budgets; finally enable production environment-role enforcement. Do not perform that rollout from this report automatically.

Emergency rollback can set the applicable CRM_SECURITY_* flag false and restart. Disabling vault/upload protection restores weaker legacy behavior, so it is not a recommended steady state. Keep the original credential encryption key even if the vault flag is off. Disabling the environment-role flag does not resurrect removed literal identity lists; retain their explicit environment configuration. No destructive database migration or bulk apply script was introduced.

## Remaining Limits

- These are the requested security phases, not a complete security certification. Other Phase 0 routes with weak/absent authorization are not silently treated as fixed. Employee directory summaries still follow the existing read-access policy; this phase removes private fields rather than implementing universal API authorization. Code-only employee login remains the requested existing login model and is not strong authentication.
- Rate-limit counters are process-local and reset on restart. A multi-process/multi-server rollout needs a shared rate-limit store and separately tested proxy policy; neither was claimed verified here.
- The existing contradictory `/attendance-hub/live` role checks and legacy per-punch issue counters remain outside this security task. The independently tested employee session/command routes and canonical deductions continue to work.
- Legacy vault plaintext is encrypted on intentional writes, not automatically rewritten by reads. Key rotation and production backup recovery remain untested.
- CI was edited locally but never run on GitHub; no secret-scanner binary was executed over real files/history. The scanner action pin is source-verified only.
- Production/Nginx behavior, HTTPS cookie/proxy behavior, an actual shared-office traffic load, external integration suites, real Nextiva calls and all mobile/browser combinations were not tested live.
- Existing large rich-text bundles remain a build warning, not a test failure. No RingCentral files or historical call records were deleted.

Reminder: make the GitHub repository private and rotate exposed admin/tracker codes through an authorized maintenance process. Those account and online changes were not performed.

## Manual Local Test

Use localhost:5173 only. Synthetic admin is `90000001`; the saved break/lunch test employee is `90000003`.

1. Log out and sign in as the fake admin. Open Dashboard, Employees, HR, Payroll, Credentials and Media. Confirm the protected synthetic image appears in each selected business.
2. In Credentials, Show/Hide the dummy record; edit only its label with password blank, save and refresh.
3. Log out and sign in as the fake employee. Open Profile, Dashboard and Knowledge Base. Open `Synthetic security preview`; its inline image should load.
4. Switch between Sample Studio and Sample Operations, then open Attendance and Refresh. Existing rest tests are already used and intentionally preserved; this work did not reset them.
5. Use isolated test fixtures, not real employee accounts, when testing deliberate login lockouts or forbidden requests.
