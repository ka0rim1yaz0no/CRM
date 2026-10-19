# Local Attendance Integrity Delivery

## Scope And Safety

Working tree: `C:/Users/hp/OneDrive/Desktop/crm`, branch `codex/payroll-leads-settings`.
The chat's `CRM 2` directory is a separate, nearly empty tree; the existing V2 attendance files are in the Desktop tree. No AGENTS.md was found in the applicable locations.

This work is local only. No online server, production database, real employee records, environment files, secrets, uploads, historical logs, or GitHub operations were used. The existing service on port 4000 was not queried or stopped. Existing unrelated working-tree changes were retained. Changes are uncommitted because the tree already contained mixed, substantial work; no unrelated changes were bundled into phase commits.

## Audit Findings

- The actual employee page is `src/pages/attendance/index.tsx`, with active code beginning around line 459. It has the original live status panel, manual ONLINE/OFFLINE/LUNCH/Break/Off-the-Phone controls, interval timers, and session history. It does not contain an active calendar grid. The first part of this file is commented-out older code, not the live implementation.
- The former active-session condition depended on matching the current reporting slot and loaded only 250 events. At 08:01 the reporting slot changes while the operational session can still be open. The replacement session query is around line 585; server status is used around line 670; labels are mapped by `sourceLabel` around line 855; controls and rows remain in the original page.
- `backend/src/controllers/attendanceController.ts:getActiveAttendanceSlot` had the matching server-side date gate. It is bypassed when the authoritative-session flag is enabled. `shouldAutomaticallyCloseAttendanceSlot` remains false and `closeExpiredAttendanceSlots` remains a no-op. `authController.logoutEmployee` does not write attendance.
- The real calendar remains in `src/pages/admin/employees/index.tsx` around line 2920, followed by Selected Slot around line 2955. It was not deleted. Its per-day status markers, records, timestamps and existing editing route remain available. The correction controls were added in this area.
- HR previously launched every populated field through `Promise.all`, while each handler acquired the same employee lock. A real Mongo characterization test confirms that a field can persist while another parallel field receives HTTP 409. The new form sends one intentional batch, not several field requests.
- Legacy synchronization used an absent-from-snapshot archival pass. A new test identifies the concurrently added record that the old predicate would select, then verifies the replacement synchronization leaves it intact. Legacy synchronization is insert-only when used, and is replaced by ledger delivery when integrity is enabled.
- The existing admin employee page opens one selected employee at a time. The admin dashboard's Employee Attendance panel is not an expandable employee/day list. Expand-all is therefore implemented on the new hub's one-group-per-employee list, not as a misleading control on those other screens.
- Existing reads also created/normalized SystemSettings documents. Defaults and normalization are now projected in memory; explicit configuration saves are the write boundary.

### Calendar Information

Nothing was deleted from the existing employee or admin calendar paths. The new, flagged admin hub relocates dates/day markers into rows; attendance issues into badges/KPIs/review items; approved leave into day detail; notes/excuses into day detail and note history; exact punches into the event table and chronological colored timeline. There is no new employee hub replacing the original employee page. A small-screen-only navigation fix prevents the original sidebar from covering that page's buttons.

## Six Phases

| Phase | Local Implementation (P1-P6 Implemented Locally) |
| --- | --- |
| P1 | Authoritative, read-only session endpoint; original overnight session stays open across reporting dates; server clock anchor; revision-ordered cache; stale/unknown handling; business/employee query keys; non-destructive history reads. |
| P2 | Shared session projection and existing time-accounting module; one versioned Mongo aggregate; command ID + expected revision; renewable fenced lease; atomic event/correction/audit/receipt/outbox commit; durable business delivery. |
| P3 | One HR batch; exact timestamp/source-preserving draft diff; blank checkout stays missing; required reason/removal preview; stable retry ID; retained dirty draft; explicit rebase after conflict; separate session selection when a day has several sessions. |
| P4 | Admin-only Undo last action and per-event Correct/Undo; preview bound to revision; reason/audit; original evidence retained; dependent timeline validation; composite checkout undo; stable session identity through corrections. |
| P5 | Separate administrative missing-checkout closure; persisted shift/deadline; startup and periodic catch-up; same fenced command service; default OFF; no synthetic checkout/return/working hours; ambiguous early assignments are not automatically recovered. |
| P6 | Admin-only hub, URL filters, KPIs, grouped days, expand/collapse/mixed state, columns/density, drawer, chronological timeline, trends, review queue, notes/excuses, CSV and print; signed admin configuration; existing calendar retained. |

