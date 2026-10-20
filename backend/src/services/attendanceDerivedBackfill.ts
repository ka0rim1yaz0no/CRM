import { isDeepStrictEqual } from "node:util";
import { deriveAttendanceDays, type AttendanceDerivedDay, type AttendanceDerivedLedger, type AttendanceDerivedPolicy } from "./attendanceDerived";
import { assignAttendanceShift } from "./attendanceShift";
import type { SessionEvent } from "./attendanceSessionState";

export type AttendanceBackfillRecord = {
  id: string; eventId?: string; source: SessionEvent["source"]; timeIn: Date; derived?: AttendanceDerivedDay;
};
export type AttendanceBackfillEmployee = {
  employeeCode?: string;
  records: AttendanceBackfillRecord[]; ledger?: AttendanceDerivedLedger & { derived?: AttendanceDerivedDay[] };
};
const minuteFields = ["lateMinutes", "excessBreakMinutes", "excessLunchMinutes", "earlyTimeOutMinutes", "deductibleMinutes"] as const;
const comparisonFields = [...minuteFields, "status", "hasOpenSession", "breakSessions", "lunchSessions", "issues", "shiftStart", "shiftEnd", "eventIds", "sessionIds"] as const;
const totals = () => Object.fromEntries(minuteFields.map((field) => [field, 0])) as Record<typeof minuteFields[number], number>;
const comparable = (value: unknown): unknown => JSON.parse(JSON.stringify(value ?? null));

export function attendanceDerivedBackfillWindow(now: Date) {
  if (!Number.isFinite(now.getTime())) throw new Error("A valid dry-run time is required.");
  const end = new Date(now.getTime() + 8 * 3_600_000).toISOString().slice(0, 10);
  const from = new Date(`${end}T00:00:00+08:00`);
  from.setUTCDate(from.getUTCDate() - 59);
  return { fromDay: new Date(from.getTime() + 8 * 3_600_000).toISOString().slice(0, 10), throughDay: end,
    contextStart: new Date(from.getTime() - 86_400_000) };
}

