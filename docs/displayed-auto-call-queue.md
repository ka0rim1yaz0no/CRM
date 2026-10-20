# Displayed Auto-Call Queue

Local-only implementation, October 21, 2026. GitHub publication is authorized; online deployment is not.

## Selection

The Leads page publishes the exact ordered `filteredLeads` array that it renders. Auto-call selects the first assigned, eligible row with a valid callable phone from that array. The existing UI applies tab/status, search, state, category and favorites; no second copy of those filtering/sorting rules was added. Recently commented leads, not-yet-due follow-ups and other employees' leads remain ineligible under existing rules. A pending-comment storage entry is no longer a candidate source and cannot override the displayed order.

Loading, fetching additional pages, errors and pending search debounce pause selection. Only loaded/displayed rows can be selected; auto-call does not secretly scan later undisplayed pages. Outside Leads, the existing queue API is used only to check whether work exists, then the caller opens Leads before selecting/reserving. There is no call from that invisible/background candidate. Automatic detail selection preserves the active filters; ordinary user navigation retains its existing behavior.

The in-memory view is scoped to employee and business, cleared on unmount and replaced by the latest owner. The lead query key includes business. A business change restarts the caller context and cannot reuse another business's displayed rows.

## Timing and Safety

The existing 30-second server cooldown, atomic employee-wide lease, reservation token and one-time V2 dial-start claim remain unchanged. Reservation, dial-start and cleanup now pin their original business header. The displayed head, current employee/business and valid call window are rechecked after asynchronous waits and before phone launch. Fresh lead status/assignment/comments are checked; changed phone data refreshes the list rather than dialing the old number. A filter/order change cancels the stale candidate and releases its reservation. A returned `alreadyStarted` claim does not launch another phone action.

No exactly-30-second physical Nextiva guarantee is implied: network/browser scheduling and list readiness can delay a dial. The rule remains no reservation before the server deadline, with no new five-second cooldown added. If uncertainty occurs after dial-start, the existing dial-intent guard may conservatively delay a retry rather than risk a duplicate.

## Verification

- `node --test scripts/displayed-auto-call-queue.test.mjs`: 11 passed. Tests execute the real component effects with fake transport/phone actions, covering pending-lead priority, filtered/empty/loading lists, eligibility, stale candidates during read/reserve/dial-start, changed business/phone, already-started claims, cooldown and background navigation. No real calls are made.
- `node --test scripts/*.test.mjs`: 82 passed (the final targeted rerun also passed).
- Full backend suite with cached synthetic Mongo and `--test-concurrency=2`: 534 total, 532 passed, two optional external-Mongo skips, zero failures. The first fully parallel run had six hook failures from one local Mongo connection reset; reduced-concurrency rerun passed without code changes.
- Two new actual ephemeral-Mongo checks prove only one concurrent reservation wins across tabs/businesses; 29,999ms is rejected, exactly 30,000ms allows one winner, and an outstanding dial intent still blocks a duplicate. These are not skipped and never use the CRM fixture databases.
- Backend typecheck, root build and lint passed. Existing large rich-text-editor bundle warning remains. Checks-only CI includes the new frontend test.
- The localhost backend/database were unavailable during verification. The existing standalone Vite process on 5173 was replaced with the known isolated local runner, restoring the last verified four-database backup `outputs/security-phase1-fixture-1792537558479`. No online server was accessed. Restoration is a local runtime recovery, not a historical migration or deduction recalculation.
- After recovery, the existing attendance/derived and saved-payroll preservation fingerprints matched in both sample businesses, including read-only previews. In the actual localhost browser, normal login as the known offline synthetic Sales employee opened My Leads, search reduced the displayed list from one row to zero, and clearing it restored the row. No call, call-outcome button, favorite mutation or attendance action was clicked. The synthetic displayed lead has no phone, so physical dialing was not verified from this view. State options were empty in this sample; state/category/favorites scope is covered by the shared rendered-array contract and synthetic component tests, not claimed as a populated real-browser test of every option.

## Manual Test

Open `http://localhost:5173/leads` as a disposable Sales employee. While offline or with no paired bridge, change search, state, category, favorites and status tabs to inspect the visible order safely. Empty/non-callable lists should not launch anything. For a separately authorized real bridge test, use consenting internal numbers only: go Online, observe the first eligible row, end the call, and measure the next dial relative to the confirmed server end time. Change a filter during the wait and verify the new first eligible row is selected. Two tabs must never produce two phone launches for one employee.

Physical Nextiva behavior, production data and every possible device outage were not tested. The live CRM and GitHub deployment configuration were not changed.