## Main Files

- `backend/src/services/attendanceSessionState.ts`, `attendanceShift.ts`, `timeAccounting.ts`: projection, shift assignment, shared buckets and clicked-interval extraction. Payroll re-exports the existing rounded-minute helper from this shared module; its rounding policy is preserved.
- `backend/src/models/AttendanceLedger.ts`: canonical aggregate, command receipts, audits, business jobs, policy and policy audit.
- `backend/src/services/attendanceLedgerService.ts`, `attendanceLedgerOutbox.ts`, `attendanceRecoveryWorker.ts`: commands, synchronization, membership refresh and recovery.
- `backend/src/controllers/attendanceSessionController.ts`, `attendanceHubController.ts`, `backend/src/routes/attendanceRoutes.ts`: signed-role APIs.
- `backend/src/services/attendanceMigrationPreview.ts`: dry-run-only legacy report; no adoption/write mode.
- `backend/src/controllers/attendanceController.ts`, `authController.ts`, `employeeController.ts`, `systemSettingsController.ts`, `payrollController.ts`: integration with existing controls, business membership, settings and scoped payroll recalculation.
- `backend/src/services/employeeAttendanceSyncService.ts`, `attendanceReconciliationWorker.ts`; models `Attendance.ts`, `Employee.ts`, `BusinessUserAccess.ts`; `backend/src/server.ts`: effective-record filtering, non-destructive legacy compatibility and worker wiring.
- `src/api/attendanceSession.ts`, `attendance.ts`, `attendanceHub.ts`, `systemSettings.ts`, `src/lib/api.ts`: client contracts, signed requests and revision cache.
- `src/lib/attendanceCommandDraft.ts`, `attendanceHubState.ts`: exact diff and URL/clock helpers, exercised by tests.
- `src/pages/attendance/index.tsx`, `attendance.css`: original employee page with authoritative state and small-screen navigation.
- `src/pages/admin/hr/attendanceForm.tsx`, `src/pages/admin/employees/index.tsx`: batch HR save, retained calendar and correction entry points.
- `src/components/AttendanceHub.tsx`, `AttendanceHub.css`, `AttendanceCorrections.tsx`, `AttendancePolicyEditor.tsx`, `src/pages/admin/attendance/index.tsx`: admin hub and controls.
- `backend/src/localAttendance.ts`, `scripts/start-attendance-local.mjs`, package scripts and `vite.config.ts`: isolated local runtime and same-origin API/socket proxy.
- Test additions cover draft diffs, shared allowances, URL/clock state, flags, projection, hub calculations and real isolated Mongo/API integration.

## API Contracts

Employee requests use `X-CRM-Attendance-Session`; admin requests use `X-CRM-Admin-Session`. These are server-signed login tokens. User-type/name/code headers are not attendance authorization. Employee requests resolve their own employee code and explicit business membership on the server; unrelated tenants with matching codes are not combined.

