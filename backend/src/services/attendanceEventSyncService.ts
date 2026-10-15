import crypto from "node:crypto";
import { getConfiguredBusinesses, getCurrentBusinessId, runForEachBusiness, runWithBusiness } from "../config/tenancy";
import { Attendance, type AttendanceSource, type AttendanceStatus } from "../models/Attendance";
import { AttendanceSyncOutbox } from "../models/AttendanceSyncOutbox";
import { Employee } from "../models/Employee";

type EventInput = {
  employeeCode: string;
  eventId?: string;
  source: AttendanceSource;
  timeIn: Date;
  attendanceStatus: AttendanceStatus;
  isArchived?: boolean;
};
type ResolvedEvent = EventInput & { eventId: string };

export function normalizedEventId(value: unknown) {
  const id = String(value || "").trim();
  if (!id) return crypto.randomUUID();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) {
    throw new Error("Invalid attendance event ID");
  }
  return id;
}

async function memberBusinessIds(employeeCode: string) {
  const ids: string[] = [];
  await runForEachBusiness(async (business) => {
    if (await Employee.exists({ employeeCode, status: { $ne: "Archived" } })) ids.push(business.id);
  });
  return ids;
}

async function writeToBusiness(businessId: string, input: ResolvedEvent, updateExisting = false) {
  return runWithBusiness(businessId, async () => {
    const employee = await Employee.findOne({ employeeCode: input.employeeCode, status: { $ne: "Archived" } }).select("_id").lean();
    if (!employee) throw new Error("Attendance employee membership changed during sync");
    try {
      const fields = { source: input.source, timeIn: input.timeIn,
        attendanceStatus: input.attendanceStatus, isArchived: Boolean(input.isArchived) };
      await Attendance.updateOne(
        { employee: employee._id, eventId: input.eventId },
        updateExisting
          ? { $set: fields, $setOnInsert: { employee: employee._id, eventId: input.eventId } }
          : { $setOnInsert: { employee: employee._id, eventId: input.eventId, ...fields } },
        { upsert: true }
      );
    } catch (error) {
      if ((error as { code?: number })?.code !== 11000) throw error;
    }
    const record = await Attendance.findOne({ employee: employee._id, eventId: input.eventId });
    if (!record || (!updateExisting && record.source !== input.source)) {
      throw new Error("Attendance event ID was reused for a different action");
    }
    return record;
  });
}

export async function deliverAttendanceEvent<T>(primaryBusinessId: string, secondaryBusinessIds: string[],
  writePrimary: (businessId: string) => Promise<T>,
  writeSecondary: (businessId: string, primary: T) => Promise<unknown>) {
  const primary = await writePrimary(primaryBusinessId);
  const results = await Promise.allSettled(secondaryBusinessIds.map((id) => writeSecondary(id, primary)));
  return { primary, pendingBusinessIds: secondaryBusinessIds.filter((_, index) => results[index].status === "rejected") };
}

export async function recordAttendanceEvent(input: EventInput) {
  const event: ResolvedEvent = { ...input, eventId: normalizedEventId(input.eventId) };
  const primaryBusinessId = getCurrentBusinessId();
  const membership = await memberBusinessIds(event.employeeCode);
  if (!membership.includes(primaryBusinessId)) throw new Error("Employee is not in the selected business");
  const secondaries = membership.filter((id) => id !== primaryBusinessId);
  const canonicalFromPrimary = (primary: Awaited<ReturnType<typeof writeToBusiness>>): ResolvedEvent => ({
    employeeCode: event.employeeCode, eventId: event.eventId, source: primary.source,
    timeIn: primary.timeIn, attendanceStatus: primary.attendanceStatus, isArchived: primary.isArchived,
  });
  const { primary, pendingBusinessIds } = await deliverAttendanceEvent(primaryBusinessId, secondaries,
    (id) => writeToBusiness(id, event),
    (id, primaryRecord) => writeToBusiness(id, canonicalFromPrimary(primaryRecord), true));
  const canonical = canonicalFromPrimary(primary);
  primary.syncPending = pendingBusinessIds.length > 0;
  await primary.save();
  if (pendingBusinessIds.length) {
    await AttendanceSyncOutbox.updateOne({ employeeCode: event.employeeCode, eventId: event.eventId },
      { $set: { ...canonical, pendingBusinessIds, lastErrorAt: new Date() }, $inc: { attempts: 1 } }, { upsert: true });
  }
  else {
    await AttendanceSyncOutbox.updateOne({ employeeCode: event.employeeCode, eventId: event.eventId },
      { $set: { pendingBusinessIds: [] } });
  }
  return primary;
}

export async function retryAttendanceSyncOutbox(limit = 100) {
  let retried = 0;
  for (const business of getConfiguredBusinesses()) {
    try {
      await runWithBusiness(business.id, async () => {
        const pending = await AttendanceSyncOutbox.find({ pendingBusinessIds: { $ne: [] } })
          .sort({ lastErrorAt: 1, updatedAt: 1 }).limit(limit).lean();
        for (const item of pending) {
          const employee = await Employee.findOne({ employeeCode: item.employeeCode }).select("_id").lean();
          const primary = employee ? await Attendance.findOne({ employee: employee._id, eventId: item.eventId }).lean() : null;
          if (!primary) continue;
          const event: ResolvedEvent = { employeeCode: item.employeeCode, eventId: item.eventId,
            source: primary.source, timeIn: primary.timeIn, attendanceStatus: primary.attendanceStatus,
            isArchived: primary.isArchived };
          const results = await Promise.allSettled(item.pendingBusinessIds.map((id) => writeToBusiness(id, event, true)));
          const remaining = item.pendingBusinessIds.filter((_, index) => results[index].status === "rejected");
          await AttendanceSyncOutbox.updateOne({ _id: item._id },
            { $set: { pendingBusinessIds: remaining, lastErrorAt: remaining.length ? new Date() : item.lastErrorAt }, $inc: { attempts: 1 } });
          if (!remaining.length) {
            if (employee) await Attendance.updateOne({ employee: employee._id, eventId: item.eventId }, { $set: { syncPending: false } });
          }
          retried += 1;
        }
      });
    } catch (error) {
      console.error(`Attendance retry failed for business ${business.id}`, error);
    }
  }
  return retried;
}

export async function syncRecentAttendanceEventsForBusinessSwitch(employeeCode: string, sourceBusinessId: string) {
  return runWithBusiness(sourceBusinessId, async () => {
    const employee = await Employee.findOne({ employeeCode, status: { $ne: "Archived" } }).select("_id").lean();
    if (!employee) return 0;
    const since = new Date(Date.now() - 48 * 60 * 60_000);
    const events = await Attendance.find({ employee: employee._id,
      eventId: { $type: "string" }, timeIn: { $gte: since } }).sort({ timeIn: 1 }).lean();
    for (const event of events) {
      await recordAttendanceEvent({ employeeCode, eventId: event.eventId, source: event.source,
        timeIn: event.timeIn, attendanceStatus: event.attendanceStatus, isArchived: event.isArchived });
    }
    return events.length;
  });
}
