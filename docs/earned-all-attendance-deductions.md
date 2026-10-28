# Earned Pay With All Attendance Deductions

This opt-in policy retains earned-to-date gross pay and additionally deducts Late,
Undertime, completed scheduled-shift Absence, excess Break, excess Lunch and
non-billable Off the Phone. The user explicitly approved the additional shortfall
charges even though the unworked hours already reduce earned gross pay.

- `CRM_EARNED_ALL_DEDUCTIONS_FROM` is a configured cutoff start, not a punch date.
- `CRM_EARNED_PAYROLL_FROM` must also enable earned payroll for that cutoff.
- New calculations use `earned-hours-all-deductions-v1`.
- Future shift absence is never charged. An employee still online is not undertime.
- Existing paid break/lunch allowances, per-shift Off the Phone allowance and
  minute rounding remain unchanged.
- Gross pay uses attended paid hours and approved overtime. Worked hours remain
  physical paid time, rather than being reduced a second time by monetary penalties.
- Money rounds once per aggregate, deductions are capped at gross and net cannot
  become negative. The displayed deduction rows reconcile to the charged total.
- Edit Hours preserves accrued shortfall charges and applies rest/non-billable
  deductions once, without using shortfall penalties to inflate gross hours.
- Read-only unpaid views update Payroll, DTR, Payments and payslips. Viewing or
  refreshing does not rewrite a saved payroll or change payment status.
- Paid and Completed records retain their saved amounts, dates and calculation
  versions. Older paid earned-hours-v1 views retain their original explanation.
- Saving an unpaid recompute still requires its revision-checked confirmation.

Deployment requires a stable call-free and write-free window, a fresh verified
encrypted backup and preservation of the existing Off the Phone effective time.
Do not reset that timestamp, backfill punches, bulk rewrite payroll, stop Auto Call,
or clear call state to manufacture a deployment window.
