# Local Attendance Accuracy Review

## October 21 Follow-Up: Immediate Early Checkout

The user subsequently changed the early-departure presentation rule: with `CRM_ATTENDANCE_ACCURACY_FIXES` enabled, a recorded Offline/Time Out (or Logout) before the scheduled shift end now shows undertime immediately. The shared `calculateSlotAttendance` remains the only calculation, reused by canonical derived days, the admin hub, employee dashboard presentation, and payroll calculation detail. Open sessions, including break/lunch/off-phone and a reopened session, have no undertime. Closing again uses only the latest departure, with the existing upward minute rounding and shift-window clipping. Future-dated checkout does not trigger this early calculation. Flag-off behavior still waits for shift end.

Example: an 08:00 scheduled end and 06:35:11 checkout produce 85 minutes of undertime immediately. No new attendance events or automatic checkout rules are added. Payroll remains provisional/review-blocked until scheduled shift end; a visible undertime badge is not permission to finalize payroll early. Existing saved historical snapshots and approved cutoffs are not rewritten by this change.

Regression tests first reproduced three failures (expected 85/60 minutes, received zero). Added HTTP coverage verifies closed/reopened sessions, active online/break/lunch/off-phone modes, stored replicas, dashboard numbers, hub badges and summary totals in three synthetic businesses, including repeated read-only refreshes.

Follow-up verification: backend typecheck and root lint/build passed; all 531 backend tests completed (529 passed, two optional external-Mongo skips), and all 64 frontend regression tests passed. After backing up the four isolated local databases, localhost:5173 was restarted with this source; normal admin login, business switching, and refresh showed Alex's same 06:35 checkout as 85m with the UNDERTIME badge in Sample Studio and Sample Operations. Existing attendance evidence/derived snapshots and saved payroll fingerprints were unchanged through restart and read-only previews. Initial startup requests hit the API throttle; after its existing window cleared, a normal reload/login worked without altering security limits. New behavior is a live read calculation for the existing example, not an automatic historical snapshot rewrite. Local backup: `outputs/security-phase1-fixture-1792536422556`; screenshot: `outputs/immediate-undertime-local.png`. The user authorized publishing this follow-up to GitHub, but not online deployment.

Scope: local source only. No deployment, GitHub push, historical rewrite, or production flag change is authorized by this task. Employee attendance markup/styles, CallDashboardPanel.tsx, api/callDashboard.ts, and authentication/security rules are excluded.

## Phase 0: Reproduction

Added regression tests before implementation in `backend/src/services/attendanceAccuracyFixes.test.ts` and `attendanceLedgerOutbox.test.ts`.

Initial targeted run: 17 tests, 10 passed, 7 failed. Failures: manual unreturned break, automatic-checkout unreturned break, unreturned lunch, next Time In boundary, fractional-minute consumer parity, payroll failure emits, lost completion marker emits. Full `cd backend; npm test`: 509 tests, 500 passed, 7 failed, 2 optional external-Mongo skips. Backend typecheck and frontend build passed.

The document's literal `/ 8` and `|| 9` flaws were already addressed by the previous payroll accuracy work. Verified by reading `payrollRatesForCutoff`, `paidHoursPerDay`, `accuratePayrollRates`, saved payroll snapshots, and the existing source-scan and invalid-settings API tests. Do not reintroduce a duplicate implementation.

## Phase 1: Shared Missing-Return Accounting

`CRM_ATTENDANCE_ACCURACY_FIXES` defaults on in development/test, off otherwise, with explicit true/false override. With it off, existing accounting and event representations remain unchanged.

`clickedSessionIntervals` treats recorded Time Out, Logout and next Time In as boundaries for an unreturned break/lunch. The shared slot calculator can also bound rest at shift cutoff without writing an attendance event. In-progress rest remains open, overdue, and uncharged. Recorded 08:05 checkout is used exactly, not truncated to 08:00. Administrative system closures are virtual calculation boundaries only, never fabricated stored events. Manual command validation is unchanged: starting/ending rest still uses the existing buttons.

Hub and employee dashboard presentation use the same calculator; hub badges include missing-return charged minutes. Payroll regular paid hours use scheduled paid hours minus the shared deductible total once; gross elapsed hours remain a separate attendance measurement, not an alternative salary base.

