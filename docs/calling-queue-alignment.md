# Calling Queue Alignment

## Audit Before Implementation

Checkout: `security-data-check`, based on `ae9bb78` with newer uncommitted fixes preserved. The supplied review baseline is older. The attached request initially limited work to local development. The user subsequently authorized online application after verification, then explicitly chose **keep calls running; prepare only**. Activation is held for a confirmed quiet window; no production service or record was changed in this work.

Verified by reading:

- `src/pages/leads/index.tsx:355`: independent browser rank/"today" sorting. Its My Leads view combines NEW and Follow up; search, category, favorites and infinite paging change the published displayed queue (`:589`, `:725`).
- `src/components/EmployeeAutoCaller.tsx:155`: an effect-local permanent `blockedLeadIds` set; `:244` selects from the displayed filtered page. Pending-comment storage no longer selects the next lead, but a changing marker can still cancel preparation.
- `backend/src/controllers/leadController.ts:2645`: default My Leads orders lightweight candidates before pagination, while search/other views page first. Ten-comment slices can omit relevant eligibility facts.
- `backend/src/controllers/callBridgeController.ts:900`: reserve checks assignment/comment eligibility, bridge and employee cooldown, then atomically acquires the employee lease. It does not establish the authoritative queue head. Dial-start rechecks the target and consumes the lease once.
- `src/lib/employeeAutoCall.ts:119` and `backend/src/services/leadAutoCallEligibility.ts:30`: duplicated rolling 24-hour comment rules; both silently treat a nonempty invalid schedule as absent.
- `src/pages/leads/index.tsx:950`: note mutation clears pending-note state and the draft optimistically before server confirmation. Route selection resets drafts (`:1204`), so automatic navigation can lose unsaved work.
- `src/lib/dateTime.ts:1`: schedule input already uses America/New_York with Intl-based conversion. Call window uses Asia/Manila 23:00-08:00. No fixed-offset date equality is needed for due eligibility.
- API interceptors capture the current business unless the operation supplies an explicit business header. Auth middleware verifies signed identity and overwrites employee filters; automatic queue permissions must remain assignment-scoped even for employees allowed to browse others' leads.

Changed requirement: eligible due scheduled Follow up first (earliest UTC instant), then NEW (createdAt descending, ID ascending), then unscheduled Follow up. This supersedes earlier NEW-before-due instructions. Future/invalid schedules remain visible but cannot dial. Existing leases, retry cooldown and duplicate-phone suppression remain enforced.

Dashboard follow-up: the completed read-only six-business sample observed ONLINE with disconnected bridges. Disconnection alone does not prove an attendance timeout. No production correction or status mutation was performed. This calling repair does not alter attendance or payroll rules.

Implementation and verification results are recorded below after testing.

## Final Design

`shared/leadCallingPolicy.ts` is the single eligibility/ranking policy. `employeeCallingQueue` evaluates assigned candidate summaries and duplicate-phone evidence at one server timestamp, orders every candidate before pagination, and hydrates only the requested page plus its head. It reads complete employee-comment facts through database summaries instead of relying on ten UI comments. Explicit assignee IDs override stale display names. Phone validation uses libphonenumber-js, as manual browser calling already does.

The existing `/api/my-leads` API accepts `callingQueue=true`. Signed employee default My Leads also uses this service. The additive `callingQueue` response contains scope, policy/version hash, server time, per-page decisions/reasons, next lead/normalized phone, next eligibility change, calling-window permission and wait reason. Browsing filters remain independent; the compact next-call indicator remains visible when they hide the head. The browser preserves the server order and no longer publishes a second page-dependent automatic queue. The obsolete displayed-queue selector was removed.

Reservation requires the displayed queue version, head ID and normalized phone. The backend checks signed identity, current assignment, eligibility, window, availability, bridge and cooldown. It returns `CALL_QUEUE_CHANGED` when the submitted snapshot is stale. Dial-start revalidates the current head/target before consuming the existing atomic lease. Replaying a reservation returns its existing token; an ambiguous dispatch retry returns `alreadyStarted` and cannot launch a second telephone link. Browser request scope and session are captured; late operations cannot switch into another business.

There is one coordinator mounted in the existing employee layout. Browser exclusions and pending-note priority overrides were removed. Scope changes cancel old work; an owner token protects the in-flight guard. Activation also pins its request business/session and rejects an obsolete business before writing its browser session. Relative timers use server deadlines and a monotonic client clock. Queue refresh occurs on due deadlines, polling, lead events, focus, visibility changes and reconnect. A new callback never interrupts a call already dialing/active.

