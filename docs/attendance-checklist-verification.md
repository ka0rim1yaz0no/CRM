# Attendance Checklist Verification - 2026-10-21

## Confirmed Policy

- One reusable Break button, usable twice per assigned shift day, 15 minutes independently for each interval. No mandatory gap between the first and second break. One Lunch interval, 60 minutes.
- Only clicked start/return events determine rest duration; there are no permanent rest clock times in duration mode.
- Completed intervals round to the nearest minute first: 15:00 and 15:01 mean zero excess, 15:30 means one excess minute. This explicit user clarification supersedes the contradictory 15:01 example in the attachment.
- Automatic cutoff is 08:05 Asia/Manila on an existing overnight session's end date, including weekends and a late 07:50 starter. No session is invented for a day off. Processing can lag the exact stamped cutoff if the server is stopped.
- Latest one-button instructions supersede the attachment's earlier request for two separate Break buttons. Off the Phone is below the Break/Lunch row. Call dashboard design and behavior are unchanged by this update.

## Audit And Implementation Map

Phase 0 was reviewed before the duration implementation. Current source locations for the retained legacy behavior and shared replacements:

| Area | Verified Source | Outcome |
| --- | --- | --- |
| Legacy rest clock windows | `backend/src/controllers/payrollController.ts:398`, `:600`; `src/pages/admin/settings/index.tsx:1128` | Retained only for flag-off rollback. Duration policy takes precedence; clock-window inputs hidden in duration mode. Schema values are not deleted. |
| Shared allowance/calculation | `backend/src/services/timeAccounting.ts:9`; `backend/src/services/attendanceDerived.ts:45` | One clicked-duration calculator for independent rests, late/early deductions, open intervals and totals. Admin-only policy supplies allowances. |
| Hub/employee insights | `backend/src/services/attendanceHubMath.ts:62`; `backend/src/services/attendanceDashboardPresentation.ts:25`; `backend/src/controllers/attendanceSessionController.ts:44` | Shared calculations; parity fixtures and actual HTTP reload tests. |
| Actual payroll | `backend/src/controllers/payrollController.ts:621` | Shared duration calculator; actual DTR and persisted payroll verified in three synthetic businesses. Existing weekend waivers/finalized-payroll protections retained. |
| Corrections/edit popup/HR | `src/components/AttendanceCorrections.tsx:41`; `src/pages/admin/hr/attendanceForm.tsx:311`; `backend/src/services/attendanceLedgerService.ts` | Existing preview, reason, revision, fenced commit, audit and outbox path. No alternate attendance math or navigation to a second edit flow. |
| Notes | `backend/src/services/attendanceNoteCommand.ts`; `src/components/AttendanceDayNoteForm.tsx` | Atomic local note plus canonical recalculation/audit/jobs; stale drafts retained; idempotent retries. Private notes stay in their business. |
| Business delivery | `backend/src/services/attendanceLedgerOutbox.ts`; `src/lib/employeeWorkspaceCache.ts` | Employee-code membership mapping, durable retries, attendance and payroll cache refresh; notification after payroll attempt. |
| Policy changes | `backend/src/services/attendancePolicyRefreshWorker.ts` | Audited refresh of already-derived days only; missing-derived/unadopted history is not backfilled. Failures stay visibly pending. |
| Cutoff | `backend/src/services/attendanceAutoTimeOutWorker.ts`; `backend/src/services/attendanceAutoTimeOut.ts` | Server-only, explicit flag, deterministic session command, exact stamped cutoff, paired return before checkout, Auto marker. |

## Checklist Status

- Phase 1 complete under the duration flag: shared calculation, single policy, legacy-window isolation, strict API ordering/limits with HTTP 409, and compact reusable buttons. Two-break and lunch counts cannot reset by timing out and back in during the same shift day.
- Phase 2 complete for canonical commands: derived values/audits commit with attendance; note confirmation uses a real shared-client Mongo transaction. Business delivery is deliberately asynchronous, not a distributed all-business transaction. Partial failures remain pending until retries finish. Policy edits recompute already-derived days without rewriting attendance evidence. Historical backfill tooling is read-only and intentionally not applied.
- Phase 3 complete behind its separate opt-in: cutoff boundary/race/restart checks, active-rest closure, late starter, weekend sessions, stable equal-timestamp ordering in payroll, Auto badges, admin-only cutoff validation. Post-cutoff non-checkout clicks wait for the worker instead of creating events that would make exact cutoff impossible. Manual checkout retains precedence.
- Phase 4 local verification complete as listed below. This is not production verification or a guarantee that no undiscovered bugs exist.

