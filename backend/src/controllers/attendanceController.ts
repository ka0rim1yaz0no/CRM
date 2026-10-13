import type { Request, Response } from "express";
import { Types } from "mongoose";
import { Attendance, type AttendanceSource, type AttendanceStatus } from "../models/Attendance";
import { getConfiguredBusinesses, runWithBusiness } from "../config/tenancy";
import { syncEmployeeAttendanceAcrossBusinesses, syncEmployeesAttendanceAcrossBusinesses, updateAttendanceAcrossBusinesses } from "../services/employeeAttendanceSyncService";
import { syncEmployeeAvailabilityAcrossBusinesses } from "../services/employeeAvailabilityService";
import { Employee, normalizeEmployeeAvailabilityStatus } from "../models/Employee";
import { recordEmployeeTransaction } from "./employeeTransactionController";
import { recalculateEmployeePayrollAfterAttendanceEdit } from "./payrollController";
import { emitCallDashboardUpdated, emitEmployeeAvailabilityUpdated } from "../socket";
import { getSystemSettings } from "./systemSettingsController";

const activityTrackedStatuses = new Set(["ONLINE", "OFF THE PHONE"]);
const attendanceSources: AttendanceSource[] = [
  "Login",
  "Logout",
  "Time In",
  "Time Out",
  "Break Out",
  "Break In",
  "Lunch Break Out",
  "Lunch Break In",
  "Off the Phone Out",
  "Off the Phone In",
];
const timeInSources: AttendanceSource[] = ["Login", "Time In"];
const timeOutSources: AttendanceSource[] = ["Logout", "Time Out"];
const breakOutGapMs = 30 * 60 * 1000;

export function workedMinutesToTimeOut(timeIn: Date, workedMinutes: number, lunchMinutes: number) {
  return new Date(timeIn.getTime() + (workedMinutes + lunchMinutes) * 60_000);
}

export function isTimeInLate(timeIn: Date, allowedStart: Date) {
  return timeIn.getTime() >= allowedStart.getTime() + 60_000;
}

function minutesFromTime(value = "23:00") {
  const [hours, minutes] = value.split(":").map((part) => Number(part));
  return hours * 60 + minutes;
}

function zonedParts(value: Date, timeZone = "Asia/Manila") {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(value);
  const part = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((item) => item.type === type)?.value || 0);
  return {
    year: part("year"),
    month: part("month"),
    day: part("day"),
    hour: part("hour"),
    minute: part("minute"),
  };
}

function zonedDateTimeToUtc(year: number, month: number, day: number, hour: number, minute: number, timeZone = "Asia/Manila") {
  let utcTime = Date.UTC(year, month - 1, day, hour, minute);

  for (let index = 0; index < 2; index += 1) {
    const actual = zonedParts(new Date(utcTime), timeZone);
    const desiredTime = Date.UTC(year, month - 1, day, hour, minute);
    const actualTime = Date.UTC(actual.year, actual.month - 1, actual.day, actual.hour, actual.minute);
    utcTime += desiredTime - actualTime;
  }

  return new Date(utcTime);
}

function attendanceSlotKey(value: Date, timeZone: string, shiftStart: string, shiftEnd: string) {
  const parts = zonedParts(value, timeZone);
  const shiftStartMinutes = minutesFromTime(shiftStart);
  const shiftEndMinutes = minutesFromTime(shiftEnd);
  const actualMinutes = parts.hour * 60 + parts.minute;
  const slotDate = new Date(Date.UTC(parts.year, parts.month - 1, parts.day));

  if (shiftEndMinutes <= shiftStartMinutes && actualMinutes <= shiftEndMinutes) {
    slotDate.setUTCDate(slotDate.getUTCDate() - 1);
  }

  return slotDate.toISOString().slice(0, 10);
}

async function getTimeInStatus(timeIn: Date) {
  const settings = await getSystemSettings();
  const timeZone = settings.attendanceTimeZone || "Asia/Manila";
  const actual = zonedParts(timeIn, timeZone);
  const officialShiftStartTime = settings.officialShiftStartTime || "23:00";
  const officialShiftEndTime = settings.officialShiftEndTime || "08:00";
  const startMinutes = minutesFromTime(officialShiftStartTime);
  const endMinutes = minutesFromTime(officialShiftEndTime);
  const actualMinutes = actual.hour * 60 + actual.minute;
  const isOvernightShift = endMinutes <= startMinutes;
  const shiftStartDay = { year: actual.year, month: actual.month, day: actual.day };

  if (isOvernightShift && actualMinutes < endMinutes) {
    shiftStartDay.day -= 1;
  }

  const [startHour, startMinute] = officialShiftStartTime.split(":").map((part) => Number(part));
  const allowedStart = zonedDateTimeToUtc(shiftStartDay.year, shiftStartDay.month, shiftStartDay.day, startHour, startMinute + (settings.lateGraceMinutes || 0), timeZone);
  return isTimeInLate(timeIn, allowedStart) ? "Late" : "On time";
}

