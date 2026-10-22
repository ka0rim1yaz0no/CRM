# Attendance Undo Review

## Verified Findings

- A date-specific editor used an unspecified `targetCommandId` for **Undo last action**. The backend therefore selected the employee's global latest action, not necessarily an action from the displayed shift.
- Every row advertised Undo, including earlier dependent actions and imported, automatic or administrative events requiring reviewed correction. Removing an earlier break/lunch start while retaining its return legitimately fails timeline validation with 422.
- The UI displayed the generic error but omitted the server's specific dependency details.
- The submitted screenshot did not establish which individual event triggered that particular 422. The user confirmed Undo and requested checks of both last-action and row controls. No production attendance event was reversed during this investigation.

## Changes

- Last-action Undo now freezes an explicit target from the selected shift. It cannot silently undo a newer shift.
- Row and last-action controls use the same availability check. A newer action, expired undo window, imported/system/admin event or cross-shift command requires a reviewed correction instead of advertising an unsafe Undo.
- Availability uses the server-provided timeline, audit and reset deadline. Attendance state transitions, time accounting and payroll math remain exclusively server-side. The backend still previews and validates every command.
- Specific dependency messages appear inline, failed previews retain the reason, and a failed save clears the obsolete confirmation. The Reason field has a stable accessible name.

## Tests

All final commands exited 0:

```powershell
node --test scripts/attendance-undo-ui.test.mjs scripts/attendance-duration-ui.test.mjs scripts/attendance-undertime-status.test.mjs
npx tsx --test --test-reporter=spec src/services/attendanceIntegrity.integration.test.ts # backend directory
npx tsx --test --test-reporter=spec src/services/attendanceUndo.integration.test.ts # backend directory
npx tsc -b --pretty false
npx tsc --noEmit --pretty false # backend directory
npx eslint src/components/AttendanceCorrections.tsx src/lib/attendanceUndo.ts scripts/attendance-undo-ui.test.mjs scripts/attendance-undo-browser.mjs backend/src/services/attendanceUndo.integration.test.ts
node scripts/prepare-guarded-release.mjs crm-20261023-prepared-undoreview2 --code-only
node scripts/attendance-undo-browser.mjs outputs/crm-20261023-prepared-undoreview2/dist
```

- 22 UI/accounting regression assertions passed.
- The existing 36-test real MongoDB/API attendance suite passed, including dependent-event rejection and retained original evidence.
- The new real API test covered six business replicas: read-only preview, valid explicit undo targets, rejected earlier dependencies without writes, audit, idempotent retry, authorization, and fresh synchronized reads. Original events remained stored.
- Browser tests passed both controls in six sample businesses at desktop and mobile widths. They covered successful save/refresh, failure draft retention, actionable details and prevention of historical-shift retargeting. No page errors or production writes occurred in these fixtures.
- The first browser run exposed an unstable implicit textarea label; the stable accessible name fixed it. The first backend typecheck caught an untyped test fixture array; the final check passed after typing it.

## Online Activation

- Frontend: `crm-20261023-prepared-undoreview2`, published October 23 at 05:14:59 Asia/Manila.
- Backend remains `crm-20261023-prepared-workspace3` on its existing process and loopback port. All compiled backend hashes match the previous live release; the active Call Bridge download and configuration are unchanged.
- 942 source/build hashes verified. Only the frontend Nginx target changed, followed by configuration validation and graceful reload. No backend restarted and no existing connection was forced closed.
- Public release metadata, health and the published attendance editor asset hash were verified. The signed-in online admin page was refreshed only after confirming no open editor or draft, and loaded the new module in light mode.
- No database writes, migration, attendance undo, payroll approval or real telephone launch was performed in production.

## Use And Limitations

Refresh the admin page, open the shift's editor and review an eligible latest manual action with a reason before confirming. Older dependent, automatic or corrected events require a reviewed attendance correction; disabling unsafe Undo is intentional, not a bypass of timeline validation. A genuine concurrent change can still make the server reject a preview or confirmation; the draft and validation detail remain visible.

For rollback, retain the new hashed assets for already-open tabs, restore the prior frontend upstream from the private release receipt, validate Nginx and gracefully reload. The previous frontend remains available; no database restore is involved. Backend services and accounting rules were not modified by this release.
