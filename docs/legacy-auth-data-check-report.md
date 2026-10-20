# Local Authentication And Data Check

2026-10-21. This report supersedes the remaining legacy-auth/live-hub limitations in `security-recheck-report.md`. The earlier reports remain historical phase records. Source is for localhost:5173 and an explicitly authorized GitHub source upload, not a production deployment. No online server, real Mongo database, real uploads, environment files or production keys were inspected or changed.

## Changes

- `backend/src/middleware/legacyAuthentication.ts`: private legacy API families require a signed session; verified server identity replaces client claims. Employee membership and record ownership are enforced before reads/writes. Task/lead identity filters cannot be changed to another employee. Tracker-only sessions cannot use full-admin APIs. Explicit integration/bridge/extension transports retain their own credential checks.
- `backend/src/socket.ts` and `src/lib/socket.ts`: signed handshake, business membership, per-packet verification, expiry disconnection even for idle sockets, 30-second membership rechecks for idle employees, tracker restrictions, timer cleanup and reconnect with current tokens. A membership read timeout fails closed for the socket; it does not create an attendance event.
- Auth routes, login token metadata, central API headers, file sessions and task population were updated for those contracts. Package downloads accept verified file GET cookies; cookies never authorize attendance/profile writes. The known development extension fallback key is rejected under the new guard; existing agents need a properly configured extension key or an employee-signed session.
- Browser regression caught the employee dashboard's reuse of `/leads/agent-dashboard` and `/leads/employee-logs`. Signed employees retain access, with server-enforced own-employee detail rows and exact own-name log scope. Existing dashboard arithmetic and full-admin output are unchanged. Tests compare each employee's resulting row with its unchanged admin-calculated counterpart in both businesses.
- The employee-only `/attendance-hub/live` guard now permits signed employees while the list, summary, detail, note and policy administration remain admin-only. No attendance arithmetic, manual command, automatic cutoff worker or call-dashboard calculation was changed.
- New read-only Data Check API/controller/service/math, shared report/export types and admin page. Date/business URL filters, explicit Run, per-section loading, match/mismatch/cannot-verify rows, expandable proof/samples, problems filter, plain-text copy and formula-neutralized mismatch CSV. All-business rows identify their business explicitly.

Core new files: `backend/src/controllers/dataCheckController.ts`, `backend/src/routes/dataCheckRoutes.ts`, `backend/src/services/dataCheckService.ts`, `backend/src/services/dataCheckMath.ts`, `shared/dataCheck.ts`, `src/api/dataCheck.ts`, `src/pages/admin/data-check/index.tsx`, `src/pages/admin/data-check/dataCheck.css`. Regression files: `dataCheck.integration.test.ts`, `dataCheckMath.test.ts`, `legacyAuthentication.integration.test.ts`, `scripts/data-check-ui.test.mjs`; existing attendance/security/navigation expectations were updated for intentional 401/403 contracts. The phase-0 calculation audit is `docs/data-check-audit.md`.

The accumulated earlier security phases are included in the source upload: credential encryption and explicit reveal, private employee responses, upload ownership and authorization, safe document downloads, headers/body/rate limits, environment-configured administrator codes, compiled backend tooling and CI tests. Their detailed file inventories and rollback requirements are in the earlier security reports.

## Flags And API

`CRM_SECURITY_LEGACY_AUTH` and `CRM_DATA_CHECK` default ON in development/test, OFF in production, with explicit true/false overrides. No production flag was enabled. Set `CRM_DATA_CHECK=false` and restart locally to hide the new navigation/page API. Disabling the legacy auth flag restores weaker old behavior and is not a security remedy. Existing vault/upload/privacy/hardening flags are unchanged; do not discard a vault encryption key during rollback.

- `GET /api/admin/data-check/config`: signed full admin; enabled/default completed Manila shift/business metadata.
- `GET /api/admin/data-check?date=YYYY-MM-DD&business=<configured-id|all>`: signed full admin; strict scalar date/business validation, no future date, 60-second in-process cache per selection, concurrent cache coalescing, 10 requests/minute per configured admin slot. Failed reads are cannot-verify, not zeros or repairs. Audit output contains only configured admin slot name and requested date/business/cache status.
- Query budgets: 3 seconds for projected raw reads, 6 seconds for existing screen adapters, approximately 22 seconds overall section budget, 1,000 employees and 25,000 events/calls per business. Larger/unavailable selections report unverified sections. Timed-out existing read adapters may finish in the background; they remain read-only. This is not a measured throughput claim for thousands of employees.

Independent checks cover present/late totals, each break and lunch duration, attempt limits, deductible minutes, open/corrupt events, saved derivatives, cross-business signatures, logged and observed call populations, malformed calls, current bridge freshness/version, call/attendance gaps, status cards, overdue SLA, malformed leads and rounded percent changes. No bank, customer contact, credential or password fields are returned. Samples are capped at ten IDs/codes/timestamps per mismatching row.

## Proof Limits

Explicit **same-code, weaker proof**: shift day/boundaries use attendanceSlotKey/hubShiftBounds; dashboard-to-hub parity reuses the hub; the employee-insights comparison invokes its shared calculation rather than capturing an employee screen; DTR-to-hub parity invokes the existing read-only DTR path. Independent interval pairing and raw validation are audit-only, never used to save payroll/attendance.

