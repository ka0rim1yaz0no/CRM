import { getConfiguredBusinesses, getCurrentBusinessId, runWithBusiness } from "../config/tenancy";
import { Attendance, type AttendanceSource, type AttendanceStatus } from "../models/Attendance";
import { Employee } from "../models/Employee";
import { getBusinessAccessForEmployeeCode, normalizeBusinessAccessIds } from "../models/BusinessUserAccess";
import { attendanceIntegrityEnabled } from "../config/rolloutFlags";

type AttendanceSnapshot = {
  timeIn: Date;
  source: AttendanceSource;
  attendanceStatus: AttendanceStatus;
  isArchived: boolean;
  eventId?: string;
};

const duplicateWindowMs = 5_000;

export function mergeAttendanceSnapshots(recordGroups: AttendanceSnapshot[][]) {
  const mergedRecords: AttendanceSnapshot[] = [];
  const sortedRecords = recordGroups
    .flat()
    .filter((record) => !record.isArchived)
    .sort((left, right) => left.timeIn.getTime() - right.timeIn.getTime());

  sortedRecords.forEach((record) => {
    const isDuplicate = mergedRecords.some((candidate) =>
      candidate.source === record.source &&
      Math.abs(candidate.timeIn.getTime() - record.timeIn.getTime()) <= duplicateWindowMs
    );
    if (isDuplicate) return;
    mergedRecords.push({
      ...record,
      timeIn: new Date(record.timeIn),
      isArchived: false,
    });
  });

  return mergedRecords;
}

async function readAttendanceHistory(employeeCode: string, businessId: string) {
  return runWithBusiness(businessId, async () => {
    const employee = await Employee.findOne({
      employeeCode,
      status: { $ne: "Archived" },
    }).select("_id").lean();

    if (!employee) return [] as AttendanceSnapshot[];

    return Attendance.find({
      employee: employee._id,
      isArchived: { $ne: true },
    })
      .select("timeIn source attendanceStatus isArchived")
      .sort({ timeIn: 1 })
      .lean() as unknown as AttendanceSnapshot[];
  });
}

async function writeAttendanceHistory(employeeCode: string, businessId: string, records: AttendanceSnapshot[]) {
  if (!records.length) return 0;

  return runWithBusiness(businessId, async () => {
    const employee = await Employee.findOne({
      employeeCode,
      status: { $ne: "Archived" },
    }).select("_id").lean();

    if (!employee) return 0;

    const result = await Attendance.bulkWrite(
      records.map((record) => ({
        updateOne: {
          filter: {
            employee: employee._id,
            timeIn: record.timeIn,
            source: record.source,
          },
          update: {
            $setOnInsert: {
              employee: employee._id,
              timeIn: record.timeIn,
              source: record.source,
              attendanceStatus: record.attendanceStatus || "",
              isArchived: false,
            },
          },
          upsert: true,
        },
      }))
    );

    // A snapshot cannot prove a concurrently written event is a duplicate.
    // Legacy reconciliation only inserts missing evidence and never archives or restores it.
    return result.upsertedCount;
  });
}

async function mergedAttendanceHistory(employeeCode: string, preferredBusinessIds: string[] = []) {
  const businessIds = Array.from(new Set(
    (preferredBusinessIds.length > 0
      ? preferredBusinessIds
      : getConfiguredBusinesses().map((business) => business.id)
    ).filter(Boolean)
  ));
  const histories = await Promise.all(
    businessIds.map((businessId) => readAttendanceHistory(employeeCode, businessId))
  );

  return mergeAttendanceSnapshots(histories);
}

async function assignedBusinessIds(employeeCode: string) {
  const configuredBusinessIds = new Set(getConfiguredBusinesses().map((business) => business.id));
  const controlledBusinessIds = normalizeBusinessAccessIds(
    await getBusinessAccessForEmployeeCode(employeeCode)
  ).filter((businessId) => configuredBusinessIds.has(businessId));

  return controlledBusinessIds.length > 0
    ? controlledBusinessIds
    : [getCurrentBusinessId()];
}

export async function syncEmployeeAttendanceAcrossBusinesses(employeeCode: string) {
  const normalizedEmployeeCode = String(employeeCode || "").trim();
  if (!normalizedEmployeeCode) return 0;
  if (attendanceIntegrityEnabled()) {
    const { refreshAttendanceLedgerMemberships, deliverAttendanceLedger } = await import("./attendanceLedgerOutbox");
    for (const key of await refreshAttendanceLedgerMemberships(normalizedEmployeeCode)) await deliverAttendanceLedger(key);
    return 0;
  }

  const businessIds = await assignedBusinessIds(normalizedEmployeeCode);
  const mergedHistory = await mergedAttendanceHistory(normalizedEmployeeCode, businessIds);
  const copiedCounts = await Promise.all(
    businessIds.map((businessId) =>
      writeAttendanceHistory(normalizedEmployeeCode, businessId, mergedHistory)
    )
  );

  return copiedCounts.reduce((total, count) => total + count, 0);
}

