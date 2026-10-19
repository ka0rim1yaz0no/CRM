import { Employee } from "../models/Employee";
import { Attendance } from "../models/Attendance";
import { runWithBusiness } from "../config/tenancy";
import { assignAttendanceShift } from "./attendanceShift";
import { attendancePolicy, type AttendanceIdentity } from "./attendanceLedgerService";
import { projectAttendance, type SessionEvent } from "./attendanceSessionState";

// Dry run only. This deliberately has no write/adopt mode.
export async function previewLegacyAttendanceMigration(identity: AttendanceIdentity) {
  const policy = await attendancePolicy(identity.canonicalBusinessId);
  const businesses = [];
  for (const businessId of identity.businessIds) businesses.push(await runWithBusiness(businessId, async () => {
    const employee = await Employee.findOne({ employeeCode: identity.code }).select("_id").lean();
    if (!employee) return { businessId, missingEmployee: true, events: [], sessions: [], issues: ["Employee replica missing"], duplicateKeys: [] };
    const records = await Attendance.collection.find({ employee: employee._id }).sort({ timeIn: 1, _id: 1 }).toArray();
    const keys = records.map((record) => `${record.source}:${new Date(record.timeIn).toISOString()}`);
    const duplicateKeys = keys.filter((key, index) => keys.indexOf(key) !== index);
    const events: SessionEvent[] = records.filter((record) => !record.isArchived && record.isEffective !== false).map((record, sequence) => ({
      id: String(record._id), source: record.source, at: new Date(record.timeIn).toISOString(), sequence, commandId: `legacy:${record._id}`, recordedAt: new Date(record.createdAt || record.timeIn).toISOString(),
      ...(["Login", "Time In"].includes(record.source) ? { shift: assignAttendanceShift(new Date(record.timeIn), policy.shiftStart, policy.shiftEnd, policy.recoveryTime) } : {}),
    }));
    const projection = projectAttendance(events);
    return { businessId, missingEmployee: false, events: records.map((record) => ({ id: String(record._id), eventId: record.eventId || null, source: record.source,
      at: new Date(record.timeIn).toISOString(), archived: Boolean(record.isArchived), reversed: record.isEffective === false })),
      sessions: projection.sessions.map((session) => ({ id: session.id, assignedShift: session.shift, lifecycle: session.lifecycle,
        missingCheckout: !session.endedAt, ambiguousEarlyCheckIn: Boolean(session.shift && Date.parse(session.startedAt) < Date.parse(session.shift.start) - 2 * 3_600_000) })),
      issues: projection.issues.map((issue) => issue.message), duplicateKeys };
  }));
  const signatures = businesses.map((business) => JSON.stringify(business.events.map((event) => [event.source, event.at, event.archived, event.reversed])));
  return { dryRun: true, writes: 0, employeeCode: identity.code, identityKey: identity.key, businesses,
    crossBusinessMismatch: new Set(signatures).size > 1, requiresBackupAndReviewedAdoption: businesses.some((business) => business.events.length > 0),
    proposedIndexes: ["Attendance(employee,isArchived,timeIn)", "Attendance(employee,eventId) unique where eventId is string", "AttendanceLedger(_id) unique", "AttendanceLedger(employeeCode,businessIds)"],
    automaticAdoption: false };
}
