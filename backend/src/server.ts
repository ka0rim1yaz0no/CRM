import "dotenv/config";
import { createServer } from "node:http";
import { createApp } from "./app";
import { connectDatabase } from "./config/db";
import { refreshConfiguredBusinessesFromStore } from "./config/tenancy";
import { startLeadAutoAssignmentScheduler } from "./controllers/leadController";
import { ensureEmployeeIndexes } from "./models/Employee";
import { createSocketServer } from "./socket";
import { startHempSurveyLeadQueueWorker } from "./services/hempSurveyLeadQueue";
import { startAttendanceReconciliationWorker } from "./services/attendanceReconciliationWorker";
import { startAttendanceIntegrityWorker } from "./services/attendanceRecoveryWorker";
import { assertCredentialEncryptionConfiguration } from "./services/credentialEncryption";
import { assertAttendanceFlagConfiguration } from "./config/attendanceFlags";
import { applyLeadWorkspaceSwitch } from "./config/leadWorkspaceRuntime";
import { startPayrollGenerationWorker } from "./services/payrollGenerationWorker";

assertAttendanceFlagConfiguration();
const port = Number(process.env.PORT || 4000);
const host = process.env.HOST || "127.0.0.1";
const mongoUri = process.env.MONGODB_URI || "";

assertCredentialEncryptionConfiguration();
await connectDatabase(mongoUri);
await refreshConfiguredBusinessesFromStore();
await ensureEmployeeIndexes();

const app = createApp();
const httpServer = createServer(app);

createSocketServer(httpServer);
let workersStarted = false;
const startWorkers = () => {
  if (workersStarted) return;
  workersStarted = true;
  startLeadAutoAssignmentScheduler();
  startHempSurveyLeadQueueWorker();
  startAttendanceReconciliationWorker();
  startAttendanceIntegrityWorker();
  startPayrollGenerationWorker();
};
if (process.env.CRM_LEAD_WORKSPACE_SWITCH_FILE) {
  await applyLeadWorkspaceSwitch(startWorkers);
  process.on("SIGUSR2", () => { void applyLeadWorkspaceSwitch(startWorkers).catch(() => {
    console.error("LEAD_WORKSPACE_SWITCH_FAILED");
  }); });
} else startWorkers();

httpServer.listen(port, host, () => {
  console.log(`API server running on http://${host}:${port}`);
});
