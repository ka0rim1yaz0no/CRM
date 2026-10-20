# Security Phase 1 - Local Credentials Vault

Historical checkpoint: later authorized local work is recorded in [security-phases-3-5-report.md](security-phases-3-5-report.md). Statements below describe the earlier Phase 1 stopping point.

Date: 2026-10-21, Asia/Manila.

## Scope and checkpoint

Phase 1 only is implemented and tested. Phase 2 remains skipped as requested. Phase 3, Phase 4 and Phase 5 have not started. Nothing was deployed online, pushed to GitHub, or committed in this phase. No `.env`, real credentials, keys, logs, uploads, real employee/customer database, or original local MongoDB on port 27017 was inspected. All database tests used disposable synthetic data.

The browser application remains at **http://localhost:5173**. No frontend was started on port 5174. Port 4101 is its loopback backend, not a second frontend.

## Implemented

- With the vault flag enabled, every existing credential route and the new reveal route requires the existing signed, full-access `verifiedAdminOnly` session. Employee-code headers alone, employee sessions, tracker-only admins, expired sessions and altered signatures cannot access them.
- List, create, update and archive responses expose whitelisted metadata and `hasPassword`, never password plaintext or ciphertext.
- `POST /api/credentials/:id/reveal` returns one password only after a reveal audit has persisted. The audit stores the verified admin code, credential ID, requesting business and timestamp, but no password. Responses use `Cache-Control: no-store`. Audit failure returns a sanitized 503, not a password.
- AES-256-GCM uses a random 12-byte IV, 16-byte tag, versioned envelope and credential-ID authenticated context. Copying ciphertext between credentials or altering the key, IV, tag or body fails closed.
- Legacy plaintext remains readable through explicit reveal without rewriting the credential. Intentional writes upgrade the affected legacy password. Reads never run a migration. Blank or omitted edit passwords preserve existing values, including during a concurrent password replacement.
- Save, query and insert-many model hooks encrypt supported writes. Unsupported bulk writes fail closed while enabled. Raw driver access intentionally remains a privileged maintenance boundary, not an encryption guarantee.
- The admin UI fetches a password only after Show. Copy is disabled until Show succeeds. Hide, editing, filter/selection changes, business/auth changes and unmount clear revealed state. Late responses cannot restore a cleared password. Query caches retain only metadata. Existing design/library patterns were reused.
- The existing shared-vault business resolver is unchanged. Tests cover the same shared vault and audit storage through three different businesses.
- The dry-run script only counts plaintext, structurally encrypted and malformed records. It does not authenticate every ciphertext or apply any migration.

## Flag and key contract

`CRM_SECURITY_CREDENTIAL_VAULT` defaults ON in development/test and OFF in production. Explicit `true`/`1` enables it; `false`/`0` disables it through the existing rollout helper.

`CRM_CREDENTIAL_KEY` must contain at least 32 UTF-8 bytes, or `base64:` followed by canonical standard base64 encoding at least 32 bytes. The implementation derives the AES-256 key with SHA-256. There is no default key. Production startup refuses a missing, short or malformed key when the flag is enabled, before database connection/index work. Development/test may start without a key so login, dashboards and attendance remain available; vault encryption/reveal of encrypted records fails closed without one.

The disposable fixture launcher generates an ephemeral random key only for a freshly created synthetic database. The preserved local test runtime also uses a fresh in-memory key after verifying its restored backup contained no encrypted credentials. No key was printed or saved. This is not a persistent-production key management strategy. Do not restart a restored encrypted database with a newly generated key.

For a future separately approved rollout, configure securely through the deployment environment:

```text
CRM_SECURITY_CREDENTIAL_VAULT=true
CRM_CREDENTIAL_KEY=<securely generated and retained material of at least 32 bytes>
```

Do not paste the real key into chat, Git, command output, screenshots or this report. Existing signed-admin session configuration remains necessary and unchanged.

### Read-only dry-run

Run from `backend`, using an explicitly approved database destination and each actual vault database name:

```powershell
node --import tsx src/scripts/auditCredentialEncryption.ts --dry-run --uri "mongodb://127.0.0.1:<approved-port>/" --business-db "<approved-vault-database>"
```

Repeat `--business-db` for additional databases. The script does not load `.env` or connect implicitly, prints aggregate counts only, rejects apply/unknown options, and closes its raw MongoDB cursor/client on failure. No apply mode was added.

## Files changed

| Files | Purpose |
| --- | --- |
| `backend/src/config/rolloutFlags.ts` | Vault rollout switch |
| `backend/src/app.ts`, `backend/src/server.ts` | Production key validation |
| `backend/src/localAttendance.ts` | Fresh disposable fixture key, without changing attendance logic |
| `backend/src/routes/credentialRoutes.ts` | Signed-admin guard and reveal route |
| `backend/src/controllers/credentialController.ts` | Safe metadata, write upgrades, audited reveal and sanitized errors |
| `backend/src/models/Credential.ts` | Default password exclusion and encryption write hooks |
| `backend/src/models/CredentialRevealAudit.ts` | Additive audit model/index |
| `backend/src/services/credentialEncryption.ts` | Shared encryption/decryption/configuration implementation |
| `backend/src/scripts/auditCredentialEncryption.ts` | Read-only storage counts |
| `src/api/credentials.ts`, `src/lib/credentialVault.ts`, `src/lib/credentialContext.ts` | Safe requests, metadata and transient reveal state |
| `src/pages/admin/credentials/index.tsx` | Explicit reveal and blank-password edit handling |
| `backend/src/services/credentialEncryption.test.ts` | 12 crypto/dry-run tests |
| `backend/src/services/credentialVault.integration.test.ts` | 10 real-Mongo/HTTP vault tests |
| `backend/src/services/securityCredentialCompatibility.integration.test.ts` | 3 flag/login/dashboard/attendance tests |
| `scripts/credential-vault-ui.test.mjs` | 24 frontend contract/state tests |
| `docs/security-phase1-report.md` | This checkpoint report |

