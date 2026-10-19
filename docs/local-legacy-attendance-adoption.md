# Local Legacy Attendance Review

October 20, 2026. Local only. No online CRM, SSH, deployment or GitHub actions.

## Finding And Fix

Unadopted legacy history returned `migration-review`, intentionally refusing manual writes. Merely copying it would not solve the remaining problem: old orphan events and repeated starts could permanently block a later, independently verified session.

The explicit local-review launcher now backs up its isolated Mongo copy and adopts reviewed evidence into the existing canonical attendance ledger. It deduplicates exact source/timestamp replicas only within explicitly assigned employee identities. Original record IDs, sources and punch timestamps remain unchanged. Exact duplicate rows remain stored with lineage and are marked ineffective, not deleted. Differing business evidence is retained and flagged.

A trusted boundary at an existing latest Time In separates historical warnings from current blocking ambiguity. An earlier unresolved session remains open with no end timestamp; it is not automatically checked out. A recorded legacy manual checkout is retained even if its separate break/lunch return was missing. Missing Time In, future/invalid records and ambiguous current break/lunch still fail closed. New actions retain strict validation; employee commands cannot supply trusted legacy markers. Historical notes are visible without disabling otherwise valid controls.

The browser recheck also found that a manual checkout of an older open shift could display stale activity. The page now displays the latest complete canonical session after checkout, including events recorded on a later calendar date. Active-session selection remains separate from display selection. A regression test covers this case.

Shared time-accounting/payroll formulas were not changed. Adoption does not recalculate payroll. Reads never adopt data or create punches; recovery and automatic checkout remain off.

## Scope And Verified Local Result

- Three businesses, seven distinct attendance identities, twelve assigned employee replicas.
- Seven adopted; zero blocked; all twelve replicas match; zero pending synchronization jobs.
- Business A: 6/6 employee API snapshots verified; B: 2/2; C: 4/4.
- Five histories retain historical review warnings. These are not claims that their missing or conflicting historical punches have been repaired.
- Original IDs/sources/Time In timestamps verified preserved. The read-only API audit also checked ledger hashes before and after its requests: unchanged.

No attendance action was performed on original copied employees during verification. Mutation tests use seeded fake employees and isolated test databases.

## Running And Rollback

From the repository root: `npm run dev:local-review`. The launcher forwards `--adopt-legacy` only to the disposable local review. Each new review gets a fresh backup and explicit adoption; ordinary development/production startup does not adopt history.

The applied review backup is under:

`C:/Users/hp/AppData/Local/AssistlyLocalReview/snapshots/a25e35d2-c35b-42ab-ace6-17616fa5772d/legacy-before-adoption/`

It contains a full Mongo dump with replica-set oplog, a SHA-256 artifact manifest, reviewed source fingerprints and an aggregate result. Treat the dump/manifest as private local data. Backups are validated for target, age, coverage, path containment, hashes and source fingerprints before a transaction can adopt history. Source or membership changes abort the adoption.

The application guard permits explicit development adoption only on `127.0.0.1:27119`; production and the original local Mongo port 27017 are refused. Tests additionally permit their own `legacy_adoption_test_` disposable namespace. There is no public adoption endpoint.

To revert, stop only the isolated review launcher and discard its disposable copy, then start review without `--adopt-legacy`. Do not delete or restore over original port 27017. If exact pre-adoption investigation is needed, restore the backup dump with `mongorestore --oplogReplay` into a new disposable local replica set, never the original or online database. Restarting the normal review command deliberately repeats backed-up adoption on its fresh copy.

Current browser preview uses the compiled `dist-local-employee-review` build and backend 4101. Open **http://127.0.0.1:5173/** and sign in again. An unrelated existing server owns IPv6 `localhost:5173`; it was left untouched. This compiled preview does not hot-reload source edits.

## Main Files

- `backend/src/services/legacyAttendanceAdoptionPlan.ts`: deterministic evidence plan and duplicate lineage.
- `backend/src/services/localLegacyAttendanceAdoption.ts`: verified-backup guard and transactional adoption.
- `backend/src/services/localLegacyAttendanceRollout.ts`: isolated full backup, application and preservation checks.
- `backend/src/services/attendanceSessionState.ts`: historical versus current blocking issues; no fabricated closure.
- `backend/src/services/attendanceLedgerService.ts`, `attendanceLedgerOutbox.ts`, and `backend/src/models/AttendanceLedger.ts`: additive audit metadata, replica origins and delivery.
- `backend/src/scripts/reviewLocalLegacyAttendance.ts`: aggregate-only read/API verification.
- `backend/src/localReview.ts`, `scripts/start-attendance-local.mjs`, root `package.json`: explicit local launch path.
- `src/api/attendanceSession.ts`, `src/pages/attendance/index.tsx`, `src/lib/attendancePresentation.ts`: historical warning and complete-session display.
- `backend/src/localAttendance.ts`: optional `--history-review-demo` for synthetic browser verification only.

