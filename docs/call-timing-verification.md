# Post-Call Timing Verification

## Scope And State

October 23, 2026. Working copy: `C:/Users/hp/OneDrive/Desktop/crm`, branch `security-data-check`. Existing unrelated changes were preserved. No AGENTS.md was present in the applicable workspace paths.

The additional request explicitly prohibits automatic production deployment. Employees' live calls, production services, production flags, records and GitHub were not changed. The new code-only preparation is `crm-20261023-prepared-timing`; it supersedes the earlier `crm-20261023-prepared-queuev7` package. Do not activate the earlier package expecting these timing fixes.

## Audit And Verified Causes

Already correct and retained: `backend/src/services/callTiming.ts:7` anchors the cooldown to the first reliable idle observation, after eight seconds of confirmation. A late confirmation does not add eight seconds to the end-plus-30-second deadline. The existing Bridge samples detection every 500 ms, sends state changes promptly and sends unchanged heartbeats every five seconds; this patch does not change or reinstall it.

Seven new failing tests reproduced these local flaws before runtime edits:

- An idle heartbeat with Nextiva no longer detected entered end-confirmation instead of UNKNOWN.
- Atomic lease acquisition could overwrite a tracked call whose end was still unconfirmed, despite an earlier read guard.
- Readiness advertised READY for an unresolved tracked call when the latest device appeared idle.
- With backend timing off, the new automatic reservation API still accepted a call.
- The frontend ignored its disabled timing flag.
- An active call could be labelled as a cooldown because an old deadline was examined first.
- Consecutive network failures continued at fixed five-second intervals.

Additionally verified by reading: release could overwrite a later existing deadline with the earlier unconfirmed retry time; Settings described every wait as a confirmed end and incorrectly said no NEW leads remained for due callbacks. New regression tests verify the corrected release behavior and labels. These findings are not claims that every production delay had one of these causes.

## Final Behavior

- Confirmed end: `nextCallAllowedAt = first confirmed idle observation + 30000 ms`. Idle confirmation validates the original observation rather than adding another delay. Repeated reads, refreshes, notes, status saves and follow-up scheduling do not write this deadline.
- Unconfirmed dispatch: the server records one retry deadline 30000 ms from dial start. It does not fabricate a connected call or completed-call timestamp. Release uses a monotonic database `$max` and never adds 30 seconds from release time or shortens a later deadline. Cancelling an unused reservation creates no cooldown.
- Fresh idle detection, Nextiva availability, attendance, assignment, calling hours and queue priority remain required. UNKNOWN, disconnected and unresolved tracked calls block retries even after a deadline has elapsed.
- Shared conditional-write predicates enforce cooldown, dial intent and unresolved-call protection inside both lease acquisition and dispatch consumption. Lease acquisition no longer erases observed call-start evidence. Competing tabs still have one winner.
- The coordinator uses the backend deadline and monotonic elapsed time. It prepares queue reads during cooldown, wakes at the deadline, rechecks the authoritative head, and handles busy wakeups without an additional full polling interval. Call-dashboard change events also prompt reconciliation. Active/unknown states take precedence over an old deadline.
- Network/request failures back off at 5, 10, 20 and then at most one retry per 30 seconds. This is separate from normal five-second readiness observation. Lost requests retain the logical attempt. Replayed dispatch never launches TEL twice and waits only until the original server confirmation deadline, not 30 more seconds from the replay.
- Priority is unchanged: eligible due scheduled follow-up, then NEW, then unscheduled follow-up. Pending notes and browsing filters do not select a different head. Temporary saving guards preserve drafts and resume without resetting call timing.

Timing constants remain authoritative in `callTiming.ts`. Legacy unused frontend interval/failure exports are not used as calling deadlines. Manual telephone behavior, attendance calculations, payroll, login design, employee permissions and historical records were not modified.

## Configuration And API

