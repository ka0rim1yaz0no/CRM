# Lead reassignment repair

## October 23 follow-up verification and staging

The user subsequently authorized deploying the verified fixes during a confirmed
pause. The live preflight refused activation because one fresh Call Bridge
reported UNKNOWN. No service was stopped and no database rollback was performed.
The admin login supplied by the user was checked read-only: Calls and Attendance
both loaded, with seven sales employees on Lunch and zero pending attendance
delivery jobs. Across six production businesses, 48 signed GET checks passed for
settings, attendance, payroll and dashboard endpoints. These checks do not prove
physical Nextiva timing or exercise a production reassignment write.

A final refresh regression exposed missing `assignmentRevision` projections in
the paginated admin and filtered employee lead responses. Both projections now
include the viewed revision. The existing synthetic handoff test checks both
responses twice after saving, in six businesses.

`crm-20261023-prepared-reassign2` is a separate immutable candidate based on the
previous verified package. Only that projection fix and its regression test
differ in source; frontend and bridge bytes are unchanged. The unfinished new
phone-deduplication, inline Shift Records and employee bulk-archive features are
not included. All 910 source/build hashes were verified during remote staging;
staging changed no live services. Production bulk duplicate cleanup has not been
approved or run.

On the isolated candidate source, the combined lead-assignment, legacy-auth and
employee-calling-queue HTTP suites passed **40 tests, zero failures/skips**.
Backend typecheck and native production compilation passed. The candidate's
reassignment browser suite passed all four employee/admin, desktop/mobile,
two-business save-and-refresh flows with zero page errors or real calls.
Focused ESLint and `git diff --check` passed. Earlier full-suite results below
refer to the earlier source snapshot, not an additional full rerun of this fix.

Activation remains held until the UNKNOWN bridge is resolved and the user
confirms employees are still paused. A fresh verified backup and the same
quiet-state checks are required immediately before switching.

## Scope and approved rule

Working branch: `security-data-check`. Local preparation only. No deployment,
restart, GitHub push, production assignment, customer call, or employee-data repair
is part of this task. Preserve the existing pending queue/timing release.

Approved recipients: **Active and Training Sales**, with Sales in role or team.
Paused, Archived, unrelated Agent roles, wrong-tenant IDs and revoked business
access are rejected. Manual assignment does not depend on automatic-assignment
Settings; Reassign New and automatic batches still do.

## Verified audit

- `src/pages/leads/index.tsx`: employee recipient filtering accepted arbitrary
  Agent roles, used a tenant-independent employee cache, and put a successfully
  transferred lead back into the sender's cache and held tabs.
- `src/pages/admin/leads/index.tsx`: recipient filtering allowed Paused staff;
  employee/lead/count caches and delayed note-to-assignment actions lacked
  explicit business context.
- `backend/src/controllers/leadController.ts`: employee handoff required Active
  while admin paths accepted all non-Archived Sales. Batch/archive reassignment
  omitted the recipient name. Bulk counts described selected logical groups,
  not necessarily actual changes. Stale names could match a different valid ID.
- `src/lib/api.ts`: both the interceptor and page mutations reported the same
  failure. Client-provided actor names also reached administrative audit entries.
- Assignment writes did not consistently compare current ownership/revision;
  a stale assignment or duplicate submission could overwrite a newer decision or
  append unnecessary history.

## Read-only live revision check, October 23, 2026

Only public release metadata, process entry paths, code hashes and release
manifest revision fields were examined. No configuration secrets, logs,
employee/customer records, or production assignment requests were read or sent.

- Public frontend receipt: `crm-20261022-prepared-newfirst`, commit
  `ae9bb78bf8ed4b516730fb5334ad35b0e5739cdb`.
- GitHub default HEAD: `1fd7772b4823c780ce2334615b0b1be1a4b7673c`;
  `security-data-check`: `ae9bb78bf8ed4b516730fb5334ad35b0e5739cdb`.
