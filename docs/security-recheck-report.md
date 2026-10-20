# Local Security Recheck

Date: 2026-10-21. Only the local source and isolated synthetic environment were changed. No production access, deployment, GitHub API calls, commits or pushes were performed. The browser UI remains at http://localhost:5173; no 5174 server was started.

## Findings Fixed

Each defect was reproduced with a failing regression before its fix.

1. Credential model query hooks encrypted `$set` but allowed `$min` and `$max` to target `password` without encryption. Alternate password operators, nested password paths and password renames now fail closed. Normal encrypted save/query/insertMany behavior and rollback tests still pass.
2. A stalled file-cookie logout could block the next login indefinitely, and repeated logout calls created competing requests. Logout now shares one pending request, aborts it after five seconds, clears its deadline on success/failure and always clears local auth immediately. Login continues to wait for cookie cleanup before creating the next session.
3. Knowledge-base files lived in a common disk directory and a signed user in another assigned business could request them by filename. New uploads now register ownership in the control database before the upload response. Serving checks that ownership against the selected business, including before an entry is saved. Copying a registered URL into another business does not claim the file. Legacy files require a reference in that business's entry metadata; GETs do not backfill ownership or rewrite entries. New filenames use UUIDs.
4. Knowledge-base and message documents could use an HTML filename while claiming an allowed MIME type. Document responses now use attachment disposition and an inert binary content type. Message image/audio/video previews explicitly use an allowed stored media MIME instead of inferring HTML from the filename. Protected legacy `/uploads` responses also use attachment disposition.
5. File-session middleware overwrote the existing `Vary: Origin` header. It now appends cookie/session/business variance instead, retaining Origin and private/no-store caching.
6. Cross-origin raw image uploads requested `X-File-Name`, but CORS did not allow it. The allowed-header list and preflight regression now cover it.

## Files In This Recheck

- `backend/src/models/Credential.ts`
- `backend/src/models/KnowledgeBaseUpload.ts` (new)
- `backend/src/controllers/knowledgeBaseController.ts`
- `backend/src/controllers/messageController.ts`
- `backend/src/middleware/securityFileSession.ts`
- `backend/src/app.ts`
- `src/api/authStorage.ts`
- `backend/src/services/credentialVault.integration.test.ts`
- `backend/src/services/payrollUploads.integration.test.ts`
- `scripts/security-auth-ui.test.mjs` (new)
- `.github/workflows/ci.yml`: local-only workflow source adds frontend regressions; nothing uploaded or executed on GitHub.
- This report. Ignored local fixture helpers/backups/proof images were also updated; they are not source intended for upload.

## Flags And Additive Storage

Existing `CRM_SECURITY_CREDENTIAL_VAULT` gates the model fix. Existing `CRM_SECURITY_UPLOAD_AUTH` gates upload ownership, dispositions and file-cache handling. All security flags retain their development/test ON and production OFF defaults. No production flag or environment file was changed.

`KnowledgeBaseUpload` is a new control-database collection with a unique compound index on `(directory, fileName)` and the owning `businessId`. Model registration/index creation are idempotent. There is no destructive migration, legacy backfill, or data-changing maintenance script. New uploads write one ownership record. A failed file write can leave an ownership row without bytes; the download still fails rather than falling back to another tenant's file.

The synthetic four-database environment was dumped before each local restart; the final backup is `outputs/security-phase1-fixture-1792518786408`. Restore validated all 80 collection counts and the canonical attendance fingerprint. Only the verified known dummy vault password was resealed under the new ephemeral local key. Known one-pixel synthetic preview files were regenerated from fixed bytes, without reading original uploads. The original local database on port 27017 was not accessed.

For a future real rollout, first follow the earlier security reports and take a proper Mongo backup; no real dump/restore or key rotation was attempted here. Retain the encryption key when rolling back encrypted records. Disabling a security flag restores legacy behavior and its risks, so it is not a security remedy.