The earlier Phase 0 audit documents remain historical reports. The unrelated pre-existing untracked image was not modified.

## Verification actually run

| Working directory / command | Result |
| --- | --- |
| `backend`: `node --import tsx --test --test-reporter=spec "src/**/*.test.ts"` | 415 tests: 413 passed, 0 failed, 2 skipped; final run 73.57 seconds |
| `backend`: `npm run typecheck` | Passed |
| Repository root: `npx tsc -b` | Passed |
| Repository root: `npm run lint` | Passed, zero errors/warnings |
| Root: `node --test scripts/credential-vault-ui.test.mjs scripts/attendance-duration-ui.test.mjs` | 38 passed: 24 vault tests plus 14 attendance UI tests |
| Root: `npm run build -- --outDir dist-local-employee-review` | Passed with local API/socket/attendance feature settings; existing large rich-text chunk warning remains |
| Root: `git diff --check` | Passed; existing Windows CRLF normalization notice is not a diff error |

The two existing skips are `callBridgeReservation.integration.test.ts` and `employeeAvailabilityService.integration.test.ts`, which require `CRM_INTEGRATION_MONGO_URI`. No external/production test URI was configured.

The new compatibility test enables the vault without a development key, logs in a fake admin and employee, checks signed dashboard/session responses, and executes Time In, two immediate back-to-back 15-minute breaks, one 60-minute lunch, off-phone return and manual Time Out. Fresh reads in both assigned businesses agree and no extra rest deduction appears.

The actual running localhost API was also checked with a synthetic test credential: ciphertext at rest, metadata-only list, anonymous denial, explicit audited reveals in two businesses, a read-only dry-run with one encrypted/zero plaintext record, and an unchanged attendance ledger. A real mongodump backup preceded the disposable database restart. All collection counts and the attendance fingerprint matched after restoration. The user's existing fake employee's 22 attendance events, both short breaks, lunch, stored payroll and deductions remained equal across both businesses after fresh reads.

Browser verification at localhost:5173, desktop 1280x720, observed:

1. Synthetic admin login opens the admin dashboard and live call panel.
2. Credential is masked and Copy disabled before Show. Explicit Show enables Copy; Hide clears it.
3. Edit password starts blank. Changing account metadata and saving survives refresh; explicit reveal still returns the original dummy password.
4. Switching to Sample Operations retains the same shared credential, masked again with Copy disabled.
5. Logout and fake employee login open the employee dashboard. Attendance opens and Refresh preserves the saved records/status and usable Time In control. Existing exhausted break/lunch controls remain disabled, not reset by this security change.

Proof: `outputs/security-phase1-vault-masked.png` and `outputs/security-phase1-employee-attendance.png`. No real password appears in either screenshot. UI state tests cover error handling, cancellation, stale responses and cross-tab changes; not every supported browser/device was manually tested.

## Data and rollback

No destructive schema migration or bulk apply was performed. The new audit collection/index is additive. Existing encrypted records require their original key even when the flag is disabled. Never delete or rotate that key without a separately tested re-encryption and recovery procedure.

Setting `CRM_SECURITY_CREDENTIAL_VAULT=false` and restarting restores legacy route/list behavior, including its pre-existing password exposure and weaker access controls. That is an emergency compatibility rollback, not a secure operating state. Keep the same encryption key available so previously encrypted rows remain readable. For a full rollback after data writes, retain a verified database backup and key; do not restore an older code version that cannot read encrypted values.

## Remaining limits and existing findings

- This phase is not a claim that the entire CRM is secure or bug-free. Phase 0's unrelated route exposures and public uploads remain pending. Phase 3/4/5 work is not silently included here.
- The pre-existing `/api/attendance-hub/live` contradictory role checks remain: both signed employee and signed admin requests can return 403. Existing attendance buttons use the separately tested employee session/command routes. No new attendance guard or calculation change was made in Phase 1.
- Existing legacy employee-dashboard attendance issue counters can differ from canonical minute-based deductions; the current fake fixture displays legacy per-punch flags. Phase 1 does not recalculate those UI counters or change payroll math. Canonical deductions and payroll equality were verified independently.
- Legacy plaintext remains at rest until an intentional write upgrades its record. Counting it is not a completed bulk migration.
- No key rotation, production backup recovery, real live bridge call, external integration database, or production deployment was tested. No online access was used.
- Rollout OFF intentionally preserves legacy behavior. The enabled security behavior has been tested locally, not activated in production.

## Manual local check

1. Open localhost:5173. Use the existing synthetic admin code `90000001`, not a real account.
2. Open Credentials and locate `Phase 1 Test Vault`. Confirm masked password/disabled Copy; Show then Hide it.
3. Edit the account label with password blank, save, refresh, then verify Show still works. Switch businesses and confirm the same masked record.
4. Log out; use synthetic employee `90000003`. Confirm the employee dashboard, Attendance and Refresh load. Current saved rest tests are intentionally preserved and already used; this phase did not reset them.
5. Review this report before authorizing the next phase.

Reminder for the later security rollout: make the GitHub repository private and rotate exposed admin/tracker codes. No GitHub settings or codes were changed during this local-only phase.
