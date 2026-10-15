import { reconcileAllEmployeeAttendance } from "./employeeAttendanceSyncService";
import { attendanceV2Enabled } from "../config/rolloutFlags";
import { retryAttendanceSyncOutbox } from "./attendanceEventSyncService";
import { retryPendingEmployeeAvailability } from "./employeeAvailabilityService";

const defaultIntervalMs = 5 * 60 * 1000;
let reconciliationTimer: NodeJS.Timeout | null = null;
let reconciliationRunning = false;

export async function runAttendanceReconciliation() {
  if (reconciliationRunning) return null;
  reconciliationRunning = true;
  try {
    if (attendanceV2Enabled()) {
      const [attendanceResult, availabilityResult] = await Promise.allSettled([
        retryAttendanceSyncOutbox(),
        retryPendingEmployeeAvailability(),
      ]);
      if (attendanceResult.status === "rejected") {
        console.error("Attendance event retry failed", attendanceResult.reason);
      }
      if (availabilityResult.status === "rejected") {
        console.error("Employee availability retry failed", availabilityResult.reason);
      }
      return {
        employees: availabilityResult.status === "fulfilled" ? availabilityResult.value : 0,
        repairedRecords: attendanceResult.status === "fulfilled" ? attendanceResult.value : 0,
      };
    }
    const result = await reconcileAllEmployeeAttendance();
    if (result.repairedRecords > 0) {
      console.log("Attendance reconciliation repaired records", result);
    }
    return result;
  } catch (error) {
    console.error("Attendance reconciliation cycle failed", error);
    return null;
  } finally {
    reconciliationRunning = false;
  }
}

export function startAttendanceReconciliationWorker() {
  if (reconciliationTimer) return;
  const configuredInterval = Number(process.env.ATTENDANCE_RECONCILIATION_INTERVAL_MS);
  const intervalMs = Number.isFinite(configuredInterval) && configuredInterval >= 60_000
    ? configuredInterval
    : defaultIntervalMs;

  void runAttendanceReconciliation();
  reconciliationTimer = setInterval(() => void runAttendanceReconciliation(), intervalMs);
  reconciliationTimer.unref();
  console.log(`Attendance reconciliation worker started: intervalMs=${intervalMs}`);
}
