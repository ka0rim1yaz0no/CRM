# Payroll Accuracy: Local Review

2026-10-21. Local CRM at localhost:5173 only. No online CRM, VPS, production database or environment files were accessed. Source publication is on `ka0rim1yaz0no/CRM`, branch `security-data-check`.

## Audit Before Coding

References below are the pre-change source at commit `5f6034e`, not the shifted line numbers after implementation.

| Location | Verified behavior / literal | Decision |
| --- | --- | --- |
| `backend/src/controllers/payrollController.ts:531-542` | Monthly salary, monthly weekdays, half-month base pay (`/ 2`), fixed hourly divisor `/ 8`, minute conversion `/ 60` | Accuracy rates derive the paid day from shift settings and policy. Half salary and the existing complete 6th-5th monthly weekday denominator remain the billing policy. |
| Same controller:600-607 | Lunch fallback 60, two break fallbacks 15, gross-day fallback `|| 9`, `Math.max(1, gross - lunch)` | New path uses the shared policy, validates settings, and throws HTTP 422 instead of guessing. Frozen rollback path remains available. |
| Same controller:675-708 | Absence uses scheduled day times 60. DTR missing time uses `max(late, early shortage)` and subtracts official weekday lunch | New DTR missing hours and deductions both come from the same component minutes. Lunch shown in the DTR is the actual clicked duration. |
| Same controller:743, 801-846, 994-1022 | Separate sum of late, early, excess and absence; rates reused for DTR, gross/net and payroll synchronization | One shared component-total helper; full-precision rates; final money rounding. Generated records are snapshots, not read-time recalculations. |
| Same controller:1119-1186 | Worked-minute/OT edits can recalculate stored money across businesses | Accuracy mode directs these changes through the preview. OT must be explicitly approved and bounded by completed verified weekend work. |
| `src/pages/admin/payroll/index.tsx:382, 1931` | Another `/ 8` fallback and eight-hour help text | Removed. Stored rates are used. Unknown historical paid-day snapshots are labelled unavailable, not invented. |
| `src/pages/admin/payrollCompute/index.tsx:5, 39-44, 88-89` | Fixed eight-hour display/rate calculation | Removed; uses stored paid hours/rates/net pay. |
| `backend/src/services/timeAccounting.ts:5-6, 15-39, 65` | 15/60 allowance defaults, interval minute rounding and deduction sum | Existing shared module extended, not copied. Two breaks and one lunch remain enforced by the session model. |
| `attendanceLedgerService.ts:55-61`, `models/AttendanceLedger.ts` | Global duration policy and versioned allowances; defaults 15/60 | Reused as settings, not embedded in new payroll math. |
| `attendanceHubMath.ts:17-20` | Literal 8 is the Manila UTC offset | Retained: timezone conversion, not an eight-hour paid day. |

Whole backend/frontend search found no other consumer of `PayrollRecord` outside payroll and diagnostics. Dashboards/employee attendance insights consume the shared attendance/hub calculation. The read-only compute page was an additional fixed-day assumption found during the audit. Unit conversion 60, semi-monthly division by two, calendar 15th/defaults and two-break limits are intentional. No separate `0.5` payroll multiplier was found. The only preserved fixed paid/gross days are explicitly named in `payrollLegacyPolicy.ts`, exclusively for rollback. No `/ 8` or `|| 9` expressions remain in active payroll sources; a source-scan test checks this.

The shared boundary calculation could charge time outside the shift on malformed early/late punches. A regression covers punches wholly before/after the shift and verifies non-overlapping late/early intervals. The fix is in `timeAccounting.ts`, behind the flag. Valid stored attendance evidence is not edited.

## Implemented