- `GET /api/employees/:id/attendance/session`: session ID, revision, lifecycle, mode, original interval start, persisted assigned shift, review state, server time, effective records, audit and synchronization state. Read-only, independent of history pagination.
- `POST .../attendance/commands`: `commandId`, `expectedRevision`, `operation`, optional `source`, `reason`, `changes`, `targetCommandId`, `fingerprint`. Employees may send manual `action` commands only. Admins use reviewed `correct`/`undo` commands. System recovery is not exposed as a public command operation.
- `POST .../attendance/preview`: admin-only proposed before/after state, target IDs, business scope and payroll implications; revalidated at commit.
- `GET .../attendance/migration-preview`: signed admin, dry run only, no writes.
- `GET /api/attendance`: admin-only batched canonical history, including when a business replica is pending; legacy fallback is read-only.
- `GET/PUT /api/attendance-policy`: signed admin only; save uses expected revision and records before/after/actor/time.
- `/api/attendance-hub/days`, `/summary`, `/day/:dayKey`, `/export`, `/day/:dayKey/note`: signed admin scope, validated range and pagination. Employee access to the hub and configuration is forbidden.
- Old attendance write URLs return a refresh-required response when integrity is enabled. The current manual buttons and HR form use commands. Ordinary sign-out and GET never become checkout commands.

## Flags And Configuration

| Flag | Development/Test Default | Production Default |
| --- | --- | --- |
| `CRM_ATTENDANCE_INTEGRITY` | ON | OFF |
| `CRM_ATTENDANCE_ACTIVE_SESSION` | ON; also enabled by integrity | OFF |
| `CRM_ATTENDANCE_HUB` | ON | OFF |
| `CRM_ATTENDANCE_RECOVERY_CUTOFF` | OFF | OFF |
| matching frontend `VITE_CRM_ATTENDANCE_INTEGRITY`, `VITE_CRM_ATTENDANCE_HUB` | ON | OFF |

The local runner explicitly enables integrity and the admin hub and disables recovery. The signed admin can enable recovery in Attendance configuration. Default allowances are 15 minutes per break, 60 minutes lunch and zero grace. The official shift remains 23:00-08:00 Asia/Manila; recovery defaults to the following day's 22:59. Policy edits are global across explicitly assigned businesses and audited. Read-only SystemSettings projections expose the same configured allowance lengths to the existing calculation paths; default values and existing payroll rounding are preserved.

Check-ins more than two hours before the assigned official start are conservatively flagged as ambiguous for administrative recovery. They remain manual sessions, not guessed automatic closures. This is a safety guard, not evidence that the business approved a two-hour early-arrival policy.

## Local Startup And Accounts

From `C:/Users/hp/OneDrive/Desktop/crm`, run `npm run dev:attendance`.

It starts a fresh, uniquely named, in-memory Mongo replica set on loopback, a real API on 4101 and Vite on 5173. It never loads the normal backend's environment file or uses its database URI. A backup manifest records that the new database is empty before synthetic seeding. It refuses to stop an existing process if 4101 or 5173 is already occupied. The test database survives while this process runs; restarting creates fresh synthetic data and invalidates the previous signed test sessions.

Open `http://localhost:5173/login`:

- Admin: `90000001`.
- Alex Sample: `90000002`, seeded with the specified Oct 15 22:53 overnight fixture and no checkout.
- Blair Sample: `90000003`, initially clean for manual action tests.
- Businesses: Sample Studio and Sample Operations. Both synthetic employees have explicit membership in both.

No real employee codes or production login are needed.

## Verification

