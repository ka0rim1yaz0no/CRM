export async function reconcileExpiredAttendanceSlots(_now = new Date()) {
  // Attendance time-out is always employee-controlled. This legacy entry point
  // remains a no-op so an old deployment hook cannot close shifts automatically.
  return 0;
}

export function startAttendanceAutoOfflineWorker() {
  console.log("Attendance auto-offline worker disabled: time-out requires manual employee action.");
}
