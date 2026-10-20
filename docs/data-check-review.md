# Data Check Review And Hidden Navigation

2026-10-21. Localhost:5173 only; no online CRM, production environment or real database was accessed. This report supersedes the 18-unverifiable sample result in `legacy-auth-data-check-report.md`.

## Investigation

The four flags on the preserved synthetic shift 2026-10-20 were independently checked using projected read-only queries on the isolated Mongo at 27099, after verifying the fake database/employee identity:

| Business | Flag | Evidence | Action |
| --- | --- | --- | --- |
| Sample Studio | Unassigned lead | One NEW sample lead has neither an assigned ID nor a name-only assignment | Retained; no basis to select an employee automatically |
| Sample Operations | Unassigned lead | Same condition in that business's sample lead queue | Retained; no invented assignment |
| Sample Studio | Present sales employee without logged calls | Two historical call logs, zero in the selected shift, zero bridge observations in that shift | Retained; this was a manual attendance test, not proof of a calling-system failure |
| Sample Operations | Present sales employee without logged calls | Same selected-shift absence of call evidence | Retained; no fabricated call records or changed timestamps |

These are operational review signals, not confirmed arithmetic/authentication defects. They still produce FAIL under the original rule that any non-stale mismatch fails. Nothing was assigned, deleted, excused, marked as called, or reset merely to make a report green.

The 18 unverifiable checks consisted of 12 missing dashboard status-card counterparts, two live-millisecond comparisons, two undefined percent comparisons and two historical disconnect-gap counts. Actual verification defects were corrected:

- All eight status counts now compare with the existing admin Leads status-tab handler (`countAdminLeads`) instead of searching for nonexistent dashboard cards. The other dashboard card checks remain separate. Raw aggregation stays independent; UI deduplication differences still fail and are not hidden. No existing lead/dashboard calculation was changed.
- Percent checks distinguish an explicitly returned null (undefined percentage because the previous total is zero) from unavailable evidence. Explicit null agrees with independently computed undefined; a fabricated zero or wrong percentage fails. Missing evidence remains cannot-verify.
- Dashboard and hub reads inside a Data Check share one trusted server-time snapshot through AsyncLocalStorage. Normal requests still use current server time. A client cannot set the snapshot through query/header input. The running-hour test proves exact 3,600,000 ms parity across both businesses and unchanged stored documents. No tolerance, rounding workaround or attendance mutation was added.
- Historical disconnect gaps remain cannot-verify: the database retains latest heartbeat state, not an immutable disconnect history. No past history was reconstructed from guesses.

The same localhost sample now returns **132 match, 4 mismatch, 2 cannot-verify**, versus 116/4/18 before. Each single-business report returns 67/2/1. Attendance, two independent breaks, lunch, DTR and saved payroll deductions remained equal across the two businesses, with the original 22 effective attendance events preserved. Reports and the investigation script are ignored local outputs, not uploaded employee/customer data.

## Hide And Restore

The admin sidebar hides Data Check by default in development, test and production, across all businesses. New `CRM_DATA_CHECK_NAV` defaults false; it only controls navigation. It does not weaken admin authentication or remove the diagnostic source.

To restore the sidebar for a future local investigation: start the backend with `CRM_DATA_CHECK_NAV=true`, retaining `CRM_DATA_CHECK=true`, then refresh the browser (or wait for the 60-second config cache). Restart the backend without the NAV override to hide it again. The signed-admin page `/admin/data-check` remains available by direct URL when the feature itself is enabled. `CRM_DATA_CHECK=false` disables the endpoint and navigation entirely. Production feature defaults remain OFF; nothing was enabled online.

`GET /api/admin/data-check/config` now returns `navigationVisible`. An old server missing that field does not accidentally expose the new tab. Employee and tracker-only access remain forbidden.

## Source And Branch

Changed files: rollout flags; Data Check config/API type; admin navigation; Data Check service/math and tests; new `readSnapshot.ts` and test; two existing read-controller clock entry points; frontend wiring test; CI branch selection; this report. Attendance/call command handlers, shared attendance arithmetic, `CallDashboardPanel.tsx` and `api/callDashboard.ts` were not modified.

The requested branch name is `security-data-check`, under `ka0rim1yaz0no/CRM`. The old `codex/security-data-check` reference is removed only after the new remote branch contains the same history and updated source. The old reference is guarded by its expected commit so a concurrent branch update is not deleted. No commit history is rewritten, main stays unchanged, and no production deployment is involved. CI includes the new name and contains build/test steps only.

## Verification Actually Run

- Backend: `node --import tsx --test --test-reporter=spec "src/**/*.test.ts"`: **461 tests, 459 passed, 2 optional external-Mongo tests skipped, 0 failed**, 65.72 seconds.
- Frontend regressions: `node --test --test-reporter=spec scripts/*.test.mjs`: **48 passed**, 0 failed.
- `npm run typecheck` in backend; `npm run build` at root; `npm run lint`; `npm run build:production` and `npm run test:production` in backend: passed. Existing large rich-text-editor bundle warning remains.
- Actual localhost HTTP checks: security/login/dashboard/profile/business-switch/asset checks passed in both businesses; saved attendance/hub/DTR/payroll parity and unchanged ledger passed; Data Check report output/privacy/read-only proof passed for each business and All.
- New tests cover navigation hidden/restored, explicit-null percentage versus absent evidence, exact running totals, concurrent snapshot isolation and no document writes. Empty indexed collections created by lazy model initialization are distinguished from inserted/updated application documents in the hash test.

No production call timing, historical disconnect history, remote CI result, real employee records, or complete browser/device matrix was verified. The tested fixes do not establish that every possible bug is impossible.