async function getTimeOutStatus(timeOut: Date): Promise<AttendanceStatus> {
  const settings = await getSystemSettings();
  const timeZone = settings.attendanceTimeZone || "Asia/Manila";
  const actual = zonedParts(timeOut, timeZone);
  const startMinutes = minutesFromTime(settings.officialShiftStartTime || "23:00");
  const endMinutes = minutesFromTime(settings.officialShiftEndTime || "08:00");
  const actualMinutes = actual.hour * 60 + actual.minute;
  const isOvernightShift = endMinutes <= startMinutes;
  const isUnderTime = isOvernightShift
    ? actualMinutes >= startMinutes || actualMinutes < endMinutes
    : actualMinutes < endMinutes;

  return isUnderTime ? "Undertime" : "";
}

async function getAttendanceStatus(source: AttendanceSource, occurredAt: Date): Promise<AttendanceStatus> {
  if (timeInSources.includes(source)) return getTimeInStatus(occurredAt);
  if (timeOutSources.includes(source)) return getTimeOutStatus(occurredAt);
  return "";
}

async function getTodayAttendanceRange() {
  const settings = await getSystemSettings();
  const timeZone = settings.attendanceTimeZone || "Asia/Manila";
  const now = new Date();
  const today = zonedParts(now, timeZone);
  const start = zonedDateTimeToUtc(today.year, today.month, today.day, 0, 0, timeZone);
  const end = zonedDateTimeToUtc(today.year, today.month, today.day + 1, 0, 0, timeZone);

  return {
    start,
    end,
  };
}

async function getTodayAttendance(employeeId: Types.ObjectId | string) {
  const { start, end } = await getTodayAttendanceRange();
  return Attendance.find({
    employee: employeeId,
    timeIn: { $gte: start, $lt: end },
  }).sort({ timeIn: 1 });
}

async function getActiveAttendanceSlot(employeeId: Types.ObjectId | string, includePreviousShift = false) {
  const timeIn = await Attendance.findOne({
    employee: employeeId,
    isArchived: false,
    source: { $in: timeInSources },
  }).sort({ timeIn: -1 });

  if (!timeIn) return { timeIn: null, timeOut: null, records: [] as Awaited<ReturnType<typeof Attendance.find>>, recoveryTimeOut: null as Date | null };

  const settings = await getSystemSettings();
  const timeZone = settings.attendanceTimeZone || "Asia/Manila";
  const shiftStart = settings.officialShiftStartTime || "23:00";
  const shiftEnd = settings.officialShiftEndTime || "08:00";
  const activeSlotKey = attendanceSlotKey(timeIn.timeIn, timeZone, shiftStart, shiftEnd);
  const currentSlotKey = attendanceSlotKey(new Date(), timeZone, shiftStart, shiftEnd);

  // An unclosed prior shift must not block time-in, breaks, or lunch on a new shift.
  if (activeSlotKey !== currentSlotKey && !includePreviousShift) {
    return { timeIn: null, timeOut: null, records: [] as Awaited<ReturnType<typeof Attendance.find>>, recoveryTimeOut: null as Date | null };
  }

  const timeOut = await Attendance.findOne({
    employee: employeeId,
    isArchived: false,
    source: { $in: timeOutSources },
    timeIn: { $gte: timeIn.timeIn },
  }).sort({ timeIn: -1 });

  const records = await Attendance.find({
    employee: employeeId,
    isArchived: false,
    timeIn: {
      $gte: timeIn.timeIn,
      ...(timeOut ? { $lte: timeOut.timeIn } : {}),
    },
  }).sort({ timeIn: 1 });

  const [slotYear, slotMonth, slotDay] = activeSlotKey.split("-").map(Number);
  const [shiftEndHour, shiftEndMinute] = shiftEnd.split(":").map(Number);
  const isOvernightShift = minutesFromTime(shiftEnd) <= minutesFromTime(shiftStart);
  const recoveryTimeOut = activeSlotKey === currentSlotKey
    ? null
    : zonedDateTimeToUtc(slotYear, slotMonth, slotDay + (isOvernightShift ? 1 : 0), shiftEndHour, shiftEndMinute, timeZone);

  return { timeIn, timeOut, records, recoveryTimeOut };
}

function countAttendanceSource(records: Array<{ source: AttendanceSource }>, source: AttendanceSource) {
  return records.filter((record) => record.source === source).length;
}

function latestAttendanceSource(records: Array<{ source: AttendanceSource }>) {
  return records[records.length - 1]?.source || "";
}

function sendAttendanceConflict(response: Response, message: string) {
  response.status(409).json({ message });
}

export async function recordEmployeeTimeIn(employeeId: Types.ObjectId | string) {
  const now = new Date();
  return Attendance.create({
    employee: employeeId,
    timeIn: now,
    source: "Time In",
    attendanceStatus: await getTimeInStatus(now),
  });
}

export async function recordEmployeeTimeOut(employeeId: Types.ObjectId | string, occurredAt = new Date()) {
  return Attendance.create({
    employee: employeeId,
    timeIn: occurredAt,
    source: "Time Out",
    attendanceStatus: await getTimeOutStatus(occurredAt),
  });
}

export function shouldAutomaticallyCloseAttendanceSlot({
  recoveryTimeOut: _recoveryTimeOut,
  now: _now,
}: {
  isInsideShift: boolean;
  hasCurrentOpenSlot: boolean;
  recoveryTimeOut: Date | null;
  now: Date;
}) {
  // Attendance is employee-controlled. Shift boundaries never create a time-out
  // record or force availability offline.
  return false;
}

export function canEditWorkedMinutes(hasManualTimeOut: boolean) {
  return hasManualTimeOut;
}