- `CRM_PAYROLL_ACCURACY`: ON by default in development/test, OFF by default in production, explicit true/false overrides. Local runtime uses the existing duration-attendance flag as well. No production flags were changed.
- One paid-day function: overnight-aware configured shift length minus `policy.lunchMinutes / 60`; invalid/missing/equal start/end or non-positive paid duration returns **422: Shift settings are required for payroll**. Global persisted attendance policy is authoritative; projected UI defaults alone are not evidence of configured shifts.
- Hourly rate = monthly salary / full-cycle working weekdays / paid hours. Minute rate = hourly rate / 60. Absence = paid-day minutes. New DTR regular/scheduled/missing hours use that definition.
- Shared components: late + early time-out + independently excessive breaks + excessive lunch + absence. Actual clicked lunch is displayed; official lunch clock windows do not determine excess. Both breaks have separate duration allowances, one lunch its own allowance.
- User clarification supersedes the text file's conflicting rounding statements: **a completed 15:01 break deducts one minute**. Each completed rest excess rounds up; 15:00 is zero. Open rests never finalize excess. Existing lateness minute-boundary/grace behavior remains; early-out rounds up only after shift end. Component minutes are summed before one money rounding, with full-precision rates. Gross/net are rounded money values. No intermediate component money is used to calculate the total.
- Open/unresolved/current-not-yet-ended shifts are Needs Review and excluded from finalized payroll deductions. Preview blocks application until resolution. The hub may still show observational late/overdue minutes; Data Check now verifies that exclusion rather than equating provisional issue minutes with finalized pay.
- Reads and attendance synchronization do not generate or overwrite cutoffs, seed sample payroll items, archive duplicates, or replace old rates. Old records without paid-day snapshots stay unchanged. New snapshots are also protected from automatic recalculation after rolling the flag off.
- Generate/Recompute modal: configured full semi-monthly range, old/new gross/deductions/net per employee, net difference, bounded OT approvals, audit reason and explicit checkbox. Paid/completed cutoffs lock; overlapping cutoffs (including archived paid ones), duplicate records, invalid settings and mismatched business copies block application.
- Server regenerates and hashes the preview at confirmation; stale previews reject with 409. Deterministic IDs and a partial unique index prevent duplicate active accuracy cutoffs. One Mongo transaction commits all business mirrors plus before/after audits, or none. The transaction requires a replica set; it does not silently downgrade to partial writes on a standalone database.
- Canonical attendance is selected by employeeCode **and assigned business membership**. Matching codes alone do not link unrelated businesses. Copies are compared, never concatenated as additional worked time. Preview totals count one employee, not the number of mirrors. A stored owner business is the only place to mark a new shared cutoff paid. Payment status changes across mirrors are atomic and audited; this does not perform an external bank transfer.
- Admin screen and DTR expose paid hours/day, hourly and minute rates. Old un-snapshotted hours are explicitly identified. DTR distinguishes saved monetary totals from current event rows. Unconfirmed cutoffs cannot be sent as finalized payslips through the updated UI.
- The duplicate **Breaks / Break 1 / Break 2 detail-card panel** requested in the latest screenshot was removed. Shift-record columns, event timeline, totals and source events remain intact.

### Follow-Up Bug Review

Eight additional isolated integration tests and an extended weekend-OT regression cover the continued local review. The following failures were reproduced before fixing them:

- Saved DTR/payslip reads used new-calculation validation, so missing current shift settings or reduced current OT evidence could make a valid saved cutoff unreadable. Saved money/rates/approved OT now come directly from the existing record. Current attendance is calculated separately; a settings validation failure returns an explicit warning and no invented event rows. Actual database failures still return an error. Generation/recomputation still rejects invalid settings and unsupported OT.
- Payment could omit a historical mirror after business membership changed. New recompute snapshots retain their original sorted business IDs. Payment uses that frozen list; older snapshots fall back to the known scoped ledger/access list. Mismatching owners or snapshot membership reject the entire transaction. The source record is rechecked inside the transaction; repeated already-paid requests add no audit or timestamp changes. No historical record was backfilled. For old records without either a frozen list or surviving membership/ledger evidence, the complete historical mirror set remains unverifiable.
- OT approval values such as `null`, booleans, arrays or numeric strings were silently converted to numbers, and unknown employee codes were ignored. The server now requires finite non-negative numeric hours for a listed employee; excessive verified hours remain blocked.
- Equivalent legacy attendance copies conflicted over their unrelated Mongo IDs or business display labels. Financial comparison now includes settings, rates, allowance policy, event types/timestamps, shift information, DTR rows and monetary totals, not replica IDs/names. Each business retains its own labels and evidence IDs. A real event-time difference still blocks confirmation.
- Comparing live business copies at separate server instants introduced a false mismatch in the first localhost recheck. Every preview now uses the existing shared server-read snapshot. A deliberately advancing-clock regression reproduces the old failure and passes with the fix; the actual localhost preview was rerun successfully afterward.
- The browser exposed a monthly/cutoff weekday display mix-up and unformatted decimal-hour cells. DTR now separates current cutoff weekday count from the saved monthly rate denominator, labels an unavailable count explicitly, and displays durations with the existing hours/minutes formatter. Stored amounts/rates are unchanged.

