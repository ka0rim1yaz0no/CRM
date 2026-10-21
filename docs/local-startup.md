# Local CRM Startup

Use the repository at `C:/Users/hp/OneDrive/Desktop/crm`.

The current test runtime uses MongoDB on loopback port 27099, the API on 4101,
and the frontend at **http://localhost:5173/**. It does not use backend port 4000.

`npm run dev` now checks the local API before starting the frontend. It reuses
an already running CRM without stopping any process. When the API is down it
exits with instructions instead of opening a frontend with endless refused
API/socket connections. It never guesses a database URI, restores data,
creates sample records or kills a port owner.

## Preserve Existing Test Records

Keep the currently running preserved fixture launcher open. If only Vite has
stopped and the API is still running, use `npm run dev` to reconnect it to 4101
with the current local attendance UI flags.

If the whole isolated runtime has stopped, its existing preserved launcher is:

```powershell
node outputs/start-preserved-local.mjs outputs/security-phase1-fixture-1792537558479
```

This machine-local helper restores the saved synthetic snapshot, not changes
made since that snapshot. Do not stop a running database just to run it, and
take a new synthetic backup before restarting after further test edits. The
helper and backups are intentionally not published source artifacts.

## Start Fresh Sample Data Only

```powershell
npm run dev:attendance -- --duration-model --auto-time-out
```

This starts the disposable seeded MongoDB, backend and frontend together. It
requires the local ports to be free and creates a NEW sample database. It is
not the command to preserve existing test changes. Do not run it alongside
the preserved fixture launcher, a separate Vite, or `dev:backend`.

`npm run dev:backend` is the separately configured backend path. Its
`MONGODB_URI` requirement remains intentional; the fixture launcher does not
require a production URI or an environment-file change. Production startup,
authentication, attendance calculations and payroll records are unchanged.

## Verification

Verified locally on October 21, 2026:

- `node --test scripts/local-startup.test.mjs scripts/local-review-ports.test.mjs`: 9 passed.
- `npm run dev`: recognized the existing local CRM without replacing processes.
- `npm run typecheck --prefix backend`, `npm run lint`, `npm run build`: passed.
  Build retains the existing large rich-text-editor chunk warning.
- API health and Socket.IO polling handshake through localhost:5173: HTTP 200.
- Existing synthetic preservation check: attendance and saved payroll unchanged
  in fixture-a and fixture-b; admin login and dashboard queries succeeded.
- Employee dashboard opened in the browser and displayed fixture data.

No full restart, database restore, data reset, production connection, GitHub
operation or change to attendance/payroll calculations was performed for this
startup repair. A database becoming unavailable after startup remains a runtime
failure; the preflight is not a guarantee against future backend crashes.
