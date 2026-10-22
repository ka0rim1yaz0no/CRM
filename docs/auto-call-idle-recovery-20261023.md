# Auto-Call Idle Recovery

## Reproduced Cause

The automatic caller invalidated its active calling-queue query with the default
cancel-and-refetch behavior on every live dashboard update. When a cached queue
was being refreshed slowly, repeated updates kept replacing the request the
caller was awaiting. The caller could remain waiting instead of reaching bridge
readiness/reservation. A full browser refresh temporarily removed the cached
query, explaining the reported workaround.

The regression uses the actual coordinator and actual installed QueryClient,
not only a mock of query invalidation. The old built release also reproduced it
in Edge: 81 queue reads, no reservation or dispatch, and no page error during the
4.5-second broadcast test. This demonstrates one real cause; it does not identify
every possible employee-PC or provider problem.

## Changes

- `EmployeeAutoCaller` invalidates without cancelling an existing queue refresh.
- The queue's exact eligibility-deadline refresh uses the same behavior.
- Browser `online` and `pageshow` events resume the normal guarded readiness
  checks, alongside the existing focus, visibility, socket and polling checks.
- No queue ranking, phone normalization, calling hours, attendance rule, bridge
  ownership check, server cooldown, reservation or dispatch contract changed.
- Genuine failed requests still back off. Unsaved work, OFFLINE/Break/Lunch,
  an unready bridge, an active call and an empty queue still prevent dialing.

## Verification

- Root script suite: 184 passed, zero failures/skips. Includes 22 coordinator
  tests covering six-business slow-read broadcasts, reconnect/page restoration,
  intentional saved-cache cancellation, active calls, genuine failure backoff,
  scope changes, lost responses and the original 30-second server deadline.
- Focused real backend/API and dashboard tests: 64 passed. Includes six-business
  queue priority, Dead exclusion, competing leases and the 29,999/30,000 ms
  reservation boundary using isolated synthetic MongoDB replicas.
- Actual built-app Edge fixture: all six fake businesses passed at desktop and
  mobile widths. Slow queue reads under live dashboard broadcasts completed
  without reloading, selected the first NEW lead and made one mocked dispatch.
  Repeated recovery events did not duplicate that active call. Final runs used
  7-9 queue reads for each complete scenario and had zero page errors.
- `scripts/calling-queue-idle-browser.mjs` intercepts assets/APIs only in its own
  synthetic browser at localhost:5173. It does not replace the user's listener,
  access production records or launch an actual telephone handler.
- Frontend typecheck/build, native backend compilation, focused lint and
  `git diff --check` passed. Existing large-chunk advisories remain.

## Online Activation

Release `crm-20261023-prepared-callrecovery` was published on October 23, 2026
at 07:04:09 Asia/Manila, frontend port 5182. The publisher verified 953 source
and build hashes, the unchanged guarded profile, the reviewed change allowlist
and unchanged compiled backend. Existing process IDs, PIDs, statuses and restart
counts were preserved. Only the frontend upstream changed through a validated
graceful ingress reload; previous hashed browser assets were retained.

Backend remains `crm-20261023-prepared-workspace3`, process 35 / port 4011.
Database writes, backend restarts and forced connection closures were all zero.
Bridge runtime/package access and security configuration were not changed.
Public health returned 200 and four required browser module hashes matched the
manifest, including the caller's compiled recovery code. A separate fresh admin
Call Dashboard tab loaded without a loading/error state. Original tabs and
employee sessions were not refreshed or replaced.

Already-open employee tabs must refresh once **after their current call ends**
to adopt this code. The fix cannot modify JavaScript already loaded in another
browser, overcome browser sleep/TEL permissions or prove physical Nextiva timing.
No customer or internal production test call was placed.

For rollback, restore the previous frontend upstream from the private activation
receipt, validate and gracefully reload ingress. Keep retained hashed assets and
the current authoritative database. Do not restart the backend or restore an old
database snapshot for this frontend-only change.