export async function closeExpiredAttendanceSlots(_now = new Date()) {
  return [] as string[];
}

export async function recordEmployeeBreakOut(employeeId: Types.ObjectId | string) {
  return Attendance.create({
    employee: employeeId,
    timeIn: new Date(),
    source: "Break Out",
  });
}

export async function recordEmployeeBreakIn(employeeId: Types.ObjectId | string) {
  return Attendance.create({
    employee: employeeId,
    timeIn: new Date(),
    source: "Break In",
  });
}

export async function recordEmployeeLunchBreakOut(employeeId: Types.ObjectId | string) {
  return Attendance.create({
    employee: employeeId,
    timeIn: new Date(),
    source: "Lunch Break Out",
  });
}

export async function recordEmployeeLunchBreakIn(employeeId: Types.ObjectId | string) {
  return Attendance.create({
    employee: employeeId,
    timeIn: new Date(),
    source: "Lunch Break In",
  });
}

export async function recordEmployeeOffPhoneOut(employeeId: Types.ObjectId | string, occurredAt = new Date()) {
  return Attendance.create({
    employee: employeeId,
    timeIn: occurredAt,
    source: "Off the Phone Out",
  });
}

export async function recordEmployeeOffPhoneIn(employeeId: Types.ObjectId | string, occurredAt = new Date()) {
  return Attendance.create({
    employee: employeeId,
    timeIn: occurredAt,
    source: "Off the Phone In",
  });
}

export async function timeInEmployee(request: Request, response: Response) {
  const employeeId = String(request.params.employeeId || request.body.employeeId || "").trim();

  if (!employeeId) {
    response.status(400).json({ message: "employeeId is required" });
    return;
  }

  const employee = await Employee.findOne({ _id: employeeId, status: { $ne: "Archived" } });

  if (!employee) {
    response.status(404).json({ message: "Employee not found" });
    return;
  }

  const activeSlot = await getActiveAttendanceSlot(employee._id);
  if (activeSlot.timeIn && !activeSlot.timeOut) {
    sendAttendanceConflict(response, "Employee is already timed in.");
    return;
  }

  const updatedEmployee = await Employee.findOneAndUpdate(
    { _id: employee._id },
    { availabilityStatus: "ONLINE" },
    { returnDocument: "after", runValidators: true }
  );

  if (!updatedEmployee) {
    sendAttendanceConflict(response, "Employee cannot time in from the current status.");
    return;
  }

  const businessEmployees = await syncEmployeeAvailabilityAcrossBusinesses(employee.employeeCode, updatedEmployee.availabilityStatus);

  const attendance = await recordEmployeeTimeIn(employee._id);
  await syncEmployeeAttendanceAcrossBusinesses(employee.employeeCode);
  emitEmployeeAvailabilityUpdated({
    employeeId: String(updatedEmployee._id),
    availabilityStatus: updatedEmployee.availabilityStatus,
  }, businessEmployees);

  await recordEmployeeTransaction({
    employee: employee._id,
    category: "Attendance",
    title: "Time in",
    description: `${employee.name} timed in from the attendance page.`,
  });

  response.status(201).json(attendance);
}

export async function breakOutEmployee(request: Request, response: Response) {
  const employeeId = String(request.params.employeeId || request.body.employeeId || "").trim();

  if (!employeeId) {
    response.status(400).json({ message: "employeeId is required" });
    return;
  }

  const employee = await Employee.findOne({ _id: employeeId, status: { $ne: "Archived" } });

  if (!employee) {
    response.status(404).json({ message: "Employee not found" });
    return;
  }

  const activeSlot = await getActiveAttendanceSlot(employee._id);
  const breakOutCount = countAttendanceSource(activeSlot.records, "Break Out");
  const breakInCount = countAttendanceSource(activeSlot.records, "Break In");
  const latestSource = latestAttendanceSource(activeSlot.records);

  if (!activeSlot.timeIn || activeSlot.timeOut) {
    sendAttendanceConflict(response, "Employee must be timed in before starting break.");
    return;
  }

  if (latestSource === "Break Out" || breakInCount < breakOutCount) {
    sendAttendanceConflict(response, "Employee is already on break.");
    return;
  }

  if (latestSource === "Lunch Break Out") {
    sendAttendanceConflict(response, "Employee is currently on lunch.");
    return;
  }

  if (breakOutCount >= 2) {
    sendAttendanceConflict(response, "Only two breaks are allowed per attendance slot.");
    return;
  }

  const latestBreakOut = [...activeSlot.records].reverse().find((record) => record.source === "Break Out");
  if (latestBreakOut && Date.now() - latestBreakOut.timeIn.getTime() < breakOutGapMs) {
    sendAttendanceConflict(response, "Please wait at least 30 minutes before starting another break.");
    return;
  }

  const updatedEmployee = await Employee.findOneAndUpdate(
    { _id: employee._id },
    { availabilityStatus: "BREAK" },
    { returnDocument: "after", runValidators: true }
  );

  if (!updatedEmployee) {
    sendAttendanceConflict(response, "Employee cannot start break from the current status.");
    return;
  }

  const businessEmployees = await syncEmployeeAvailabilityAcrossBusinesses(employee.employeeCode, updatedEmployee.availabilityStatus);

  const attendance = await recordEmployeeBreakOut(employee._id);
  await syncEmployeeAttendanceAcrossBusinesses(employee.employeeCode);
  emitEmployeeAvailabilityUpdated({
    employeeId: String(updatedEmployee._id),
    availabilityStatus: updatedEmployee.availabilityStatus,
  }, businessEmployees);

  await recordEmployeeTransaction({
    employee: employee._id,
    category: "Attendance",
    title: "15 min break out",
    description: `${employee.name} started a 15 minute break.`,
  });

  response.status(201).json(attendance);
}