No rounding or attendance-action rules changed in this follow-up. Confirmation still requires a fresh matching preview, resolved evidence, an administrator and an audit reason. Calculation inputs are read before the payroll-write transaction; simultaneous attendance/policy edits during final confirmation are not fully fenced by this change. Resolve/freeze the selected cutoff operationally before approval; this is not a claim of production concurrency certification.

## Rechecked Data Check Findings

Before changes, localhost returned 132 matches, four review flags and two unverifiable checks. Read-only independent queries again confirmed one unassigned NEW sample lead and one present-without-selected-shift-call condition in each of two synthetic businesses. They are legitimate workflow review signals, not evidence that a lead should be assigned to an arbitrary employee or that a call should be invented. No assignment, call, attendance or stored payroll was changed to clear them. The two historical disconnect checks still lack immutable disconnect history; that evidence cannot be recreated honestly.

After the approved rounding change, the same localhost report returns **128 match, 8 mismatch, 2 cannot-verify**. Four non-stale mismatches are the original workflow flags. Four additional warning-only comparisons expose historical cached rounding (one stored day total 120 versus a newly computed 121 minutes, plus its per-event stale-cache count, in each business). Those older caches were not silently rewritten under a new rounding policy. They remain clearly visible for review, and unchanged stored payroll is independently hash-verified. This is not a claim that all checks are green.

## Worked Example

The full configured Oct 6-20, 2026 synthetic cutoff test uses 11 weekdays, all present. Ten days have no deduction. Oct 15 has Time In 23:05, first break 00:00-00:16, second 01:00-01:15, lunch 02:20-03:21, and Time Out 07:50. The test clock is Oct 22, after the cutoff ends.

1. Monthly salary PHP 30,000; monthly 6th-5th weekday denominator 23.
2. Shift 23:00-08:00 = 540 minutes, calculated from settings. Lunch allowance 60; paid day = 480 minutes = 8 hours.
3. Hourly rate = 30,000 / 23 / 8 = 163.04347826086956. Minute rate = 2.717391304347826.
4. Cutoff base = 30,000 / 2 = 15,000. No approved OT, so gross = 15,000.
5. Late 5 + early-out 10 + first-break excess 1 + second-break excess 0 + lunch excess 1 + absence 0 = **17 deductible minutes**.
6. Missing = 17 / 60 hours. Scheduled = 11 x 8 = 88 hours. No second shortage formula is added.
7. Deduction = roundMoney(17 x 2.717391304347826) = **PHP 46.20**. Net = **PHP 14,953.80**.

Separate tests cover 15:00 / 15:01, 30/60-minute lunches, other shift lengths, absence, open rest, late-only, early-only, late+early, too many breaks, weekend approval, invalid settings, and old cutoff preservation after settings changes.

## Dry Run And Rollout

`backend/src/scripts/payrollDryRun.ts` is read-only, disables collection/index auto-creation, and refuses a non-loopback/credential-bearing URI. It inspects the last three **available** cutoffs, deduplicates employee/cutoff pairs across mirrors, and prints differences/review counts only. No stored records are applied. The disposable localhost dataset currently has only two cutoffs; both were inspected. A separate isolated test seeds four and proves only the newest three are inspected without writes.

Example invocation from backend, using an explicitly selected local database mapping:

```powershell
node --import tsx src/scripts/payrollDryRun.ts --uri "mongodb://127.0.0.1:27099/LOCAL_ROOT?directConnection=true" --control-db LOCAL_CONTROL --businesses '[{"id":"business-a","databaseName":"LOCAL_A"}]'
```

