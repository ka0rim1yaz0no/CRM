import { isDeepStrictEqual } from "node:util";
import type { AttendanceDerivedDay } from "./attendanceDerived";

export type AttendanceDerivedMetadata = Pick<AttendanceDerivedDay, "dayKey" | "computedAt" | "revision" | "policyRevision">;
export type AttendanceDerivedAuditDelta = {
  derivedAuditVersion: 1; beforeDerived: AttendanceDerivedDay[]; afterDerived: AttendanceDerivedDay[];
  removedDerivedDays: string[]; derivedMetadata?: AttendanceDerivedMetadata[];
};
type Audit = Partial<AttendanceDerivedAuditDelta> & { afterRevision: number };
export type AttendanceDerivedBaseline = { revision: number; days: AttendanceDerivedDay[] };

function values(day: AttendanceDerivedDay) {
  const rest = Object.fromEntries(Object.entries(day).filter(([key]) => !["computedAt", "revision", "policyRevision"].includes(key)));
  return JSON.parse(JSON.stringify(rest)) as unknown;
}

export function sameAttendanceDerivedValues(left: AttendanceDerivedDay, right: AttendanceDerivedDay) {
  return isDeepStrictEqual(values(left), values(right));
}

export function attendanceDerivedAuditDelta(before: AttendanceDerivedDay[], after: AttendanceDerivedDay[]): AttendanceDerivedAuditDelta {
  const previous = new Map(before.map((day) => [day.dayKey, day]));
  const current = new Map(after.map((day) => [day.dayKey, day]));
  const changed = new Set([...previous.keys(), ...current.keys()].filter((key) => {
    const left = previous.get(key); const right = current.get(key);
    return !left || !right || !sameAttendanceDerivedValues(left, right);
  }));
  return { derivedAuditVersion: 1, beforeDerived: before.filter((day) => changed.has(day.dayKey)),
    afterDerived: after.filter((day) => changed.has(day.dayKey)), removedDerivedDays: before.filter((day) => !current.has(day.dayKey)).map((day) => day.dayKey) };
}

export function replayAttendanceDerived(ledger: { derivedBaseline?: AttendanceDerivedBaseline; audit: Audit[] }, revision: number) {
  const baseline = ledger.derivedBaseline && ledger.derivedBaseline.revision <= revision ? ledger.derivedBaseline : undefined;
  let days = baseline ? new Map(baseline.days.map((day) => [day.dayKey, day])) : undefined;
  for (const audit of [...ledger.audit].sort((a, b) => a.afterRevision - b.afterRevision)) {
    if (audit.afterRevision > revision || (baseline && audit.afterRevision <= baseline.revision)) continue;
    if (audit.derivedAuditVersion !== 1) {
      // Existing full-snapshot audits remain immutable and readable.
      if (audit.afterDerived !== undefined) days = new Map(audit.afterDerived.map((day) => [day.dayKey, day]));
      continue;
    }
    days ??= new Map();
    for (const key of audit.removedDerivedDays || []) days.delete(key);
    for (const day of audit.afterDerived || []) days.set(day.dayKey, day);
    for (const metadata of audit.derivedMetadata || []) {
      const day = days.get(metadata.dayKey);
      if (day) days.set(metadata.dayKey, { ...day, ...metadata });
    }
  }
  return days && [...days.values()].sort((a, b) => a.dayKey.localeCompare(b.dayKey));
}
