# Call, attendance, and dashboard rollout

## Scope and switches

The code was deployed to the production CRM on October 16, 2026. The backend
and browser V2 flags were enabled during the approved maintenance window. No
production data migration or repair script was run. A Hostinger VPS snapshot
was taken before deployment, but it expires on October 17, 2026; no verified
MongoDB dump is available. Employee tabs must refresh once to load the new
client, and admins must sign in again after the session-secret rotation.

The backend flags
`CRM_CALL_TIMING_V2`, `CRM_ATTENDANCE_V2`, `CRM_TIME_ACCOUNTING_V2`, and
`CRM_CALL_DASHBOARD_V2` default on only when `NODE_ENV` is `development` or `test`.
In production they default off. The corresponding browser build flags are
`VITE_CRM_CALL_TIMING_V2`, `VITE_CRM_ATTENDANCE_V2`, and
`VITE_CRM_CALL_DASHBOARD_V2`; they default on for Vite development and off for
production builds. Set each to `false` to roll back locally or `true` to opt in
on a production build. Backend and browser timing/attendance flags must match.
`VITE_CRM_UPDATE_PROMPT` also defaults off in production. When built with it
enabled, an open tab checks the published app bundle every two minutes or when
the tab becomes visible and offers a manual refresh. Tabs loaded before the
first deployment of this listener cannot be prompted and need one manual
refresh. The prompt never forces a reload during an active call.

The dashboard V2 endpoint and attendance V2 admin edits additionally need
`CRM_ADMIN_SESSION_SECRET` of at least 32 characters in production. A
full-access admin must sign in again to receive a 12-hour signed token.
Tracker-only admin access is rejected.

The timing V2 server accepts client version `2026-10-15-call-timing-v6` only;
the previous path accepts `2026-10-14-comment-lock-v5`. Upgrade the browser
and Call Bridge (0.4.1 or later) together before enabling timing V2. No
RingCentral monitor starts. Existing RingCentral attempt records remain stored.

Availability V2 writes a revisioned control-database outbox before fanout.
Failed business writes remain pending for the reconciliation worker, and an
older retry cannot overwrite a newer status. The control database must be
available for the initial write; an outage there can still fail an attendance
action after its primary event was recorded. Do not enable this without a
tested recovery procedure for that case.

## Timing contract

The first server-observed idle heartbeat anchors the 30-second deadline. A
subsequent idle heartbeat must confirm it for at least 8 seconds; this does not
add another delay. Reservation is atomic per employee and a dial attempt has a
UUID. Unknown, stale, conflicting, or unpaired bridge states cannot dial.
An unconfirmed dial may retry at dial-start plus 30 seconds, with no extra
post-lease delay. A sleeping browser only wakes and re-checks the server; its
timer is not authorization to dial.

The bridge samples state every 2 seconds and sends immediately when that state
changes; otherwise it heartbeats every 5 seconds. Therefore the physical
hang-up to first observed idle can lag by up to about 2 seconds plus network
latency. Idle confirmation typically arrives on the next two 5-second
heartbeats. The browser can dial later than the deadline because of API,
lead-loading, background-tab throttling, or a closed bridge. It must not dial
earlier. An exact physical 30.000-second gap cannot be guaranteed by a browser
and sampled desktop bridge; measure this with the real softphone before rollout.

## Data safety

Do not enable attendance V2 against a production database from a local dev
process. The new event-ID index, outbox, and action lock need an isolated test
database first. The CLI `npm run reconcile:attendance --prefix backend` is
report-only and does not modify history. The V2 worker retries pending event
copies only; it does not run the legacy history-merging routine. It never
creates a Time Out. Manual Time Out and admin edits remain the only close paths.

Before any future migration or production data-changing script, take a Mongo
dump and record its archive path. PowerShell examples (never paste the URI in
the command):

```powershell
mongodump --uri="$env:MONGODB_URI" --gzip --archive="C:\backups\crm-before-rollout.archive"
# Restore only during an approved outage. --drop replaces current collections.
mongorestore --uri="$env:MONGODB_URI" --gzip --archive="C:\backups\crm-before-rollout.archive" --drop
```

Test a restore into an isolated database before rollout. Do not run the
`mongorestore --drop` line during normal deployment.

## Manual Nextiva check

1. On an isolated test environment, pair Bridge 0.4.1+, sign in as one sales
   employee, time in, and verify Nextiva is open. Use a stopwatch and server
   timestamps. End a real call and compare the first idle heartbeat, confirmed
   call end, `nextCallAllowedAt`, and the next dial. Deadline must be exactly
   30 seconds after first server-observed idle; physical hang-up may precede it.
2. Open two tabs for the same employee. At one eligible slot, exactly one tab
   should acquire the reservation and open a dial.
3. Sleep the laptop during a cooldown. On wake, there must be no early dial;
   the browser should re-check and proceed only if Bridge is fresh and idle.
4. Close Bridge during a call and reopen it. Dashboard should show unavailable
   while stale and should not invent a call end or start a dial.
5. Time in, break out/in, lunch out/in, off-phone out/in, and manually time out
   in one business. Switch to another business where the employee is a member;
   each event ID and availability should match. Simulate one secondary database
   failure and confirm `syncPending` then outbox recovery.
6. Switch businesses in the admin layout and confirm the call dashboard shows
   only sales employees belonging to the selected business. There are no
   dashboard-local business or state filters. Confirm the eight visible states
   are ON CALL, ONLINE, CALL WAITING, OFFLINE, OFF THE PHONE, READY, BREAK,
   and LUNCH. A timed-in employee with a stale or disconnected bridge remains
   ONLINE, not READY. Compare a manual Nextiva call timer with the
   bridge-observed start and end.

## Staged rollout and remaining risk

Use an isolated test database and one test employee first, then a test team.
The current production flags are global, not per-employee: a production canary
requires a separately routed instance and database plan. Do not turn on a
global production flag while expecting it to affect only one employee.
After backup, index verification, and monitoring are ready, enable the flags
for all employees in a planned maintenance window.
Watch duplicate reservation conflicts, observed hang-up latency, missing
heartbeats, pending attendance sync, dashboard snapshot age, and call durations.
Roll back by disabling the matching flags and rebuilding the browser; preserve
the new event and observation collections for investigation. Do not delete
historical attendance or RingCentral attempts.

One controlled Nextiva test with employee 26001004 was reported by the user as
about 30 seconds from hang-up to the next dial, with no duplicate dial. This
is a useful first live observation, not a server-timestamp measurement or a
general guarantee. Admin dashboard timing, two-tab behavior in production,
and a real multi-business failure/recovery test remain unverified.

The isolated Mongo tests now cover simultaneous first-use lease acquisition,
the lease cooldown boundary, availability fanout, pending availability replay,
and concurrent status revisions. Still unverified beyond the single user-reported
Nextiva run and without failure-injection tests: precise physical hang-up-to-dial
timing, process failure during
attendance outbox delivery, Mongo index creation on historical collections,
control-database outage after a primary attendance write, and administrative
edits racing a pending outbox item. A secondary business can temporarily show
an old status until its pending write succeeds. The browser still derives some attendance display state locally, and
historical RingCentral code remains in the repository but is not started by
the live provider selector. Payroll still has its own payable-hour
rules (including paid breaks) and is not replaced by the display accounting
buckets; changing pay calculation requires separate fixture-based validation.
