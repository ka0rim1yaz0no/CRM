import { attendanceAccuracyFixesEnabled } from "../config/rolloutFlags";

export type AttendanceWorkerName = "auto-time-out" | "recovery" | "derived-refresh" | "policy-refresh" | "outbox" | "coaching-return";
export type WorkerCounters = { scanned: number; closed: number; failed: number; deliveryPending: number };
type WorkerHealth = { name: AttendanceWorkerName; startedAt: string | null; lastRunAt: string | null; running: boolean;
  counters: WorkerCounters; lastErrorCode: string | null };
const names: AttendanceWorkerName[] = ["auto-time-out", "recovery", "derived-refresh", "policy-refresh", "outbox", "coaching-return"];
const empty = (): WorkerCounters => ({ scanned: 0, closed: 0, failed: 0, deliveryPending: 0 });
const health = new Map<AttendanceWorkerName, WorkerHealth>(names.map(name => [name,
  { name, startedAt: null, lastRunAt: null, running: false, counters: empty(), lastErrorCode: null }]));

export function attendanceWorkerCounter(name: AttendanceWorkerName, field: keyof WorkerCounters, count = 1) {
  if (attendanceAccuracyFixesEnabled()) health.get(name)!.counters[field] += count;
}
export function attendanceWorkerFailure(name: AttendanceWorkerName, operation: string, error: unknown,
  context: { employeeCode?: string; businessId?: string; ledgerId?: string } = {}) {
  const raw = error as { code?: unknown; name?: unknown } | null;
  const code = typeof raw?.code === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(raw.code) ? raw.code : "ATTENDANCE_OPERATION_FAILED";
  // Database errors can embed documents/PII in their message. Never log raw errors, stacks or payloads.
  const message = code === "ATTENDANCE_OPERATION_FAILED" ? "Attendance operation failed; retry remains available" : `Attendance operation failed (${code})`;
  if (attendanceAccuracyFixesEnabled()) {
    health.get(name)!.lastErrorCode = code;
    console.warn("attendance-worker", { worker: name, operation, ...context, code, message });
  }
  return { code, message };
}
export function attendanceWorkersSnapshot() { return structuredClone([...health.values()]); }
export async function trackAttendanceWorker<T>(name: AttendanceWorkerName, run: () => Promise<T>): Promise<T> {
  if (!attendanceAccuracyFixesEnabled()) return run();
  const item = health.get(name)!;
  item.startedAt = new Date().toISOString(); item.running = true; item.counters = empty();
  try { return await run(); }
  catch (error) { item.counters.failed++; attendanceWorkerFailure(name, "cycle", error); throw error; }
  finally { item.lastRunAt = new Date().toISOString(); item.running = false; }
}
