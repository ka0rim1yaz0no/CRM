# Local / Online Design Parity

Verified October 22, 2026, Asia/Manila. The integrated design on `http://localhost:5173` is authoritative. No online styling, layout, tenant records, private settings or uploads were merged into the prepared source.

## Result

The comparison covered the application route inventory and every exported source/build file, not a claim that every production mutation was clicked.

- 575 selected source files and 300 compiled files were staged separately and checksum-verified: 875 checks passed.
- All 192 frontend/shared/public source files match the deployed source after normalizing text-file line endings. Existing public icon, login video and 3D model assets were preserved. The older online appearance comes from disabled production rollout switches, not a different frontend source tree.
- Two newer backend runtime files differ: `backend/src/middleware/securityHardening.ts` and `backend/src/services/localLegacyAttendanceAdoption.ts`. They remain held because installing them requires a verified API cutover.
- All 53 declared routes were inventoried. All 39 non-parameterized entry pages returned the SPA successfully through the public office connection; the server-local frontend checks also passed. These HTTP checks do not establish that protected data or every button works.
- All 15 visible local admin tabs were opened with synthetic data. They rendered in light mode with no observed page-level horizontal overflow or generic view failure at the current narrow browser viewport. Workspace search navigated to the new Attendance hub; All Shifts loaded the existing synthetic history and showed zero pending deliveries.

## Launch Classification

| Area | Authoritative Local Implementation | Online / Prepared State |
| --- | --- | --- |
| Login and opening | Existing cinematic login, video and 3D logo | Already published; preserved, not redesigned |
| Shared navigation, admin light mode | Current local components and styles | Source already published; no independent frontend patch left to launch |
| Admin dashboard | Integrated workspace, call panel, views, search and call-count layout | Exact local build staged with dashboard switch ON; public activation held for backend parity |
| Admin Attendance | Information hub, shift records, notes/edit popup, first/second break columns, review and delivery panels | Exact local build staged with hub/integrity/duration switches ON; activation held for fresh canonical migration |
| Employee dashboard, profile and attendance | Existing local source, displayed-lead call order and manual controls | Source preserved; profile and canonical attendance changes require matching server switches |
| Payroll, deductions and approval | Shared canonical calculation and concurrency protections | Staged; transaction-capable authoritative database and quiet-window checks still required |
| Payslip, PDF, messages, uploads and sound | Existing local source, image/PDF and media helpers | Source already published; security/upload mode changes remain grouped with the matching server/session rollout |
| Teams, employees, leads, tasks, HR, reports, tracker, knowledge base, media, messages, credentials and settings | Existing local pages | Source parity verified; private production records and write buttons were not exercised |
| Security | Retained private signing/vault configuration, compatible sessions and explicit guards | Non-secret release profile staged; production activation held, no authentication protections bypassed |
| Data Check | Diagnostics available to authorized admins, navigation hidden | Hidden-navigation setting preserved in the prepared profile |

No additional independent public UI patch was needed. Publishing the new dashboard/hub frontend while their APIs remain disabled would produce errors. No live frontend entrypoint, API process, database, Nginx rule, session or employee tab was switched or forcibly refreshed in this comparison.

## Prepared Artifacts

- Release ID: `crm-20261021-prepared` (an immutable preparation ID, not a statement that the release is active).
- Inactive server directory: `/home/ftpuser/assistly/releases/crm-20261021-prepared`.
- Local source/build/config inventory: `outputs/crm-20261021-prepared/release-manifest.json`.
- Source/build comparison: `outputs/crm-20261021-prepared/comparison-report.json`.
- Public entry checks: `outputs/public-entry-checks.json`.
- Local browser checks: `outputs/local-admin-route-checks.json`.
- Central non-secret release configuration: `release/guarded-profile.json`.
- Profile SHA-256: `216e368eeb9458744a5a9cfecc6263d42f2352e35ef2ca194481e38defe89425`.

The prepared frontend uses only the local source and Git-tracked public assets, with local Vite overrides stripped and `.env` loading disabled for this build. Private environment files, uploads, logs, database backups, keys and unrelated untracked images are excluded. No local fixture database was copied online. No GitHub push was performed.

The next activation must use this authoritative local build/profile and a fresh backup/copy batch. Do not blindly rerun the older fixed-path activation helper or route traffic to the stale isolated database. The user will confirm a quiet window at the next break; until then calls remain on the existing public release `crm-20261021-eb493d6`.

## Verification

- `node scripts/prepare-guarded-release.mjs crm-20261021-prepared`: frontend typecheck/build and native backend production build passed.
- `node --test <all scripts/*.test.mjs paths>`: 108 passed.
- From `backend`, `node --import tsx --test --test-concurrency=2 <all src/**/*.test.ts paths>`: 536 passed, two optional external-database skips, zero failures.
- `npm run lint`: passed.
- From `backend`, `npm run test:production`: signed login, privacy, attendance and dashboard smoke passed in two synthetic businesses.

The build still reports large lazy-loaded 3D/editor chunks; that is a performance warning, not a failed build. Current local narrow-viewport checks are not a new full desktop/mobile/browser matrix. Real Nextiva calls, production writes, hardware print dialogs, crash/reboot recovery and every combination of business-specific data were not exercised by this comparison. No bug-free guarantee is implied.