### Numeric Example

23:00-08:00, lunch 60 minutes, two 15-minute break allowances. First break 00:00-00:15; second break 07:40 with no return; recorded checkout 08:00. Excess = 20 - 15 = 5 minutes. Scheduled paid hours = 9 - 1 = 8. Regular paid hours = 8 - 5/60, not 8 - 10/60. No extra deduction is made from gross salary on top of the minute deduction.

## Rounding Decision

Retain the user's already-confirmed rule: each completed break/lunch duration rounds up to whole minutes before subtracting its own allowance (15:01 = 1 minute excess). Late minutes floor after grace; early checkout minutes ceil. Sum component minutes, then round money once. This differs from the new file's suggested nearest-minute default; it is explicit here rather than silently replacing the confirmed rule. Historical approved/saved cutoffs remain frozen.

## Phase Verification Ledger

Phase 0: backend typecheck passed; npm test 500 pass / 7 expected fail / 2 skip; frontend build passed.
Phase 1: backend typecheck and frontend build passed. Full tests after compatibility check: 505 passed, 2 known Phase 4 failures, 2 optional skips (509 total). Added two further boundary/exact-payment tests; targeted accounting/payroll tests: 13 passed.

## Phase 2: Settings-Derived Paid Day

Existing implementation is reused, not replaced: `paidHoursPerDay` validates overnight-aware shift minutes minus policy lunch; invalid values throw `PayrollValidationError` (422). `accuratePayrollRates`, absence/scheduled/regular/missing hours and the DTR use the same paid day. Generated payroll records freeze paid hours and rates in `calculationSnapshot`; the payroll DTR panel displays paid hours/day, hourly and minute rates. Existing integration tests cover missing settings returning 422 and settings changes not modifying saved cutoffs.

Added all four 22:00-07:00 / 23:00-08:00 with 30 / 60 minute lunch combinations. Existing source-scan forbids `/ 8` and `|| 9` in active payroll sources. Repository search found only the intentional `payrollLegacyPolicy` 8/9 defaults and its rollback-only branches, kept to preserve flag-off behavior. Dashboard call-count `/ 8` is pagination, not attendance arithmetic; UI spacing/week-list sizes are unrelated. Existing legacy `Math.max(1, ...)` is likewise confined to the old payroll flag-off branch.

Phase 2 verification: backend typecheck and frontend build passed; full backend tests 507 passed, 2 known Phase 4 failures, 2 optional skips (511 total).

## Phase 3: One Deductible Total

New red test first reproduced 0 versus 1 rest-excess minute when the new flag was on but the older payroll flag was off. Fixed the shared rounding/clipping gate in `timeAccounting.ts`. Consumers use completed integer component minutes; late is clipped before arrival and early-out after departure, never overlapping. Existing accurate payroll already derives missingHours from the identical deductible total, including rest, absence and review exclusions; no duplicate payroll arithmetic was added. See the rounding decision above. Monetary totals round once at cutoff level; saved cutoffs do not change on read.

Phase 3 verification: backend typecheck and frontend build passed; full backend tests 508 passed, 2 known Phase 4 failures, 2 optional skips (512 total).

## Phase 4: Delivery Reliability

Outbox failures log safe structured operation/ledger/employee-code/business identifiers and classified error codes/messages, never raw errors, stacks or document contents. Failed payroll or completion compare-and-set suppresses availability emission and preserves the pending business job. Emission failure reopens that job for at-least-once retry. Completed marker is tested before successful emission. No guarantee of exactly-once socket delivery is implied; clients still reconcile by revision/read on reconnect.

Workers report last-run/start times and per-run scanned/closed/failed/deliveryPending counters. The admin-only GET `/attendance-hub/delivery-health` aggregates pending jobs by authorized business, oldest age and last error code; reads never run delivery or mutate evidence. Admin hub has a compact collapsible diagnostics section. Process counters reset on server restart and last error persists until a later error/restart; pending-job errors are stored on the existing durable jobs. Existing signed-session checks are reused unchanged. Startup reports effective attendance flags and incompatible combinations.

New health endpoint test failed first (404), then passed in three businesses and explicitly denied employees. Notification/failure tests failed before changes, including socket retry. Full phase gate: 515 tests, 513 passed, 2 optional skips, zero failures; typecheck and frontend build passed.