export async function syncEmployeesAttendanceAcrossBusinesses(employeeCodes: string[], concurrency = 4) {
  const pendingCodes = Array.from(new Set(
    employeeCodes.map((employeeCode) => String(employeeCode || "").trim()).filter(Boolean)
  ));
  let copiedCount = 0;

  for (let index = 0; index < pendingCodes.length; index += Math.max(1, concurrency)) {
    const results = await Promise.allSettled(
      pendingCodes.slice(index, index + Math.max(1, concurrency)).map(syncEmployeeAttendanceAcrossBusinesses)
    );
    copiedCount += results.reduce(
      (total, result) => total + (result.status === "fulfilled" ? result.value : 0),
      0
    );
    results.forEach((result, offset) => {
      if (result.status === "rejected") {
        console.error("Attendance reconciliation failed", {
          employeeCode: pendingCodes[index + offset],
          error: result.reason,
        });
      }
    });
  }

  return copiedCount;
}

export async function reconcileAllEmployeeAttendance() {
  const employeeCodes = new Set<string>();
  for (const business of getConfiguredBusinesses()) {
    const businessCodes = await runWithBusiness(business.id, () =>
      Employee.find({ status: { $ne: "Archived" } }).distinct("employeeCode")
    );
    businessCodes.forEach((employeeCode) => {
      const normalizedCode = String(employeeCode || "").trim();
      if (normalizedCode) employeeCodes.add(normalizedCode);
    });
  }

  const repairedRecords = await syncEmployeesAttendanceAcrossBusinesses(Array.from(employeeCodes));
  return { employees: employeeCodes.size, repairedRecords };
}

export async function updateAttendanceAcrossBusinesses(
  employeeCode: string,
  previous: Pick<AttendanceSnapshot, "timeIn" | "source" | "eventId">,
  updated: AttendanceSnapshot,
) {
  const normalizedEmployeeCode = String(employeeCode || "").trim();
  if (!normalizedEmployeeCode) return [] as Array<{ businessId: string; employeeId: string }>;

  const affected: Array<{ businessId: string; employeeId: string }> = [];
  const businessIds = await assignedBusinessIds(normalizedEmployeeCode);
  for (const businessId of businessIds) {
    await runWithBusiness(businessId, async () => {
      const employee = await Employee.findOne({
        employeeCode: normalizedEmployeeCode,
        status: { $ne: "Archived" },
      }).select("_id").lean();
      if (!employee) return;

      const matchingRecord = await Attendance.findOne({
        employee: employee._id,
        ...(previous.eventId ? { eventId: previous.eventId } : { timeIn: previous.timeIn, source: previous.source }),
      });

      if (matchingRecord) {
        matchingRecord.timeIn = updated.timeIn;
        matchingRecord.source = updated.source;
        matchingRecord.attendanceStatus = updated.attendanceStatus;
        matchingRecord.isArchived = updated.isArchived;
        await matchingRecord.save();
      } else {
        await Attendance.updateOne(
          {
            employee: employee._id,
            timeIn: updated.timeIn,
            source: updated.source,
          },
          {
            $setOnInsert: {
              employee: employee._id,
              ...(previous.eventId ? { eventId: previous.eventId } : {}),
              timeIn: updated.timeIn,
              source: updated.source,
              attendanceStatus: updated.attendanceStatus,
              isArchived: updated.isArchived,
            },
          },
          { upsert: true }
        );
      }

      affected.push({ businessId, employeeId: String(employee._id) });
    });
  }

  return affected;
}

export async function syncActiveAttendanceForBusinessSwitch(
  employeeCode: string,
  sourceBusinessId: string,
  targetBusinessId: string
) {
  const normalizedEmployeeCode = String(employeeCode || "").trim();
  const normalizedSourceBusinessId = String(sourceBusinessId || "").trim();
  const normalizedTargetBusinessId = String(targetBusinessId || "").trim();

  if (!normalizedEmployeeCode || !normalizedSourceBusinessId || !normalizedTargetBusinessId ||
    normalizedSourceBusinessId === normalizedTargetBusinessId) {
    return 0;
  }

  const mergedHistory = await mergedAttendanceHistory(normalizedEmployeeCode, [
    normalizedSourceBusinessId,
    normalizedTargetBusinessId,
  ]);

  return writeAttendanceHistory(normalizedEmployeeCode, normalizedTargetBusinessId, mergedHistory);
}