export async function breakInEmployee(request: Request, response: Response) {
  const employeeId = String(request.params.employeeId || request.body.employeeId || "").trim();

  if (!employeeId) {
    response.status(400).json({ message: "employeeId is required" });
    return;
  }

  const employee = await Employee.findOne({ _id: employeeId, status: { $ne: "Archived" } });

  if (!employee) {
    response.status(404).json({ message: "Employee not found" });
    return;
  }

  const activeSlot = await getActiveAttendanceSlot(employee._id);
  const breakOutCount = countAttendanceSource(activeSlot.records, "Break Out");
  const breakInCount = countAttendanceSource(activeSlot.records, "Break In");
  const latestSource = latestAttendanceSource(activeSlot.records);

  if (!activeSlot.timeIn || activeSlot.timeOut || latestSource !== "Break Out" || breakInCount >= breakOutCount) {
    sendAttendanceConflict(response, "No active break to end.");
    return;
  }

  const updatedEmployee = await Employee.findOneAndUpdate(
    { _id: employee._id },
    { availabilityStatus: "ONLINE" },
    { returnDocument: "after", runValidators: true }
  );

  if (!updatedEmployee) {
    sendAttendanceConflict(response, "Employee cannot end break from the current status.");
    return;
  }

  const businessEmployees = await syncEmployeeAvailabilityAcrossBusinesses(employee.employeeCode, updatedEmployee.availabilityStatus);

  const attendance = await recordEmployeeBreakIn(employee._id);
  await syncEmployeeAttendanceAcrossBusinesses(employee.employeeCode);
  emitEmployeeAvailabilityUpdated({
    employeeId: String(updatedEmployee._id),
    availabilityStatus: updatedEmployee.availabilityStatus,
  }, businessEmployees);

  await recordEmployeeTransaction({
    employee: employee._id,
    category: "Attendance",
    title: "15 min break in",
    description: `${employee.name} returned from a 15 minute break.`,
  });

  response.status(201).json(attendance);
}

export async function lunchBreakOutEmployee(request: Request, response: Response) {
  const employeeId = String(request.params.employeeId || request.body.employeeId || "").trim();

  if (!employeeId) {
    response.status(400).json({ message: "employeeId is required" });
    return;
  }

  const employee = await Employee.findOne({ _id: employeeId, status: { $ne: "Archived" } });

  if (!employee) {
    response.status(404).json({ message: "Employee not found" });
    return;
  }

  const activeSlot = await getActiveAttendanceSlot(employee._id);
  const latestSource = latestAttendanceSource(activeSlot.records);

  if (!activeSlot.timeIn || activeSlot.timeOut) {
    sendAttendanceConflict(response, "Employee must be timed in before starting lunch.");
    return;
  }

  if (activeSlot.records.some((record) => record.source === "Lunch Break Out")) {
    sendAttendanceConflict(response, "Lunch was already started for this attendance slot.");
    return;
  }

  if (latestSource === "Break Out") {
    sendAttendanceConflict(response, "Employee is currently on break.");
    return;
  }

  const updatedEmployee = await Employee.findOneAndUpdate(
    { _id: employee._id },
    { availabilityStatus: "LUNCH" },
    { returnDocument: "after", runValidators: true }
  );

  if (!updatedEmployee) {
    sendAttendanceConflict(response, "Employee cannot start lunch from the current status.");
    return;
  }

  const businessEmployees = await syncEmployeeAvailabilityAcrossBusinesses(employee.employeeCode, updatedEmployee.availabilityStatus);

  const attendance = await recordEmployeeLunchBreakOut(employee._id);
  await syncEmployeeAttendanceAcrossBusinesses(employee.employeeCode);
  emitEmployeeAvailabilityUpdated({
    employeeId: String(updatedEmployee._id),
    availabilityStatus: updatedEmployee.availabilityStatus,
  }, businessEmployees);

  await recordEmployeeTransaction({
    employee: employee._id,
    category: "Attendance",
    title: "Lunch break out",
    description: `${employee.name} started lunch break.`,
  });

  response.status(201).json(attendance);
}

