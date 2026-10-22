# Live Leads And Selective Attendance Undo

## Scope

The requested fixes cover both admin attendance Undo controls, their refreshed records/deductions/dashboard views, live lead status changes, and removal of WhatsApp from Admin/Employee Leads. A follow-up request explicitly permits undoing an earlier action without first undoing unrelated newer actions.

## Verified Changes

- Earlier manual attendance actions are no longer blocked merely because a newer action exists.
- Reversing an earlier completed break, lunch or standalone off-phone interval explicitly previews both matching events. It submits one existing audited reviewed-correction command. It does not remove unrelated newer events or split an atomic checkout.
- Latest-return Undo can still undo that return alone, reopening its rest interval as before. Imported, system-closed, automatic and administrative events still require reviewed corrections. A historical checkout cannot silently reopen an old session.
- All previews/saves retain backend authorization, revision/fingerprint fencing, timeline validation and original evidence. No attendance or payroll mathematics were copied into the browser.
- Attendance save invalidation now includes admin attendance/dashboard/call-dashboard and employee summaries, alongside payroll and DTR views. Tenant payloads are not copied between businesses.
- Confirmed lead changes update the current business's list/detail caches, remove terminal statuses such as Dead from active queues, cancel older in-flight reads, and refresh server ordering/counts. Stale timestamps/assignment revisions cannot restore newer saved data.
- The admin lead list now subscribes to the existing business socket events. Active screens refresh on reconnect, and non-default lists have a 30-second fallback refresh. The calling queue keeps its existing five-second fallback and server-driven eligibility deadlines.
- Queue changes never choose a replacement caller in the browser. The backend remains authoritative: due scheduled callbacks, eligible NEW, then unscheduled Follow up. Dead records remain in their historical tab, not the active caller.
- Genuine unsaved notes/status/details still pause navigation/calling. Confirmed saves release that guard; failed saves preserve drafts. Business switching clears held details/history instead of showing the previous business's lead. Multi-request detail saves capture their original business/session.
- WhatsApp was removed from both lead screens. Unrelated Team contact tools were not changed.

## Verification

Final focused commands:

```powershell
node --test --test-reporter=spec scripts/attendance-undo-ui.test.mjs scripts/lead-live-workspace.test.mjs scripts/lead-reassignment.test.mjs scripts/attendance-duration-ui.test.mjs scripts/attendance-undertime-status.test.mjs scripts/calling-queue-policy.test.mjs scripts/calling-queue-reproduction.test.mjs scripts/displayed-auto-call-queue.test.mjs scripts/calling-workflow.test.mjs scripts/call-dashboard-freshness.test.mjs
npx tsx --test --test-reporter=spec src/services/attendanceUndo.integration.test.ts
npx tsx --test --test-reporter=spec src/services/employeeCallingQueue.integration.test.ts
npx tsx --test --test-reporter=spec src/services/attendanceIntegrity.integration.test.ts src/services/callDashboardService.test.ts src/services/legacyAuthentication.integration.test.ts
npx tsc --noEmit --pretty false
node scripts/prepare-guarded-release.mjs crm-20261023-prepared-leadundo2 --code-only
node scripts/attendance-undo-browser.mjs outputs/crm-20261023-prepared-leadundo2/dist
node scripts/lead-live-workspace-browser.mjs outputs/crm-20261023-prepared-leadundo2/dist
node scripts/current-call-display-browser.mjs outputs/crm-20261023-prepared-leadundo2/dist
node scripts/calling-queue-browser.mjs outputs/crm-20261023-prepared-leadundo2/dist
```

Backend commands run from `backend/`; other commands run from the repository root. Release preparation runs the frontend typecheck and both frontend/backend builds. Focused ESLint and `git diff --check` are also run.

