# Missing Time Out and runtime cleanup verification

Date: 2026-10-23, Asia/Manila.

## Feature

Administrators can open Attendance, select a shift, open Edit attendance, and use
Add Time Out. The action is disabled when the selected shift has no session with
a missing checkout. Multiple eligible sessions require an explicit selection.

The PH date/time is editable, without milliseconds. A completed shift defaults to
its configured end time, not a hard-coded 8:00 AM. An unfinished shift defaults
no later than the authoritative server time. The proposed checkout cannot precede
the last event, be in the future, or overlap the next session. Conflicting late
activity requires choosing a valid checkout rather than silently changing events.

A reason and Review change -> Confirm change are required. An open break, lunch,
or off-phone interval requires explicit approval to add its matching return at the
same timestamp. Original evidence remains intact. Existing revisions, duplicate
protection, audit, authorization, business synchronization and payroll rules apply.
Finalized payroll is not reopened automatically.

No backend product endpoint, attendance calculation, allowance, feature default,
schema, migration or database record was changed for this release. The action uses
the existing guarded administrator correction API. Failed business synchronization
is reported as pending and retried by the existing outbox.

## Source changes

- src/components/AttendanceCorrections.tsx: missing checkout form, frozen preview
  scope, authoritative returned snapshot and existing workspace invalidation.
- src/components/AttendanceHub.css: wrapping correction action layout.
- src/lib/attendanceMissingTimeOut.ts: session selection and additive change plan.
- scripts/attendance-missing-time-out.test.mjs: focused plan tests.
- scripts/attendance-missing-time-out-browser.mjs: six isolated browser cases.
- backend/src/services/attendanceMissingTimeOut.integration.test.ts: real HTTP API
  and replica-set integration tests using synthetic records only.
- scripts/prepare-guarded-release.mjs: source export allowlist entries.

## Verification

- 188 root script tests passed, with no failures or skips.
- 78 focused backend tests passed on re-verification, including missing checkout,
  earlier undo, attendance accuracy, call-dashboard and payroll integration suites.
- Six desktop/mobile browser cases passed across six synthetic businesses.
  Each saved once, retained its record after refresh and prevented a second checkout.
  A stale preview retained the reason and required a fresh review.
- Real isolated HTTP API tests verified shared employee synchronization across six
  businesses, read-only preview, administrator-only access, idempotency, stale
  revision rejection and fresh duplicate rejection.
- One test verified late 5 + excess break 2 + excess lunch 1 + undertime 10 = 18
  deductible minutes in the attendance hub and payroll DTR. Repairing a historical
  shift preserved the employee's newer open session and current break timer.
- Explicit open break, lunch and off-phone returns plus checkout were verified.
- A current-shift checkout changed the actual call-dashboard HTTP response from
  BREAK to OFFLINE in all six synthetic businesses. Repeated fresh dashboard and
  employee-quick-view requests retained the checkout, 20-minute break, 370-minute
  undertime and 5-minute excess break. Payroll correctly remained Needs Review
  before the scheduled shift end, then calculated 375 deductible minutes after
  that boundary without another attendance write. A displayed early checkout
  does not bypass the existing provisional-payroll safeguard.
- Frontend and backend typechecks, focused lint, backend compile and diff whitespace
  checks passed. All compiled backend hashes matched the existing live backend.
- Synthetic desktop/mobile screenshots were inspected for fit and readability.

These are bounded test results, not a guarantee that every browser, employee PC,
external telephony integration or historical record is error-free. Physical Nextiva
calls were not initiated. No real attendance corrections or payroll approvals were
submitted as part of verification.

## Online release

- Frontend: crm-20261023-prepared-checkoutbutton2.
- Backend retained: crm-20261023-prepared-workspace3.
- Activation: 2026-10-23 07:27:36 PH.
- 959 source/build hashes verified before activation. All 92 browser assets matched
  the build used by the isolated browser tests.
- Public release identity, health HTTP 200 and four required public module hashes
  passed verification again after PM2 cleanup.
- The live administrator editor showed Add Time Out, PH Time Out, Reason and Review
  change after refresh. The editor and drawer were closed without preview or save.
- No backend restart, forced connection closure or production data write.

The initial package was held by the source-freeze check after a test-only type fix.
Only the final fully verified package above was activated.

## PM2 cleanup

Removed 11 retired, unused CRM process entries: 20, 22, 24, 26, 28, 32, 33, 36,
37, 38 and 39. PM2 state was saved. No application directories, uploaded files,
private configuration, database files or retained rollback releases were removed.
All 368 retained older frontend assets were present after cleanup.

The current CRM ingress uses exactly one frontend and one backend:

| Role | PM2 ID | Process | Port |
| --- | --- | --- | --- |
| Frontend | 40 | crm-frontend-checkoutbutton2-20261023 | 5183 |
| Backend | 35 | crm-backend-workspace3-20261023 | 4011 |

