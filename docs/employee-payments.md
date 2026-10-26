# Employee Payments

Payments appears immediately after Notices in employee Profile. It is a read-only history of the signed employee's saved payroll in the selected authorized business. Approval, payment and attendance actions remain administrator-only.

The default view is the current configured cutoff only. Full cutoff history is an explicit dropdown choice, bounded by the frozen history start. Both modes exclude overlapping monthly drafts when the business uses semi-monthly cutoffs. Filtering occurs before pagination, including compatibility with the previous read API.

Monthly basic pay is separate from cutoff basic pay. Missing display rates can be calculated from saved semi-monthly basic pay, saved working days and saved minute/hour rates, without using the employee's current salary or modifying stored amounts. Unverifiable inputs stay unavailable. Calculated values have source tooltips.

ISO and readable cutoff labels are recognized as the same period. Equivalent copies render once. A unique canonical Admin Payroll entry remains selected when a legacy alias disagrees, with a conflict flag; ambiguous canonical duplicates are withheld. Payment status changes are blocked for alias groups until payroll review. Historical entries before the history boundary do not inflate the selected cutoff's review count. Records are never merged, archived, deleted or rewritten by these read rules.

## History Boundary

Initialize once in the intended environment using its existing private configuration:

```sh
cd backend
node --import tsx src/scripts/initializeEmployeePayments.ts
node --import tsx src/scripts/initializeEmployeePayments.ts --apply
```

The first command is a dry run. Apply creates only the new `EmployeePaymentHistoryPolicy` document in each configured business, using the same current cutoff resolver as admin Payroll. It never changes payroll, employee or attendance records. Existing history boundaries are retained on subsequent runs. GET requests never initialize or move a boundary.

Initialize during the approved deployment window before publishing the new frontend. Until then, the tab shows a preparation status rather than exposing older cutoffs. Freeze the boundary at activation, not at build time; check each business's dry-run cutoff before applying.

## Saved Amounts And Access

### Payroll Review Scope

The authorized starting cutoff is October 6-20, 2026. Reviews use the full scheduled cutoff and the agreed attendance-based pay rules. A missing hire date, an employee-account creation date, or attendance before the frozen history boundary is not a prerequisite for reviewing this cutoff. Do not infer a hire date from the first punch or prorate this cutoff by hire date. Later configured cutoffs retain the same history boundary.

Verified payable attendance remains included. Shift-derived paid hours, saved salary/rates, late time, early checkout, excess rest, scheduled absences and approved overtime retain their existing calculation rules. This scope instruction does not waive genuine attendance conflicts, missing rate inputs, conflicting saved cutoff records or payment-approval safeguards. Saved payroll amounts and statuses still require an explicit reviewed action before alteration.

- `GET /api/employees/:id/payments?page=1` independently validates a signed session, own employee ID and business membership even when legacy authentication is disabled.
- Tracker sessions, unsigned claims, archived employees and another employee's ID are rejected. The admin payroll router is not opened to employees.
- Responses are private/no-store and include only allowlisted saved payroll fields. They omit banking, email, audit trails and raw attendance/calculation evidence.
- Old cutoffs are filtered before pagination. Unknown, conflicting or financially inconsistent cutoffs are held for review, not recalculated or repaired during reads.
- The employee breakdown and administrator payslip use the same cent-based allocation helper. Deduction rows always reconcile with the saved total.
- Pending/Review/Failed do not imply payment. Only a saved Paid status displays a payment date; the scheduled date is separate.
- Data refreshes on focus, every 30 seconds while the tab is mounted, and with Refresh. Account/business changes discard late financial responses and reset the ledger cache.

## Verification

```sh
cd backend
node --import tsx --test src/services/employeePayments.integration.test.ts
cd ..
node --test scripts/employee-payments.test.mjs scripts/payroll-payslip-ui.test.mjs
node scripts/employee-payments-browser.mjs <built-frontend-directory>
```

The integration suite uses a unique loopback-only replica set and six synthetic tenants. The browser suite serves a local build through intercepted localhost requests, with synthetic data only and no production requests or outbound calls. It checks desktop/mobile, light/dark, tab navigation, refresh/payment status, amount reconciliation, loading, empty and failed-refresh states.

Online activation remains gated on a newly confirmed quiet window. Do not restart the backend or employee bridges while calls are active. No production attendance/payroll edits are required for this feature.

## Total Cutoff Hours

The Payroll action **Edit hours** edits the selected employee's total cutoff hours, not daily attendance events. Decimal hours normalize to whole minutes in the before/after preview. A signed administrator must supply a reason and confirm before any save.

The adjustment retains saved gross pay, rates, approved overtime, payment status and payment date. Deductions use scheduled cutoff minutes minus the approved total minutes, plus saved excess break and lunch once, capped at gross pay. The payslip and Payments show the adjusted time shortfall instead of charging saved late/absence/undertime categories again. Raw attendance and its daily breakdown remain unchanged. Explicit later recomputes retain the approved total-hours override.

All frozen cutoff business copies update in one transaction with attendance/payroll fences, fresh source checks and before/after audit entries. Paid/Completed cutoffs, differing mirrors, overlapping or duplicate aliases, missing saved rates and stale previews are rejected without partial writes. An hours adjustment cannot clear genuine attendance review or mark a payment Paid.

Verification: `node --import tsx --test src/services/payrollWorkedHours.integration.test.ts` from `backend`, and `node scripts/payroll-hours-editor-browser.mjs <built-frontend-directory>` from the repository root. Both use synthetic records only.

## Payment Status Confirmation

Attendance review is not a payment state: unpaid Review records display Pending in Admin Payroll and employee Payments. Original attendance counts and evidence remain available. Mark Paid/Set Unpaid use an administrator-only, business-pinned preview of saved amounts, followed by a reason and explicit confirmation. Attendance/history warnings require a separate acknowledgement, not invented attendance or recalculated pay.

Equal-money date aliases can share a payment status while preserving each record's amounts and attendance details. Different money, contradictory prior payment states/dates, ambiguous canonical records, overlapping cutoffs, ownership mismatches and unavailable business mirrors remain blocked. All approved status/date/audit writes share one fenced transaction; stale previews, duplicate confirmations and partial mirror failures cannot settle partially. Tests use isolated fixtures; deployment verification never marks production payroll Paid.

## Admin Cutoff Selection

Admin Payroll opens the current configured cutoff within the frozen history boundary. Its complete active roster includes saved records and separate non-payable metadata rows for employees whose payroll has not been generated. Unsaved rows have no invented payroll ID, amounts, hours, payment date or payment actions; ambiguous saved aliases remain explicitly flagged as conflicts. Only saved records contribute to monetary totals, and Generated is separate from the roster count. Historical cutoffs show their own saved records, never today's missing roster. The selector identifies Current; selecting it removes a historical URL override, so reopening the page follows the latest configured cutoff. An explicitly selected history cutoff survives refresh. Canonical aliases count once, archived employees are excluded, and overlapping monthly drafts do not become additional semi-monthly cutoffs. Reads never generate missing pay or change amounts, attendance or payment statuses.

When the new roster endpoint is not yet active, the frontend joins business-pinned, read-only employee and unfiltered saved-cutoff reads. Missing canonical saved views display Not ready, because this older API cannot distinguish an ungenerated record from an unresolved alias. No amount is guessed and no payment action is supplied. This compatibility path permits the roster display fix to roll out without restarting a busy call backend.
