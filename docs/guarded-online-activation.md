# Guarded Online Activation

## Current State

As of October 21, 2026 (Asia/Manila), the public release remains `crm-20261021-eb493d6`. The live API and frontend are PM2 7 and 8. The guarded candidate, PM2 9, is stopped and has never been exposed publicly. No GitHub push was performed during this recheck.

The user selected the next employee break for the final cutover and will explicitly confirm when ready. Do not stop, restart, reload, replace or reroute the live API, frontend or database before that confirmation. Do not force employee refreshes or sign-outs during calls.

## Verified Sync Recheck

- Before retry: one isolated-copy business delivery pending, with no recorded worker failure.
- After the existing `deliverAttendanceLedger` operation: zero pending deliveries, zero delivery errors. The retry plus preservation verification took 543 ms.
- All seven isolated databases were encrypted and verified before retrying. Original attendance sources/timestamps and every existing saved payroll document still matched their pre-adoption fingerprints afterward.
- The live API remained online with the same process uptime and zero restarts. No live database writes were made by the recheck.
- Read-only comparison verified all 39 employee-business replicas across six businesses and 15 canonical identities: 20,830 effective events, zero event/revision mismatches, zero availability mismatches, zero derived-deduction mismatches, zero pending jobs.
- The original 40-second readiness loop was too short to accommodate arbitrary bounded-worker backlogs. The retry demonstrates that this pending item was deliverable; it does not establish that every possible future delivery failure is eliminated.

The runtime worker retains its two-second work budget and 15-second cadence. Increasing its work budget could hurt live request latency and was not needed. The operational readiness guard now waits for real progress, requires exactly zero pending jobs, and fails closed after two minutes without progress or ten minutes overall. Sampling uses monotonic time; unavailable or invalid counts are never treated as ready.

## Remaining Cutover Requirements

The original live database is standalone. The isolated replica-set copy is stale once employees resume writing call activity. A successful isolated sync check does not prove that this copy is current. MongoDB does not provide change streams on a standalone server, and Mongosync does not support a standalone source. See [MongoDB change streams](https://www.mongodb.com/docs/manual/changestreams/) and [Mongosync limitations](https://www.mongodb.com/docs/mongosync/current/reference/mongosync-binary/).

The final operator workflow must:

1. Obtain the user's ready confirmation after calls finish; pause new calls, attendance and administrative writes together. Do not infer consent from an idle heartbeat or a zero-call count alone.
2. Preserve the current runtime configuration privately and verify call completion, reservations and any unknown bridge states without printing identities or phone numbers.
3. Take a fresh encrypted backup of every CRM database. Prepare a fresh isolated target; do not overwrite the original source or blindly restore over the older adopted copy. Retain the older backup/copy for recovery and use a distinct backup/receipt batch.
4. Copy and verify all collection counts and BSON fingerprints. Re-review and adopt the fresh histories through the existing backed-up adoption transaction, without fabricated punches or automatic historical repairs.
5. Drain the initial candidate-only delivery backlog through the normal delivery service and require zero pending jobs. Preserve the bounded background-worker behavior. Recheck original punches, saved payroll, signed login, secure upload cookie, role scoping, attendance, deductions and dashboards in every configured business.
6. Compare the still-quiescent source with the exact reviewed copy snapshot again before publication. `assertSourceUnchanged` rejects new, edited or deleted records, collections and databases. Recheck that the original API has not resumed while the candidate was being verified.
7. Persist and sync the process-manager primary/backup state with the original writer stopped, then persist and sync a private public-exposure intent before the first publicly routed candidate API could accept a write. This prevents an ordinary process-manager resurrection from selecting the old writer during an interrupted switch. From public exposure onward the new database must remain authoritative, even if the frontend switch fails. Never silently restore the old standalone source after potential new writes. Failure before exposure may resume only the source process that was already paused for this rollout, never restart an online source after a preflight failure.
8. Publish the matching frontend, preserving the cinematic login assets and all matching frontend/backend rollout switches. Keep Data Check navigation hidden and the old recovery cutoff disabled. Retain signing and vault keys.
9. Verify public health, release ID, login assets and all-business guarded reads. Resume employees only after those checks, with refresh/sign-in performed after their calls are finished. A consenting employee must verify real Nextiva behavior; automated tests do not prove physical dial timing.

The old activation helper is not an unattended deployment command. It intentionally rejects the current online-source/stopped-candidate state and the stale snapshot. A fresh target, receipt batch and explicit quiet window are prerequisites before using an updated cutover helper.

## Tests

`node --test scripts/attendance-rollout-guard.test.mjs` covers completion beyond forty seconds, stalled and oscillating backlogs, the overall deadline, invalid counts/read failures, stale-copy rejection, exposure fencing, and refusal to restart an online call API after a failed preflight.

Recheck commands and results:

- `node --test <all scripts/*.test.mjs paths>`: 104 passed, zero failures.
- `npm run lint`: passed.
- From `backend`, `node --import tsx --test src/services/localLegacyAttendanceAdoption.integration.test.ts src/services/attendanceAccuracyHttp.integration.test.ts src/services/securityCredentialCompatibility.integration.test.ts src/services/attendanceLedgerOutbox.test.ts`: 22 tests registered and passed, zero failures.
- `node --check outputs/activate-guarded-release.mjs`: passed. The cutover script was staged but not executed against live services.

No frontend rebuild or new backend compilation was necessary for these operational guard scripts; the application runtime source and cinematic login were unchanged. Real reboot/crash recovery during a database switch has not been exercised; do not interpret process-state fencing as a completed disaster-recovery drill.

These are operational safety changes, not a second attendance calculation implementation. No attendance thresholds, payroll amounts, call timing rules, authentication contracts or dashboard calculations were changed.