export async function lunchBreakInEmployee(request: Request, response: Response) {
  const employeeId = String(request.params.employeeId || request.body.employeeId || "").trim();

  if (!employeeId) {
    response.status(400).json({ message: "employeeId is required" });
    return;
  }

  const employee = await Employee.findOne({ _id: employeeId, status: { $ne: "Archived" } });

  if (!employee) {
    response.status(404).json({ message: "Employee not found" });
    return;
  }

  const activeSlot = await getActiveAttendanceSlot(employee._id);
  const latestSource = latestAttendanceSource(activeSlot.records);
  const hasLunchOut = activeSlot.records.some((record) => record.source === "Lunch Break Out");
  const hasLunchIn = activeSlot.records.some((record) => record.source === "Lunch Break In");

  if (!activeSlot.timeIn || activeSlot.timeOut || latestSource !== "Lunch Break Out" || !hasLunchOut || hasLunchIn) {
    sendAttendanceConflict(response, "No active lunch break to end.");
    return;
  }

  const updatedEmployee = await Employee.findOneAndUpdate(
    { _id: employee._id },
    { availabilityStatus: "ONLINE" },
    { returnDocument: "after", runValidators: true }
  );

  if (!updatedEmployee) {
    sendAttendanceConflict(response, "Employee cannot end lunch from the current status.");
    return;
  }

  const businessEmployees = await syncEmployeeAvailabilityAcrossBusinesses(employee.employeeCode, updatedEmployee.availabilityStatus);

  const attendance = await recordEmployeeLunchBreakIn(employee._id);
  await syncEmployeeAttendanceAcrossBusinesses(employee.employeeCode);
  emitEmployeeAvailabilityUpdated({
    employeeId: String(updatedEmployee._id),
    availabilityStatus: updatedEmployee.availabilityStatus,
  }, businessEmployees);

  await recordEmployeeTransaction({
    employee: employee._id,
    category: "Attendance",
    title: "Lunch break in",
    description: `${employee.name} returned from lunch break.`,
  });

  response.status(201).json(attendance);
}

export async function timeOutEmployee(request: Request, response: Response) {
  const employeeId = String(request.params.employeeId || request.body.employeeId || "").trim();
  const intent = String(request.body.intent || "").trim();
  const actorEmployeeCode = String(request.header("x-crm-user-code") || "").trim();
  const actorUserType = String(request.header("x-crm-user-type") || "").trim().toLowerCase();

  if (!employeeId) {
    response.status(400).json({ message: "employeeId is required" });
    return;
  }

  if (intent !== "manual-attendance-time-out") {
    response.status(400).json({ message: "Offline status requires manual confirmation." });
    return;
  }

  const employee = await Employee.findOne({ _id: employeeId, status: { $ne: "Archived" } });

  if (!employee) {
    response.status(404).json({ message: "Employee not found" });
    return;
  }

  if (actorUserType !== "employee" || !actorEmployeeCode || actorEmployeeCode !== employee.employeeCode) {
    response.status(403).json({ message: "You can only set your own attendance status offline." });
    return;
  }

  const activeSlot = await getActiveAttendanceSlot(employee._id, true);
  const latestSource = latestAttendanceSource(activeSlot.records);

  if (!activeSlot.timeIn || activeSlot.timeOut) {
    sendAttendanceConflict(response, "Employee is not currently timed in.");
    return;
  }

  if (latestSource === "Break Out" || latestSource === "Lunch Break Out") {
    sendAttendanceConflict(response, "Employee must return from break or lunch before timing out.");
    return;
  }

  const updatedEmployee = await Employee.findOneAndUpdate(
    { _id: employee._id },
    { availabilityStatus: "OFFLINE", availabilityStatusReason: "manual-time-out" },
    { returnDocument: "after", runValidators: true }
  );

  if (!updatedEmployee) {
    sendAttendanceConflict(response, "Employee cannot time out from the current status.");
    return;
  }

  const businessEmployees = await syncEmployeeAvailabilityAcrossBusinesses(
    employee.employeeCode,
    updatedEmployee.availabilityStatus,
    updatedEmployee.availabilityStatusReason
  );

  const offPhoneOutCount = countAttendanceSource(activeSlot.records, "Off the Phone Out");
  const offPhoneInCount = countAttendanceSource(activeSlot.records, "Off the Phone In");

  if (offPhoneInCount < offPhoneOutCount) {
    await recordEmployeeOffPhoneIn(employee._id);
  }

  const attendance = await recordEmployeeTimeOut(employee._id, new Date());
  await syncEmployeeAttendanceAcrossBusinesses(employee.employeeCode);
  emitEmployeeAvailabilityUpdated({
    employeeId: String(updatedEmployee._id),
    availabilityStatus: updatedEmployee.availabilityStatus,
  }, businessEmployees);

  await recordEmployeeTransaction({
    employee: employee._id,
    category: "Attendance",
    title: "Time out",
    description: `${employee.name} timed out from the attendance page.`,
  });

  response.status(201).json(attendance);
}

export async function listEmployeeAttendance(request: Request, response: Response) {
  const employeeId = String(request.params.employeeId);
  const showArchived = String(request.query.archived || "") === "true";
  const includeAll = String(request.query.all || "") === "true";
  const requestedLimit = Number(request.query.limit);
  const limit = includeAll ? 0 : Math.min(1_000, Math.max(1, Number.isFinite(requestedLimit) ? Math.floor(requestedLimit) : 300));
  const from = new Date(String(request.query.from || ""));
  const to = new Date(String(request.query.to || ""));
  const timeIn = {
    ...(!Number.isNaN(from.getTime()) ? { $gte: from } : {}),
    ...(!Number.isNaN(to.getTime()) ? { $lte: to } : {}),
  };
  const employee = Types.ObjectId.isValid(employeeId)
    ? await Employee.findById(employeeId).select("employeeCode").lean()
    : null;
  if (employee?.employeeCode) {
    await syncEmployeeAttendanceAcrossBusinesses(employee.employeeCode);
  }

  const attendanceQuery = Attendance.find({
    employee: employeeId,
    ...(showArchived ? { isArchived: true } : { isArchived: { $ne: true } }),
    ...(Object.keys(timeIn).length > 0 ? { timeIn } : {}),
  }).sort({ timeIn: -1 }).lean();
  if (limit > 0) attendanceQuery.limit(limit);
  const attendance = await attendanceQuery;

  response.json(attendance);
}