Historical heartbeat health, installed historical bridge versions, disconnect-gap counts and historical live-panel snapshots cannot be reconstructed from latest-state device rows. They are cannot-verify, not invented measurements. Raw lead statuses/SLA are current snapshots; six statuses have no exact dashboard card and are explicitly unverified comparisons. Zero previous activity makes percent change undefined. Exact running milliseconds from separate live reads cannot prove equality and are unverified while sessions remain open. Concurrent writes/policy changes during a run can require a rerun after cache expiry; this is not a transactional snapshot of all screens.

Missing assigned agents and present sales staff without call logs are review signals, not proof of misconduct or arithmetic bugs. They still produce FAIL under the requested verdict rule. Nothing is automatically assigned, closed, repaired or deleted.

Code-only login remains unchanged; passwords/MFA were not introduced because phase 2 of the supplied security instructions was explicitly skipped. Stateless tokens are not centrally revoked by logout; file cookies/local auth are cleared, sockets expire, and membership is rechecked. Rate limits and report cache are process-local, not a distributed multi-worker store. This is not a complete penetration test or a claim of zero remaining bugs.

## Storage And Local Preservation

Only additive, idempotent model indexes were declared: Lead.createdAt; CallBridgeAttempt.(businessId,reservedAt); CallBridgeObservation.(businessIds,startedAt) and (businessIds,endedAt). There is no data-changing migration/backfill. Model startup can create indexes. The Data Check endpoint never writes a collection; integration tests compare document hashes across all synthetic collections before and after a run.

The disposable local four-database environment was dumped before restart. Restoration validates all collection counts and the attendance fingerprint; the known dummy credential is resealed with the replacement ephemeral local key. Original local Mongo on 27017 is not used. Do not restore these fabricated databases over a real CRM. For a future separately approved index rollout, dump each tenant/control/canonical database first using `mongodump --uri <approved-uri> --db <name> --out <backup-directory>` with credentials supplied privately, not in a report. Restore to an isolated database first using `mongorestore --uri <isolated-uri> --dir <backup-directory>` and compare counts. No such real-data operation was run here.

## Verification

Commands actually run from the repository root unless noted:

| Command | Result |
| --- | --- |
| `npm run typecheck` (backend) | Passed |
| `npm run build` | Passed, including frontend typecheck; pre-existing large editor bundle warning remains |
| `npm run lint` | Passed |
| `node --import tsx --test --test-reporter=spec "src/**/*.test.ts"` (backend) | 456 tests: 454 passed, 2 optional external-Mongo cases skipped, 0 failed; 82.85 seconds |
| `node --test --test-reporter=spec scripts/*.test.mjs` | 48 passed, 0 failed |
| `npm run build:production` (backend) | Passed, native Node imports resolved |
| `npm run test:production` (backend) | Passed: compiled production entry, signed guard ON explicitly, login/profile/attendance/dashboard/Data Check config in two fake businesses |
| `node --import ./backend/node_modules/tsx/dist/loader.mjs outputs/verify-local-security-recheck.mts` | Passed against localhost:5173; signed login, dashboards, business switch, protected synthetic assets and cross-business denial |
| `node --import ./backend/node_modules/tsx/dist/loader.mjs outputs/verify-local-attendance.mts` | Passed; preserved two breaks/lunch, session/hub/DTR/saved payroll match in both businesses; ledger unchanged |
| `node --import ./backend/node_modules/tsx/dist/loader.mjs outputs/verify-local-data-check.mts` | Passed; real local HTTP reports for each synthetic business and All, capped/redacted output, unchanged attendance fingerprint |
| `git diff --check` | Passed, existing LF/CRLF notice only |

Automated fixtures include normal two-break/one-lunch days, overages, third break, open session, wrong ordering/slots, stale derivatives, cross-business differences, negative/reversed/overlong calls, Manila boundaries, role spoofing, sockets expiring while idle, revoked membership, private-field exclusion, export formula safety, read-only hashes and caching/rate limits. Index query plans confirmed the additive indexes are selectable on seeded Mongo. Existing 200-employee/31-day hub regression also runs; Data Check itself is bounded and may report partial evidence at its limit. The two skipped tests require a separately supplied integration Mongo URI; no external URI was supplied.

The preserved localhost sample run for shift 2026-10-20 returned **116 match, 4 mismatch, 18 cannot-verify, overall FAIL** across both businesses. Each business had one present sales employee with no logged calls and one unassigned sample lead. All preserved break/lunch/deduction values matched; no attendance evidence changed. Ignored sample JSON reports are in `outputs/data-check-*.json`, not the GitHub upload.

Manual test: sign in with the synthetic local admin, open `/admin/data-check`, choose 2026-10-20 and All businesses, Run, expand a result, toggle problems, copy/export, then switch businesses and rerun. A full reload retains the selected URL filters but requires Run again. For employee regression use the existing synthetic employee, verify its saved two breaks and lunch after a business switch and refresh; do not reset that preserved shift just to repeat an automated test.

No real Nextiva call, production failure recovery, remote CI result, complete browser/device matrix or production rollout was verified. Desktop browser review is distinct from responsive CSS/static-render tests; no measured mobile viewport screenshot is claimed.
