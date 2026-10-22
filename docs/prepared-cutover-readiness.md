# Prepared Cutover Readiness

Verified October 22, 2026, Asia/Manila. Preparation only: no quiet-window confirmation has been supplied and the public release has not been switched. Localhost 5173 remains the design authority. No older online design was merged and no GitHub push was performed.

## Completed Before The Pause

- The existing local-design release is already built and staged at `/home/ftpuser/assistly/releases/crm-20261021-prepared`. All 875 selected source/build checksums passed again. No frontend or backend build, dependency installation or application archive upload is needed during the pause if these files remain unchanged.
- A **fresh, authenticated, loopback-only** single-node replica set is initialized on port 27020, service `assistly-crm-mongodb-prepared`, replica name `assistly_crm_prepared_rs`, data directory `/var/lib/assistly-crm-mongodb-prepared`. It is empty apart from Mongo system databases. This is the next target, not the stale port-27019 copy and not the original live database. Single-node replication is not high availability.
- A restrictive-umask configuration permission problem was found and fixed on that empty target: directory 0750/root:mongodb, configuration 0640/root:mongodb and member key 0400/mongodb:mongodb. Authentication and primary readiness subsequently passed. No production service was restarted.
- The exact compiled backend ran privately on port 4001 with the complete guarded release profile and two synthetic businesses. **82 assertions passed**: signed admin/employee login, secure file cookie, private data minimization, anonymous rejection, guarded reads, manual attendance, two breaks/one lunch, third-break/second-lunch rejection, refresh parity, payroll preview amount parity, canonical/replica/availability/derived parity, competing call reservations and the 29,999/30,000 ms boundary. The child process exited and all four precisely namespaced synthetic databases were removed. No real Nextiva call was placed and no real payroll was approved.
- **17 deployment-safety tests passed locally and on the server.** These cover target URI/path restrictions, sealed companion filenames, synthetic cleanup scoping, unchanged live-process identities, required user-confirmed maintenance, stalled outbox handling, source freshness and no old-database rollback after possible public writes. All new operational files passed native Node syntax checks.
- Read-only preflight covered six businesses and seven source databases, approximately 277 MiB allocated in aggregate at the time of inspection. Over 136,000 MiB of backup disk was available. Dump/restore/FIFO tools were present, the private staging port was free, and the new target was authenticated and empty. These sizes are capacity checks, not measured final migration time.
- Public API/frontend PM2 7 and 8 and unrelated application PIDs, statuses, uptimes and restart counters remained unchanged. No live flags, routes, Nginx settings, sessions, uploads or employee records were changed.

## Release-Specific Operations

The preparation companions live locally in `outputs/` and on the server in `/root/assistly-release-tools/`. They are separate from the sealed application source/build archive, so preparing operational tools does not rebuild or alter the authoritative UI.

- `guarded-preparation-contract.mjs`: release/target paths and strict quiet-window validation.
- `check-prepared-cutover-readiness.mjs`: read-only artifact, target, capacity, rehearsal and unchanged-process checks. It does not activate anything.
- `copy-prepared-release.mjs`: fresh encrypted backup, authenticated verification/restore, complete BSON comparison and reviewed canonical adoption. It refuses a nonempty target, a changed business catalog, a missing rehearsal, existing exposure state or absent/expired maintenance confirmation. It captures the current private runtime before pausing, rather than relying on the earlier configuration snapshot.
- `activate-prepared-release.mjs`: uses the same central profile as the frontend and the rehearsed backend; drains outbox jobs, verifies every canonical business replica, preserves original attendance evidence/saved payroll and checks source fingerprints both before and after private verification. The original signing/vault keys are retained. Counts are dynamic, not fixed to the previous 15 identities or six businesses.
- `verify-prepared-projections.mjs`: shared read-only gate for event/revision, availability, derived-value and pending-job parity. This gate also passed on the synthetic native rehearsal.
- `read-prepared-business-catalog.mjs`: separate read-only process for complete catalog verification, avoiding a source-to-target Mongoose connection-cache crossover.
- `attendance-rollout-guard.mjs`: progress-aware outbox deadline and exposure-aware recovery rules.

New private receipt/configuration batch: `/root/assistly-release-private/guarded-20261022-prepared`.
Future encrypted backup destination: `/root/assistly-release-backups/guarded-20261022-prepared`.
Future backup key location: `/root/assistly-backup-keys/guarded-20261022-prepared.key`.
Never display, download or commit the runtime, database URI, vault key, backup key or raw data files from those locations. The safe rehearsal and preflight receipts contain aggregate results only.

The earlier `guarded-20261021` replica/copy and encrypted backups remain preserved. Do not route traffic to that stale copy or blindly execute the older fixed-path helpers. Do not rerun the one-off bootstrap recovery helper against an initialized target.

## At The Confirmed Pause Only

1. Obtain explicit user confirmation that calls are finished, employees have paused and attendance/administrative writes are paused. Check active calls, reservations and unknown bridge states; a zero count alone is not consent. Do not force refresh or sign-out during a call.
2. Repeat the read-only preflight and source/catalog review. If the code, catalog, runtime or target changed, refresh the preparation instead of assuming the earlier receipt still applies. Inspect upcoming 08:05 cutoffs so automatic timeout cannot race adoption/preservation checks.
3. Only after that user confirmation, create a private 0600 `maintenance-window.json` attestation for this exact release/batch with `operatorConfirmed`, `callsFinished`, `employeesPaused` and `administrativeWritesPaused` all true, a truthful confirmation reference and the current ISO timestamp. No such attestation exists now. The helpers reject one older than an hour or dated in the future. If it expires, keep writes paused and renew only after reconfirming the maintenance state.
4. Execute the release-specific copy helper. This is the first step that may stop PM2 7. It still must take a **fresh** encrypted backup/copy and verify all source records; neither the empty prepared target nor the stale older copy is current production data. Review any new blocked/overdue histories without inventing punches or changing valid records.
5. Execute the release-specific activation helper only after copy/adoption receipts pass. It privately starts the candidate, checks signed login and every configured business, drains real pending jobs, verifies replicas and preserves source evidence. It does not publish if these checks fail.
6. Immediately before publication the helper rechecks the unchanged source and paused API, persists the stopped-original-writer process state and a synced exposure intent, then starts the candidate on public API port 4000 and publishes the matching frontend on 5173. No Nginx route change or shared Mongo restart is required.
7. Verify public health, release identity, cinematic login assets, signed role-scoped reads, dashboard/Attendance UI and deductions for each business. Only then resume staff with refresh/sign-in. Measure a consenting employee's real Nextiva hang-up-to-dial interval and duplicate behavior separately.

Before public exposure, a failed cutover may resume only the original process paused for this operation. **After possible public writes, never restart the old standalone-database writer or revert the database URI.** Retain the new replica as authoritative and recover application code/settings on it. Real crash/reboot recovery and the final production copy/cutover have not been rehearsed end-to-end; safety-unit tests are not proof of either.

## Remaining Time

Builds, application uploads, empty replica initialization, runtime dependency checks and synthetic native rehearsal are moved outside the pause. Fresh backup/copy, current-history review/adoption, final outbox/record checks, the public switch and live acceptance cannot safely be pre-completed while staff continue writing call activity. No shorter downtime guarantee is implied by the preparation measurements.