export async function listEmployeesAttendance(request: Request, response: Response) {
  const employeeIds = Array.from(
    new Set(
      String(request.query.employeeIds || "")
        .split(",")
        .map((value) => value.trim())
        .filter((value) => Types.ObjectId.isValid(value))
    )
  ).slice(0, 200);

  if (!employeeIds.length) {
    response.json([]);
    return;
  }

  const employees = await Employee.find({
    _id: { $in: employeeIds },
    status: { $ne: "Archived" },
  }).select("employeeCode").lean();
  await syncEmployeesAttendanceAcrossBusinesses(employees.map((employee) => employee.employeeCode));

  const includeAll = String(request.query.all || "") === "true";
  const requestedFrom = new Date(String(request.query.from || ""));
  const requestedTo = new Date(String(request.query.to || ""));
  const from = !Number.isNaN(requestedFrom.getTime())
    ? requestedFrom
    : includeAll
      ? null
      : new Date(Date.now() - 72 * 60 * 60 * 1000);
  const to = !Number.isNaN(requestedTo.getTime()) ? requestedTo : null;

  const attendance = await Attendance.find({
    employee: { $in: employeeIds },
    isArchived: { $ne: true },
    ...((from || to) ? {
      timeIn: {
        ...(from ? { $gte: from } : {}),
        ...(to ? { $lte: to } : {}),
      },
    } : {}),
  }).sort({ timeIn: -1 }).lean();

  response.json(attendance);
}

export async function createEmployeeAttendance(request: Request, response: Response) {
  const employeeId = String(request.params.employeeId || request.body.employeeId || "").trim();
  const source = attendanceSources.includes(request.body.source) ? request.body.source : "Time In";
  const timeIn = new Date(request.body.timeIn || Date.now());

  if (!employeeId || Number.isNaN(timeIn.getTime())) {
    response.status(400).json({ message: "Valid employeeId and timeIn are required" });
    return;
  }

  const employee = await Employee.findOne({ _id: employeeId, status: { $ne: "Archived" } });
  if (!employee) {
    response.status(404).json({ message: "Employee not found" });
    return;
  }

  const attendance = await Attendance.create({
    employee: employee._id,
    timeIn,
    source,
    attendanceStatus: await getAttendanceStatus(source, timeIn),
  });
  await syncEmployeeAttendanceAcrossBusinesses(employee.employeeCode);

  await recordEmployeeTransaction({
    employee: employee._id,
    category: "Attendance",
    title: "Attendance added",
    description: `${employee.name} had an attendance record added by admin.`,
  });

  if (request.business?.id) emitCallDashboardUpdated([request.business.id]);

  response.status(201).json(attendance);
}

export async function updateEmployeeAttendance(request: Request, response: Response) {
  const employeeId = String(request.params.employeeId || "").trim();
  const source = attendanceSources.includes(request.body.source) ? request.body.source : "Time In";
  const timeIn = new Date(request.body.timeIn || Date.now());

  if (Number.isNaN(timeIn.getTime())) {
    response.status(400).json({ message: "Valid timeIn is required" });
    return;
  }

  const attendance = await Attendance.findOne({ _id: request.params.attendanceId, employee: employeeId });
  if (!attendance) {
    response.status(404).json({ message: "Attendance record not found" });
    return;
  }

  const previousTime = attendance.timeIn;
  const previousSource = attendance.source;
  attendance.timeIn = timeIn;
  attendance.source = source;
  attendance.attendanceStatus = await getAttendanceStatus(source, timeIn);
  await attendance.save();

  const employee = await Employee.findById(employeeId).select("name employeeCode").lean();
  await recordEmployeeTransaction({
    employee: attendance.employee,
    category: "Attendance",
    title: "Attendance edited",
    description: `${employee?.name || "Employee"}'s ${source} time was corrected by admin.`,
    metadata: {
      attendanceId: String(attendance._id),
      source,
      previousTime: previousTime.toISOString(),
      updatedTime: timeIn.toISOString(),
    },
  });
  const affectedEmployees = employee?.employeeCode
    ? await updateAttendanceAcrossBusinesses(employee.employeeCode, {
        timeIn: previousTime,
        source: previousSource,
      }, {
        timeIn,
        source,
        attendanceStatus: attendance.attendanceStatus,
        isArchived: false,
      })
    : [{ businessId: request.business?.id || "", employeeId }];

  for (const affected of affectedEmployees) {
    if (!affected.businessId) continue;
    await runWithBusiness(affected.businessId, () =>
      recalculateEmployeePayrollAfterAttendanceEdit(affected.employeeId, previousTime, timeIn)
    );
  }

  emitCallDashboardUpdated(affectedEmployees.map((item) => item.businessId));
  response.json(attendance);
}

