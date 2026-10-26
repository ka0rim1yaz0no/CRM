# Missing Payroll Generation

Generation creates only missing unpaid records for the configured current semi-monthly cutoff. It never copies another employee's pay, marks a record paid, recalculates existing payroll, restores archived records, or changes attendance.

An administrator previews eligible employees, held conflicts, non-billable minutes and deductions, and the resulting amounts. Confirmation requires a reason and a revision-bound token. All connected business mirrors are inserted atomically under the existing attendance/payroll transaction fences. A conflicting saved cutoff, salary or policy mismatch, changed attendance, concurrent generation, or missing membership prevents the affected insertion. Nonzero overlapping payroll and paid history are never silently bypassed.

Current-cutoff attendance can still be incomplete. New records preserve that calculation state and snapshot; they are not an approval of final attendance or payment. Later attendance changes require the existing explicit Recompute flow. Generation itself does not update saved snapshots.

Future generation is opt-in per source business and starts strictly after the cutoff confirmed when enabling it. The backend checks every five minutes using the same missing-only rules. Existing saved or archived cutoffs are skipped on every run, including equivalent date aliases. Conflicting employees remain held; an ambiguous or interrupted run is retried without partial mirrors or duplicate pay. There is no automatic payment or backfill of older cutoffs. The worker is inactive in businesses without an enabled policy.
