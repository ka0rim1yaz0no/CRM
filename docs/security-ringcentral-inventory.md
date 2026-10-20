# RingCentral Legacy Inventory

Phase 5 read-only source inventory, 2026-10-21. No RingCentral files or historical records were deleted.

`backend/src/config/callProvider.ts:getCallProvider()` always returns `nextiva`. No live RingCentral monitor is started by `backend/src/server.ts`. This is verified by reading source, not a production call test.

| File | Remaining direct consumers | Status under Nextiva-only provider |
| --- | --- | --- |
| `backend/src/services/ringCentralCallMonitor.ts` | `controllers/callBridgeController.ts`, `controllers/leadController.ts`, `services/ringCentralCallMonitor.test.ts` | Monitor is a no-op/unavailable-status stub. Old provider-specific branches are inactive. Pure parsing helpers remain tested. Not safe to delete without removing imports. |
| `backend/src/services/ringCentralCallClassification.ts` | `controllers/callBridgeController.ts`, `controllers/leadController.ts`, `services/ringCentralCallClassification.test.ts` | Old provider/shadow branches are inactive; classification helpers remain source/test dependencies. |
| `backend/src/services/ringCentralCallOutcomePersistence.ts` | No remaining source imports found | Unreachable legacy outcome-persistence implementation. Candidate for later reviewed removal. |
| `backend/src/services/ringCentralRecordingAnalysis.ts` | No remaining source imports found | Unreachable legacy worker dispatcher. Candidate for later reviewed removal. |
| `backend/src/services/ringCentralAudioWorker.mjs` | Worker URL in `services/ringCentralRecordingAnalysis.ts` | Unreachable through the active provider. References optional old audio/transformer packages that are not installed; no attempt was made to execute it. |
| `backend/src/services/ringCentralCallMonitor.test.ts` | Backend test runner | Runs pure compatibility/parser tests, not live telephony. Retained. |
| `backend/src/services/ringCentralCallClassification.test.ts` | Backend test runner | Runs pure classification tests, not live telephony. Retained. |

Other retained compatibility references include provider enums and historical evidence in `models/CallBridge.ts`, `models/leadCallStat.ts`, `controllers/leadCallStatController.ts`, `controllers/callDashboardController.ts`, `services/callBridgeActiveSignal.ts`, and `services/callDashboardService.ts`. Some explicitly exclude old RingCentral devices from Nextiva selection. These are not whole dead files and must not be removed indiscriminately.

This inventory does not imply authorization to purge historical call data or remove every string mentioning a former provider.
