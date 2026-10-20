# Clicked Attendance Duration Update

## Behavior

- One employee Break button alternates start/end for two breaks per assigned shift day. Each break has its own 15-minute allowance. Lunch is separate, once per shift, with a 60-minute allowance. Both buttons match the other attendance button sizes and show only Break/Lunch; state/action descriptions remain accessible through labels/tooltips, with the live timer outside the buttons. Off the Phone sits in its own full-width row below Break/Lunch. The shift-record table still shows the two breaks separately.
- Confirmed by the user: the second break may start immediately after the first ends. Duration mode defaults to no break-start gap; the legacy flag-off path retains its existing gap.
- No fixed break/lunch clock windows are used in duration mode. Existing clock-window settings/data are retained and hidden behind the flag.
- Confirmed by the user: completed rest intervals round to the nearest minute first. A 15:01 break has zero excess; 15:30 has one excess minute. Open rests show live overdue time but no finalized excess deduction.
- Late grace retains the existing minute-boundary rule. Undertime is finalized only after the scheduled shift ends. A background, audited derived-field refresh handles an earlier manual checkout without adding or changing attendance events.
- Corrections use the existing preview, reason, revision, fenced-lock, audit and outbox flow. Derived values are committed with the canonical change. Failed business/payroll delivery remains visibly pending and retryable. Finalized payroll is not silently rewritten.
- Ordinary notes remain business-local context, not a global financial excuse. In duration/integrity mode, note confirmation and canonical recalculation/audit/outbox commit in one shared-client Mongo transaction, with attendance/note revision checks and retry-safe command IDs. A note does not fabricate an attendance event or copy its private text to other businesses. Unsupported transactions fail closed instead of partially saving.
- Policy changes refresh already-derived canonical days through audited system commands and the same outbox. Pending recalculation/delivery remains explicit and retryable; GET requests remain read-only. Unadopted or missing-derived historical data is not silently backfilled.
- The new automatic cutoff is intentionally separate from the earlier manual-only behavior. Only the explicitly enabled server worker writes automatic returns/Time Out. It never runs from a GET, calendar rollover or browser timer.
- Default cutoff: 08:05 Asia/Manila on the overnight shift's end date, including a late 07:50 starter and weekend overnight sessions, as confirmed by the user. Open break/lunch/off-phone intervals close first with the same timestamp. Automatic events retain canonical sequence order in business replicas/payroll and have an explicit marker and Auto badge. A delayed/restarted worker still stamps 08:05, rather than its processing time. Processing normally occurs on the next 15-second worker tick; a down server cannot physically write at that instant.
- Manual checkouts, ambiguous assignments, unadopted legacy history, invalid timelines and future events are not overwritten. Per-ledger failures do not stop other employees. Stable command IDs, revision checks and fenced leases prevent duplicate automatic checkout.
- Audit entries store affected-day changes rather than two full copies of all historical days. Existing full audits remain readable.

## Flags And Local Preview

| Switch | Default | Purpose |
| --- | --- | --- |
| `CRM_ATTENDANCE_DURATION_MODEL` | Off | Shared duration deductions and durable derived snapshots |
| `VITE_CRM_ATTENDANCE_DURATION_MODEL` | Off | New Break/Lunch controls and duration-only settings |
| `CRM_ATTENDANCE_AUTO_TIMEOUT` | Off | Explicitly enable automatic overnight checkout |
| `CRM_ATTENDANCE_BREAK_GAP` | Off in duration mode; On in legacy mode | Explicit override for the old 30-minute break-start gap |
| `CRM_ATTENDANCE_INTEGRITY` | Existing rollout default | Required canonical command/worker infrastructure |

Do not put production switches in committed environment files. Automatic cutoff is an administrator-only `AttendancePolicy.autoTimeOutTime` setting, validated as HH:MM and not before the 08:00 shift end.

Local seeded preview only, on port 5173:

```text
npm run dev:attendance -- --duration-model --auto-time-out
```

