# Security Phase 0 Audit - 2026-10-21

## Checkpoint And Scope

This is the required read-only audit before security implementation. Application source, security flags, environment files, secrets, original employee/customer databases, uploads, logs, online CRM and GitHub were not changed. The two report documents are the only new tracked-workspace artifacts. Temporary inspection scripts/results stay under ignored `outputs/`.

The requested order is Phase 0, Phase 1, skip Phase 2, then Phases 3, 4 and 5. The instruction to stop and report before the next phase is honored here: Phase 1 is not implemented yet. There are no new `CRM_SECURITY_*` flags, migrations, credential encryption keys or production configuration changes in this phase.

## Important Findings

| Severity | Finding | Verified By Reading |
| --- | --- | --- |
| Critical | Credential list returns the password field; create/update/archive also return credential documents. All four routes lack an independent admin guard. The shared-vault business choice is not caller authorization. | `backend/src/routes/credentialRoutes.ts:6`; `backend/src/controllers/credentialController.ts:39`, `:56`, `:90`, `:122`, `:138` |
| High | `businessAccessMiddleware` calls `next()` when user-type headers are absent. Claimed employee identity and configured-admin identity are client headers, not signed authentication. Tenant selection is not authentication. | `backend/src/middleware/businessAccess.ts:15`, `:24`, `:29`, `:43`; `backend/src/app.ts:191` |
| High | Full employee records are returned by default from employee detail/list and employee-code login, except for the profile image. Requesting a summary is optional, and personal data is not confined to a verified owner/admin in every read path. | `backend/src/controllers/authController.ts:65`, `:80`; `backend/src/controllers/employeeController.ts:321`, `:348`, `:369` |
| High | Tasks populate assigned employees and related leads without field whitelists, providing another route for employee/lead data exposure even if the direct employee response is later minimized. | `backend/src/controllers/taskController.ts:4`, `:22`, `:36`, `:41` |
| High | `/uploads` is publicly served before business/session middleware. File permissions cannot be inferred from the UI that originally uploaded a file. No actual uploaded files were opened. | `backend/src/app.ts:139` |
| High | Most basic configuration/task/team create/update/archive routes have only the permissive business middleware. Hiding employee sidebar tabs is not server authorization. | Route inventory, especially roles/branches/tools/product-categories/features/tasks/teams |
| High | Lead/admin-lead reads and broad modification/deletion paths lack signed caller authorization. Tracker reads/file serving and enabled deletion also lack verified administrator checks. | `backend/src/controllers/leadController.ts:2718`, `:3739`, `:4786`; `backend/src/controllers/browserActivityController.ts:344`, `:388`, `:480` |
| High | Call Bridge pairing can be bootstrapped from an employee ID; device revocation accepts an employee code without signed owner authentication. Downstream device-token protection does not secure the bootstrap/revocation step. | `backend/src/controllers/callBridgeController.ts:268`, `:1353` |
| High | HR applicant data, evaluation notes, notice/leave workflows and employee history have substantial read/write paths with no independent caller authentication. | `backend/src/controllers/hrController.ts:353`, `:415`; `backend/src/controllers/employeeEvaluationController.ts:31`, `:95`; `backend/src/controllers/employeeTransactionController.ts:23`; `backend/src/controllers/noticeController.ts:12`; `backend/src/controllers/leaveRequestController.ts:285` |
| Medium | Global JSON/urlencoded body size defaults to 500 MB. CORS also allows HTTP origins on ports 5173/5174 without restricting them to loopback, and permits Chrome extension origins. CORS does not protect endpoints from non-browser callers. | `backend/src/app.ts:55`, `:74`, `:83`, `:134` |
| Medium | Credential password is an ordinary required string; list serialization explicitly copies it. Current UI show/copy operations use the already-loaded password, not a separately audited reveal. | `backend/src/models/Credential.ts:23`; `backend/src/controllers/credentialController.ts:56`; `src/pages/admin/credentials/index.tsx:71`, `:377`, `:648`, `:662` |
| High | Knowledge-base reads/uploads/moderation have no independent caller authorization. Message membership/ownership checks exist, but are based on impersonable type/code headers rather than signed sessions. Direct-conversation creation has a membership-check gap, and team creation can write before checking membership. | `backend/src/controllers/knowledgeBaseController.ts:49`, `:450`; `backend/src/controllers/messageController.ts:46`, `:164`, `:190` |
| Functional | `/api/attendance-hub/live` first uses a shared guard that rejects employees, then a handler check that rejects non-employees. Neither valid role can succeed. Current Break/Lunch buttons use `/employees/:employeeId/attendance/session`, not this contradictory endpoint; that session path and deductions passed testing. This pre-existing issue is reported, not silently fixed during the no-code-change audit. | `backend/src/controllers/attendanceHubController.ts:96`, `:395` |

