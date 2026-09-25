# Assistly CRM Activity Tracker Extension

Chrome Manifest V3 extension for transparent employee browser activity tracking.

## What It Tracks

- Tab opened, updated, activated, closed
- Window focus changes
- Chrome idle state changes
- Links clicked
- Form submit events without field values
- Copy/paste events without copied or pasted text
- Keyboard activity without key content
- Mouse movement and scroll activity with throttling
- Active-tab screenshots when enabled
- URL classification as `work`, `non-work`, or `unknown`

The extension does not collect passwords, cookies, request bodies, typed text, or private form values.

## Managed Employee Mode

The employee popup is read-only. Employees cannot log out from the tracker, manually connect another employee, or turn off browser activity/screenshot tracking. The background worker enforces those settings even if older saved settings or popup controls try to disable them.

Tracking and screenshots automatically pause while the CRM employee availability status is `BREAK` or `LUNCH`, then resume when attendance marks the employee `ONLINE`.

## Backend Endpoints

The CRM backend now exposes:

- `POST /api/browser-activity/events/bulk`
- `POST /api/browser-activity/screenshots`
- `GET /api/browser-activity/events`
- `GET /api/browser-activity/screenshots`
- `GET /api/browser-activity/extension-package`

Requests must include:

```http
X-CRM-Extension-Key: dev-crm-extension-key
```

For production, set a real key on the backend:

```powershell
$env:CRM_EXTENSION_KEY="replace-with-a-long-random-key"
```

Then use the same key in the extension popup.

## Easy Install Package

Build the install package from the CRM root:

```powershell
npm run extension:package
```

This creates:

```text
crmext/dist/assistly-crm-activity-tracker.zip
crmext/dist/assistly-crm-activity-tracker-install.zip
crmext/dist/assistly-crm-activity-tracker-store.zip
```

The admin Tracker tab exposes `assistly-crm-activity-tracker.zip` as a `Get Extension` download button. The install package includes `install-windows.cmd`, which copies the extension to a stable Windows folder, copies the install path, and opens Chrome's extensions page.

The Windows installer also configures current-user screen-capture policies for Chrome, Brave, and Edge, then creates an `Assistly CRM Managed Browser` shortcut on the desktop and Start Menu. That shortcut launches the browser with:

```text
--auto-select-desktop-capture-source="Entire screen"
--enable-usermedia-screen-capturing
```

Use that managed shortcut for admin Live View auto-share. Close existing browser windows first, because Chromium ignores new launch flags when the browser is already running.

Chrome only allows true click-to-install extensions through Chrome Web Store or managed enterprise policy. For the closest normal install flow, upload `assistly-crm-activity-tracker-store.zip` to Chrome Web Store as an unlisted/private extension, then set this frontend environment variable to the published listing URL:

```powershell
$env:VITE_CRM_EXTENSION_WEB_STORE_URL="https://chromewebstore.google.com/detail/your-extension-id"
```

When that value is set, the admin Tracker tab shows an `Install Extension` button that opens the Chrome Web Store install page.

## Load In Chrome

1. Start the CRM backend.
2. Download the package from Admin -> Tracker -> `Get Extension`, or use the local `crmext` folder during development.
3. Extract the ZIP.
4. On Windows, run `install-windows.cmd`. It copies the extension folder path and opens `chrome://extensions`.
5. Enable `Developer mode`.
6. Click `Load unpacked`.
7. Paste/select the copied extension folder.
8. Close existing Chrome/Brave/Edge windows, then open CRM from the `Assistly CRM Managed Browser` shortcut if Live View auto-share is required.
9. If an employee is already logged in to CRM in an open tab, the extension auto-connects from that CRM session on install.
10. If it does not auto-connect, open or refresh the CRM while logged in, then open the extension popup.
11. Manual fallback:
   - CRM API URL: `https://crm.assistly123.com/api`
   - Extension key
   - Employee code
12. Click `Connect`.

Auto-connect reads only the CRM `authUser` session stored by this CRM app: employee id, name, and employee code. It does not read CRM page content or form values for connection.

## Screenshot Settings

Screenshots are company managed and locked on. Chrome captures only the currently visible active tab every 3 minutes, limited to non-work sites by default. Screenshots are uploaded to:

```text
backend/uploads/browser-screenshots
```

and served by the CRM backend under:

```text
/api/browser-activity/screenshots/file/...
```

## URL Categorization

The extension has built-in domain lists for common work and non-work categories. Admins can also add work domains and ignored domains in the popup.

Unknown domains are logged as `unknown` until categorized by the built-in rules or the work domain list.