- `npm run typecheck` in `backend`: passed.
- `npm run build` at the repository root: passed. The pre-existing large rich-text bundle warning remains.
- `npm test` in `backend`: 179 tests, 177 passed, zero failed, two unrelated call integration tests skipped because their external fixture configuration is absent. Real attendance integration tests use a newly created memory Mongo replica set, not mocks or the existing backend.
- `npx eslint src/components/AttendanceHub.tsx src/components/AttendanceCorrections.tsx src/components/AttendancePolicyEditor.tsx src/api/attendanceSession.ts src/api/attendanceHub.ts src/lib/attendanceCommandDraft.ts src/lib/attendanceHubState.ts src/pages/admin/hr/attendanceForm.tsx src/pages/attendance/index.tsx`: passed.
- Whole-repository `npx eslint . --format json`: failed with 160 errors and 25 warnings, including existing React effect/ref and unused-code debt. This is not a clean whole-repository lint result; unrelated files were not broadly rewritten to hide that failure.
- Measured isolated workload: 200 synthetic employees, two businesses, 31 shift days, 24,800 punches. A request returned 496 day rows (16 employees) with an indexed query examining 62 documents for one employee. Reusing date formatters reduced the measured request from 6906ms to roughly 1.7-1.9s on this machine. This is a local measurement, not a production capacity guarantee.
- Expansion is capped at 500 day rows per response; the server reduces employee page size for long ranges. Expanding the loaded groups does not issue one HTTP request per employee. No hundreds-of-concurrent-browser claim is made.
- Browser checks used the requested `localhost:5173`, rather than the file's older 5174 example. Both employee and admin views were inspected at 1280x900 and 390x844 in light and dark themes. The original employee action layout remains; mobile navigation no longer covers it. Break/lunch have distinct labels; admin groups become mobile shift cards. The drawer supports Escape and focus return.
- Actual browser actions included manual clock/break/lunch/off-phone/checkout, checkout cancellation, reload during a break, logout without checkout, cross-business switching, admin undo, two-field HR correction, KPI filtering and browser Back, expand-all/mixed state, and CSV export. Recovery configuration was visibly unchecked and left off.
- The two-field HR browser test exposed a cache hydration race: confirmed edits were saved, but inputs briefly displayed stale values. The success handler now installs the confirmed response before clearing the draft; the two-field save was retested, including retained input values and a still-missing checkout.
- Screenshots are in `outputs/attendance-employee-{desktop,mobile}-{light,dark}.png`, `outputs/attendance-admin-{desktop,mobile}-{light,dark}.png`, `outputs/attendance-hr-batch-saved.png` and `outputs/attendance-local-final.png`. The manual test below remains useful for owner acceptance. Browser scenarios are executed observations, not a new automated Playwright test suite.

## Manual Acceptance Script

1. Sign in as Alex. Confirm the Oct 15 shift is still open and no 08:00 checkout was invented. Refresh; the original start and status must remain. Switch business and return to Attendance; it must remain the same canonical session.
2. Sign in as Blair. Use ONLINE, Break, ONLINE, LUNCH, ONLINE, Off the Phone and ONLINE. Confirm each running timer starts from its corresponding saved outgoing event and never says Online while on break/lunch.
3. Click OFFLINE. Cancel the confirmation first; attendance must stay open. Confirm it next; it must create a manual checkout. Sign out while another test session is open and verify it is still open when signing back in.
4. As admin, open Attendance. Change presets, employee/team/role/issue, and click a KPI. Reload and use browser Back. Filters must be preserved in the URL. Test empty results and CSV with those filters.
5. Expand all, collapse one employee manually, confirm mixed state, then collapse all. Change page/range and check the current-page controls. Open a day with keyboard, use Tab inside its drawer and Escape to close.
6. Use Edit in HR. Alter two timestamps, enter a reason, review and confirm. Verify one revision increment, both intended changes, untouched seconds/milliseconds and the still-blank checkout. Try invalid ordering: nothing should commit.
7. Open the same session in two admin tabs. Save one, then try the stale draft in the other. The stale command must fail without losing draft inputs. Explicitly review/rebase against the latest records; it must not silently overwrite the first admin.
8. Create a fresh manual Lunch Out, then use admin Undo with a reason. Verify no synthetic Lunch In and the preceding state is restored. Try reversing an older Break Out with a later Break In: the server must require a coordinated correction. Correct the pair in one HR command instead.
9. When there are several legitimate sessions on one shift day, use the HR Session selector. Confirm the drawer lists all events and the offline gap remains offline; one session's edit must not pair with another's punches.
10. Recovery is OFF in the supplied test runtime. Test ON behavior with the isolated automated fixtures or an explicitly approved local recovery test. Do not turn it on against unreviewed historical data merely to clear a queue.
11. Check 1280px and 390px widths and a light/dark theme. On mobile use the page's navigation toggle; the sidebar must not cover the controls.

## Additive Migration And Rollback

New collections are AttendanceLedger and AttendancePolicy; AttendanceDayNote is additive. Attendance gains effective/ledger identity/revision fields; Employee gains attendance revision/session-reference fields. Stable event-ID uniqueness and employee/date indexes are additive. No historical migration or destructive script was run.

