import crypto from "node:crypto";
import { assignAttendanceShift } from "./attendanceShift";
import { projectAttendance, type SessionEvent } from "./attendanceSessionState";
import type { AttendanceSource } from "../models/Attendance";

export type LegacyAttendanceRow = { id: string; source: string; at: string; createdAt: string;
  eventId?: string; archived: boolean; reversed: boolean };
export type LegacyAttendanceReplica = { businessId: string; employeeId: string | null; records: LegacyAttendanceRow[] };
export type LegacyAdoptionPolicy = { shiftStart: string; shiftEnd: string; recoveryTime: string };
const sources = new Set(["Login", "Logout", "Time In", "Time Out", "Break Out", "Break In", "Lunch Break Out", "Lunch Break In", "Off the Phone Out", "Off the Phone In"]);
const digest = (value: unknown) => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");

export function prepareLegacyAttendanceAdoption(identityKey: string, replicas: LegacyAttendanceReplica[], policy: LegacyAdoptionPolicy) {
  const input = replicas.map((replica) => ({ ...replica, records: [...replica.records].sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id)) }));
  const fingerprint = digest({ identityKey, replicas: input, policy });
  const problems: string[] = [];
  const grouped = new Map<string, Array<LegacyAttendanceRow & { businessId: string }>>();
  for (const replica of input) {
    if (!replica.employeeId) problems.push("MISSING_EMPLOYEE_REPLICA");
    for (const row of replica.records.filter((record) => !record.archived && !record.reversed)) {
      if (!sources.has(row.source) || !Number.isFinite(Date.parse(row.at)) || !Number.isFinite(Date.parse(row.createdAt))) {
        problems.push("INVALID_SOURCE_OR_TIME"); continue;
      }
      const key = JSON.stringify([row.source, new Date(row.at).toISOString()]);
      const matches = grouped.get(key) || [];
      matches.push({ ...row, businessId: replica.businessId }); grouped.set(key, matches);
    }
  }
  const duplicates: Array<{ businessId: string; recordId: string; primaryRecordId: string; eventId: string }> = [];
  const events = [...grouped].map(([key, records]): SessionEvent => {
    const first = records[0];
    const eventId = `legacy:${digest([identityKey, key])}`;
    const origins = new Map<string, { businessId: string; recordId: string }>();
    for (const record of records) {
      const primary = origins.get(record.businessId);
      if (primary) duplicates.push({ businessId: record.businessId, recordId: record.id, primaryRecordId: primary.recordId, eventId });
      else origins.set(record.businessId, { businessId: record.businessId, recordId: record.id });
    }
    return { id: eventId, source: first.source as AttendanceSource, at: new Date(first.at).toISOString(), sequence: 0,
      commandId: `legacy-adoption:${eventId}`, recordedAt: first.createdAt, origin: { businessId: first.businessId, recordId: first.id },
      replicaOrigins: [...origins.values()],
      ...(["Login", "Time In"].includes(first.source) ? { sessionId: eventId,
        shift: assignAttendanceShift(new Date(first.at), policy.shiftStart, policy.shiftEnd, policy.recoveryTime) } : {}) };
  }).sort((a, b) => a.at.localeCompare(b.at) ||
    // An explicitly recorded off-phone return precedes checkout at the same instant.
    (a.source === "Off the Phone In" && ["Logout", "Time Out"].includes(b.source) ? -1 :
      b.source === "Off the Phone In" && ["Logout", "Time Out"].includes(a.source) ? 1 : 0) ||
    a.origin!.recordId.localeCompare(b.origin!.recordId)).map((event, sequence) => ({ ...event, sequence }));
  const latestStart = [...events].reverse().find((event) => ["Login", "Time In"].includes(event.source));
  if (events.length && !latestStart) problems.push("MISSING_TIME_IN");
  if (events.some((event) => Date.parse(event.at) > Date.now())) problems.push("FUTURE_EVENT");
  const reviewedEvents = events.map((event) => ({ ...event, legacyReviewed: true,
    ...(event.id === latestStart?.id ? { legacyBoundary: true } : {}) }));
  const projection = projectAttendance(reviewedEvents);
  const businessStreams = input.map((replica) => [...new Set(replica.records.filter((row) => !row.archived && !row.reversed).map((row) => JSON.stringify([row.source, row.at])))].sort());
  return { fingerprint, events: reviewedEvents, duplicates, problems: [...new Set(problems)],
    timelineIssues: projection.issues, openSession: Boolean(projection.active),
    businessStreamsDiffer: new Set(businessStreams.map((stream) => JSON.stringify(stream))).size > 1,
    ready: !problems.length && !projection.blockingIssues.length,
    blockingIssues: projection.blockingIssues,
    sourceCount: input.reduce((sum, replica) => sum + replica.records.length, 0) };
}