Two older CRM-named services were deliberately preserved because other active
website configurations still reference them:

| PM2 ID | Service dependency | Port |
| --- | --- | --- |
| 31 | assistly123.com / www.assistly123.com backend | 4000 |
| 34 | technolaw.ph / www.technolaw.ph / kato.technolaw.ph frontend | 5175 |

The user explicitly chose to preserve those website services. A call pause does
not remove their routing dependencies. They are not extra processes for the
current crm.assistly123.com ingress. Five unrelated application services were
also preserved. Nine PM2 entries therefore remain in total, not two for the whole
server. All retained PIDs and restart counters were unchanged by cleanup.

An access-restricted server-only PM2 snapshot and cleanup receipt were retained.
Do not publish the PM2 snapshot or private deployment configuration. Rollback files
and uploads remain on the server. A frontend rollback must start the retained prior
frontend before restoring its upstream; it does not require a database restore or
an active backend restart. Do not restore every old worker while employees are active.

## Manual check

1. On an authorized disposable local test employee, choose a completed shift with
   a Time In and no Time Out. Do not alter a valid production record just to test.
2. Open Edit attendance -> Add Time Out. Check the PH date and configured shift end.
3. Enter the intended checkout and an audit reason. For an open rest interval,
   approve the matching return only when that is the intended correction.
4. Review the selected session, affected businesses and payroll impact, then confirm.
5. Verify the Time Out, worked time, undertime and deductions; refresh and verify again.
6. Switch to each assigned business and check the same employee/shift. Confirm that
   any newer active shift still has its original attendance state and timer.
7. Check pending payroll DTR and the call dashboard. Existing finalized payroll must
   remain finalized. The Add Time Out button should no longer allow the closed session.
8. Try a stale second editor or an already closed shift; a duplicate must be rejected
   without changing evidence. Perform these negative tests on local synthetic data.

Publication target: ka0rim1yaz0no/CRM, branch security-data-check. The Git credential
was checked against GitHub's authenticated-user endpoint and confirmed to belong
to ka0rim1yaz0no with repository push permission. The repository CI workflow has no
deployment step. Private runtime configuration, database files, deployment helpers,
employee-specific operational notes and unrelated local images are excluded.

## Online re-verification

Read-only UI checks covered Next Gen Vending, Order THCA, Exclusive Hemp Farms,
HILT, HILT Survey and Assistly. The missing-checkout action, PH time field, reason
and review step were present in each business. Attendance pages loaded again after
refresh; no preview or confirmation was submitted for production employees.
Delivery-health indicators showed zero pending jobs when checked in each scope.

The tested frontend is still crm-20261023-prepared-checkoutbutton2. Public health
returned HTTP 200, its release identity matched, and four required public module
hashes were rechecked. CRM backend PID 407124 and frontend PID 465145 retained
their zero restart counters. This request required no online code switch; only
regression tests and this report were expanded beyond the already active feature.

Save/refresh and monetary-component checks used isolated synthetic data, not
invented corrections to valid production records. The online checks prove read
availability and deployed code identity, not a production write for every employee
or a physical telephony test. An individual attendance repair still requires an
administrator to choose the correct PH timestamp and review its impact.

## Website process names follow-up

At 2026-10-23 07:46:37 PH, the two preserved website services were renamed:

| PM2 ID | Saved name | Port |
| --- | --- | --- |
| 31 | assistly123.com-backend | 4000 |
| 34 | technolaw.ph-frontend | 5175 |

Only IDs 35 and 40 now have the crm- prefix. Their PIDs remain 407124 and 465145,
with restart counters still zero. The five unrelated services also retained their
PIDs and restart counters. Nine PM2 entries remain; no service was deleted.

The installed PM2 version requires restarting an entry to change its name. Only
IDs 31 and 34 were restarted, one at a time. An initial persistence guard wrongly
expected runtime IDs in dump.pm2 and restored the original names. Inspection of
the installed PM2 save implementation confirmed it intentionally removes those
IDs. After correcting the guard to match script and working-directory identity,
the names were applied and persistence verified. Each renamed entry has a restart
counter of three, including the initial attempt, rollback and final rename.

Private environment and launch-configuration fingerprints remained unchanged
apart from names. Nginx configuration and current CRM release metadata were not
modified. Backups of the prior PM2 metadata remain access-restricted on the server.
No application files, uploads, database commands or CRM restarts were involved.

Both website roots, www variants and kato.technolaw.ph returned HTTP 200 before
and after the completed rename. Both renamed services passed their loopback
health checks. The current CRM passed loopback health, and its public health,
release identity and four module hashes passed again from the office computer.
The VPS itself receives an existing public-CRM 403, so its CRM health check used
the loopback backend instead; access restrictions were not altered.

Website services briefly restarted during the naming operation. These checks
establish final health and an untouched live CRM process pair; they do not prove
zero transient downtime for the restarted website services or measure individual
employee telephony sessions.