These are source-verified findings, not claims that production was probed or that real credentials were accessed. No unauthenticated exploit, destructive request or live credential reveal was performed. Existing passing tests do not establish that these routes are secure.

## Guard Definitions

- `none`: no general interactive guard mounted at that point. An endpoint may still have a controller-specific secret/schema check, listed below.
- `businessAccessMiddleware only`: the global middleware is present, but it allows missing user-type headers through and accepts identity claims in headers. It is not a substitute for a verified session.
- `configuredAdminOnly`: checks claimed user type/code against configured administrators, not the signed admin session (`businessAccess.ts:62`).
- `verifiedAdminOnly`: requires a signed, unexpired full-admin session (`businessAccess.ts:7`, `adminDashboardSession.ts:22`).
- Controller checks must be considered in addition to declaration middleware. Signed employee/owner checks, bridge pairing tokens and integration secrets are different guards and must not be mislabeled as public solely because `verifiedAdminOnly` is absent.

## Complete Route Inventory

[The complete route table](security-phase0-route-inventory.md) lists all **33 mounted routers and 237 declared method/path endpoints**, with explicit guard category, middleware, handler and source line. It was extracted from TypeScript syntax, not guessed from UI navigation. It includes the first public routers before `/api` business middleware and every later router after it.

The appendix's category describes explicit mount/route middleware. Effective controller guards and feature-flag exceptions are documented in the following section. Read both together.

### Standalone And Middleware Mounts

| Entry | Guard | Notes |
| --- | --- | --- |
| `GET /api/health` | none | Health response, `app.ts:142`. |
| `GET /api/businesses` | none | Public business selector metadata, `app.ts:146`. |
| `POST /api/businesses` | configuredAdminOnly | Header-code admin check, `app.ts:150`; not signed-session verification. |
| `PATCH /api/businesses/:businessId` | configuredAdminOnly | Same weakness, `app.ts:168`. |
| `/uploads/*` static middleware (GET/HEAD) | none | One or more upload roots, before tenant/auth middleware, `app.ts:139`. |
| `/api` business-context middleware | none | Selects tenant; does not authenticate, `app.ts:189`. |
| `/api` business-access middleware | businessAccessMiddleware only | Mounted after `/api/auth`, `app.ts:192`. |
| final error handler | none | Error handling, not endpoint authorization, `app.ts:223`. |

### Controller-Level Guard Review

For the basic routers audited directly: all methods in `roleRoutes.ts`, `branchRoutes.ts`, `toolRoutes.ts`, `productCategoryRoutes.ts`, `featureFlagRoutes.ts`, `taskRoutes.ts` and `teamRoutes.ts` lack another actor/session guard. GET settings is also unverified; PUT settings has an inline signed-admin check at `systemSettingsRoutes.ts:8`. Some read endpoints seed/normalize configuration; they were inspected in source, not called as a supposedly non-mutating security probe.

The following table completes the controller review of every mounted router. All route declarations, methods, middleware and handler names are individually listed in the appendix; these exceptions must be applied to that table when assessing effective access.