## Phase 5: Bounded Workers and Historical Protection

New flag-on worker reads select only necessary fields, request at most 200 candidates, use `_id` cursors and a cooperative 2-second per-worker budget with a 2-second query maxTimeMS. Existing single-flight timer remains. One in-flight transaction/delivery can exceed the cooperative budget; it is never cancelled halfway through a durable operation. Empty candidate pages reset cursors for the next cycle. A failing candidate advances the cursor and is retried after wrap, preventing starvation of later ledgers.

New commands store additive `maintenance.active` / `derivedRefreshAt` metadata. Additive indexes: maintenance.active + _id, maintenance.derivedRefreshAt + _id, jobs.done + _id, derived.policyRevision + _id. No schema migration/backfill was executed. Old ledgers use a bounded, read-only compatibility path rather than silently rewriting metadata. Important measured limit: on 802 synthetic Mongo ledgers the covered indexed active and pending queries examined 0 documents; the legacy-compatible active query examined 800 to return 200 (3ms in the targeted run). That fallback is NOT claimed to be fully index-covered. Query timeout/batches limit its impact; a reviewed metadata backfill could remove it later.

Red test proved a new shift used to rewrite an unchanged older day from 0 to 60 minutes. It now preserves the entire old closed-day snapshot when its evidence is unchanged. Pre-rollout derived days are not picked up by new automatic finalization/policy refresh; only new-version days are eligible. Existing explicit admin correction/recompute and dry-run/backfill remain the approval routes for old records. No historical data script was run.

Tests cover projected/cursor-limited pages, budget expiration, legacy active candidates, real Mongo explain, and effective 08:05 automatic checkout plus identical refreshed deductions in three synthetic businesses. Runtime actions retain their original validation.

Phase 5 verification: initial full run caught three regressions in confirmed notes and policy retry; fixed target-note finalization and immediate cursor wrap. Targeted regressions passed; final full phase gate: 520 tests, 518 passed, 2 optional skips, zero failures. Backend typecheck and frontend build passed. Compatibility explain in the full rerun: 800 examined / 200 returned / 6ms; this is a synthetic measurement, not a production performance guarantee.

## Phase 6: Flags

Strict validation fails before server connection/startup only when NODE_ENV=production and CRM_ATTENDANCE_STRICT_FLAGS=true (or 1). Otherwise incompatible combinations are warned at worker startup without changing login behavior. Red test first failed because strict validation did not exist; added and covered invalid/valid production and permissive development cases.

| Flag | Development/test default | Production default / parsing |
| --- | --- | --- |
| CRM_ATTENDANCE_ACCURACY_FIXES | ON | OFF; true/1 or false/0 explicit override |
| CRM_ATTENDANCE_INTEGRITY | ON | OFF; true/1 or false/0 override |
| CRM_ATTENDANCE_ACTIVE_SESSION | ON | OFF unless integrity is on, which forces it effectively on |
| CRM_ATTENDANCE_DURATION_MODEL | OFF unless explicitly true/1 | OFF unless explicitly true/1 |
| CRM_ATTENDANCE_AUTO_TIMEOUT | OFF unless explicitly true | OFF unless explicitly true |
| CRM_ATTENDANCE_BREAK_GAP | OFF with duration model; otherwise ON | Same; false/0 disables, original parser retained |
| CRM_ATTENDANCE_RECOVERY_CUTOFF | OFF unless explicitly true | OFF unless explicitly true |
| CRM_ATTENDANCE_HUB | ON | OFF; true/1 or false/0 override |
| CRM_ATTENDANCE_V2 | ON | OFF; legacy compatibility switch |
| CRM_TIME_ACCOUNTING_V2 | ON | OFF; legacy compatibility switch |
| CRM_PAYROLL_ACCURACY | ON | OFF; keep ON with new attendance accuracy |
| CRM_ATTENDANCE_STRICT_FLAGS | OFF | OFF; true/1 enables production fail-fast |

Valid accuracy rollout: INTEGRITY + DURATION_MODEL + PAYROLL_ACCURACY on; then ACCURACY_FIXES on. AUTO_TIMEOUT additionally requires INTEGRITY + DURATION_MODEL. Automatic timeout is optional, not enabled just by the new accuracy flag. Existing recovery/automatic timeout precedence is retained. Hub flag controls hub/diagnostics availability separately.