Existing non-empty legacy history is deliberately **not automatically adopted**. It remains readable, with migration-review status, and commands fail closed until a reviewed import is designed for that dataset. The dry-run endpoint reports session candidates, missing checkout, ordering issues, duplicates, archived/reversed evidence, early-assignment ambiguity, mismatches and proposed indexes. This prevents enabling the flag from silently choosing one business's history or duplicating legacy rows.

Before any non-empty local historical import: stop local writers, take a full MongoDB Database Tools dump of the explicitly approved local source and control databases, verify the backup can be restored to a separate empty test database, inspect the dry-run report and uniqueness conflicts, then review an additive adoption plan. Restore into a separate verified local database for rollback; do not drop or overwrite the current database. No production command is supplied or executed here.

For an immediate UI rollback, turn off only the frontend/backend hub flags and use the original employee page and retained admin calendar. Keep integrity and effective-record filtering enabled so corrections are not resurrected. Turning off integrity restores legacy APIs and their old limitations; that is not a safe live operational rollback plan. Never delete corrections, audits, closures or ledger receipts to roll back a screen.

## Limits And Unverified Conditions

- No production topology, real historical dataset, real employee browser or live network outage was accessed. A missing secondary employee replica and retry were tested; a physical database network partition/primary failover was not.
- Outbox delivery is at-least-once with revision-guarded/idempotent resulting data. A crash after a downstream deterministic payroll recomputation but before acknowledgment may repeat computation on retry; this is not a claim of exactly-once external execution. Finalized payroll policy is retained.
- The aggregate currently has a 10,000-event/command guard. Long-lived high-volume histories require an approved archive/bucketing plan before that limit; they are not silently truncated.
- Historical schedule changes/holiday calendars are not inferred. New sessions persist assigned shifts. Missing historical schedules and ambiguous imports require review.
- Day notes/excuses are explicitly business-scoped. Differing business notes/excuses are surfaced as mismatches rather than silently choosing one.
- This is not a claim that every possible CRM bug is eliminated. Unrelated lint/build-size debt remains outside the attendance change.

## October 20 Recheck After Dashboard/Profile Work

All six phase regressions were rerun against isolated real Mongo/API fixtures, including manual-only sessions beyond 08:00, fencing/two-tab conflicts, one-batch HR correction, audited undo, recovery default OFF, explicit business identity/membership, failed-replica retries, hub filters/export and the 200-employee seeded range. No historical or production data was accessed. Later report totals also include dashboard/profile/notice tests, not additional production checks.

Fresh browser checks confirmed clock-in, Break, return, Lunch, switching businesses during Lunch without resetting its original start, Off the Phone, and manual checkout confirmation. The old Oct 15 fixture remained open with a blank Time Out. Admin open-session filtering and expand-all showed its seven original events. Break table labels now say per break, the calculation popover uses loaded threshold values, and scheduled trend budgets are labelled explicitly; none of the shared attendance/deduction numbers changed.

The dashboard/profile report records the latest build/typecheck/test/lint results, measured local traffic, approved cross-business notice fix, screenshots, fake login codes and remaining acceptance limits. Recovery remains OFF. The supplied runtime is disposable and reseeds on restart; sign in again after a restart. The owner later approved local whole-project lint cleanup; its final checkpoint supersedes the earlier lint-debt limitation.

The final cleanup browser replay found and reproduced a hub-only timestamp-tie bug: the hub discarded ledger sequence and could order a manual off-phone return after its same-millisecond checkout. Canonical sequence is now preserved through the adapter and shared hub calculation. A failing-before/passing-after fixture checks exact online/off-phone/offline/undertime totals; the two-business API/undo regression forces reversed random IDs. No Employee-tab calculation, manual action handler, stored attendance, or recovery policy was changed. Final full suite: 202 cases, 200 passed, 2 existing skips, 0 failures. Full lint has zero errors/warnings; frontend build and backend typecheck pass. Repeating the manual flow in the local browser no longer flagged the valid checkout.