| Router / Mount | Effective Controller Guard And Exceptions |
| --- | --- |
| `tomTomQuotaRouter` / `/api/tomtom-quota` | Both usage/reserve routes are outside business middleware, but enforce a fail-closed timing-safe shared-secret check. `tomTomQuotaController.ts:21`, `:32`. Not a public endpoint and not an admin-session endpoint. |
| `publicSurveyRouter` / `/api/public/surveys` | Intentionally public POST, input validation/honeypot/duplicate checks; no CRM records returned, although the duplicate response can reveal prior participation. `publicSurveyController.ts:17`. |
| `authRouter` / `/api/auth` | Public code-only login and business lookup. Switch validates employee/business membership but does not require an existing signed session; returns another broad employee object/new token. Logout checks employee ID and does not revoke already-issued stateless tokens. `authController.ts:36`, `:89`, `:107`, `:188`. |
| `employeeRouter` / `/api/employees` | GET list/detail lack independent authentication; summary selection is not access control. POST create, PUT update, PATCH archive and DELETE require an admin-type header plus a signed admin session. Profile/bank PATCH uses a weaker header-only owner helper that accepts callers not claiming employee type. `employeeController.ts:161`, `:170`, `:321`, `:348`, `:470`, `:516`. |
| `roleRouter` / `/api/roles` | All four routes: business middleware only; no controller actor guard. `roleRoutes.ts:6`. |
| `branchRouter` / `/api/branches` | All four routes: business middleware only. `branchRoutes.ts:6`. |
| `toolRouter` / `/api/tools` | All four routes: business middleware only. `toolRoutes.ts:6`. |
| `productCategoryRouter` / `/api/product-categories` | All four routes: business middleware only. `productCategoryRoutes.ts:11`. |
| `mediaRouter` / `/api/media` | GET list/file: business middleware only, no role/owner guard. POST upload and PATCH archive: verifiedAdminOnly at route level. Filename containment is not caller authorization. `mediaRoutes.ts:7`, `:8`, `:9`, `:10`; `mediaController.ts:51`, `:140`. |
| `featureFlagRouter` / `/api/features` | Both routes: business middleware only. Configuration seeding is a write-capable GET side effect, not authentication. `featureFlagController.ts:40`, `:46`. |
| `systemSettingsRouter` / `/api/system-settings` | GET: business middleware only. PUT: inline verified signed-admin check. `systemSettingsRoutes.ts:7`, `:8`. |
| `taskRouter` / `/api/tasks` | All seven routes: business middleware only. Read paths populate employee/lead documents without safe-field projection. `taskController.ts:22`, `:41`. |
| `hrRouter` / `/api/hr` | All 13 routes lack independent caller authentication, including applicant reads and update/permanent-delete paths. `hrController.ts:353`, `:415`. |
| `teamRouter` / `/api/teams` | All four routes: business middleware only. `teamRoutes.ts:6`. |
| `integrationRouter` / `/api/integrations` | Registration verifies its separately configured integration credential and fails closed when missing. This is integration authentication, not configuredAdminOnly. `integrationController.ts:162`. |
| `adminLeadRouter` / `/api/admin-leads` | All three routes lack independent administrator authentication. `leadController.ts:2718`. |
| `myLeadRouter` / `/api/my-leads` | All three use caller-selected employee identifiers/names/role lookup for scope, not a signed principal. `leadController.ts:2558`. |
| `leadRouter` / `/api/leads` | Ordinary CRUD, bulk operations, scoring, dashboard/statistics and deletion: no independent signed actor guard. `/my` uses caller-selected assignment filters. Favorite and normal call writes look up employee headers/body IDs, not signed identity; failed-to-start call branch can skip that check. TomTom usage/search/import rely on declared admin headers or employee-code POC/admin role lookup, not a signed administrator. `leadController.ts:276`, `:2558`, `:3739`, `:4266`, `:4510`, `:4786`. |
| `knowledgeBaseRouter` / `/api/knowledge-base` | All 12 routes: business middleware only; includes reads/file downloads, uploads, create/edit/archive and suggestion approval/rejection. `knowledgeBaseRoutes.ts:20`; `knowledgeBaseController.ts:49`, `:450`. |
| `credentialRouter` / `/api/credentials` | All four: business middleware only, no independent controller auth; raw password data returned, shared vault chosen server-side. `credentialRoutes.ts:6`; `credentialController.ts:39`. |
| `payrollRouter` / `/api/payroll` | All 17 routes: verifiedAdminOnly through router.use. Worked-minutes editing has an extra admin-type check, not its sole protection. No payroll route should be called unguarded based on the broad app middleware issue. `payrollRoutes.ts:24`; `payrollController.ts:1068`. |
| `employeeEvaluationRouter` / `/api/evaluations` | All three lack independent controller authentication; manager notes and modifications exposed. GET can invoke write-capable synchronization. `employeeEvaluationController.ts:31`, `:95`. |
| `reportRouter` / `/api/reports` | Productivity report: business middleware only; report filters are not authorization. `reportController.ts:263`. |
| `messageRouter` / `/api/messages` | All 12 require a header/code-derived actor, not a signed session. Most conversation reads/writes check membership; message PATCH/DELETE check sender ownership, but spoofable identity undermines those checks. Direct/team creation exceptions noted above. `messageController.ts:46`, `:73`, `:79`, `:164`, `:190`, `:377`. |
| `browserActivityRouter` / `/api/browser-activity` | Event/screenshot POST and tracking-status use shared extension credentials with a hardcoded fallback and a caller-selected employee, not an employee-bound signed session. Event/screenshot/file reads and package download have no caller authentication. DELETE checks only the clear-data feature setting. `browserActivityController.ts:43`, `:156`, `:344`, `:388`, `:480`. No actual tracker images/files opened. |
| `callBridgeRouter` / `/api/call-bridge` | Pairing creation, status/package and device revocation lack signed owner authentication. Claim validates and atomically consumes a hashed, unexpired pairing code; heartbeat requires a device bearer token. Activation checks employee headers/sales/business and desktop browser-device credentials; a retained alternate provider branch differs. Latest attempt/reserve use employee-header identity plus business/client/device/lead checks, not signed employee sessions. Dial-start/release validate matching reservations, with weaker retained legacy/tokenless branches. `callBridgeController.ts:268`, `:309`, `:411`, `:622`, `:769`, `:840`, `:895`, `:1092`, `:1254`, `:1353`. |
| `callDashboardRouter` / `/api/call-dashboard` | V2: verified signed-admin session. Legacy flag-off branch: configured admin-type/code headers only. `callDashboardController.ts:15`, `:109`. |
| `dashboardWorkspaceRouter` / `/api/dashboard-workspace` | All six require the feature flag plus verified signed-admin session. Note PATCH/DELETE also enforce authenticated author ownership. `dashboardWorkspaceController.ts:20`, `:129`. |
| `noticeRouter` / `/api` | Bulk `PATCH /employees/:employeeId/notices/read`: verified admin or signed owner attendance session plus membership validation. Other eight notice endpoints lack independent authentication, including individual read/acknowledge/reply/edit/delete. Some reads invoke write-capable synchronization. `noticeController.ts:12`, `:91`, `:180`. |
| `leaveRequestRouter` / `/api` | All eight routes lack independent controller authentication, including approval/rejection with caller-supplied reviewer identity. Some reads synchronize data. `leaveRequestController.ts:119`, `:285`. |
| `attendanceRouter` / `/api` | Signed-session, owner/admin and feature-flag protections vary by route; exact groups are expanded immediately below. These are not generally anonymous just because the appendix shows business middleware at the mount. |
| `employeeTransactionRouter` / `/api` | Both employee history/activity routes lack independent caller authentication. `employeeTransactionController.ts:23`. |
| `callRouter` / `/api/log` | General stats/summary/lead stats: no independent actor guard. Me-stats/call-outcome writes may resolve a caller-selected employee ID from body/query; existence/ID format is not signed identity. `leadCallStatController.ts:39`, `:173`, `:402`, `:425`. |