Automatic calling is explicitly supported only with both `CRM_CALL_TIMING_V2=true` and `VITE_CRM_CALL_TIMING_V2=true`. The approved guarded profile already contains this pair and was not altered. Profile validation rejects either-off and both-off combinations. Frontend-off initiates no automatic call; backend-off returns `CALL_TIMING_CONFIGURATION_REQUIRED` before reservation/dispatch. There is no silent legacy automatic-calling fallback or production flag switch.

Status responses add `waitCode` and `postCallWaitMs`. Waiting distinguishes confirmed cooldown, unconfirmed dial/retry, unresolved end, configuration and provider availability. The browser adds a monotonic receipt timestamp locally. Dispatch replay responses consistently include the original deadline and reserved target. Existing identity, business, token and client-version validation remain.

Settings uses captured business/session headers and business-scoped query keys. Its display now distinguishes retry eligibility, uncertain provider state, attendance OFFLINE and a due scheduled callback; countdowns use the received server instant rather than a wrong client wall clock.

No schema migration or data-changing script is needed. The queue protocol version remains `2026-10-23-authoritative-queue-v7`; older production caller contracts are rejected by the existing version guard. The new paired frontend/backend bundle must be adopted together in a confirmed quiet window. Existing unpublished v7 bundles should also be refreshed to receive the new UI/backoff behavior. No new Bridge package/version requirement was introduced.

## Files Changed For This Requirement

- Backend runtime: `backend/src/services/callTiming.ts`, `backend/src/services/callBridgeReservation.ts`, `backend/src/controllers/callBridgeController.ts`.
- Frontend runtime: `src/components/EmployeeAutoCaller.tsx`, `src/api/callBridge.ts`, `src/api/leads.ts`, `src/pages/settings/index.tsx`.
- Tests: `backend/src/services/callBridgeHeartbeat.integration.test.ts`, `backend/src/services/employeeCallingQueue.integration.test.ts`, `scripts/displayed-auto-call-queue.test.mjs`, `scripts/guarded-release-profile.test.mjs`, new `scripts/calling-settings.test.mjs`, and `scripts/calling-queue-browser.mjs`.
- Preparation/report: `scripts/prepare-guarded-release.mjs`, this report and the queue-alignment report. `rolloutFlags.ts`, the guarded profile, Bridge source, attendance/payroll runtime and login source were inspected or regression-tested but not changed for this requirement.

## Measured Timing

These are controlled-clock test measurements, not physical Nextiva timing. All times below are UTC. No real phone was dialed.

| Layer | Confirmed End | Confirmation | Deadline | Reservation Attempt | Dial-Start Attempt | Mock TEL Launch |
| --- | --- | --- | --- | --- | --- | --- |
| HTTP + isolated Mongo, each of six businesses | 17:02:00.000 | 17:02:08.000 | 17:02:30.000 | 17:02:29.999 rejected; 17:02:30.000 one winner | 17:02:30.000 | Blocked |
| Actual coordinator, zero mocked API latency | 17:00:00.000 | Server fixture | 17:00:30.000 | 17:00:30.000 | 17:00:30.000 | 17:00:30.000 |
| Actual coordinator, 40 ms per mocked API step | 17:00:00.000 | Server fixture | 17:00:30.000 | 17:00:30.160 | 17:00:30.200 | 17:00:30.240 |

The coordinator's measured launch scheduling jitter is 0 ms with instantaneous APIs and 240 ms with the specified synthetic latency. A separately delayed readiness request completed 125 ms after the deadline and proceeded at +30.125 seconds, not the next five-second interval. The server-side controlled clock records zero grant-time jitter; this does not imply zero real HTTP latency.

## Requirement Coverage