export function summarizeAttendanceDerivedBackfill(businessId: string, employees: AttendanceBackfillEmployee[], policy: AttendanceDerivedPolicy, now: Date,
  options: { accuracyReport?: boolean } = {}) {
  const window = attendanceDerivedBackfillWindow(now);
  const report = { businessId, dryRun: true as const, writes: 0, fromDay: window.fromDay, throughDay: window.throughDay,
    employeesChecked: 0, daysChecked: 0, recordsChecked: 0, differingDays: 0, differingRecords: 0, missingDerivedRecords: 0,
    canonicalDaysDiffering: 0, legacyEmployeesRequiringReview: 0, daysRequiringReview: 0, unmatchedRecords: 0,
    before: totals(), after: totals(), fieldDiffCounts: Object.fromEntries(comparisonFields.map((field) => [field, 0])) };
  const accuracy = { changedStoredRecords: 0, minutesDifference: 0, unverifiableRecords: 0, unverifiableDays: 0,
    topEmployees: [] as Array<{ employeeCode: string; changedStoredRecords: number; minutesDifference: number }> };
  for (const employee of employees) {
    const affected = { employeeCode: employee.employeeCode || "unidentified", changedStoredRecords: 0, minutesDifference: 0 };
    const records = [...employee.records].sort((a, b) => a.timeIn.getTime() - b.timeIn.getTime() || a.id.localeCompare(b.id));
    const ledger = employee.ledger || { events: records.map((record, sequence): SessionEvent => ({
      id: record.eventId || `dry-run:${record.id}`, source: record.source, at: record.timeIn.toISOString(), sequence,
      commandId: `dry-run:${record.id}`, recordedAt: record.timeIn.toISOString(), legacyReviewed: true,
      ...(["Time In", "Login"].includes(record.source) ? { shift: assignAttendanceShift(record.timeIn, policy.shiftStart, policy.shiftEnd, policy.recoveryTime) } : {}),
    })) };
    const allDays = deriveAttendanceDays(ledger, policy, now);
    const days = allDays.filter((day) => day.dayKey >= window.fromDay && day.dayKey <= window.throughDay);
    if (!days.length && !records.length) continue;
    report.employeesChecked++;
    if (!employee.ledger) report.legacyEmployeesRequiringReview++;
    const matched = new Set<string>();
    for (const day of days) {
      report.daysChecked++;
      if (day.issues.includes("TIMELINE REVIEW") || day.issues.includes("SYSTEM CLOSED")) report.daysRequiringReview++;
      const ids = new Set(day.eventIds);
      const origins = new Set(ledger.events.filter((event) => ids.has(event.id)).flatMap((event) => [
        ...(event.origin?.businessId === businessId ? [event.origin.recordId] : []),
        ...(event.replicaOrigins?.filter((origin) => origin.businessId === businessId).map((origin) => origin.recordId) || []),
      ]));
      const copies = records.filter((record) => ids.has(record.eventId || `dry-run:${record.id}`) || origins.has(record.id));
      const before = copies.find((record) => record.derived)?.derived;
      if (options.accuracyReport) {
        const stored = before || employee.ledger?.derived?.find(item => item.dayKey === day.dayKey);
        if (stored) affected.minutesDifference += day.deductibleMinutes - stored.deductibleMinutes;
        else accuracy.unverifiableDays++;
        for (const record of copies) {
          if (!record.derived) accuracy.unverifiableRecords++;
          else if (record.derived.deductibleMinutes !== day.deductibleMinutes) affected.changedStoredRecords++;
        }
      }
      for (const field of minuteFields) { report.before[field] += before?.[field] || 0; report.after[field] += day[field]; }
      let dayDiffers = false;
      for (const field of comparisonFields) {
        if (!isDeepStrictEqual(comparable(before?.[field]), comparable(day[field]))) { report.fieldDiffCounts[field]++; dayDiffers = true; }
      }
      if (dayDiffers) report.differingDays++;
      const canonicalBefore = employee.ledger?.derived?.find((item) => item.dayKey === day.dayKey);
      if (employee.ledger && comparisonFields.some((field) => !isDeepStrictEqual(comparable(canonicalBefore?.[field]), comparable(day[field])))) {
        report.canonicalDaysDiffering++;
      }
      for (const record of copies) {
        matched.add(record.id); report.recordsChecked++;
        if (!record.derived) report.missingDerivedRecords++;
        if (comparisonFields.some((field) => !isDeepStrictEqual(comparable(record.derived?.[field]), comparable(day[field])))) report.differingRecords++;
      }
    }
    const outsideWindowIds = new Set(allDays.filter((day) => day.dayKey < window.fromDay || day.dayKey > window.throughDay).flatMap((day) => day.eventIds));
    report.unmatchedRecords += records.filter((record) => {
      if (matched.has(record.id) || outsideWindowIds.has(record.eventId || `dry-run:${record.id}`) || record.timeIn > now) return false;
      return assignAttendanceShift(record.timeIn, policy.shiftStart, policy.shiftEnd, policy.recoveryTime).dayKey >= window.fromDay;
    }).length;
    accuracy.changedStoredRecords += affected.changedStoredRecords; accuracy.minutesDifference += affected.minutesDifference;
    if (affected.changedStoredRecords || affected.minutesDifference) accuracy.topEmployees.push(affected);
  }
  accuracy.topEmployees.sort((a, b) => Math.abs(b.minutesDifference) - Math.abs(a.minutesDifference) || b.changedStoredRecords - a.changedStoredRecords || a.employeeCode.localeCompare(b.employeeCode));
  accuracy.topEmployees = accuracy.topEmployees.slice(0, 20);
  return { ...report, ...(options.accuracyReport ? { accuracy } : {}) };
}
