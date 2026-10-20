# Clicked Attendance Duration Update

## Behavior

- One employee Break button alternates start/end for two breaks per assigned shift day. Each break has its own 15-minute allowance. Lunch is separate, once per shift, with a 60-minute allowance. Both buttons match the other attendance button sizes and show only Break/Lunch; state/action descriptions remain accessible through labels/tooltips, with the live timer outside the buttons. The shift-record table still shows the two breaks separately.
- No fixed break/lunch clock windows are used in duration mode. Existing clock-window settings/data are retained and hidden behind the flag.
- Confirmed by the user: completed rest intervals round to the nearest minute first. A 15:01 break has zero excess; 15:30 has one excess minute. Open rests show live overdue time but no finalized excess deduction.
- Late grace retains the existing minute-boundary rule. Undertime is finalized only after the scheduled shift ends. A background, audited derived-field refresh handles an earlier manual checkout without adding or changing attendance events.
- Corrections use the existing preview, reason, revision, fenced-lock, audit and outbox flow. Derived values are committed with the canonical change. Failed business/payroll delivery remains visibly pending and retryable. Finalized payroll is not silently rewritten.
- Ordinary notes remain business-local context. A note does not fabricate an attendance event. Saving a note reloads the server-computed day; corrections use the shared calculator.
- The new automatic cutoff is intentionally separate from the earlier manual-only behavior. Only the explicitly enabled server worker writes automatic returns/Time Out. It never runs from a GET, calendar rollover or browser timer.
- Default cutoff: 08:05 Asia/Manila on the overnight shift's end date, including a late 07:50 starter. Open break/lunch/off-phone intervals close first with the same timestamp. Automatic events have an explicit marker and Auto badge. A delayed/restarted worker still stamps 08:05, rather than its processing time. Processing normally occurs on the next 15-second worker tick; a down server cannot physically write at that instant.
- Manual checkouts, ambiguous assignments, unadopted legacy history, invalid timelines and future events are not overwritten. Per-ledger failures do not stop other employees. Stable command IDs, revision checks and fenced leases prevent duplicate automatic checkout.
- Audit entries store affected-day changes rather than two full copies of all historical days. Existing full audits remain readable.

## Flags And Local Preview

| Switch | Default | Purpose |
| --- | --- | --- |
| `CRM_ATTENDANCE_DURATION_MODEL` | Off | Shared duration deductions and durable derived snapshots |
| `VITE_CRM_ATTENDANCE_DURATION_MODEL` | Off | New Break/Lunch controls and duration-only settings |
| `CRM_ATTENDANCE_AUTO_TIMEOUT` | Off | Explicitly enable automatic overnight checkout |
| `CRM_ATTENDANCE_BREAK_GAP` | On | Retain the existing 30-minute gap between break starts |
| `CRM_ATTENDANCE_INTEGRITY` | Existing rollout default | Required canonical command/worker infrastructure |

Do not put production switches in committed environment files. Automatic cutoff is an administrator-only `AttendancePolicy.autoTimeOutTime` setting, validated as HH:MM and not before the 08:00 shift end.

Local seeded preview only, on port 5173:

```text
npm run dev:attendance -- --duration-model --auto-time-out
```

This launcher uses a disposable, fake-data database, not the original local database or online CRM. It refuses automatic-timeout testing with `--local-review`. Test codes: administrator `90000001`, employees `90000002` / `90000003`. Only one preview process should own localhost:5173; do not start a second preview on 5174.

## Verification

Final verification commands:

- Backend: `node --import tsx --test --test-reporter=spec "src/**/*.test.ts"`: 353 tests, 351 passed, zero failures, two skipped. The skipped suites require an external configured test Mongo URI for call reservations/availability; their live-database scenarios were not claimed as verified.
- Backend: `npm run typecheck`: passed.
- Frontend/root: `npm run lint`: passed.
- Frontend/root: `npm run build -- --outDir dist-local-employee-review`: passed with local duration/integrity/hub/workspace build flags enabled. Existing rich-text chunk-size warning remains.
- Frontend/root: `node --test scripts/attendance-duration-ui.test.mjs`: 12 passed, zero failures.

Coverage includes shared rounding, independent allowances, orphan returns, multiple sessions in one shift, a third break rejection, completed edit/reload parity, cross-business delivery and failures, automatic cutoff boundaries/races/restarts, derived refresh and bounded audit growth. The upload integration test now waits for the existing asynchronous replication result rather than assuming it completes before the original HTTP response; no message runtime behavior was changed.

Browser checks on localhost:5173 used fake employees only: first Break start/end, independent Lunch start/end, saved records after refresh and switching businesses, and desktop/mobile layout. Second-cycle/third-attempt coverage is automated; the live preview retains the 30-minute gap.

## Rollout, Backfill And Rollback

1. Publish/deploy source with duration and automatic-timeout switches OFF. GitHub publication is not deployment; this task does not change the online CRM.
2. With approval, run the read-only 60-day backfill preview described in `attendance-duration-derived-phase2.md`. It prints aggregate differences, not employee records. It has no apply path and rejects apply arguments.
3. Review historical mismatches/adoption separately. Any future data-changing migration requires explicit approval and a verified Mongo dump first. No historical backfill was applied by this task; no destructive migration is included.
4. Enable both duration-model switches and verify corrections, reloads, pending payroll and business replication.
5. Confirm the open policy questions below, then separately enable automatic cutoff. Refresh employee tabs.

Rollback: disable `CRM_ATTENDANCE_AUTO_TIMEOUT` first, then both duration switches and refresh/rebuild the frontend. This restores legacy controls/calculations without deleting evidence. Disabling flags does not erase already committed automatic events or audited corrections; reversing those requires an explicit reviewed correction.

## Policy Questions And Limits

- The 30-minute break-start gap remains on until the user explicitly chooses otherwise.
- Existing payroll weekend exemptions remain unchanged. Attendance insight excess on a weekend is not necessarily a payroll deduction. Weekday parity is tested separately.
- The cutoff currently applies to an existing non-ambiguous overnight session regardless of weekday. Weekend/holiday exclusions require confirmation before production activation. There is no new holiday-calendar inference.
- Legacy history requires reviewed adoption; the worker never silently adopts or repairs uncertain historical punches.
- This is not a claim of being bug-free or of live production verification. Original employee data, online deployment and real-world overnight timing are outside the local seeded verification.

## Manual Test

1. Sign in with a seeded employee at `http://localhost:5173/attendance` and click Time in.
2. Start/end Break using the same button. Confirm one completed break in the event records after refresh; only the name Break appears on the button.
3. Switch the employee's business and confirm the same events/counts.
4. After the configured gap, start/end Break again. Confirm two of two used and the button is disabled; a third API attempt must fail.
5. Start/end Lunch once. Confirm an independent timer and a second lunch is unavailable.
6. As admin, correct a return time through the existing popup with a reason. Reload and compare the shift records and pending payroll in both businesses.
7. Use automated fake-clock tests for 07:59, 08:04:59, 08:05, delayed processing and restart instead of altering a real employee's clock or data.
