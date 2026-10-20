# Attendance Duration Derived Fields: Phase 2

## Scope

- `backend/src/services/attendanceDerived.ts` exports `deriveAttendanceDays(ledger, policy, now)`.
- It projects corrections and closures first, groups sessions by the assigned shift day, and calculates one canonical day rather than summing business replicas or individual session lateness/early checkout.
- Break and lunch intervals are paired within individual sessions. A missing return cannot pair with a different session's return. Administrative missing-checkout closures are not real Time Outs and do not invent completed breaks.
- All calculations use the shared `calculateSlotAttendance` function. The confirmed completed break/lunch rule is nearest minute: 15:01 has zero excess; 15:30 has one minute excess. Open intervals expose raw overdue milliseconds but have zero final excess deduction. Early checkout deductions require a closed session and `now >= shiftEnd`.
- Payroll's existing weekend deduction waivers remain payroll-specific. Insight duration accounting does not depend on weekday or official break/lunch clock windows; a weekend insight issue is not automatically a payroll deduction.

## Durable Save And Delivery

The additive `AttendanceLedger.derived`, `Attendance.derived`, and audit `beforeDerived`/`afterDerived` fields preserve derived data with the evidence. The canonical command save computes and stores the next revision's derived days alongside events, audit and outbox jobs in the existing fenced compare-and-set operation. Snapshot reads return that stored result.

`attendanceLedgerOutbox.ts` attaches the assigned day's derived snapshot to each effective attendance event in every assigned business. Consumers must count a derived day once, not sum the repeated event copies. It also copies the auto-time-out marker.

Every pending duration-model delivery, including normal actions and automatic checkout, requests actual payroll recalculation. Correction and closure dates include the assigned shift start, so both old and new affected pay periods are considered. A missing replica employee, failed attendance write, failed payroll recalculation, or lost revision leaves delivery pending. Attendance availability events are emitted after the payroll attempt and completion marker, avoiding a refresh racing old payroll totals. A failed payroll attempt still publishes confirmed attendance state with durable delivery pending.

Canonical derivation happens on every command, including ordinary actions and auto time-out. Delivery deliberately uses the committed snapshot instead of recomputing it at a later wall clock or under a changed policy. This preserves exact canonical/replica parity on retries. A pre-derived ledger can be calculated provisionally at its latest audit timestamp; delivery never mutates the canonical snapshot outside the fenced save. Policy saves now queue audited canonical recomputation of already-derived days; unadopted/missing-derived historical backfill still requires separate approval.

### Policy And Note Confirmation

`attendancePolicyRefreshWorker.ts` detects stored policy-revision mismatches and uses a deterministic system-only `recalculate-policy` command. It changes derived snapshots/audits/jobs, never attendance evidence. Each ledger is isolated from another ledger's failure. Partial canonical or business/payroll failures stay visibly pending and retry in the existing maintenance worker. Read endpoints may display explicitly pending current-policy calculations but never persist them. Original command replay reconstructs the original policy snapshot.

`attendanceNoteCommand.ts` confirms a business-local note and canonical derived calculation in one Mongo transaction. Attendance and note revisions protect against lost updates; stable command IDs replay the committed result. Private note text and excuse flags remain in the owning business, while a scoped hash/reference is attached to the canonical audit. Notes are not attendance punches or a payroll deduction waiver. If the connection cannot provide the shared-client transaction, the request fails without a partial note save. Successful saves invalidate attendance and actual payroll query families.

The additive `Attendance.sequence` field preserves ordering for equal-timestamp events, especially an automatic rest return followed by Time Out at 08:05. Existing records without sequence retain the existing stable fallback; no historical rewrite is required.

### Shift-End Finalization And Compact Audits

`attendanceDerivedRefreshWorker.ts` now runs in the existing 15-second integrity maintenance cycle independently of the auto-time-out flag. It requires integrity and duration-model opt-ins. Only stored closed days with `computedAt < shiftEnd <= now` qualify; active, unadopted, invalid, missing-derived and already-finalized days are skipped. Under the same fenced lease/CAS, a deterministic system-only `recalculate` command rechecks eligibility, updates only the target day's derived snapshot, appends an audit and queues every business. Its database update contains no attendance events, corrections or closures. Read-only snapshots/GETs never trigger finalization. Late worker runs use their actual processing timestamp and remain once-only; partial replica/payroll failure leaves durable jobs pending.

Closed days with unchanged amounts, including an administrative closure before shift end, are finalized too. A compact `derivedMetadata` audit records their updated calculation timestamp without duplicating unchanged financial snapshots; subsequent scans do not select them again.

New audits are versioned day-level deltas (`derivedAuditVersion: 1`): `beforeDerived` and `afterDerived` contain only days with changed values, and `removedDerivedDays` records deletions. Metadata-only differences are excluded. Ordinary commands retain unchanged historical day snapshots instead of restamping their timestamps/revisions. A one-time `derivedBaseline` seeds replay for already-existing history; historical full-snapshot audits remain immutable and readable. Replay reconstructs the baseline plus deltas up to the requested revision, including metadata finalization and deleted days. No historical audit is rewritten or removed.

