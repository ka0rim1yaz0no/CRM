# Attendance View Refresh

## Change

Manual attendance saves and administrator corrections invalidate the session,
history, dashboard attendance, shift-list, live-panel and day-detail caches.
Tenant replicas can have different employee IDs, so cached responses are never
copied between businesses. Each view refetches through its existing scoped API.

The admin shift list and open day detail also refresh every 30 seconds while
visible, and on window focus. This is a fallback for missed socket events, not
an automatic attendance action. Dashboard shift details retain the selected day
ID rather than a stale copy of the day row.

No attendance calculations, schedules or manual-button semantics were changed.
Read requests remain read-only. Recovery/automatic closure remains disabled by
default. Existing production feature flags are not enabled by publishing source.

## Regression Checks

- `backend/src/services/attendanceWorkspaceCache.test.ts` checks all attendance
  cache families and distinct IDs across businesses; unrelated queries remain
  untouched. The initial regression failed against the old invalidation path.
- The three-business API test in `attendanceIntegrity.integration.test.ts`
  checks every manual action, request replay, replica state, employee history,
  dashboard shift records and admin shift-list events against the canonical
  saved events after each action.

## Manual Check

1. Use a disposable local employee assigned to more than one test business.
2. Open Attendance, the employee dashboard shift detail and an admin attendance
   list filtered to that employee and the session's starting shift date.
3. Manually use Time in, Break/End break, Lunch/End lunch, Off the phone/End off
   the phone, then Offline. Confirm each view receives the corresponding event.
4. Switch businesses and confirm the same event IDs and status, without duplicate
   events. Do not expect the overnight shift under the following shift's date.
5. Leave a detail open during another attendance action. It must update rather
   than retain the row captured when it opened. Refocus a sleeping tab to resync.

Follow-up correction, October 20: the admin Today selector now uses the existing
server shift-day function, matching employee attendance. After midnight it still
selects the shift's starting date, rather than the following night's empty shift.
The current calendar date is displayed separately. Specific Date remains an
explicit date selection, and All Shifts keeps its existing history windows.

The original calendar-date behavior described in earlier audit notes is
superseded by this correction. No punches, totals or payroll calculations were
moved or rewritten to implement the filter fix.

## Local Verification, October 20, 2026

- Backend suite: 256 passed, zero failed or skipped, including the optional
  Mongo integration suites against a fresh isolated test namespace.
- Local loopback launcher tests: two passed.
- `npm run lint`, `npm run typecheck --prefix backend`, and the frontend build
  passed. The existing large rich-text editor bundle warning remains.
- Browser at `http://localhost:5173`: a disposable employee completed all eight
  manual attendance events. A dashboard detail left open in another tab updated
  from one to eight records without reloading and showed the manual checkout.
- All three assigned local business copies ended OFFLINE at revision eight with
  eight identical effective event IDs. Temporary test employees, events, ledger
  and access mapping were removed; cleanup preserved non-fixture attendance.
- The complete selected source set was checked for excluded file paths and
  common credential patterns. The only initial pattern match was the explicit
  invalid `user:password` local URI used in a rejection test, not a credential.

Local data, environment files, uploads, backups, generated builds and screenshots
are excluded from the source upload. Publishing the repository is not a CRM
deployment or a database migration.

## Reloading The Existing Local Copy

Keep the original local review owner on port 4101 running; it owns Mongo on
27119 and its retry worker. To reload application code without restoring/resetting
the review copy, run `node --import tsx src/localReviewReuse.ts --existing-local-review`
from `backend`, then `node scripts/preview-local-review.mjs --existing-local-review`
from the repository root after stopping only the old 5173 preview. The refreshed
app binds 4103 on loopback and the same localhost:5173 preview proxies it. Both
launchers verify the isolated-copy metadata. A fresh app requires signing in again.
This path never connects to the original 27017 database or online services.

## Follow-Up Verification: Today Shift Selection

- Reproduced the exact empty-list bug with a failing test: at 02:00 Manila,
  October 20, the old Today selector requested October 20 instead of October 19.
- `attendanceViewRange` now requires the existing server-calculated shift day.
  `hubDayKey` / `attendanceSlotKey` and all time-accounting math remain unchanged.
- Frozen-time API checks cover three businesses, the list, CSV, explicit date
  isolation, hand-calculated online/break totals and non-mutating reads. Boundary
  fixtures cover PH midnight, month/year/leap-day transitions and the established
  end-minute rule. No time-out, return punch or worked time is fabricated.
- The final backend suite passed 259 tests with no failures or skips. Backend
  typecheck and the frontend build passed; the existing editor bundle warning
  remains. The frozen Call Dashboard source guard now normalizes checkout line
  endings, while still rejecting source changes; the Call Dashboard files were
  not edited.
- On localhost:5173, browser checks verified the populated Today row, expansion,
  Specific Date, Reset to Today and switching through all three businesses.
  Desktop 1440x1000 and mobile 390x844 were checked with a disposable employee.
  The mobile list width and scroll width were both 358 pixels.
- After removing that fixture, aggregate-only summary checks on both localhost
  loopback addresses showed one worked shift and 19 online minutes from existing
  records in each of the three businesses, under October 19. Test cleanup removed
  only the owned fixture and preserved non-fixture attendance.
- The follow-up was first verified locally. Its source is included in the later
  user-authorized GitHub upload alongside admin light mode; no online deployment
  was performed.
