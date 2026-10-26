# Automatic Current-Cutoff Previews

The verified administrator Payroll page prepares unsaved employee previews on read for the business's configured current semi-monthly cutoff. It refreshes when attendance changes, on page focus, and once per minute while visible. The cutoff picker also refreshes, so the next configured cutoff requires no manual initialization or scheduler.

`GET /api/payroll/current-previews` is read-only. It returns no approval token, payroll record ID, payment status, or saving action. Existing dated aliases, saved records, and archived Paid/Completed records are excluded for the same cutoff. Historical and future explicit cutoff requests are refused. An unexpected concurrent generation is skipped.

Amounts use the existing backend candidate calculation, exact rates, and common deduction breakdown. Non-billable Off the Phone is included once at the configured minute rate with existing rounding and gross-pay limits. Future days and incomplete or unverified shifts remain explicit. Full cutoff basic pay is provisional, not earned-to-date pay or authorization to pay.

Automatic preparation never creates records, recalculates saved payroll, marks anyone paid, changes attendance, or silently repairs conflicting historical records. Actual saving still requires a fresh guarded administrator approval with its existing concurrency and paid-record protections.