`attendanceDerivedRefreshWorker.test.ts` covers durable zero-to-undertime finalization at the exact shift end, zero-amount administrative closures, system-only/flag/idempotency guards, no event writes, lease loss, two-worker races, restart, pending delivery, active-day rechecks, metadata-only deltas, legacy audit compatibility, removed days and multi-day replay/growth. The 30-day/60-command fixture stores one changed day per new audit rather than every historical day. Outbox tests also check derived-only refresh payroll and socket updates for both businesses.

`CRM_ATTENDANCE_DURATION_MODEL` is explicit opt-in (`true` or `1`), off by default in production, development and tests. When off, outbox delivery writes no derived fields and retains ordinary-action payroll behavior. The existing correction/recovery payroll paths and the new auto-checkout payroll path remain available.

## Business-Local Note Confirmation

With the duration model enabled, note POSTs require a UUID `commandId`, canonical `expectedRevision`, and tenant-local `expectedNoteRevision`. Older clients receive 426 without a write; flag-off requests retain existing local-note behavior. Hub day reads expose `attendanceRevision`, `noteRevision`, and `noteExcused` separately from leave-derived display status.

`attendanceNoteCommand.ts` uses a shared-client Mongo session and transaction for the tenant note CAS, full tenant-local before/after audit, canonical derived recomputation, compact canonical audit, and outbox jobs. Canonical reads, seeding, lease, CAS and release use that same session; no outside lease renewal runs. Transaction support is required, with no fallback to partial sequential writes. The `confirm-note` operation writes no attendance events.

Note text and excuse values remain tenant-local. Shared audits contain only a scoped business/day/note-revision/content-hash reference. Local excuses do not globally waive deductions. Duplicate commands replay their original note revision without another audit. After commit, delivery updates shared attendance derivatives, recalculates payroll and notifies each business; failures return `syncPending` and retain durable retry jobs.

The form retains its draft and UUID across failed retries, checks text and excuse state, and provides an explicit revision reload without discarding text. Shared attendance refresh invalidates payroll-records/stats/DTR/payslip query prefixes for notes, HR saves and corrections across businesses.

`attendanceNoteCommand.test.ts` verifies real transactions using a disposable synthetic Mongo replica set, a cached executable and downloads disabled. Coverage includes commit, rollback, races, replay, privacy, legacy revisions, endpoint compatibility, scoped hub reads and delivery/payroll notifications. No existing database, real user data, application server, environment file, Git or online service is used.

## Dry-Run Backfill

`backend/src/scripts/backfillAttendanceDerived.ts` is strictly read-only. It has no apply implementation, rejects `--apply` and backup/apply options, does not load environment files, and requires every database destination explicitly. It uses raw driver `find`/`findOne` calls so model auto-index creation cannot write to the database. Use a database account with read-only permissions when an approved operator eventually runs it.

From the backend directory, the supported invocation shape is:

```text
node_modules/.bin/tsx src/scripts/backfillAttendanceDerived.ts --dry-run --uri <approved-read-only-uri> --ledger-database <canonical-ledger-db> --business <business-id>=<business-db> --business <other-id>=<other-db> --as-of <ISO-timestamp>
```

The window is the current Asia/Manila shift day and the preceding 59 shift days. A context day is read to retain complete overnight pairs at the boundary. Assigned shift days, not individual event calendar dates, determine inclusion. The canonical global attendance policy must already exist.

Output contains counts and aggregate minute totals per business only: employees/days/records checked, differing days/records, missing derived records, canonical differences, per-field diff counts, before/after totals, unmatched records, and legacy/review counts. Repeated snapshots on event rows are counted once per day. Employee codes, record IDs, timestamps, connection strings, and raw events are never printed. Computed-at and revision metadata alone are not counted as financial differences.

Legacy rows without a canonical ledger receive a provisional, read-only calculation and a review count; this does not adopt legacy attendance or infer that historical business copies agree. Unmatched events remain explicitly counted. No live backfill was run during implementation.

There is no apply path. A future write migration requires explicit user approval, a verified database backup, and an independently reviewed guarded command that persists canonical snapshots and schedules replica/payroll delivery together.

## Rollout And Verification

1. Deploy with duration and auto-time-out flags off.
2. Obtain approval and run the read-only 60-day preview with read-only credentials; review differences and legacy/unmatched counts.
3. Review and approve any historical write migration separately, with a verified backup. This script cannot apply it.
4. Enable `CRM_ATTENDANCE_DURATION_MODEL=true` and verify new commands, corrections, reloads and cross-business delivery.
5. Enable the separately owned auto-time-out flag only after duration-model verification.

Synthetic coverage is in `attendanceDerived.test.ts`, `attendanceDerivedBackfill.test.ts`, and `attendanceLedgerOutbox.test.ts`: nearest-minute duration edges, corrections and serialization, multiple sessions per day, overnight auto checkout, open interval and administrative closure handling, read-only argument guards, count-only aggregation, 60-day boundaries, cross-business copies, flag-off behavior, immutable snapshot retries and payroll failures.

This focused module coverage uses fake events and mocked model methods. Broader real-Mongo integration, payroll parity and localhost browser results are recorded in `attendance-duration-rollout.md`. Neither report claims production verification.