## Actual Verification

All tests used synthetic seeded data and isolated disposable databases. No environment files, keys, uploads, application logs, or original employee/customer database were read. No production changes or historical data-changing script were run.

| Command | Result |
| --- | --- |
| Backend: `node --import tsx --test --test-reporter=spec "src/**/*.test.ts"` | 390 tests: 388 passed, 0 failed, 2 skipped. |
| Backend: `npm run typecheck` | Passed. |
| Root: `npm run lint` | Passed. |
| Root: `npm run build -- --outDir dist-local-employee-review` | Passed with local workspace/integrity/hub/duration flags. Existing rich-text chunk-size warning remains. |
| Root: `node --test scripts/attendance-duration-ui.test.mjs` | 13 passed. |
| Root: `node --test scripts/local-review-ports.test.mjs scripts/attendance-duration-ui.test.mjs` | 15 passed, including IPv4/IPv6 port conflicts. |

New real-Mongo/HTTP suites: `attendanceBreakLimits.integration.test.ts` (3 tests, three businesses), `attendancePolicyRefresh.integration.test.ts` (7 tests, three businesses), `attendanceNoteCommand.test.ts` (13 transaction/scoping/retry tests). The automatic return/checkout payroll sequence test was added to `attendanceIntegrity.integration.test.ts`. Cutoff suite: 44 passing boundary/race/weekend tests. Workspace cache tests cover actual payroll query invalidation.

The two skipped existing suites concern external-database call reservations/availability. They are not attendance-duration failures, but those scenarios were not verified by this run.

Browser verification uses only `http://localhost:5173`: fresh fake employee clock-in, first break start/end, immediate second break start/end, one lunch start/end, disabled exhausted buttons, off-phone start/return, manual checkout, refresh and business switching. Exact 15/60-minute amounts and edited deduction persistence were tested with controlled clocks in the real HTTP/database suites, not by waiting through physical 15/60-minute breaks. Desktop/mobile layout checks use the same port.

At 1280x900 the rest buttons share the other controls' height, with Off the Phone below them. At 390x844 all five controls measured 45px high, without horizontal overflow (390px document width). Ten saved events persisted after refresh and switching from Sample Operations to Sample Studio. A second ordinary Vite process was detected on IPv6 during testing and stopped; `vite.config.ts` now probes both loopback addresses before listening, defaults strictly to 5173, and refuses a second server rather than silently serving different flags or moving to 5174. An actual second-start attempt exited with the expected port-conflict error while the original updated app stayed available.

## Data, Flags And Rollback

Additive fields only: optional `Attendance.sequence`, note revision/command/before-after audit metadata, and a scoped note reference in the canonical audit. No destructive migration, collection rewrite, or original-data reset is included. Mongo transactions require a replica set/shared client; unsupported note transactions fail without partial writes. The local launcher supplies a disposable replica set.

Duration flags and automatic cutoff default OFF in production. Local launcher enables the requested modes on port 5173. `CRM_ATTENDANCE_BREAK_GAP` defaults OFF only when duration mode is ON; legacy mode retains its prior default. Both default 15/60 allowances and cutoff are administered through the existing attendance policy editor.

For future approved rollout: deploy source with flags off, run the approved read-only 60-day preview, review differences, obtain separate approval and a verified Mongo dump before any future historical write, enable backend/frontend duration mode and test, then enable automatic cutoff. This task only publishes source to GitHub; it does not deploy it.

Rollback: turn automatic cutoff off first, then disable both duration-model flags and refresh/rebuild the frontend. Original calendar/legacy attendance code remains available. Flags do not erase already committed events or audits. Historical repairs require a reviewed correction, never deletion of evidence.

The backfill preview has no apply mode. Thus no dump/restore operation was necessary or performed here. No promise is made about physically processing at 08:05 while a server is unavailable, an untested production database topology, or already-finalized payroll being automatically rewritten.

See `attendance-duration-rollout.md` for flags and the manual click-through script, and `attendance-duration-derived-phase2.md` for backfill preview usage and durable delivery details.
