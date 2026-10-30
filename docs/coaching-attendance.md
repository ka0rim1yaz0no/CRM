# Billable Coaching

Coaching has a separate 20-minute allowance per assigned shift. All Coaching
time is billable: it never becomes non-billable, never creates a payroll
deduction, and never consumes the ordinary Off the Phone allowance.

At the allowance boundary the server appends one audited Coaching In event and
returns the employee ONLINE. The Coaching button remains disabled until the
next assigned shift. Manual return can happen earlier. Refresh, business
switching, checkout and another Time In do not replenish the same shift's
allowance. Coaching cannot start outside the assigned shift.

The indexed worker checks due returns every second and records the exact
allowance boundary, even when processing is delayed. Commands use the existing
attendance lease, revision fence, idempotency and durable business delivery.
Manual checkout or return winning a race cannot create duplicate returns.
Original punches are retained. Existing Paid/Completed amounts, statuses and
payment dates stay protected by the existing payroll rules.

Coaching uses the canonical OFF THE PHONE calling hold with its own source and
display label. It blocks new calls through both the browser save fence and the
server attendance guard. Returning ONLINE does not bypass bridge, queue,
session-ownership or cooldown checks, and does not end an existing call.

Employee Dashboard shows separate live remaining-time clocks and controls for
Off the Phone and Coaching above the dashboard summary and Announcements.
The control reads Coaching before starting and Coaching Out while active;
Coaching Out returns ONLINE through the canonical Coaching In event. During
Coaching, the other employee attendance status controls are disabled, including
the generic ONLINE/Offline actions and any already-open Offline confirmation.
Attendance, HR/Profile and Call Dashboard retain Coaching labels and durations.
There is no Coaching deduction row.

The return worker starts independently of the optional general worker group;
enabling Coaching must not enable unrelated workers. A backend rollout still
requires the guarded call-free activation process. Frontend-only changes must
preserve existing connections, backend processes and previously loaded assets.
The isolated preview under outputs/coaching-ui-review uses synthetic browser
storage only, with no production accounts, calls or databases.

Automated boundary tests do not establish physical Nextiva launch timing or a
naturally observed production return. Passive verification must distinguish
the canonical return event, processing delay, Call Dashboard refresh and CRM
dial authorization from a provider-confirmed telephone call.