- Running backend entry resolved to the immutable release
  `crm-20261022-prepared-callguard2`, whose receipt identifies commit
  `a94ffc3e7643edc3b8d6ceb52bf20392a9190ca1`.
- Its actual compiled assignment controller contains both
  `Select an active Sales employee in this business.` and the Active-only check.
  SHA256: `b7198f564dfe2abae4a5bfa59c9cd9c9ec48c9acf5bb41b734fabeb87a428772`.
- Source controller SHA256:
  `fe246b44dcdd0ae735558ef74a6b224cf3b5a0da56a67f0dd0a404ac1649b8d0`.

This verifies version skew and the validation producing that message. The exact
historical failed HTTP transaction and its tenant/recipient status were not
captured. Do not describe the live error as repaired until an explicitly approved
deployment and a controlled live verification have happened.

## Implementation

- Shared pure policy: `shared/leadAssignmentPolicy.ts`.
- Scoped backend recipients, signed actor validation, unique legacy ownership,
  conditional writes and dispatch ownership fence:
  `backend/src/services/leadAssignment.ts`.
- `/employees?leadRecipients=true` returns safe business-local eligible summaries.
  Canonical control membership is authoritative, including explicit empty access.
  Where no canonical entry exists, retain the established tenant-local employee
  membership fallback, respecting any local businessAccessIds restriction.
- Employee/admin single, bulk, automatic and archive/delete assignment paths
  write canonical IDs/names and preserve status, notes, schedules and call history.
  Conflicts return 409; bulk conflict responses state actual completed records.
  Duplicate-group handling remains admin-only; employee passes affect one record.
- `assignmentRevision` is additive, with missing legacy values interpreted as 0.
  New UI requests send the viewed revision. CAS protects ownership, name and
  status during the actual write; no-op assignments do not append audit entries.
- `callingDispatchRevision` is an additive internal fence. Dispatch touches the
  lead in the same Mongo transaction as lease consumption so it contends with a
  concurrent transfer. Transaction-capable MongoDB is required for activation.
- Unstarted reservations are invalidated without changing cooldown/end/start
  timestamps. Already-dispatched or unresolved active calls are never canceled.
- Tenant-keyed recipient/list/count caches and captured tenant/session headers
  prevent delayed actions moving into another business or signed account.
- Confirmed employee transfers remove local held/history/route references and
  invalidate queues/counts. Failed required notes remain editable and block the
  transfer. Existing confirmation dialogs remain.
- Error-object deduplication gives one actual backend message per failed request,
  including session-expiry reporting. No permission errors are suppressed.
- Due scheduled callback > eligible NEW > unscheduled Follow up, server end+30s,
  availability guards and idempotent dispatch remain in force.

## Verification

Executed commands and real results:

- `node --test --test-reporter=spec scripts/*.test.mjs`: **166 passed**, no
  failures/skips. Includes actual page-callback/adaptor execution, error toast
  deduplication, signed-session isolation, required-note sequencing and the
  existing coordinator's due/NEW priorities and 30-second timing tests.
- From backend: `npx tsx --test --test-reporter=spec
  --test-reporter-destination=../outputs/reassignment-backend-final-tests.txt
  "src/**/*.test.ts"`: **580 passed, 0 failed, 2 optional skips**, 159.7 seconds.
  The skipped fixed-port tests are the pre-existing first-use lease and
  availability fan-out checks. Disposable-replica-set HTTP tests exercise those
  behaviors separately, including cross-business competing reservations.
- `npx tsx --test --test-reporter=spec
  src/services/leadAssignment.integration.test.ts`: **12 passed**, including
  the controlled dispatch/transfer race and six-business cases. Included in the
  complete backend run above; do not add it to the total again.