## Verification

- Backend: `npx tsc --noEmit` passed.
- Root: `npm run lint -- --max-warnings 0` passed; focused lint after the final display fix passed.
- Root: `npm run build -- --outDir dist-local-employee-review` passed with local attendance/dashboard/profile flags enabled. Existing approximately 904KB rich-text-editor chunk warning remains.
- Backend: `node --import tsx --test --test-reporter=spec "src/**/*.test.ts"`, with process-only `CRM_INTEGRATION_MONGO_URI=mongodb://127.0.0.1:27099/crm_integration_legacy_adoption_final_recheck`: **249 passed, 0 failed, 0 skipped**.
- Coverage includes backup absence/staleness/tampering, concurrent/idempotent adoption, membership changes, original evidence preservation, assigned-business fanout, forged legacy flags, strict new manual actions, unresolved historical sessions and cross-date closed-session presentation. Existing role isolation, manual attendance, payroll, uploads, sound and frozen Call Dashboard tests also passed.
- Read-only copied-data check: `node --import tsx src/scripts/reviewLocalLegacyAttendance.ts --verify-api`: all twelve assigned employee endpoints verified with matching canonical identity/state/events; attendance hashes unchanged.
- Synthetic browser fixture: historical warning visible, Off the Phone -> switch assigned business -> ONLINE -> explicitly Confirm Offline all saved and synchronized. The corrected display retained the actual checkout after reload. A new ONLINE -> Break -> ONLINE -> Lunch -> switch business -> ONLINE cycle also passed; lunch retained its original start and approximately 60-minute countdown across the switch. No auto Time Out was invoked. The page had no document-level horizontal overflow at its normal 1280px viewport. Proof: `outputs/legacy-attendance-controls-verified.png` (fake employee only).

## Owner Checks And Limits

Sign into the local preview, open Attendance and verify the recorded current state. Historical warnings must remain visible but should not disable valid controls. Use a synthetic employee for a full ONLINE -> Break -> ONLINE -> Lunch -> ONLINE -> Off the Phone -> confirmed OFFLINE cycle, alternating assigned businesses; verify state and events agree after refresh. An unresolved current break/lunch still requires its return action before checkout.

This is not an assertion that every historical event is correct, that all payroll should change, or that every CRM workflow is bug-free. Missing historical times require evidence and the existing audited administrator edit flow. Real external integrations and production failure recovery were not exercised or changed. No production adoption or rollout is enabled.

## Manual Button Recheck

October 20 local-only follow-up. No application behavior needed changing in this recheck. Added a three-assigned-business integration regression in `attendanceIntegrity.integration.test.ts`: each manual action rotates the submitting business, checks signed snapshots and persisted employee status/revision/event IDs in all three businesses, and replays the exact command to verify it appends only once. Explicit checkout while off the phone records its return plus checkout as one command. The original two-business full-cycle and failure/retry tests remain in place.

Final suite command: `node --import tsx --test --test-reporter=spec "src/**/*.test.ts"`, using disposable `crm_integration_attendance_buttons_final`: **252 passed, 0 failed, 0 skipped**. Backend `npx tsc --noEmit` and focused ESLint for the modified test passed. The focused integrity integration file also passed all 29 tests. No frontend source/build change was required.

Browser with synthetic employee 90000003: ONLINE -> Break -> switch business -> ONLINE -> Lunch; Off the Phone -> switch business -> cancel checkout -> ONLINE -> confirmed OFFLINE. A second lunch check explicitly retained LUNCH, its original start timestamp and the 60-minute countdown across business switching and page reload, then manually returned ONLINE and explicitly confirmed OFFLINE. Reload retained the checkout and re-enabled ONLINE. OFFLINE remained disabled during break/lunch; ONLINE is the manual return action. A second lunch and an immediate second break remained unavailable according to the existing session rules. A transient sync-pending notice on the second session cleared after retry; this is eventual delivery, not a promise of zero-delay replication. Proof: `outputs/attendance-buttons-lunch-persistence.png` and `outputs/attendance-buttons-cycle-verified.png`.

Read-only existing local review audit verified all seven identities across twelve assigned employee profiles in three businesses (6/6, 2/2, 4/4 endpoints), with matching snapshots, no blocked controls and unchanged ledger hashes. The five historical-review warnings remain intentionally nonblocking. No real copied employee action, original database write, online access, deployment or GitHub action was performed. These checks do not certify all browser/device policies or every possible database outage.

## Exact Localhost Button Verification

Follow-up after correcting the separate IPv4/IPv6 frontend listeners: every browser action below was performed at **http://localhost:5173/attendance**, not the separate synthetic port 5174.

A full `mongodump --oplog` backup was created before seeding one temporary fake employee (`Local Attendance QA`) into all three existing isolated businesses. The backup and ownership manifest are private under `C:/Users/hp/AppData/Local/AssistlyLocalReview/localhost-qa/107fc30c-db9d-4f0c-8e7a-58bd30ec81a6/`. The original local Mongo port 27017 and online system were not accessed or modified.

