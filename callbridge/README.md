# Assistly Call Bridge

Assistly Call Bridge reports the local NextivaONE desktop app's call state to
Assistly CRM. It uses the Windows audio-session API and does not read call
audio, contacts, messages, or Nextiva credentials.

Version 0.3 pairs the Windows computer once. When authorized sales employees
change accounts in the same CRM browser profile, the bridge follows the latest
login automatically. It will not switch away from an active or starting call.

## Package

From the CRM repository root:

```powershell
npm run call-bridge:package
```

The package is written to:

```text
callbridge/dist/assistly-call-bridge.zip
```

## Local detection test

This command prints the detected Nextiva state without requiring pairing:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\AssistlyCallBridge.ps1 -Once
```

Expected idle state when NextivaONE is running:

```json
{
  "State": "idle",
  "NextivaProcessDetected": true,
  "AudioSessionActive": false
}
```

## Install

1. Generate a pairing code from the employee CRM Settings page.
2. Extract `assistly-call-bridge.zip`.
3. Run `install-windows.cmd`.
4. Enter the CRM URL, business id, and pairing code shown by CRM.

The bridge installs per Windows user under `%LOCALAPPDATA%\Assistly\CallBridge`
and starts from that user's Startup folder. The bridge token is encrypted with
Windows Data Protection API for the current Windows user.

The pairing is shared by sales accounts that use the same CRM browser profile
and selected business on that Windows computer. Each employee still uses their
own CRM login and lead assignment. The most recent active sales login controls
auto calling; an older open tab cannot take the bridge back.

## Update an existing installation

1. Download and extract the latest Call Bridge package.
2. Run `update-windows.cmd` from the extracted folder.

The updater keeps the existing encrypted pairing and restarts Call Bridge with
the latest call detection logic. A new pairing code is not required.

Installations paired before version 0.3 remain employee-specific. To enable
automatic account switching on an existing computer, create a fresh pairing
code in CRM Settings and run `install-windows.cmd` once. Future script-only
updates can use `update-windows.cmd` without pairing again.

## Mock state

For local API testing, use one of:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\AssistlyCallBridge.ps1 -Once -MockStatus active
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\AssistlyCallBridge.ps1 -Once -MockStatus idle
```