export async function updateEmployeeWorkedMinutes(request: Request, response: Response) {
  if (String(request.header("x-crm-user-type") || "").trim().toLowerCase() !== "admin") {
    response.status(403).json({ message: "Only administrators can edit worked minutes." });
    return;
  }

  const employeeId = String(request.params.employeeId || "").trim();
  const timeInRecordId = String(request.body.timeInRecordId || "").trim();
  const workedMinutes = Number(request.body.workedMinutes);

  if (!Types.ObjectId.isValid(employeeId) || !Types.ObjectId.isValid(timeInRecordId) ||
    !Number.isInteger(workedMinutes) || workedMinutes < 0 || workedMinutes > 24 * 60) {
    response.status(400).json({ message: "Worked minutes must be a whole number from 0 to 1440." });
    return;
  }

  const employee = await Employee.findOne({ _id: employeeId, status: { $ne: "Archived" } }).select("_id name employeeCode").lean();
  const timeInRecord = await Attendance.findOne({
    _id: timeInRecordId,
    employee: employeeId,
    source: { $in: timeInSources },
    isArchived: { $ne: true },
  });
  if (!employee || !timeInRecord) {
    response.status(404).json({ message: "Attendance time-in record not found." });
    return;
  }

  const settings = await getSystemSettings();
  const timeZone = settings.attendanceTimeZone || "Asia/Manila";
  const shiftStart = settings.officialShiftStartTime || "23:00";
  const shiftEnd = settings.officialShiftEndTime || "08:00";
  const slotKey = attendanceSlotKey(timeInRecord.timeIn, timeZone, shiftStart, shiftEnd);
  const candidateRecords = await Attendance.find({
    employee: employeeId,
    isArchived: { $ne: true },
    timeIn: {
      $gte: new Date(timeInRecord.timeIn.getTime() - 12 * 60 * 60 * 1000),
      $lte: new Date(timeInRecord.timeIn.getTime() + 36 * 60 * 60 * 1000),
    },
  }).sort({ timeIn: 1 });
  const slotRecords = candidateRecords.filter((record) => attendanceSlotKey(record.timeIn, timeZone, shiftStart, shiftEnd) === slotKey);
  const existingTimeOut = [...slotRecords].reverse().find((record) => timeOutSources.includes(record.source));
  const lunchOut = slotRecords.find((record) => record.source === "Lunch Break Out");
  const lunchIn = [...slotRecords].reverse().find((record) => record.source === "Lunch Break In");
  const slotDay = new Date(`${slotKey}T00:00:00Z`).getUTCDay();
  const isWeekend = slotDay === 0 || slotDay === 6;
  const actualLunchMinutes = lunchOut && lunchIn && lunchIn.timeIn > lunchOut.timeIn
    ? Math.round((lunchIn.timeIn.getTime() - lunchOut.timeIn.getTime()) / 60_000)
    : 0;
  const payrollLunchMinutes = isWeekend ? actualLunchMinutes : 60;
  const updatedTimeOut = workedMinutesToTimeOut(timeInRecord.timeIn, workedMinutes, payrollLunchMinutes);
  const updatedStatus = await getAttendanceStatus("Time Out", updatedTimeOut);
  let affectedEmployees: Array<{ businessId: string; employeeId: string }> = [];

  if (!canEditWorkedMinutes(Boolean(existingTimeOut))) {
    sendAttendanceConflict(
      response,
      "Worked minutes cannot be edited while the employee is still timed in. The employee must time out manually first."
    );
    return;
  }

  if (existingTimeOut) {
    const previousTimeOut = existingTimeOut.timeIn;
    const previousSource = existingTimeOut.source;
    existingTimeOut.timeIn = updatedTimeOut;
    existingTimeOut.source = "Time Out";
    existingTimeOut.attendanceStatus = updatedStatus;
    await existingTimeOut.save();
    affectedEmployees = await updateAttendanceAcrossBusinesses(employee.employeeCode, {
      timeIn: previousTimeOut,
      source: previousSource,
    }, {
      timeIn: updatedTimeOut,
      source: "Time Out",
      attendanceStatus: updatedStatus,
      isArchived: false,
    });
  }

  for (const affected of affectedEmployees) {
    await runWithBusiness(affected.businessId, () =>
      recalculateEmployeePayrollAfterAttendanceEdit(affected.employeeId, timeInRecord.timeIn, updatedTimeOut)
    );
  }

  await recordEmployeeTransaction({
    employee: employee._id,
    category: "Attendance",
    title: "Worked minutes edited",
    description: `${employee.name}'s worked time was set to ${workedMinutes} minutes by admin.`,
    metadata: { slotKey, workedMinutes, updatedTimeOut: updatedTimeOut.toISOString() },
  });
  emitCallDashboardUpdated(affectedEmployees.map((item) => item.businessId));
  response.json({ workedMinutes, timeOut: updatedTimeOut.toISOString(), affectedBusinesses: affectedEmployees.length });
}

export async function archiveEmployeeAttendance(request: Request, response: Response) {
  const attendance = await Attendance.findOneAndUpdate(
    { _id: request.params.attendanceId, employee: request.params.employeeId },
    { isArchived: true },
    { returnDocument: "after", runValidators: true }
  );

  if (!attendance) {
    response.status(404).json({ message: "Attendance record not found" });
    return;
  }

  const employee = await Employee.findById(request.params.employeeId).select("employeeCode").lean();
  if (employee?.employeeCode) {
    await updateAttendanceAcrossBusinesses(employee.employeeCode, {
      timeIn: attendance.timeIn,
      source: attendance.source,
    }, {
      timeIn: attendance.timeIn,
      source: attendance.source,
      attendanceStatus: attendance.attendanceStatus,
      isArchived: true,
    });
  }

  if (request.business?.id) emitCallDashboardUpdated([request.business.id]);
  response.json(attendance);
}