This launcher uses a disposable, fake-data database, not the original local database or online CRM. It refuses automatic-timeout testing with `--local-review`. Test codes: administrator `90000001`, employees `90000002` / `90000003`. Only one preview process should own localhost:5173; do not start a second preview on 5174.

The Vite configuration also checks both IPv4 and IPv6 loopback addresses before starting and uses strict port 5173. A second `npm run dev` now exits with a port-conflict message instead of presenting an older/default-flag app to some browsers.

## Verification

Final verification commands:

- Backend: `node --import tsx --test --test-reporter=spec "src/**/*.test.ts"`: 390 tests, 388 passed, zero failures, two skipped. The skipped suites require an external configured test Mongo URI for call reservations/availability; their live-database scenarios were not claimed as verified.
- Backend: `npm run typecheck`: passed.
- Frontend/root: `npm run lint`: passed.
- Frontend/root: `npm run build -- --outDir dist-local-employee-review`: passed with local duration/integrity/hub/workspace build flags enabled. Existing rich-text chunk-size warning remains.
- Frontend/root: `node --test scripts/attendance-duration-ui.test.mjs`: 13 passed, zero failures.

Coverage includes shared rounding, independent allowances, orphan returns, multiple sessions in one shift, a third break rejection, completed edit/reload parity, cross-business delivery and failures, automatic cutoff boundaries/races/restarts, derived refresh and bounded audit growth. The upload integration test now waits for the existing asynchronous replication result rather than assuming it completes before the original HTTP response; no message runtime behavior was changed.

Browser checks use localhost:5173 and fake employees only. Exact 15/60-minute boundary and rejection behavior are covered by fake-clock HTTP/Mongo tests rather than waiting through physical rest periods. See the latest checklist verification report for this run's final results.

## Rollout, Backfill And Rollback

1. Publish/deploy source with duration and automatic-timeout switches OFF. GitHub publication is not deployment; this task does not change the online CRM.
2. With approval, run the read-only 60-day backfill preview described in `attendance-duration-derived-phase2.md`. It prints aggregate differences, not employee records. It has no apply path and rejects apply arguments.
3. Review historical mismatches/adoption separately. Any future data-changing migration requires explicit approval and a verified Mongo dump first. No historical backfill was applied by this task; no destructive migration is included.
4. Enable both duration-model switches and verify corrections, reloads, pending payroll and business replication.
5. Separately enable automatic cutoff after testing; confirmed policy includes weekend overnight shifts. Refresh employee tabs.

Rollback: disable `CRM_ATTENDANCE_AUTO_TIMEOUT` first, then both duration switches and refresh/rebuild the frontend. This restores legacy controls/calculations without deleting evidence. Disabling flags does not erase already committed automatic events or audited corrections; reversing those requires an explicit reviewed correction.

## Policy Questions And Limits

- The user confirmed no mandatory gap in duration mode, nearest-minute rounding, and weekend overnight cutoff. These are no longer open questions.
- Existing payroll weekend exemptions remain unchanged. Attendance insight excess on a weekend is not necessarily a payroll deduction. Weekday parity is tested separately.
- The cutoff applies to an existing non-ambiguous overnight session regardless of weekday. There is no new holiday-calendar inference or invented session on a day off.
- Legacy history requires reviewed adoption; the worker never silently adopts or repairs uncertain historical punches.
- This is not a claim of being bug-free or of live production verification. Original employee data, online deployment and real-world overnight timing are outside the local seeded verification.

## Manual Test

1. Sign in with a seeded employee at `http://localhost:5173/attendance` and click Time in.
2. Start/end Break using the same button. Confirm one completed break in the event records after refresh; only the name Break appears on the button.
3. Switch the employee's business and confirm the same events/counts.
4. Immediately start/end Break again. Confirm two of two used and the button is disabled; a third API attempt must fail with HTTP 409 without writing anything.
5. Start/end Lunch once. Confirm an independent timer and a second lunch is unavailable.
6. As admin, correct a return time through the existing popup with a reason. Reload and compare the shift records and pending payroll in both businesses.
7. Use automated fake-clock tests for 07:59, 08:04:59, 08:05, delayed processing and restart instead of altering a real employee's clock or data.
