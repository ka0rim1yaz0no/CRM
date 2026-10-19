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

The admin Today selector intentionally remains the Manila calendar date, as
previously specified. For an overnight shift after midnight, select the date
that shift started; its punches are not moved to the following shift date.

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
