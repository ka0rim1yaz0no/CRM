# Non-Billable Off The Phone

This feature does not require changing existing attendance or saved payroll records, does not initialize payroll, and must not be activated by restarting a backend during calls.

## Attendance

- The existing blue Off the Phone action remains paid and unchanged.
- A separate red Non-Billable Off the Phone button matches the existing action button height and records `Non-Billable Off the Phone Out` using the existing signed, revision-checked attendance command.
- The red button changes to End Non-Billable Off the Phone after confirmation and refresh. Both kinds return with the existing `Off the Phone In` event. ONLINE also returns normally.
- A second break, lunch, another off-phone interval or duplicate start cannot overlap it. Manual and automatic checkout close the active interval atomically, using the existing audit and retry mechanisms.
- Availability remains OFF THE PHONE, so auto-call does not dial while the employee is away. The call dashboard distinguishes the non-billable kind without changing calling rules or timers.
- Admin shift records, HR records, employee history, CSV, corrections, Undo and Add Time Out preserve the distinct start event and duration.

## Payroll

There is no free allowance. Chargeable time is clipped to the original shift, then each interval is rounded up to the next whole minute using the existing deduction rule. Example: 10:01 is 11 deduction minutes, multiplied by the saved/calculated cutoff minute rate. A zero-duration interval costs zero. An 08:05 automatic checkout cannot charge time after the 08:00 shift end or move the interval to another shift.

`nonBillableOffPhoneMinutes` is a separate component of attendance-based deductions. Payroll generation uses the existing rate, gross-pay cap, cross-business transaction and administrator preview/confirmation. Paid/finalized payroll and previously saved amounts/statuses are not silently rewritten. Live attendance updates invalidate the same connected payroll, DTR, dashboard and Payments queries. A saved cutoff retains its approved snapshot until an explicit authorized adjustment/recompute.

Edit Hours treats non-billable minutes as part of the total time shortfall, with that component retained as a minimum, rather than adding the same shortfall twice. Weekend potential overtime excludes non-billable time instead of charging it again against unpaid overtime. Payslips and Profile Payments use the same saved deduction breakdown and cent allocation.

The payroll roster has no separate non-billable column. Non-billable minutes and their included charge appear in deduction breakdowns, including unsaved proposals, generation confirmation, recompute approval, payslips and Payments. A legacy cutoff without this saved input is not presented as a fabricated zero. The Generate / Recompute deduction section shows old/new non-billable minutes, their included share of total deductions, and the candidate minute rate. Amounts use the same cent allocation as payslips and Payments, including capped deductions and Edit Hours, without adding another charge or changing saved records during preview.

## Upload And Activation

Upload the source, tests and shared helper together. The button is disabled against an older attendance server that does not advertise the new allowed action. Deploy the updated backend and frontend together in a safe window; no data migration, bulk correction or payroll status change is required.

Preserve the existing production feature settings. The integrated browser checks use attendance integrity, duration-model attendance and the upgraded Profile layout enabled (`VITE_CRM_ATTENDANCE_INTEGRITY`, `VITE_CRM_ATTENDANCE_DURATION_MODEL`, `VITE_CRM_PROFILE_V2`). An offline test build is available under `outputs/non-billable-off-phone/dist`; it is not the running online application.

Focused verification uses isolated, loopback-only synthetic databases and intercepted browser fixtures. Never test punches, payroll confirmations or provider calls against production.

```sh
cd backend
node --import tsx --test src/services/attendanceNonBillable.test.ts src/services/attendanceBreakLimits.integration.test.ts src/services/payrollWorkedHours.integration.test.ts
cd ..
node scripts/non-billable-off-phone-browser.mjs <built-frontend-directory>
```