Notes stay in the field until server confirmation. Failed saves preserve drafts and show the actual error. In-memory employee/business drafts survive page changes; pending-save promises keep the scope guarded until completion even after editor unmount. Status/schedule changes invalidate the queue and cannot launch a chained action in a newly selected business. A blank or missing mandatory note is never required to continue calling.

Schema additions are optional lease phone and observed attempt/lead correlation fields. No migration, historical rewrite or production data script was run. The backend dependency adds libphonenumber-js. Native backend build rewrites the shared TypeScript import into JavaScript.

## Compatibility and Limits

- New automatic caller version: `2026-10-23-authoritative-queue-v7`. Older automatic callers are rejected with the existing refresh-required response. A future rollout must publish backend/frontend together and have idle employees refresh. Bridge package installation/version requirements were not changed by this repair.
- Manual telephone links, approved statuses, attendance calculations, payroll, login design, provider credentials and production settings are preserved.
- The existing retry policy has no per-lead attempt cap. A lead can remain the head after a call if its status/comment policy still makes it eligible. A pending-note marker cannot select it independently. No hidden attempt limit was added.
- Snapshot changes are expected during concurrent edits; reservation/dial-start reject stale targets and the client refreshes. An ambiguous consumed dispatch deliberately does not relaunch; a browser may miss a launch rather than create a duplicate.
- Confirmation now requires matching server-observed attempt and lead IDs. Nextiva bridge audio is still an observation, not independent Nextiva provider-session telemetry. Physical launch, answering, and exactly 30.000 seconds on an employee PC are not proven by these tests. Network/browser/TEL restrictions can delay a permitted call.
- Database reads use narrow summaries, but large-tenant production load/latency was not measured. No production records or real outbound calls were used for this work.
- Note drafts are retained in browser memory across CRM routes/businesses. The editor warns before a full unload while changes are unsaved; accepting that unload can discard the memory-only draft. Drafts are not written to browser disk storage.

## Files

- Policy/API: `shared/leadCallingPolicy.ts`, `backend/src/services/employeeCallingQueue.ts`, `leadAutoCallEligibility.ts`, `callBridgeReservation.ts`, `backend/src/controllers/leadController.ts`, `callBridgeController.ts`, `backend/src/config/callProvider.ts`, `backend/src/models/CallBridge.ts`.
- Browser: `src/components/EmployeeAutoCaller.tsx`, `src/lib/callingWorkflow.ts`, `useCallingQueue.ts`, `employeeAutoCall.ts`, `dateTime.ts`, `src/api/leads.ts`, `callBridge.ts`, `employees.ts`, `src/pages/leads/index.tsx`. Removed `src/lib/displayedAutoCallQueue.ts`.
- Compatibility/build: backend package/lock and TypeScript build configuration; safe release-export source list. Tests include isolated HTTP/replica fixtures, coordinator tests, pure policy/DST tests, paging/save tests and an actual local browser fixture.

## Earlier Dashboard Display Fix (Local Only)

Two additional regressions were reproduced with failing seeded tests: lingering bridge audio overrode explicit OFFLINE, and a recorded checkout after the shift boundary was hidden by clipped ONLINE accounting. The user confirmed that affected employees had clicked OFFLINE / Time Out, rather than merely disconnected. `callDashboardService` now honors that recorded checkout/current OFFLINE without changing any attendance totals or records. `CallDashboardPanel` labels stale attendance snapshots UNVERIFIED instead of retaining an old ONLINE label indefinitely. Bridge disconnection alone still does not fabricate a checkout. These changes also remain local pending the quiet window.

## Review Steps

1. Start the local app with fake data. In My Leads, seed an eligible due callback, NEW lead, unscheduled follow-up and future schedule. Confirm the first three appear in that order and the future schedule has a waiting reason.
2. Hide the due callback with favorites/search/category browsing. The independent next indicator must keep the callback; the browser must not choose an unrelated search result.
3. Edit a note, save with an induced failure, then retry successfully. The draft must stay until confirmation; another permitted lead should become next after the successful save.
4. Schedule one lead for tomorrow; wait until another callback's exact due instant. Check that the server head/indicator changes, without interrupting a current call.
5. Compete two fake tabs/businesses for a lease and replay lost reserve/dial-start responses. One dispatch may be consumed; repeated dispatch must report already started.
6. Switch business during an in-flight save/reservation, then return and refresh. No operation may dial or save into the new business using the old target. Drafts and pending saves remain scoped.

