import { getConfiguredBusinesses, runWithBusiness } from "../config/tenancy";
import { Attendance, type AttendanceSource, type AttendanceStatus } from "../models/Attendance";
import { Employee } from "../models/Employee";

type AttendanceSnapshot = {
  timeIn: Date;
  source: AttendanceSource;
  attendanceStatus: AttendanceStatus;
  isArchived: boolean;
};

function attendanceRecordKey(record: Pick<AttendanceSnapshot, "timeIn" | "source">) {
  return `${new Date(record.timeIn).toISOString()}|${record.source}`;
}

export function mergeAttendanceSnapshots(recordGroups: AttendanceSnapshot[][]) {
  const recordsByKey = new Map<string, AttendanceSnapshot>();

  recordGroups.flat().forEach((record) => {
    if (record.isArchived) return;
    recordsByKey.set(attendanceRecordKey(record), {
      ...record,
      timeIn: new Date(record.timeIn),
      isArchived: false,
    });
  });

  return Array.from(recordsByKey.values()).sort(
    (left, right) => left.timeIn.getTime() - right.timeIn.getTime()
  );
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

    return result.upsertedCount;
  });
}

async function mergedAttendanceHistory(employeeCode: string, preferredBusinessIds: string[] = []) {
  const businessIds = Array.from(new Set([
    ...preferredBusinessIds,
    ...getConfiguredBusinesses().map((business) => business.id),
  ].filter(Boolean)));
  const histories = await Promise.all(
    businessIds.map((businessId) => readAttendanceHistory(employeeCode, businessId))
  );

  return mergeAttendanceSnapshots(histories);
}

export async function syncEmployeeAttendanceAcrossBusinesses(employeeCode: string) {
  const normalizedEmployeeCode = String(employeeCode || "").trim();
  if (!normalizedEmployeeCode) return 0;

  const mergedHistory = await mergedAttendanceHistory(normalizedEmployeeCode);
  const copiedCounts = await Promise.all(
    getConfiguredBusinesses().map((business) =>
      writeAttendanceHistory(normalizedEmployeeCode, business.id, mergedHistory)
    )
  );

  return copiedCounts.reduce((total, count) => total + count, 0);
}

export async function updateAttendanceAcrossBusinesses(
  employeeCode: string,
  previous: Pick<AttendanceSnapshot, "timeIn" | "source">,
  updated: AttendanceSnapshot,
) {
  const normalizedEmployeeCode = String(employeeCode || "").trim();
  if (!normalizedEmployeeCode) return [] as Array<{ businessId: string; employeeId: string }>;

  const affected: Array<{ businessId: string; employeeId: string }> = [];
  for (const business of getConfiguredBusinesses()) {
    await runWithBusiness(business.id, async () => {
      const employee = await Employee.findOne({
        employeeCode: normalizedEmployeeCode,
        status: { $ne: "Archived" },
      }).select("_id").lean();
      if (!employee) return;

      const matchingRecord = await Attendance.findOne({
        employee: employee._id,
        timeIn: previous.timeIn,
        source: previous.source,
        isArchived: { $ne: true },
      });

      if (matchingRecord) {
        matchingRecord.timeIn = updated.timeIn;
        matchingRecord.source = updated.source;
        matchingRecord.attendanceStatus = updated.attendanceStatus;
        matchingRecord.isArchived = false;
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
              timeIn: updated.timeIn,
              source: updated.source,
              attendanceStatus: updated.attendanceStatus,
              isArchived: false,
            },
          },
          { upsert: true }
        );
      }

      affected.push({ businessId: business.id, employeeId: String(employee._id) });
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