Future rollout, not performed here: publish with flag OFF; back up the selected Mongo databases; run the diff against an isolated restored local copy; review discrepancies and unresolved attendance with HR; enable deliberately; recompute only approved, unpaid configured cutoffs using the preview. Do not bulk-rewrite historic payroll. Disabling the flag restores legacy controls; accuracy snapshots remain protected from read-time sync.

## Additive Storage / Recovery

`PayrollRecord` gains optional paidHoursPerDay, hourlyRate, missingHours, calculationVersion, payrollOwnerBusinessId, calculationSnapshot and calculationAudit. New snapshots also retain their original businessIds; this is an additive key within the existing Mixed snapshot, not a migration. No backfill/migration rewrites old records. The additional unique partial index applies only to unarchived `duration-payroll-v1` records. Existing legacy duplicates are neither removed nor silently merged; preview requires review.

Before restarting the local fixture, BSON dumps were taken of all four isolated databases and collection counts/attendance evidence were checked. The backup directory stays under ignored `outputs/`; it is not uploaded. General local backup/restore pattern:

```powershell
mongodump --uri "mongodb://127.0.0.1:27099" --db LOCAL_DB --out LOCAL_BACKUP
mongorestore --uri "mongodb://127.0.0.1:27099" --db RESTORED_COPY_DB LOCAL_BACKUP/LOCAL_DB
```

Restore into a separate local copy and verify counts/evidence before selecting it. Never use `--drop` against an existing valid database as a shortcut.

## Verification

- Backend: `node --import tsx --test --test-reporter=spec "src/**/*.test.ts"` in backend, final follow-up run: **489 total, 487 passed, 2 optional external-Mongo tests skipped, 0 failures**, 75.56 seconds. This includes all 24 payroll integration cases, real Mongo transactions, two-business payroll, three-business manual attendance and full-cutoff golden fixtures.
- Frontend: `node --test --test-reporter=spec scripts/*.test.mjs`: **50 passed**, including disabled/explicit confirmation, displayed before/after amounts and removal of the duplicate break panel.
- Backend `npm run typecheck`: passed. A timestamp typing gap caught during the check was fixed by accurately declaring the existing Mongoose timestamp fields; no stored data changed.
- Root `npm run lint` and `npm run build`: passed. The existing 904 KB rich-text-editor bundle warning remains; it is not a new payroll failure.
- Backend `npm run build:production` and `npm run test:production`: passed. Compiled native Node entry smoke checks login, privacy, attendance and dashboards against two synthetic businesses. Production flag defaults are tested separately; the online system was not used.
- `outputs/verify-local-security-recheck.mts`: passed at the actual localhost:5173, both businesses, owner-only profiles, business switching and protected synthetic assets.
- `outputs/verify-local-payroll-accuracy.mts`: passed at localhost:5173. Entire stored payroll-document and attendance-evidence hashes match before/after restart, repeated payroll/stats/DTR/dashboard reads and previews in both businesses. No existing cutoff was applied or recomputed on the persistent local fixture.
- `outputs/verify-local-data-check.mts` and the independent flag investigation: passed their read-only/privacy assertions; actual findings are disclosed above rather than hidden.
- The real local dry-run inspected both available cutoffs without applying differences. The separate CLI test seeds four available cutoffs and proves only the latest three are inspected, with unchanged payroll/attendance documents and auto-create/index disabled.
- Browser: signed in to the final local backend; opened Payroll in Sample Operations, switched to Sample Studio, refreshed and opened the actual configured-range preview. Both employees' old/new figures and one review day each were visible. Confirm was disabled; no valid persistent record was changed. Saved proof: ignored `outputs/payroll-accuracy-local.png`. Data Check navigation stayed hidden. Desktop viewport was inspected; a full mobile/device matrix and production call timing were not tested.
- Follow-up browser proof: normal login and the admin dashboard opened on the restarted localhost server; the saved DTR showed **11 cutoff weekdays / 23 monthly rate days** with its original money intact. Event duration cells displayed hours/minutes instead of long decimal fractions. Saved screenshot: ignored `outputs/payroll-followup-local.png`. Warning/error cases were exercised in isolated integration fixtures, not by damaging the persistent sample configuration.