## Verification Actually Run

Commands below ran from the repository root unless the directory is stated:

| Command | Result |
| --- | --- |
| `npm run typecheck` (backend) | Passed |
| `npx tsc -b` | Passed |
| `npm run lint` | Passed, no lint errors |
| `node --import tsx --test --test-reporter=spec "src/**/*.test.ts"` (backend) | 431 tests: 429 passed, 2 skipped, 0 failed; final run 58.21 seconds |
| `node --test --test-reporter=spec scripts/security-auth-ui.test.mjs scripts/credential-vault-ui.test.mjs scripts/attendance-duration-ui.test.mjs` | 41 passed, 0 failed |
| `npm run build:production` (backend) | Passed |
| `node --input-type=module -e "await import('./dist/backend/src/app.js')"` (backend) | Passed |
| `npm run test:production` (backend) | Passed: actual compiled native Node entry, isolated Mongo, two fake businesses |
| `npm run build -- --outDir dist-local-employee-review` with local API/socket and attendance/dashboard/profile flags | Passed; existing large rich-text-editor bundle warning remains |
| `node --import ./backend/node_modules/tsx/dist/loader.mjs outputs/verify-local-security-recheck.mts` | Passed on the running localhost:5173 in both businesses |
| `node --import ./backend/node_modules/tsx/dist/loader.mjs outputs/verify-local-attendance.mts` | Passed after the final restart: saved session/hub/DTR/payroll values equal on repeat reads in both businesses; ledger unchanged |
| `git diff --check` | Passed; one existing LF/CRLF notice |

The two skipped backend cases are the optional external-Mongo call reservation and availability integration tests, which require `CRM_INTEGRATION_MONGO_URI`. Separate self-contained real-Mongo attendance/security/payroll tests did run. No external database URI was supplied.

Automated attendance coverage includes Time In/Out, two consecutive independent 15-minute breaks, one 60-minute lunch, off-phone return, duplicate rejection, rounding, corrections, refresh persistence and three-business parity. Tests perform new actions on disposable fixtures, not the user's preserved local test shift. The existing seeded 08:05 automatic checkout evidence remains intact; this recheck did not wait until a real 08:05 clock boundary.

Browser checks on localhost:5173 actually showed administrator login, dashboard/call panel in Sample Studio, switching to Sample Operations, logout, employee login, employee dashboard and refreshed attendance. Existing rest history was retained. No new attendance punch was submitted through the preserved UI. Screenshots are in `outputs/security-recheck-admin-dashboard.png` and `outputs/security-recheck-employee-attendance.png`.

## Remaining Limits

- Phase 2 was explicitly skipped in `security.txt`. This is not a claim that every legacy router is authenticated: the Phase 0 inventory still documents weak/header-only routes and public employee summaries. Code-only login remains weaker than password/MFA authentication. Legacy knowledge-base reference authorization trusts the existing entry metadata and does not repair those skipped metadata-write guards.
- Unreferenced legacy knowledge-base files intentionally fail closed with 404 when upload auth is enabled; new upload previews work through ownership registration. No scan of real files or data was performed.
- Rate-limit counters are process-local, reset on restart and are not yet a shared multi-worker store. Stateless signed tokens are not centrally revoked by logout, although browser cookies and local auth are cleared.
- The pre-existing employee-only attendance-hub live endpoint guard conflict remains outside these security phases; actual employee attendance uses the separately tested session/command endpoints.
- Legacy employee dashboard per-punch issue counts differ from canonical day-minute deduction totals. Security changes did not alter this attendance math or old presentation.
- No production Nginx, real Nextiva calls, production database failures, remote CI, real employee data, full device/browser matrix or live rollout was verified. The changes are not certified bug-free or a complete penetration test.

Reminder for the later authorized rollout: keep the GitHub repository private and rotate exposed admin/tracker codes. Neither action was performed because this task is local-only.
