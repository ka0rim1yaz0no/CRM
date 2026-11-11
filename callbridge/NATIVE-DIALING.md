# Native Dialing, Bridge 0.5.0

This version adds a signed, one-use native call handoff. It does not automate browser clicks, turn off browser security, or end Nextiva calls. Windows must have Nextiva selected as the default app for TEL links. CRM must use HTTPS.

## Install Between Calls

1. Pause Auto Call and let every current Nextiva call finish normally. Leave Nextiva open and idle.
2. Extract the current CRM Call Bridge package. Run `update-windows.cmd` on an already-paired PC, or `install-windows.cmd` for first-time setup.
3. Confirm the updater prompt only when the PC is idle. The installer checks idle twice and refuses active or unknown Nextiva state. Updating preserves the existing encrypted pairing and the native-attempt journal.
4. Refresh CRM between calls, confirm Bridge is ready, then resume Auto Call. An older Bridge or a missing Nextiva TEL association cannot authorize native calls.

There is no unattended forced installer. Existing browsers and Bridge processes are never remotely restarted by the CRM release.

## Timing and Safety

The server keeps the original 30-second post-call deadline. The native worker polls once per second while idle; transport, Windows and Nextiva can add handoff latency. OS handoff is not proof that Nextiva placed a physical call. CRM waits for the existing call-state confirmation before recording a successful call.

Before each handoff, CRM checks canonical attendance, ownership, phone, calling hours, cooldown, browser binding and all fresh Bridges. Coaching, Off the Phone, breaks, lunch and checkout block new calls. Refresh/account changes cancel pending browser commands. A consumed command is never replayed, including after a lost response or process restart; an unconfirmed handoff is safer than a duplicate call.

## Local Tests

`powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/test-native-call-bridge.ps1` exercises the actual handoff functions using mocked HTTP, Nextiva state and OS launch. It does not access installed Bridge configuration or call customers.

Backend integration tests use isolated synthetic databases for signed ownership, one-use commands, rest/Coaching guards, original deadlines, payroll and punch preservation. Live verification must remain read-only and observe natural calls only.
