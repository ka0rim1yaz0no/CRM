import { runForEachBusiness } from "../config/tenancy";
import { closeExpiredAttendanceSlots } from "../controllers/attendanceController";
import { emitCallDashboardUpdated, emitEmployeeAvailabilityUpdated } from "../socket";

const reconciliationIntervalMs = 60_000;
let reconciliationTimer: NodeJS.Timeout | null = null;
let reconciliationRunning = false;

export async function reconcileExpiredAttendanceSlots(now = new Date()) {
  if (reconciliationRunning) return 0;

  reconciliationRunning = true;
  let closedCount = 0;

  try {
    await runForEachBusiness(async (business) => {
      const employeeIds = await closeExpiredAttendanceSlots(now);
      if (!employeeIds.length) return;

      closedCount += employeeIds.length;
      employeeIds.forEach((employeeId) => {
        emitEmployeeAvailabilityUpdated({ employeeId, availabilityStatus: "OFFLINE" }, [
          { businessId: business.id, employeeId },
        ]);
      });
      emitCallDashboardUpdated([business.id]);
    });
  } finally {
    reconciliationRunning = false;
  }

  return closedCount;
}

export function startAttendanceAutoOfflineWorker() {
  if (reconciliationTimer) return;

  const run = () => {
    void reconcileExpiredAttendanceSlots().catch((error) => {
      console.error("Attendance auto-offline reconciliation failed:", error);
    });
  };

  run();
  reconciliationTimer = setInterval(run, reconciliationIntervalMs);
  reconciliationTimer.unref?.();
  console.log(`Attendance auto-offline worker started: intervalMs=${reconciliationIntervalMs}`);
}