BREAK_GAP is deliberately retained. When explicitly on it can show "Please wait at least 30 minutes". The user's existing choice is immediate second break; duration mode's default remains gap OFF. No 30-minute rule has been re-enabled locally. Confirm before changing that business policy in future.

Local launcher already explicitly enables integrity/duration/auto-timeout; the new flag is on by development default. No env file was read or edited and no production flag was enabled.

Phase 6 verification: backend typecheck and frontend build passed; full backend tests 521 total, 519 passed, 2 optional skips, zero failures.

## Phase 7: Final Verification

The final verification added missing-return explanations to payroll DTR deduction details, alongside the existing hub badges. Red tests first proved those explanations and ranked dry-run statistics were absent. Administrative closing metadata is now passed through one shared `recordsWithClosingBoundaries` adapter to slot calculations, ledger derivation, payroll, hub and employee dashboard presentation. A red test proved the hub used shift end instead of an earlier actual system closure (465 versus 405 excess minutes); the corrected parity test passes without adding fake clicked events. System closures remain review-only for payroll approval, with provisional accounting visible rather than silently approved deductions.

A final injected failure test proved recovery delivery exceptions did not count pending delivery after a durable close. Fixed the counter while retaining its original return/retry behavior. Derived refresh also checks its cooperative budget between multiple due days, not just between ledgers.

### Commands Actually Run

All commands were run from `C:\Users\hp\OneDrive\Desktop\crm` or its `backend` directory, not the nominal empty CRM 2 workspace.

| Command | Final result |
| --- | --- |
| `cd backend; npm run typecheck` | Passed |
| `cd backend; npm test` | 527 tests: 525 passed, 2 optional external-Mongo skips, 0 failed |
| `npm run build` | Passed; existing large rich-text-editor chunk warning remains |
| `npm run lint` | Passed |
| `node --test --test-reporter=spec scripts/*.test.mjs` | 64 passed, 0 failed |
| `git diff --check` | Passed; Windows line-ending notices only |

Total tested: 589 passed, 2 skipped. Full typecheck/test/build gates were run after every phase; intentional red tests and intermediate compatibility failures are recorded above. Some test runs used a PowerShell output filter that retained failures/counts and returned the actual test exit code; no failures were hidden as success. No dependency upgrade or new UI library was added. Final screenshot review caught crowded headers in the new delivery panel; a failing layout regression test was added first, table spacing/scroll containment was corrected, all 64 frontend tests passed, and the corrected layout was inspected in the browser.

### Actual Local Copy Results

Ran the new read-only 60-day script against the existing disposable synthetic databases on loopback port 27099, through October 21, 2026 (Asia/Manila window August 23-October 21). Both fixture businesses reported 17 stored event snapshots whose deductible total would change, representing ONE minute of extra daily deduction for sample code 90000002. The repeated event snapshots are NOT 17 minutes of deductions. The two businesses mirror one employee; their totals must not be added as two separate employee deductions.

The first dry-run exposed a script configuration error: it inherited legacy break-gap interpretation and excluded a valid immediate second break. A failing test reproduced that; the script now explicitly reports and uses duration mode ON, break gap OFF, and the confirmed upward rounding. The corrected report matches the screen's 12-minute excess rather than the old stored 11-minute snapshot. No differences were applied. Open/current shifts remain provisional and require review; a report is not approval to change a cutoff.

Generated report: `outputs/attendance-accuracy-local-dry-run.json` (ignored, local only). Synthetic Mongo dumps were taken before restarting the test runtime. Latest backup: `outputs/security-phase1-fixture-1792534841362` (4 databases, 82 collections). The existing isolated-fixture restoration path preserves the sample database and its known dummy vault; no real vault/data was accessed. Attendance evidence/derived snapshots and entire saved payroll documents were fingerprinted before restart and checked after restart and read-only previews in both businesses. They remained unchanged. The first verification attempt raced the frontend startup and got connection-refused; readiness was awaited and verification rerun successfully.

### Read-Only Dry-Run Usage

Run only against an explicit credential-free loopback copy. The script rejects remote URIs and apply options, uses the raw read-only driver path (no auto-index/auto-create), and has no write/apply mode.