export async function recordEmployeeActivity(request: Request, response: Response) {
  const employeeId = String(request.params.employeeId || request.body.employeeId || "").trim();
  const state = request.body.state === "idle" ? "idle" : "active";
  const activityReason = String(request.body.reason || (state === "idle" ? "inactivity-timeout" : "browser-input")).trim().slice(0, 80);
  const rawIdleStartedAt = new Date(String(request.body.idleStartedAt || ""));
  const idleStartedAt = !Number.isNaN(rawIdleStartedAt.getTime()) && rawIdleStartedAt.getTime() <= Date.now()
    ? rawIdleStartedAt
    : null;

  if (!employeeId) {
    response.status(400).json({ message: "employeeId is required" });
    return;
  }

  const employee = await Employee.findOne({ _id: employeeId, status: { $ne: "Archived" } });

  if (!employee) {
    response.status(404).json({ message: "Employee not found" });
    return;
  }

  const currentStatus = normalizeEmployeeAvailabilityStatus(employee.availabilityStatus);
  if (!activityTrackedStatuses.has(currentStatus)) {
    response.json({ availabilityStatus: currentStatus });
    return;
  }

  if (state === "idle" && activityReason !== "manual-off-the-phone") {
    response.json({ availabilityStatus: currentStatus });
    return;
  }

  const manualOffPhoneLocked =
    currentStatus === "OFF THE PHONE" &&
    employee.availabilityStatusReason === "manual-off-the-phone";

  if (manualOffPhoneLocked && state === "active" && activityReason !== "manual-online") {
    response.json({ availabilityStatus: currentStatus });
    return;
  }

  const nextStatus = state === "idle" ? "OFF THE PHONE" : "ONLINE";

  if (currentStatus === nextStatus) {
    response.json({ availabilityStatus: currentStatus });
    return;
  }

  const offPhoneOccurredAt = activityReason === "manual-off-the-phone"
    ? new Date()
    : idleStartedAt || new Date(Date.now() - 10 * 60 * 1000);
  const activeSlot = await getActiveAttendanceSlot(employee._id);

  employee.availabilityStatus = nextStatus;
  employee.availabilityStatusReason = activityReason;
  await employee.save();
  const businessEmployees = await syncEmployeeAvailabilityAcrossBusinesses(
    employee.employeeCode,
    employee.availabilityStatus,
    employee.availabilityStatusReason
  );
  emitEmployeeAvailabilityUpdated({
    employeeId: String(employee._id),
    availabilityStatus: employee.availabilityStatus,
  }, businessEmployees);

  const idleDescription = activityReason === "manual-off-the-phone"
    ? `${employee.name} set status to off the phone.`
    : activityReason === "tab-hidden"
    ? `${employee.name} was idle after leaving the CRM tab for 10+ minutes.`
    : activityReason === "window-blur"
      ? `${employee.name} was idle after leaving the CRM window for 10+ minutes.`
      : `${employee.name} was idle after no keyboard, mouse, touch, or scroll activity for 10+ minutes.`;
  const activeDescription = activityReason === "manual-online"
    ? `${employee.name} set status to online.`
    : activityReason === "tab-return"
    ? `${employee.name} returned to the CRM tab.`
    : `${employee.name} became active again.`;
  const attendanceRecords = [];

  if (activeSlot.timeIn && !activeSlot.timeOut) {
    const offPhoneOutCount = countAttendanceSource(activeSlot.records, "Off the Phone Out");
    const offPhoneInCount = countAttendanceSource(activeSlot.records, "Off the Phone In");

    if (nextStatus === "OFF THE PHONE" && offPhoneOutCount <= offPhoneInCount) {
      const startedAt = new Date(Math.max(offPhoneOccurredAt.getTime(), activeSlot.timeIn.timeIn.getTime()));
      attendanceRecords.push(await recordEmployeeOffPhoneOut(employee._id, startedAt));
    }

    if (nextStatus === "ONLINE" && offPhoneInCount < offPhoneOutCount) {
      attendanceRecords.push(await recordEmployeeOffPhoneIn(employee._id));
    }
  }
  if (attendanceRecords.length > 0) {
    await syncEmployeeAttendanceAcrossBusinesses(employee.employeeCode);
  }

  await recordEmployeeTransaction({
    employee: employee._id,
    category: "Attendance",
    title: nextStatus === "OFF THE PHONE" ? "Off the phone" : "Online",
    description: nextStatus === "OFF THE PHONE" ? idleDescription : activeDescription,
    occurredAt: nextStatus === "OFF THE PHONE" ? offPhoneOccurredAt : new Date(),
    metadata: {
      reason: activityReason,
      reportedAt: new Date(),
      ...(nextStatus === "OFF THE PHONE" && idleStartedAt ? { idleStartedAt } : {}),
    },
  });

  emitCallDashboardUpdated(businessEmployees.map((item) => item.businessId));

  response.json({ availabilityStatus: employee.availabilityStatus, attendanceRecords });
}