All fixtures are synthetic. No production behavior, remote GitHub CI result or zero-bug guarantee is implied.

## Files Changed

Backend: `config/rolloutFlags.ts`; `controllers/payrollController.ts` and new `payrollAccuracyController.ts`; `models/Payroll.ts`; `routes/payrollRoutes.ts`; shared `services/timeAccounting.ts`, `attendanceDerived.ts`, `dataCheckMath.ts`, `dataCheckService.ts`; new `payrollAccuracy.ts`, `payrollLegacyPolicy.ts`, `payrollRecomputeService.ts`; new read-only `scripts/payrollDryRun.ts`. Tests: new accuracy unit/integration suites; updated break-rounding HTTP fixture and explicitly flagged legacy rollback suites in attendance integrity, policy refresh and payroll/uploads.

Frontend: `api/payroll.ts`; new `components/admin/PayrollRecomputeDialog.tsx`; `pages/admin/payroll/index.tsx`; `pages/admin/payrollCompute/index.tsx`; removal of the duplicate detail section in `components/AttendanceHub.tsx`; new `scripts/payroll-accuracy-ui.test.mjs`. This report is the only new tracked document. Ignored dumps, local check scripts, screenshots, generated builds and the unrelated root JPG are not published.

## Manual Local Test

1. Open localhost:5173, sign in to the local synthetic admin, open Payroll, switch between Sample Studio and Sample Operations, and refresh. Saved pay must not change by viewing it.
2. Open a DTR: inspect paid hours/rates and the saved-cutoff notice. Open Attendance day detail: the duplicate break-card panel should be absent; exact events and separate shift-record break columns remain.
3. Choose Generate/Recompute, select a complete configured cutoff (for standard settings Oct 6-20 or Oct 21-Nov 5), then Preview. Inspect old/new amounts and each employee's owner. Preview alone saves nothing.
4. Needs Review, unpaid unresolved shifts or business mismatches must leave Confirm disabled. Use the existing audited attendance edit flow to resolve evidence, not a fabricated checkout.
5. On a disposable resolved fixture only, enter an audit reason, check confirmation and apply. Refresh/switch businesses: identical mirrored values, one logical payroll, and an audit entry. Repeat the old preview: stale confirmation must reject, not duplicate.
6. Approve only verified weekend OT in the preview, re-preview changed inputs and explicitly confirm. Try excessive hours and an overlapping/partial cutoff: both must reject. In a disposable fixture, mark paid from the owner only; paid cutoffs cannot be recomputed.
7. Login as the synthetic employee and check attendance status/buttons; new HTTP regression fixtures separately execute both breaks/lunch and verify three-business refresh behavior. No real employee's punches need to be changed for this check.
8. In an isolated disposable fixture, remove current shift settings after saving a resolved cutoff: its DTR must still open with saved totals and a visible warning, while a new preview rejects with 422. A changed current OT history must not rewrite or prevent reading the existing OT payment. Automated integration tests exercise these changes without modifying the persistent localhost data.
9. In the same disposable fixture, move an employee after cutoff generation and mark paid from the original owner. All frozen mirrors must update together. Conflicting ownership or a failed mirror must leave every business unchanged. Matching legacy copies with different internal IDs must preview normally; genuinely different event times must still reject.

## Limits / Open Questions

- Saturday/Sunday, by shift-start day in Manila, remain the existing weekend definition. No change was made to who is a weekend employee. Holidays/alternate employee calendars need an explicit policy and are not implemented here.
- Only completed verified weekend OT can be approved through this accuracy preview. Unapproved OT is not paid. Weekday/holiday OT, multipliers, tax, statutory contributions, contract/hourly allocation and alternate billing cycles require HR decisions; unsupported generation cycles fail rather than guess.
- Existing semi-monthly half-salary and complete monthly 6th-5th weekday denominator are retained billing rules, not newly inferred policies. A different monthly denominator requires a separate confirmed rule.
- Old stored cutoffs may differ from newly computed attendance because they are intentionally frozen, lack snapshots, or need review. Such records are not silently repaired. Missing historical bridge evidence remains unknown.