### Attendance Route Guard Details

| Methods / Paths Or Handler Group | Effective Guard |
| --- | --- |
| `GET /employees/:employeeId/attendance/session` | Active-session flag; signed admin or signed employee; employee ownership and business scope. `attendanceSessionController.ts:33`. |
| `GET /employees/:employeeId/attendance/migration-preview` | Signed scoped administrator; handler does not add a feature gate. `attendanceSessionController.ts:51`. |
| `POST /employees/:employeeId/attendance/commands` | Integrity flag; signed scoped actor; operation whitelist; employee-only actions and administrator-only corrections. `attendanceSessionController.ts:59`. |
| `POST /employees/:employeeId/attendance/preview`; `GET/PUT /attendance-policy` | Integrity flag plus signed administrator; correction preview checks employee scope; policy save uses revision checks. `attendanceSessionController.ts:82`, `:91`, `:107`. |
| `GET /employees/:employeeId/attendance`; `GET /attendance` | Signed scoped actor for employee history; signed administrator for tenant list, including when legacy read implementation is selected. `attendanceSessionController.ts:140`, `:156`. |
| Hub GET summary/days/export/day | Hub flag plus signed administrator. Employee actors rejected by shared guard. `attendanceHubController.ts:96`, `:299`. |
| Hub GET live | Shared guard and handler have contradictory role requirements; both roles rejected. `attendanceHubController.ts:395`. |
| Hub POST day note | Hub flag plus signed administrator. Duration-enabled path requires atomic revisioned note confirmation; legacy note path remains admin-guarded. `attendanceHubController.ts:423`. |
| Eleven legacy write routes (generic create/update/archive/worked-minutes, six clock/rest actions, activity) | `requireCurrentAttendanceClient`: integrity enabled rejects with 426; otherwise signed scoped actor. Generic modifications need admin; employees are limited to permitted own attendance actions/activity. Lock wrapper serializes actions; it is not an authentication guard. `attendanceSessionController.ts:189`; `attendanceRoutes.ts:24`. |