```powershell
cd backend
npx tsx src/scripts/attendanceAccuracyDryRun.ts --dry-run --uri "mongodb://127.0.0.1:27099/" --ledger-database "<local-canonical-db>" --business "business-a=<local-business-a-db>" --business "business-b=<local-business-b-db>"
```

The report includes each business, changed stored-record count, once-per-day minute difference, missing/unverifiable snapshot counts, and top 20 employee codes. It prints no employee names, contacts, event contents or credentials. Rerun after an active shift finishes before making an HR decision.

### Worked Cutoff Example

Monthly salary PHP30,000, 23 working days, 23:00-08:00 shift, 60-minute lunch: paid day = 8h; hourly rate = 163.043478...; minute rate = 2.717391.... Semi-monthly base = PHP15,000. One completed day has 5 late minutes, 10 early-out minutes, a normal first break, a second break lasting 40 minutes with no return before recorded checkout (25 excess), and a 60-minute lunch. Total = 5 + 10 + 25 = 40 minutes. Deduction = roundMoney(40 * minuteRate) = PHP108.70; net = PHP14,891.30, assuming no other cutoff deductions or approved overtime. Paid regular time for that day = 8 - 40/60 = 7h20m. The break excess is not deducted again from gross salary.

### Files by Phase

Paths below are relative to the actual CRM repository; overlapping files were refined in later phases.

| Phase | Files |
| --- | --- |
| 0 | `backend/src/services/attendanceAccuracyFixes.test.ts`, `attendanceLedgerOutbox.test.ts` |
| 1 | `backend/src/config/rolloutFlags.ts`; services `timeAccounting.ts`, `attendanceDerived.ts`, `attendanceSessionState.ts`, `attendanceHubMath.ts`, `attendanceDashboardPresentation.ts`, `payrollAccuracy.ts`; legacy-rollout characterization in `attendanceIntegrity.integration.test.ts` |
| 2 | `backend/src/services/payrollAccuracy.test.ts`; existing paid-day/rate/UI implementation verified and reused |
| 3 | `backend/src/services/timeAccounting.ts`, `attendanceAccuracyFixes.test.ts` |
| 4 | services `attendanceWorkerHealth.ts` and `.test.ts`, `attendanceLedgerOutbox.ts` and `.test.ts`, `attendanceAutoTimeOutWorker.ts`, `attendanceRecoveryWorker.ts`, `attendanceDerivedRefreshWorker.ts`, `attendancePolicyRefreshWorker.ts`; `backend/src/models/AttendanceLedger.ts`, `controllers/attendanceHubController.ts`, `routes/attendanceRoutes.ts`; `src/api/attendanceHub.ts`, components `AttendanceDeliveryHealth.tsx`, `AttendanceHub.tsx`, `AttendanceHub.css`; `attendanceBreakLimits.integration.test.ts` |
| 5 | services `attendanceWorkerCandidates.ts`, `.test.ts`, `.integration.test.ts`, `attendanceLedgerService.ts`, `attendanceDerived.ts`, the five worker/outbox files above; `attendanceDerivedRefreshWorker.test.ts`, `attendanceAutoTimeOutWorker.test.ts`, `attendanceBreakLimits.integration.test.ts`; additive indexes in `AttendanceLedger.ts` |
| 6 | `backend/src/config/attendanceFlags.ts` and `.test.ts`, `backend/src/app.ts`, `backend/src/server.ts`; this report |
| 7 | `backend/src/scripts/attendanceAccuracyDryRun.ts` and `.test.ts`, `backfillAttendanceDerived.ts`; services `attendanceDerivedBackfill.ts` and `.test.ts`, `timeAccounting.ts`, `payrollAccuracy.ts`, shared consumer adapters; `backend/src/controllers/payrollController.ts`, `src/api/payroll.ts`, `src/pages/admin/payroll/index.tsx`; `scripts/attendance-delivery-health-ui.test.mjs`, final table spacing in `src/components/AttendanceHub.css`; boundary/counter regression tests and this report |

### Additive Index Backup and Restore

No destructive schema migration or historical backfill was run. New metadata is written only with normal approved/new commands, and old ledgers retain a read-only compatibility path. Before any future reviewed metadata backfill, dump the canonical database and every business database separately using `mongodump`; verify the dumps before proceeding. Restore into a NEW isolated database first, never overwrite a live database as a casual rollback.