1. 29,999 ms rejection and 30,000 ms permission: six-business HTTP fixture and existing Mongo lease tests.
2. No extra idle-confirmation delay: raw heartbeat HTTP tests and confirmation-delay unit fixtures.
3. Polls/refresh do not reset: actual coordinator remount/poll test and repeated HTTP status reads.
4. Notes/status/schedule do not reset: successful signed HTTP writes with deadline checks after each operation.
5. Newly due priority: callback due during cooldown becomes the actual reserved/consumed head; coordinator latency fixture verifies the same selection.
6. Long calls: a three-minute active coordinator fixture never reserves early; real HTTP active heartbeats reject another attempt beyond 30 seconds.
7. Two tabs: competing HTTP reservations/dispatches and atomic lease regressions retain one winner.
8. Missing confirmation: original server retry deadline, lost-dispatch replay, and unknown-bridge rejection tests.
9. Disconnection: disappearing process and unknown heartbeat do not create a call end or cooldown.
10. Configuration: both-on is exercised; either-off and both-off are explicitly rejected or disabled.
11. Continuation: approved original retry time permits the next eligible attempt once fresh idle/provider conditions return.
12. No second cooldown: unused reservation cancellation, unconfirmed release at +5 seconds, and preserved later-deadline tests.

Together these cover all 15 requested timing cases; related cases are grouped above.

## Commands And Results

- `node --test --test-reporter=spec scripts/*.test.mjs`: **156 passed, zero failed/skipped**. Includes 18 actual coordinator tests, Settings display/clock/API tests, queue policy and existing regressions.
- From `backend`: `npx tsx --test --test-reporter=spec --test-reporter-destination=../outputs/call-timing-backend-tests.txt "src/**/*.test.ts"`: **568 passed, zero failed, two optional fixed-port tests skipped**, 71.1 seconds. Includes authentication/login, attendance, payroll, dashboards, six-business HTTP queue/timing and isolated Mongo atomic coordination. The related direct heartbeat/queue/timing run also passed; it is a subset, not extra unique tests.
- `npx tsc -b --pretty false`: passed. Backend `npm run typecheck -- --pretty false` and `npm run build:production`: passed, including native ESM import resolution.
- Focused ESLint passed for the changed backend timing/controller/reservation modules and tests, frontend caller/API/Settings modules, coordinator/profile/Settings tests, browser fixture and release exporter. An initial Settings render-purity lint error was corrected by storing the monotonic clock in state; it was not suppressed.
- Full-profile Vite build using `guardedBuildEnvironment` and `envDir:false`: passed. Existing large-chunk advisories remain.
- `git diff --check`: passed, with existing line-ending normalization warnings only.
- `node scripts/calling-queue-browser.mjs`: **10 built-app scenarios passed** in headless Edge at localhost:5173. Leads was checked at 1440x1000 and 390x844 across two fake businesses, including draft failures/success, refresh and next-head behavior. Settings desktop checks verified server cooldown, UNKNOWN confirmation and OFFLINE precedence. No page/console errors except the intentional 503. Every reserve/dispatch/TEL launch was blocked and counted; none occurred. The test closes its own preview. Screenshots were inspected.

No full-project lint, physical Nextiva call, production performance/load test or remote employee-PC timing test is claimed. Existing optional fixed-port tests were not enabled; isolated replica tests cover the relevant new coordination cases.

## Remaining Limits And Activation Hold

Thirty seconds is a server-controlled minimum after the confirmed observed end, not a guarantee of a physical call exactly every 30.000 seconds. Device/audio detection, heartbeat delivery, network latency, browser sleep/TEL permissions and Nextiva readiness can delay the launch. An uncertain or disconnected bridge intentionally waits rather than risking a second call. Real-world jitter and physical launch/answer/hang-up have not been measured here.

The approved retry behavior still has no per-lead attempt cap. No hidden attempt limit was invented. A still-eligible lead can remain the head; browser pending-note storage cannot select it independently.

Prepare only with `node scripts/prepare-guarded-release.mjs crm-20261023-prepared-timing --code-only`. Retain the current authoritative production database and server-only configuration. Do not rerun database copy/restore/adoption helpers. Publish only after explicit deployment approval and a confirmed pause, with paired backend/frontend validation and idle employees refreshing. Recovery must retain current data rather than restore an old database snapshot. No automatic production deployment was performed.