### Sensitive Data Route Flags

- **Employee:** unverified employee list/detail, broad code-login/switch responses, populated task assignees, notices/leave/evaluations/HR/history/report paths. Some have only header-based scope rather than no checks at all; neither qualifies as signed authentication.
- **Credentials:** all credential methods currently expose or mutate the shared vault without a signed admin guard, with password in list/write responses.
- **Payroll:** direct payroll routes are verified-admin guarded; do not conflate salary/bank exposure through employee/task/login responses with an unguarded payroll router.
- **Leads:** admin-lead/list/detail/export/bulk/statistics paths and related task/report data lack independent signed authentication; some employee-specific paths use caller-provided identifiers rather than verified ownership.
- **Files/messages/tracker:** public static uploads and weak file/controller identity checks are additional exposure paths. No real files, records or secrets were opened to demonstrate them.

## Attendance Recheck And Verification

The saved local test employee was inspected only in the explicitly isolated synthetic database on port 27099. Repeated authenticated GETs through `http://localhost:5173/api` checked both Sample Studio and Sample Operations: canonical derived values, business event replicas, admin shift-record responses, payroll DTR and saved payroll matched; no synchronization was pending and the ledger was unchanged by the checks.

- Current shift day: 2026-10-20 (overnight Asia/Manila). Two breaks: 6,469 ms and 5,709 ms; lunch: 8,373 ms. Excess-break/lunch deductions are zero. Separate late minutes are 94, based on the test clock-in after 23:00. Undertime has not finalized before the scheduled shift end.
- UI helper tests verify the employee-facing In-to-start/Out-to-finish labels across both break cycles and lunch, including reloaded event records. Saved event source names and shared deduction math were not renamed.
- The real HTTP/Mongo break-limit suite rechecks two independent 15-minute breaks, a single 60-minute lunch, invalid transition rejection, nearest-minute rounding, and correction-to-admin/payroll parity across three fake businesses. It does not consume the user's local break attempts.
- Existing seeded worker evidence shows an overdue fake session automatically checked out at a stamped 08:05:00 Manila, synchronized to both businesses. No clock was advanced in the user's database.

| Command | Actual Result |
| --- | --- |
| Root: `node --test scripts/attendance-duration-ui.test.mjs` | 14 passed, 0 failed. |
| Backend: `node --import tsx --test --test-reporter=spec src/services/attendanceBreakLimits.integration.test.ts` | 3 passed, 0 failed, no skips. |
| Backend: `npm run typecheck` | Passed. |
| Root: `npx tsc -b` | Passed. |
| Backend: `node --import tsx --test --test-reporter=spec "src/**/*.test.ts"` | 390 tests: 388 passed, 0 failed, 2 skipped. |
| Local synthetic signed-role GET probe of `/attendance-hub/live` | Reproduced the existing bug: signed admin and signed employee each receive 403. This is not a passing functional result; correction is pending the audit checkpoint. |

The skipped existing call-reservation/availability suites require a separate configured test Mongo URI. No new security guards were added, so new allowed/denied/missing-header/wrong-role tests belong to the implementation phases, not this baseline audit. Production authentication behavior, encrypted-vault migration, authenticated uploads, lockout behavior and production compilation/CI changes are not verified or implemented yet.

The role probe used only seeded fake accounts on localhost:5173, never printed session values, and did not change attendance or payroll. It was separate from the source-only route review. No anonymous credential/employee/lead endpoint was used to retrieve real data.

## Next Checkpoint And Rollout Limits

Next is Phase 1: signed-admin-only vault access, authenticated reveal audit and encryption/dry-run handling behind default-off production security flags. Local development/test opt-ins must preserve login and attendance/call/admin sessions. Do not enable a production encryption flag or run a data migration based on this audit alone.

The requested skip of Phase 2 remains respected. The file's later data-minimization, rate-limit, upload and CI phases must not be represented as blanket authorization for every currently exposed lead/HR/task/configuration route; those exposures require an explicit route-authorization decision.

No rollout environment variables were added in Phase 0. Future phase reports must name the exact implemented flags, key format and rollout/rollback order. Do not paste real keys or edit `.env` during the audit. No database migration/dump/restore was required because no stored data was changed.

Reminder: make the GitHub repository private and rotate exposed admin/tracker codes through a coordinated deployment. Neither action was performed here; actual codes and secrets are intentionally omitted.
