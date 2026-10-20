import { performance } from "node:perf_hooks";
import type { QueryFilter } from "mongoose";
import { AttendanceLedger, type AttendanceLedgerDocument } from "../models/AttendanceLedger";

const cursors = new Map<string, string>();
export function resetAttendanceWorkerCursors() { cursors.clear(); }
export function markAttendanceWorkerCandidate(name: string, id: string) { cursors.set(name, id); }
export function attendanceWorkerBudget(clock = () => performance.now()) {
  const started = clock(); let processed = 0;
  return () => processed++ === 0 || clock() - started < 2000;
}
export async function attendanceWorkerBatch(name: string, filter: QueryFilter<AttendanceLedgerDocument>, fields: string) {
  const after = cursors.get(name);
  const read = (cursor?: string) => AttendanceLedger.find(cursor ? { $and: [filter, { _id: { $gt: cursor } }] } : filter)
    .select(fields).sort({ _id: 1 }).limit(200).maxTimeMS(2000).lean();
  let rows = await read(after);
  if (!rows.length && after) { cursors.delete(name); rows = await read(); }
  if (!rows.length) cursors.delete(name);
  return rows;
}
export function activeAttendanceWorkerFilter(): Record<string, unknown> {
  return { migrationRequired: { $ne: true }, $or: [
    { "maintenance.active": true },
    // Unindexed pre-rollout metadata is never backfilled silently. Bound its read-only compatibility path.
    { maintenance: { $exists: false }, "events.source": { $in: ["Time In", "Login"] },
      $expr: { $not: [{ $in: [{ $arrayElemAt: ["$events.source", -1] }, ["Time Out", "Logout"]] }] } },
  ] };
}
export function attendanceMaintenanceState(projection: { active: unknown }, days: Array<{ hasOpenSession: boolean; computedAt: string; shiftEnd: string; policyRevision?: number; accuracyVersion?: number }> = []) {
  const refreshes = days.filter(day => day.accuracyVersion === 1 && !day.hasOpenSession && day.computedAt < day.shiftEnd).map(day => day.shiftEnd).sort();
  return { active: Boolean(projection.active), ...(refreshes.length ? { derivedRefreshAt: new Date(refreshes[0]) } : {}) };
}