- `npx tsc -b --pretty false`: passed.
- Backend `npm run typecheck -- --pretty false`: passed.
- Backend `npm run build:production`: passed, native Node ESM imports resolved.
- `npm run lint`: passed. `git diff --check`: passed.
- Frontend production Vite build used `guardedBuildEnvironment` and
  `build({envDir:false,build:{outDir:'outputs/reassignment-review/dist'}})`:
  passed. Existing large-chunk warnings remain; no private env file was read.
- `node scripts/lead-reassignment-browser.mjs
  outputs/reassignment-review/dist`: **4 transfer/refresh flows passed** in
  headless Edge at **localhost:5173**, employee/admin x two fake businesses.
  The second business was selected without a page reload, using different local
  employee IDs, and exercised at 390x844; the first used 1440x1000.
  A failed required employee note retained its text and prevented assignment;
  retry saved the note before transferring. Training recipients were available,
  Paused recipients absent from the editor. Each save persisted after reload.
  Confirmation stayed inside the viewport. **0 page errors, 0 real calls**.

The browser checks mock API responses to inspect UI behavior; the independent
backend tests use real HTTP handlers and disposable MongoDB, not mocked writes.
Screenshots are under `outputs/lead-reassignment-browser`. Existing overall page
design was retained; this is not a claim of a comprehensive responsive redesign.

All automated data is synthetic in disposable loopback MongoDB replica sets.
No migration or data repair script is required; no existing valid records are
rewritten. There is no claim of bug-free software or measured physical Nextiva
timing. The prepared package is not permission to activate it during calls.

## Files changed for this repair

Runtime: `shared/leadAssignmentPolicy.ts`,
`backend/src/services/leadAssignment.ts`, `backend/src/services/employeeCallingQueue.ts`,
`backend/src/controllers/leadController.ts`, `backend/src/controllers/employeeController.ts`,
`backend/src/controllers/callBridgeController.ts`,
`backend/src/middleware/legacyAuthentication.ts`, `backend/src/models/Lead.ts`,
`src/api/employees.ts`, `src/api/leads.ts`, `src/lib/api.ts`,
`src/lib/requestErrorToast.ts`, `src/lib/employeeAutoCall.ts`,
`src/components/EmployeeAutoCaller.tsx`, `src/pages/leads/index.tsx`,
`src/pages/admin/leads/index.tsx`, `src/pages/settings/index.tsx`.

Verification/preparation: `backend/src/services/leadAssignment.integration.test.ts`,
`scripts/lead-reassignment.test.mjs`, `scripts/lead-reassignment-browser.mjs`,
`scripts/session-authorization-ui.test.mjs`, `scripts/prepare-guarded-release.mjs`,
and this report. Earlier unrelated working-copy changes were preserved.

## Manual verification before eventual activation

1. Use two synthetic Sales accounts in the same business, one Active and one
   Training. Check that unrelated Agents, Paused/Archived staff and another
   business's employee ID are rejected by the API, not only hidden in the UI.
2. Add an unsaved note, choose Re Assign and confirm. With a failed note request,
   the note stays and ownership does not change. Retry successfully; the old
   queue removes the lead, the new queue receives it, and reload both views.
3. Switch businesses with an assignment selection open. Confirm the selection
   clears, recipients reload, and the new request uses that business's employee ID.
4. As admin test single assignment, selected duplicate groups in bulk, and
   Reassign New with Settings off/on. Check both owner ID/name, actual changed
   counts and one audit entry per real change. Repeat a no-op and submit stale
   versions from two tabs; require a no-op or clear 409, never silent overwrite.
5. Verify the former owner cannot reserve/dispatch the transferred lead. An
   already-started call must continue. Confirm due/NEW/unscheduled priority and
   that the original post-call deadline remains end+30s, not transfer+30s.

Legacy clients omitting revision values still have atomic server-snapshot CAS,
but cannot detect an ownership change that happened before their request began.
Refresh is therefore required at eventual rollout. Bulk operations are
per-record CAS, not advertised as all-or-nothing; a 409 reports any completed
records plus conflicts. No physical Nextiva dial was placed or measured.