```powershell
mongodump --uri "mongodb://127.0.0.1:27099/" --db "<local-copy-db>" --out "<backup-folder>"
mongorestore --uri "mongodb://127.0.0.1:27099/" --nsFrom "<local-copy-db>.*" --nsTo "<new-restore-test-db>.*" "<backup-folder>"
```

### Rollout Order (Not Executed)

1. Review the source and deploy with CRM_ATTENDANCE_ACCURACY_FIXES=false.
2. Take verified dumps. Run the read-only report on an isolated copy of the last 60 days using the intended flags/policy.
3. Review differences and unresolved sessions with HR. Do not treat missing snapshots as verified zero deductions.
4. Enable compatible integrity/duration/payroll flags, then ACCURACY_FIXES during a quiet window; production strict validation is optional but recommended after configurations are reviewed.
5. Recompute only approved cutoffs using the existing admin preview, explicit confirmation and audit reason. Paid/frozen cutoffs and unresolved cross-business mismatches retain their safeguards.
6. Roll back new behavior with ACCURACY_FIXES=false and restart the server. Leave additive indexes/metadata in place. Turning off the flag does NOT undo an explicitly approved historical recompute; that requires its audited correction process.

### Manual Local Check

1. Open `http://localhost:5173/login`. This isolated fixture uses synthetic admin 90000001 and employee 90000002; it is not an online account.
2. As admin, open Attendance. Switch between Sample Studio and Sample Operations, refresh, expand the same employee and compare the shift day, break allowances and excess minutes. Open Attendance delivery to inspect counts/worker times.
3. For a NEW disposable shift only, use the existing Break In/Out button twice (15 minutes each) and Lunch In/Out once (60 minutes); returns use the existing UI label convention. Do not alter preserved example shifts just to run a test.
4. Review a prepared missing-return example in Shift Records and DTR: closing evidence ends rest; excess appears once. During an active unclosed shift, overdue information is provisional, not an approved payroll deduction.
5. Preview a cutoff without applying it. Confirm paid hours/day and stored rates, component totals and review blockers. Refresh again: saved payroll totals must not change merely from reading.
6. For a consenting disposable overnight test, leave it active through 08:05 Manila. The already-enabled automatic worker records the effective cutoff once and mirrors it; no read endpoint performs that write.

### Verified Versus Not Verified

Verified by tests/measurement: shared completed-rest/late/early components; two separate allowances; no cross-session pairing; no final in-progress payroll charge; business mirror parity; signed-role restrictions; manual command validation; atomic payroll approval/attendance-edit baseline regressions; failure suppression/retry; additive query plans on seeded Mongo; strict flag validation; source invariants and actual local data preservation.

Verified in the localhost browser: normal synthetic admin and employee login/dashboard; employee attendance retained the same 17 current-shift records, online state and used break/lunch buttons after refresh and switching between both assigned businesses. Employee dashboard and admin hub both showed 12 excess break minutes. Admin attendance, new delivery panel with zero pending jobs, business switch to Sample Operations and refresh were inspected. Final screenshots: `outputs/attendance-accuracy-employee-local.png` and `outputs/attendance-accuracy-admin-local.png`. Employee page markup/styles, CallDashboardPanel.tsx, api/callDashboard.ts, security middleware and authentication controllers have no task diff. The browser initially showed cold-start loading states after test-server restart; normal login was used rather than bypassing authentication. No attendance buttons or payroll approval actions were clicked against the preserved sample records; write-side regression scenarios ran in disposable test fixtures instead.

Not verified live: production data, production failure recovery, physical Nextiva behavior, every browser/device and every possible outage. The compatibility query is not fully indexed; cooperative budgets cannot stop an in-flight transaction, and counters are per-process rather than durable monitoring. System-closed/ambiguous history still needs human review. No claim of being bug-free or fixed forever is made.

Policy questions: upward rest rounding and immediate second break retain the user's confirmed choices; unreturned rest keeps its excess deduction, with the badge/review entry rather than a new separate alert. Weekend/holiday overtime policy still needs HR confirmation; this task retains the existing weekend overtime behavior and does not invent a holiday calendar.