- 69 focused Node tests passed.
- 2 real MongoDB/API Undo tests passed, covering six business replicas, both controls, paired corrections, idempotence, evidence retention, and fresh hub/dashboard/payroll reads.
- Golden paired-Undo fixture: late 5 minutes, break excess 2, lunch excess 1, early checkout 10. Deductible minutes were 18 before, 16 after reversing the completed break, and 15 after reversing lunch. The original checkout remained unchanged in every business.
- 15 real calling-queue API tests passed, including Dead removal before pagination, blocked stale reservation, due/NEW/follow-up priority, exactly one concurrent reservation, and the 30,000 ms server cooldown in six businesses.
- 74 attendance, authentication and call-dashboard tests passed. The synthetic 200-employee/31-day request measured 1,830 ms during the combined test run; this is not a production latency guarantee.
- The caller fake-clock tests demonstrate the unchanged server deadline, no duplicate launch, and no interruption of an active three-minute call. Network/provider/browser delay can still add time after eligibility; no physical Nextiva test or customer call is claimed.
- Browser tests use fake employees/leads and intercepted APIs on localhost:5173, at 1440x1000 and 390x844. They never mutate production attendance or launch a real telephone handler.
- Both Undo controls and selective paired Undo passed in six businesses. Admin and Employee Leads passed live socket status/save/refresh checks in all six businesses. Current-call details and refresh-without-redial passed in six businesses; saved/failed notes, business switching and Settings readiness passed the two-business queue browser regression. Every final browser run had zero page errors.

The first expanded caller test run found a stale test harness missing router hooks. Those mocks were updated; the actual caller code was unchanged. The first live-socket browser run found its fake handshake did not accept the application's authenticated Socket.IO CONNECT payload; fixing that fixture allowed actual socket-event refresh verification. An initial lint check rejected manual memoization; the final code avoids it. Existing large-bundle build and line-ending warnings are retained.

## Online Release

The prepared code is frontend-only for activation. All compiled backend hashes match `crm-20261023-prepared-workspace3`; Call Bridge source, download and runtime configuration remain unchanged. The publisher verifies an explicit source-change allowlist and every source/build hash, retains older lazy assets, starts a separate loopback frontend, validates Nginx and gracefully changes only the frontend upstream. It does not stop existing processes, force browser refreshes, change API/socket upstreams, or write production records.

The signed-in attendance page may have an open dialog; do not reload it automatically. The administrator should finish/cancel their draft and refresh. Employees should refresh only after their current call finishes.

For rollback, restore the previous frontend upstream from the private activation receipt, validate Nginx and gracefully reload. Keep newer hashed assets for open tabs. No database restore, payroll migration or backend restart is involved.

### Activation Result

- `crm-20261023-prepared-leadundo2` published October 23, 2026 at 05:41:46 Asia/Manila, loopback frontend port 5181.
- 946 source/build hashes verified. All existing process IDs, PIDs, statuses and restart counters were unchanged at the switch. Backend remains `crm-20261023-prepared-workspace3` on process 35 / port 4011.
- Public release metadata matched the prepared release, health returned HTTP 200, and the three published attendance/lead editor module hashes matched the manifest.
- Production database writes: 0. Backend restarts: 0. Forced connection closures: 0. No GitHub push, migration, record cleanup or actual production Undo was performed.
- Existing editor drafts were not discarded. Already-open browsers continue using their loaded version until users refresh at a suitable time.

### Follow-Up Recheck

- On October 23 after activation, the original admin tab still loaded `/assets/index-yFSrrTXQ.js` with an open dialog. It was left untouched to protect pending work. A separate fresh admin Attendance tab loaded `/assets/index-DFjTXcuT.js`; the table loaded without an error alert, remained light, and loaded the same current module/table after another refresh.
- Public release metadata, health HTTP 200 and all three editor-module hashes were reverified. A read-only server check verified all 215 compiled backend code hashes against the tested release, and the backend loopback health endpoint returned 200. No configuration, employee/customer records or logs were read by that check. Its result is stored locally in `outputs/selective-undo-runtime-recheck.json`.
- The 35 focused UI/coordinator/cache tests and 42 real API/dashboard tests were rerun: all 77 passed. These include six-business Undo/deduction/dashboard parity, Dead exclusion before pagination and on stale reservations, 30-second cooldown and duplicate-call protection.
- Both Undo browser controls and earlier paired Undo passed save/refresh checks in all six fake businesses. Live Dead-status changes and save/refresh passed in both admin/employee views in all six fake businesses; zero page errors occurred.
- No real production Undo was submitted, no test number dialed, no data written in production, and no service restarted or deployment repeated. The temporary verification tab was closed; employee tabs and the original open admin editor were not changed.
- This is a verification-only pass. It does not claim a physical Nextiva call measurement or confirm an unidentified employee's individual deduction history. Finish/cancel the original editor and refresh that admin tab to load the current interface.
