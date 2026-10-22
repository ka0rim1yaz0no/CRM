# Lead Workspace Activation, October 23, 2026

## Live Release

- Release: `crm-20261023-prepared-workspace3`.
- Features first activated at 04:46:38 Asia/Manila; the optimized backend followed at 04:56:51 on October 23, 2026.
- Public `/release.json` confirms this release; public `/api/health` returns `ok`.
- All six authorized business databases remain on the existing authoritative CRM replica set. No database was copied or restored.
- 619 source files and 320 build files were hash-verified before final activation.
- Login design, attendance calculations, payroll calculations, existing sessions, and Call Bridge package were retained from the local integrated release.

## Features

- Full normalized telephone numbers determine canonical active logical leads before pagination, counts, and automatic-call selection. Different business names, addresses, or provider IDs do not defeat telephone matching. Separate tenant databases never share a canonical identity.
- Due callbacks retain priority, followed by eligible NEW leads and then unscheduled Follow up leads. Historical records and ownership are not merged or transferred.
- New/changed phone identities are protected on save, insertion, provider upsert, bulk insertion, update, and restoration. A partial unique `active_phone_key_unique` index was added in each business. Existing valid records were not backfilled.
- Employee bulk archive requires a signed employee session, validates every selected ID, allows at most 100 selected IDs, preserves other owners, skips busy/changed records, and saves required notes first. History remains stored.
- Admin Shift Records are a flat Employee + Date table, including employees with no event records. Date/history controls, pagination, columns, density, day details, notes and edit dialogs are retained. No fake attendance events were created.
- The authorized auto-call lead now opens in Lead Details before launching the phone link. The caller remains mounted across page changes so navigation does not cancel confirmation. Refresh restores an observed active lead without redialing. Navigation snapshots are scoped to the employee and business.
- A bounded phone-normalization memo and tenant-scoped two-second fact cache avoid repeated full scans. Concurrent reads share one pending scan. Local writes and committed lead-change notifications invalidate facts immediately. Due-callback winners are recalculated on every request, not cached as time-dependent decisions. Writes from another retained process may take up to two seconds to appear in cached canonical facts; dispatch still verifies live ownership and the phone reservation fence.

## Approved Cleanup

- Exact plan: `phone-dedup-20261022-bb341c5dcc8e`.
- Plan SHA256: `44a709338e3424cd5f3e82ad43554d326c48f9599bdd91d0d44f69ef944fd84d`.
- User approved at most 194 non-conflicting extra records, separately from feature deployment.
- Fresh AES-256-GCM encrypted MongoDB backup with oplog was decrypted and hash-verified before writes. Its private receipt and recovery key stay on the server, not in this repository.
- Actual soft archives: 17 Next Gen Vending, 5 Order THCA, 164 HILT; total **186**.
- Eight HILT extras changed after the dry run and were skipped. No busy group was changed. The other 4,913 review extras remain untouched.
- Every group used a transaction, exact fingerprint/revision checks and the existing dispatch fence. Original comments, call history, schedules, ownership and business information remain stored. Only duplicate archival metadata, status and audit/fence fields were added.

## Verification

All commands below exited 0:

```powershell
npx tsc -b --pretty false
npx tsc --noEmit --pretty false # backend directory
npm run lint
npx tsx --test --test-concurrency=2 --test-reporter=dot "src/**/*.test.ts" # backend
npx tsx --test --test-reporter=spec src/services/leadPhoneWorkspace.integration.test.ts src/config/leadWorkspaceRuntime.test.ts src/services/leadPhonePolicy.test.ts # backend: 14 passed
npx tsx --test --test-reporter=spec src/config/leadWorkspaceRuntime.test.ts # final runtime switch: 1 passed
node --test scripts/calling-workflow.test.mjs scripts/calling-queue-policy.test.mjs scripts/lead-reassignment.test.mjs scripts/lead-phone-cleanup.test.mjs # 17 passed
node scripts/prepare-guarded-release.mjs crm-20261023-prepared-workspace2 --code-only
node scripts/prepare-guarded-release.mjs crm-20261023-prepared-workspace3 --code-only
node scripts/current-call-display-browser.mjs outputs/crm-20261023-prepared-workspace1/dist
node scripts/lead-workspace-browser.mjs outputs/crm-20261023-prepared-workspace1/dist
git diff --check
```

All three workspace builds have identical frontend asset hashes. The second release extended the private server switch to start workers separately; the third added backend-only read optimization. The full backend suite was rerun after that optimization and passed. The cache/phone/workspace focused suite passed 15 tests; cache/assignment/calling-queue regressions passed 29 tests.

- Current-call browser tests: six sample businesses, desktop and mobile, exact dialed lead opened, next lead opened, refresh did not redial, navigation preserved confirmation/logging, zero real telephone launches.
- Workspace browser tests: employee and admin in six sample businesses, desktop and mobile, required-note failure prevented archive and retained draft, successful archive survived refresh, flat table retained no-record employees and date/history controls, zero page errors.
- Signed candidate checks: 121 passed, three administrator logins, 38 employee attendance sessions, 20 sales queues, six businesses. Covered settings authorization, attendance, payroll configuration/records, dashboards, canonical queue scope and duplicate-phone exclusion. No test attendance changes, payroll approvals or provider calls were made in production.
- Online UI: the admin Attendance table visibly has Employee + Date + existing attendance columns, no Expand/Collapse All controls, and light mode enabled.
- Final post-switch checks: 71 passed across all six businesses, including signed login, features, attendance, payroll, dashboards and representative employee queues. A pending synchronization encountered during the first post-switch sweep was rechecked after delivery; the subsequent full 121-check candidate sweep and 71-check final sweep passed without changing employee attendance records.
- Measured final sweep maxima included attendance reads at 3.976 seconds, dashboard summary at 4.495 seconds, and employee queues at 2.713 seconds under live load. These are not latency guarantees. Some cold reads remain slower than desired; physical hang-up-to-dial timing was not measured.
- Build has existing large-chunk warnings. No claim of physical Nextiva timing measurement is made: no consenting test caller was available and no customer call was placed for testing.

## Non-Interrupting Rollout

New loopback API/frontend processes were started and verified separately. Nginx changed only the three CRM API/socket upstream targets and one frontend upstream target, with configuration validation and graceful reload. Office IP restrictions, TLS and security headers were unchanged. Previous live processes and open connections were not restarted or force-closed. Previous services temporarily retain background-worker ownership; the new API's duplicate background workers are disabled while those connections drain.

Employees must refresh **after their current call** to load the new JavaScript and current-call display. Existing tabs cannot acquire new JavaScript without refresh. The previous processes must not be retired while they still have active connections or internal voice sessions.

The final drain check retained four connections on the intermediate backend and four on the original worker-owning backend. No connections were forced closed. The intermediate backend has no background workers; the original backend continues owning the existing workers until it can be safely retired. No duplicate worker instance was started.

## Flag And Rollback

`CRM_LEAD_PHONE_DEDUP_V2` defaults OFF and is enabled for the new online API through a release-bound private switch. Its authenticated capabilities response enables the employee bulk-archive controls. The private `workers` switch starts background workers only after the previous worker owner is safely retired.

Code rollback first ensures the saved previous API/frontend are healthy (restart only a stopped, idle rollback candidate when needed), restores the saved previous Nginx upstream configuration, validates it, gracefully reloads Nginx and restores previous release metadata. It does not restore a database or undo the approved 186 archives. Those archives and their original history remain reviewable. Do not mass-restore duplicate copies: protected restoration rejects duplicates that require administrator review.