Verified browser cycle: ONLINE in Assistly HQ -> Break -> switch to Next Gen Vending -> ONLINE -> Lunch -> switch to Order TH CA -> reload while still on lunch -> ONLINE -> Off the Phone -> switch back to Assistly HQ -> open/cancel OFFLINE -> ONLINE -> explicitly Confirm Offline -> reload. Break/lunch/off-phone timers retained their original starts; OFFLINE stayed unavailable during break/lunch; second-lunch and immediate-second-break guards remained active. Cancel left revision 6 and six events unchanged.

After every saved action, a separate local verification checked all three persisted employee statuses/revisions and attendance event IDs against the canonical snapshot. Revisions 1 through 8 matched in every business, with no pending sync and no duplicate events. Final state: OFFLINE, eight canonical punches, eight effective records in each of the three businesses. Reload retained checkout and made ONLINE available again. Original attendance/ledger hashes matched the baseline at every check. Proof with fake data only: `outputs/localhost-5173-attendance-lunch-verified.png` and `outputs/localhost-5173-attendance-buttons-verified.png`.

Signed out of the fake account, then transactionally removed only its three employee records, 24 attendance replicas, one canonical ledger and one access mapping using exact manifest IDs/code/name checks. Hash verification after removal confirmed all pre-existing attendance was unchanged. The final read-only API audit again passed all seven original employee identities/twelve assigned profiles across the three businesses. No temporary employee remains.

Focused command: `node --import tsx --test --test-reporter=spec src/services/attendanceIntegrity.integration.test.ts src/services/attendanceSessionState.test.ts src/services/attendanceSessionCache.test.ts`: **35 passed, 0 failed, 0 skipped**. No new application defect was reproduced and no frontend/backend behavior was changed in this exact-host recheck. Local preview remains on localhost:5173; online and GitHub were untouched.

## Clear Event And Action Labels

Subsequent local-only presentation update matches the requested activity history: Break / Break ended use orange icons, LUNCH / Lunch ended use violet, and Off the Phone / Off the phone ended use blue. Only actual clock-in is labeled ONLINE in the history; the current availability badge can still be ONLINE after a return. The shared `attendanceEventPresentation` helper is independent of rollout flags and selected business. Latest activity also uses the explicit event label.

The existing return handler now displays Time in, End break, End lunch or End off the phone according to the current server state. No new attendance action or automatic transition was introduced. Replaced the now-incorrect ONLINE instructions with compact factual allowance values from the session policy. Allowances, payroll/attendance calculations, original timestamps and API shapes are unchanged.

Browser testing caught a display-only race: a live refetch could already contain a saved event when the mutation callback prepended that event again. `mergeAttendanceHistory` now deduplicates by canonical record ID and preserves timestamp/sequence ordering in both ordinary and off-phone mutation caches. A regression covers overlapping refetch/save results. Persisted records were not duplicated by this display race.

Verified on http://localhost:5173/ with a backed-up temporary fake employee assigned to all three businesses: Time in -> Break -> End break -> LUNCH -> End lunch -> Off the Phone -> End off the phone -> confirmed OFFLINE. The three saved copies ended at revision 8 with eight identical events and no pending sync. At 390x844 the long return label fit its button and document width stayed 390px. At 1366x900 all three explicit end-event labels and distinct colors were present, with no document overflow. Proof: `outputs/attendance-clear-event-labels-localhost.png`.

Final focused command: `node --import tsx --test --test-reporter=spec src/services/attendancePresentation.test.ts src/services/attendanceIntegrity.integration.test.ts src/services/attendanceSessionState.test.ts src/services/attendanceSessionCache.test.ts`: **42 passed, 0 failed/skipped**. Backend `npx tsc --noEmit`, focused ESLint and the final same-flags compiled local build passed. Existing ~904KB editor chunk warning remains. One initial build caught an obsolete unused display flag; it was removed before the successful build.

Local admin code **90000001** was verified through `http://localhost:5173/api/auth/login`: HTTP 200, admin role and a signed session issued. This is the configured isolated-review code, not a change to online credentials; no session token was printed.

The private QA backup/manifest is under `C:/Users/hp/AppData/Local/AssistlyLocalReview/localhost-qa/fc9c536d-5e54-436f-9b3e-5ec3eb15f4b8/`. An existing non-QA attendance change appeared after the seeded test began. Its source was not inferred and no snapshot restore was attempted. Cleanup was constrained to exact manifest-owned IDs/code/name: three temporary employee records, 24 replica events, one ledger and one access mapping. Hashes immediately before and after cleanup confirmed current non-QA attendance was preserved. Temporary records are gone, and the fake account was signed out. No original port-27017 database, online CRM or GitHub change was made.