## Verification Record

All data below is synthetic. No provider dispatch or real telephone call was permitted.

- Root scripts: `node --test --test-reporter=spec scripts/*.test.mjs` - **143 passed, zero failed/skipped**. Includes pure policy/DST, real coordinator execution with fake clocks/lost responses, actual paging callbacks, save guards, dashboard freshness, and activation scope. A first-load null-draft crash was caught in the browser, corrected, and covered by direct execution of the page's draft-restoration block.
- Full backend: from `backend`, `npx tsx --test --test-reporter=spec --test-reporter-destination=../outputs/calling-queue-backend-tests.txt "src/**/*.test.ts"` - **562 passed, zero failed, two skipped**, 88.4 seconds. Covers login/auth, attendance, payroll, dashboards and isolated Mongo/HTTP queue/reservation tests across six fake businesses. The two opt-in fixed-port legacy tests were not enabled in this run; the new isolated replica tests separately exercise competing leases, exact 29,999/30,000 ms boundaries and business isolation.
- The full suite initially rejected the changed dashboard component's old source fingerprint. Only that reviewed component fingerprint was updated; the API/controller/route fingerprints remain unchanged. Behavioral OFFLINE/freshness tests pass. The first run's failure was not ignored or removed.
- Backend typecheck: `npm run typecheck -- --pretty false` - passed. Native backend: `npm run build:production` - passed, including compiled shared import resolution.
- Frontend typecheck: `npx tsc -b --pretty false` - passed. Vite production build with `envDir:false` - passed; existing large-chunk advisories remain.
- Focused ESLint: `npx eslint src/api/callBridge.ts src/components/EmployeeAutoCaller.tsx src/pages/leads/index.tsx scripts/call-bridge-activation.test.mjs scripts/calling-queue-browser.mjs scripts/lead-page-loading.test.mjs scripts/prepare-guarded-release.mjs` - passed. Earlier focused checks also covered the new shared policy/services/hooks/API modules. No claim of a new full-project lint run is made.
- Actual built-app browser fixture: `node scripts/calling-queue-browser.mjs` - passed seven scenarios in headless Edge at localhost:5173, 1440x1000 and 390x844, across two fake businesses. Verified initial render, independent next indicator under favorites, draft retention while saving, 503 failure/retry, queue advance after save, mobile fit, reload and switched-business request scope. The confirmed note does not return as an unsaved draft after reload. No page/console errors other than the intentionally induced 503; no reserve/dial-start request or telephone launch. The test starts/closes its own local preview. Desktop/mobile screenshots were visually inspected.
- `git diff --check` - passed, with existing LF/CRLF normalization warnings only.

The 91-test focused backend call/auth/attendance run is a subset of the full suite, not additional unique tests. No physical Nextiva end-to-dial measurement, production load test, remote employee-PC test or real production note/attendance/payroll mutation was performed. Test success is not a bug-free guarantee.

## Prepared Activation

Code-only artifact command: `node scripts/prepare-guarded-release.mjs crm-20261023-prepared-queuev7 --code-only`. The preparation tool exports only allowlisted source/builds, excludes local private configuration/data, retains the current authoritative production database for a future switch, and never activates a release. Its manifest records the exact source/build hashes and the all-business guarded profile. Do not rerun a database copy, adoption, restore or one-shot migration helper for this code-only change.

Before activation, confirm all calls have finished and CRM writes are paused. Stage a new immutable candidate, retain current server-only signing/vault/database configuration and previous hashed browser assets, verify the new dependency and compiled policy, and switch frontend/backend together. Old automatic callers must refresh because v7 reservation/dial-start contracts are enforced. Verify public health, login, read-only business scopes, attendance/payroll/dashboard reads and package access without using real leads as test calls. If rollback is needed, roll back the paired application code without restoring an older database snapshot. Physical Nextiva timing still requires a consenting controlled test.

**Current state: prepared locally; not activated online, not committed or pushed. Active employees have not been refreshed or interrupted.**

## Additional Timing Requirement

The later timing request is implemented and verified in [Post-Call Timing Verification](call-timing-verification.md). Its replacement code-only package is `crm-20261023-prepared-timing`; the earlier `crm-20261023-prepared-queuev7` snapshot does not contain those additional fixes. The newer request explicitly prohibits automatic production deployment. The timing report supersedes the earlier verification counts and documents measured controlled-clock jitter, supported flag configuration and the remaining physical-provider limits.
