import type { Request, Response } from "express";
import type { SortOrder } from "mongoose";
import { Types } from "mongoose";
import { Attendance } from "../models/Attendance";
import { Employee } from "../models/Employee";
import type { PayrollItemCategory, PayrollListItemDocument, PayrollPayType, PayrollStatus } from "../models/Payroll";
import { PayrollListItem, PayrollRecord } from "../models/Payroll";
import { getCurrencyCode, getSystemSettings } from "./systemSettingsController";

const categories: PayrollItemCategory[] = ["Payroll Runs", "Payouts", "Deductions", "Tax Settings"];
const statuses: PayrollStatus[] = ["Paid", "Pending", "Failed", "Completed", "Review", "Applied", "Enabled"];
const payTypes: PayrollPayType[] = ["Monthly", "Semi-monthly", "Weekly", "Hourly", "Contract"];

type PayrollCutoffSettings = {
  payrollFirstCutoffStartDay?: number;
  payrollFirstCutoffEndDay?: number;
  payrollFirstCutoffPayDay?: number;
  payrollSecondCutoffStartDay?: number;
  payrollSecondCutoffEndDay?: number;
  payrollSecondCutoffPayDay?: number;
};

type PayrollCutoffRange = {
  startDay: number;
  endDay: number;
  payDay: number;
};

type PayrollCutoffPeriod = {
  range: PayrollCutoffRange;
  start: Date;
  end: Date;
  payDate: Date;
};

type PayrollAttendanceSummary = {
  attendanceDays: number;
  absentDays: number;
  absentHours: number;
  lateDays: number;
  lateHours: number;
  workingDays: number;
  workedHours: number;
  overtimeHours: number;
  missingHours: number;
  scheduledHours: number;
};

type PayrollDtrRow = {
  dateKey: string;
  date: string;
  day: string;
  status: "Present" | "Late" | "Overtime" | "Absent" | "Weekend";
  isWeekend: boolean;
  timeIn: string;
  timeOut: string;
  lunchHours: number;
  grossHours: number;
  lateHours: number;
  regularHours: number;
  overtimeHours: number;
  missingHours: number;
  scheduledHours: number;
  recordCount: number;
};

function clampDay(day: number, year: number, month: number) {
  const lastDay = new Date(year, month + 1, 0).getDate();
  return Math.min(Math.max(Math.round(day || 15), 1), lastDay);
}

function sanitizeCutoffDay(value: unknown, fallback: number) {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? Math.min(Math.max(Math.round(numberValue), 1), 31) : fallback;
}

function payrollCutoffRanges(settings?: PayrollCutoffSettings): PayrollCutoffRange[] {
  return [
    {
      startDay: sanitizeCutoffDay(settings?.payrollFirstCutoffStartDay, 6),
      endDay: sanitizeCutoffDay(settings?.payrollFirstCutoffEndDay, 20),
      payDay: sanitizeCutoffDay(settings?.payrollFirstCutoffPayDay, 25),
    },
    {
      startDay: sanitizeCutoffDay(settings?.payrollSecondCutoffStartDay, 21),
      endDay: sanitizeCutoffDay(settings?.payrollSecondCutoffEndDay, 5),
      payDay: sanitizeCutoffDay(settings?.payrollSecondCutoffPayDay, 10),
    },
  ];
}

function startOfDay(date: Date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function cutoffPeriodFromStartMonth(range: PayrollCutoffRange, year: number, month: number): PayrollCutoffPeriod {
  const crossesMonth = range.startDay > range.endDay;
  const start = new Date(year, month, clampDay(range.startDay, year, month));
  const end = new Date(year, crossesMonth ? month + 1 : month, clampDay(range.endDay, year, crossesMonth ? month + 1 : month));
  const payDateMonth = range.payDay < end.getDate() ? end.getMonth() + 1 : end.getMonth();
  const payDate = new Date(end.getFullYear(), payDateMonth, clampDay(range.payDay, end.getFullYear(), payDateMonth));

  return { range, start, end, payDate };
}

function cutoffPeriodsNear(referenceDate: Date, settings?: PayrollCutoffSettings) {
  const periods: PayrollCutoffPeriod[] = [];
  const ranges = payrollCutoffRanges(settings);

  for (let monthOffset = -2; monthOffset <= 2; monthOffset += 1) {
    const referenceMonth = new Date(referenceDate.getFullYear(), referenceDate.getMonth() + monthOffset, 1);
    ranges.forEach((range) => {
      periods.push(cutoffPeriodFromStartMonth(range, referenceMonth.getFullYear(), referenceMonth.getMonth()));
    });
  }

  return periods.sort((first, second) => first.payDate.getTime() - second.payDate.getTime());
}

function formatPeriodDate(date: Date) {
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function resolveCurrentCutoff(cycle = "Monthly", settings?: PayrollCutoffSettings) {
  const now = new Date();
  if (cycle !== "Semi-monthly") return null;
  const today = startOfDay(now);
  const periods = cutoffPeriodsNear(now, settings);
  return periods.find((period) => startOfDay(period.payDate).getTime() >= today.getTime()) || periods[periods.length - 1] || null;
}

function scheduledPayDateForPeriod(payPeriod: string, settings?: PayrollCutoffSettings) {
  const explicitRange = payPeriod.match(/^([A-Za-z]+ \d{1,2}, \d{4})\s+-\s+([A-Za-z]+ \d{1,2}, \d{4})$/);
  if (!explicitRange) return null;

  const start = new Date(explicitRange[1]);
  const end = new Date(explicitRange[2]);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return null;

  const matchingRange = payrollCutoffRanges(settings).find((range) => {
    const candidateEndDay = clampDay(range.endDay, end.getFullYear(), end.getMonth());
    return candidateEndDay === end.getDate();
  });

  if (!matchingRange) return null;

  const payDateMonth = matchingRange.payDay < end.getDate() ? end.getMonth() + 1 : end.getMonth();
  return new Date(end.getFullYear(), payDateMonth, clampDay(matchingRange.payDay, end.getFullYear(), payDateMonth));
}

function currentPeriod(cycle = "Monthly", settings?: PayrollCutoffSettings) {
  const now = new Date();

  if (cycle === "Weekly") {
    const weekStart = new Date(now);
    weekStart.setDate(now.getDate() - now.getDay());
    return `Week of ${weekStart.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}`;
  }

  if (cycle === "Semi-monthly") {
    const cutoff = resolveCurrentCutoff(cycle, settings);
    if (cutoff) return `${formatPeriodDate(cutoff.start)} - ${formatPeriodDate(cutoff.end)}`;
  }

  return now.toLocaleDateString("en-US", { month: "long", year: "numeric" });
}

function scheduledPayDateLabel(cycle = "Monthly", settings?: PayrollCutoffSettings, payPeriod = "") {
  const explicitPayDate = payPeriod ? scheduledPayDateForPeriod(payPeriod, settings) : null;
  const cutoff = explicitPayDate ? null : resolveCurrentCutoff(cycle, settings);
  const payDate = explicitPayDate || cutoff?.payDate;
  if (!payDate) return "-";
  return formatPeriodDate(payDate);
}

function selectedPayDateLabel(value: unknown) {
  const rawValue = String(value || "").trim();
  if (!rawValue) return "";

  const dateInput = rawValue.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const date = dateInput
    ? new Date(Number(dateInput[1]), Number(dateInput[2]) - 1, Number(dateInput[3]))
    : new Date(rawValue);

  if (Number.isNaN(date.getTime())) return rawValue;
  return formatPeriodDate(date);
}

function todayLabel() {
  return new Date().toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function toMoney(value: unknown, fallback = 0) {
  const numberValue = Number(String(value ?? "").replace(/[^0-9.-]/g, ""));
  return Number.isFinite(numberValue) && numberValue >= 0 ? Math.round(numberValue * 100) / 100 : fallback;
}

function minutesFromTime(value = "23:00") {
  const [hours, minutes] = value.split(":").map((part) => Number(part));
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return 0;
  return hours * 60 + minutes;
}

function hoursFromTimeRange(start = "00:00", end = "00:00") {
  const startMinutes = minutesFromTime(start);
  const endMinutes = minutesFromTime(end);
  return ((endMinutes - startMinutes + 1440) % 1440) / 60;
}

function zonedAttendanceParts(value?: Date | string | null, timeZone = "Asia/Manila") {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((item) => item.type === type)?.value || 0);
  return {
    year: part("year"),
    month: part("month"),
    day: part("day"),
    minutes: part("hour") * 60 + part("minute"),
  };
}

function dateKey(year: number, month: number, day: number) {
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function dateKeyFromDate(date: Date) {
  return dateKey(date.getFullYear(), date.getMonth() + 1, date.getDate());
}

function dateFromDateKey(value: string) {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const [, year, month, day] = match;
  return new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
}

function isWeekendDateKey(value: string) {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return false;
  const [, year, month, day] = match;
  const weekday = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day))).getUTCDay();
  return weekday === 0 || weekday === 6;
}

function lateHoursForSlot(
  value: Date | undefined,
  slotKey: string,
  settings?: PayrollCutoffSettings & {
    attendanceTimeZone?: string | null;
    officialShiftStartTime?: string | null;
    lateGraceMinutes?: number | null;
  }
) {
  const timeZone = settings?.attendanceTimeZone || "Asia/Manila";
  const actual = zonedAttendanceParts(value, timeZone);
  const slotDate = dateFromDateKey(slotKey);

  if (!actual || !slotDate) return 0;

  const slotDayNumber = Math.floor(slotDate.getTime() / 86400000);
  const actualDayNumber = Math.floor(Date.UTC(actual.year, actual.month - 1, actual.day) / 86400000);
  const allowedStartMinutes = slotDayNumber * 1440 + minutesFromTime(settings?.officialShiftStartTime || "23:00") + Math.max(Number(settings?.lateGraceMinutes || 0), 0);
  const actualMinutes = actualDayNumber * 1440 + actual.minutes;

  return roundHours(Math.max(0, (actualMinutes - allowedStartMinutes) / 60));
}

function formatDtrDate(value: string) {
  const date = dateFromDateKey(value);
  if (!date) return value;
  return new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "short", day: "numeric", year: "numeric" }).format(date);
}

function formatDtrDay(value: string) {
  const date = dateFromDateKey(value);
  if (!date) return "";
  return new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "short" }).format(date);
}

function formatDtrTime(value?: Date | null, timeZone = "Asia/Manila") {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(date);
}

function periodDateKeys(start: Date, end: Date) {
  const keys: string[] = [];
  const cursor = new Date(start);

  while (cursor < end) {
    keys.push(dateKeyFromDate(cursor));
    cursor.setDate(cursor.getDate() + 1);
  }

  return keys;
}

function attendanceSlotKey(value?: Date | string | null, settings?: PayrollCutoffSettings & {
  attendanceTimeZone?: string | null;
  officialShiftStartTime?: string | null;
  officialShiftEndTime?: string | null;
}) {
  const timeZone = settings?.attendanceTimeZone || "Asia/Manila";
  const parts = zonedAttendanceParts(value, timeZone);
  if (!parts) return "";

  const shiftStartMinutes = minutesFromTime(settings?.officialShiftStartTime || "23:00");
  const shiftEndMinutes = minutesFromTime(settings?.officialShiftEndTime || "08:00");
  const isOvernightShift = shiftEndMinutes <= shiftStartMinutes;
  const slotDate = new Date(Date.UTC(parts.year, parts.month - 1, parts.day));

  if (isOvernightShift && parts.minutes <= shiftEndMinutes) {
    slotDate.setUTCDate(slotDate.getUTCDate() - 1);
  }

  return dateKey(slotDate.getUTCFullYear(), slotDate.getUTCMonth() + 1, slotDate.getUTCDate());
}

function isAttendanceTimeInSource(source?: string) {
  return source === "Login" || source === "Time In";
}

function groupPayrollAttendanceBySlot<TRecord extends { source: string; timeIn: Date }>(
  records: TRecord[],
  settings?: PayrollCutoffSettings & {
    attendanceTimeZone?: string | null;
    officialShiftStartTime?: string | null;
    officialShiftEndTime?: string | null;
  }
) {
  const groups: Record<string, TRecord[]> = {};
  let activeSlotKey = "";

  [...records]
    .sort((left, right) => left.timeIn.getTime() - right.timeIn.getTime())
    .forEach((record) => {
      const recordSlotKey = attendanceSlotKey(record.timeIn, settings);
      const slotKey = isAttendanceTimeInSource(record.source) || !activeSlotKey ? recordSlotKey : activeSlotKey;
      if (!slotKey) return;

      groups[slotKey] = [...(groups[slotKey] || []), record];
      if (isAttendanceTimeInSource(record.source)) activeSlotKey = slotKey;
    });

  return groups;
}

function payTypeForCycle(cycle = "Semi-monthly"): PayrollPayType {
  if (cycle === "Semi-monthly") return "Semi-monthly";
  if (cycle === "Weekly") return "Weekly";
  return "Monthly";
}

function grossPayForCycle(monthlySalary: number, cycle = "Semi-monthly") {
  if (cycle === "Semi-monthly") return Math.round((monthlySalary / 2) * 100) / 100;
  if (cycle === "Weekly") return Math.round((monthlySalary / 4) * 100) / 100;
  return monthlySalary;
}

function roundMoney(value: number) {
  return Math.round(value * 100) / 100;
}

function roundHours(value: number) {
  return Math.round(value * 100) / 100;
}

function countWorkingDays(start: Date, end: Date) {
  let days = 0;
  const cursor = new Date(start);

  while (cursor < end) {
    const day = cursor.getDay();
    if (day !== 0 && day !== 6) days += 1;
    cursor.setDate(cursor.getDate() + 1);
  }

  return days;
}

function periodRange(payPeriod: string) {
  const now = new Date();
  const explicitRange = payPeriod.match(/^([A-Za-z]+ \d{1,2}, \d{4})\s+-\s+([A-Za-z]+ \d{1,2}, \d{4})$/);
  if (explicitRange) {
    const start = new Date(explicitRange[1]);
    const end = new Date(explicitRange[2]);
    if (!Number.isNaN(start.getTime()) && !Number.isNaN(end.getTime())) {
      end.setDate(end.getDate() + 1);
      return { start, end };
    }
  }

  const monthYear = payPeriod.match(/^([A-Za-z]+)\s+(\d{4})(?:\s+(\d+)-(End|\d+))?$/);
  if (monthYear) {
    const month = new Date(`${monthYear[1]} 1, ${monthYear[2]}`).getMonth();
    const year = Number(monthYear[2]);
    const lastDay = new Date(year, month + 1, 0).getDate();
    if (monthYear[3]) {
      const startDay = clampDay(Number(monthYear[3]), year, month);
      const endDay = monthYear[4] === "End" ? lastDay : clampDay(Number(monthYear[4]), year, month);
      if (monthYear[4] !== "End" && startDay > endDay) {
        return { start: new Date(year, month - 1, startDay), end: new Date(year, month, endDay + 1) };
      }
      return { start: new Date(year, month, startDay), end: new Date(year, month, endDay + 1) };
    }

    return { start: new Date(year, month, 1), end: new Date(year, month + 1, 1) };
  }

  const week = payPeriod.match(/^Week of (.+)$/);
  if (week) {
    const start = new Date(week[1]);
    if (!Number.isNaN(start.getTime())) {
      const end = new Date(start);
      end.setDate(start.getDate() + 7);
      return { start, end };
    }
  }

  return { start: new Date(now.getFullYear(), now.getMonth(), 1), end: new Date(now.getFullYear(), now.getMonth() + 1, 1) };
}

function firstRecord<TRecord extends { source: string; timeIn: Date }>(records: TRecord[], sources: string[]) {
  return records.find((record) => sources.includes(record.source));
}

function lastRecord<TRecord extends { source: string; timeIn: Date }>(records: TRecord[], sources: string[]) {
  return [...records].reverse().find((record) => sources.includes(record.source));
}

async function attendancePayrollDtr(employeeId: Types.ObjectId, payPeriod: string) {
  const settings = await getSystemSettings();
  const { start, end } = periodRange(payPeriod);
  const officialLunchHours = 1;
  const scheduledGrossHours = hoursFromTimeRange(settings.officialShiftStartTime || "23:00", settings.officialShiftEndTime || "08:00") || 9;
  const scheduledDailyHours = Math.max(1, scheduledGrossHours - officialLunchHours);
  const lateGraceHours = Math.max(Number(settings.lateGraceMinutes || 0), 0) / 60;
  const workingDays = countWorkingDays(start, end);
  const queryEnd = new Date(end);
  queryEnd.setDate(queryEnd.getDate() + 1);
  const records = await Attendance.find({
    employee: employeeId,
    isArchived: false,
    timeIn: { $gte: start, $lt: queryEnd },
  }).sort({ timeIn: 1 }).lean();
  const grouped = groupPayrollAttendanceBySlot(records, settings);

  const rows = periodDateKeys(start, end).map<PayrollDtrRow>((slotKey) => {
    const dayRecords = [...(grouped[slotKey] || [])].sort((left, right) => left.timeIn.getTime() - right.timeIn.getTime());
    const isWeekendSlot = isWeekendDateKey(slotKey);
    const timeIn = firstRecord(dayRecords, ["Login", "Time In"]);
    const timeOut = lastRecord(dayRecords, ["Logout", "Time Out"]);
    const lunchOut = firstRecord(dayRecords, ["Lunch Break Out"]);
    const lunchIn = lastRecord(dayRecords, ["Lunch Break In"]);
    const hasValidShift = Boolean(timeIn && timeOut && timeOut.timeIn > timeIn.timeIn);
    const assumedGrossHours = timeIn && !hasValidShift && !isWeekendSlot ? scheduledGrossHours : 0;
    const grossHours = hasValidShift && timeIn && timeOut ? (timeOut.timeIn.getTime() - timeIn.timeIn.getTime()) / 3600000 : assumedGrossHours;
    const actualLunchHours = lunchOut && lunchIn && lunchIn.timeIn > lunchOut.timeIn ? (lunchIn.timeIn.getTime() - lunchOut.timeIn.getTime()) / 3600000 : 0;
    const lunchHours = timeIn ? Math.min(grossHours, isWeekendSlot ? actualLunchHours : officialLunchHours) : 0;
    const status: PayrollDtrRow["status"] = timeIn
      ? isWeekendSlot
        ? "Overtime"
        : timeIn.attendanceStatus === "Late"
          ? "Late"
          : "Present"
      : isWeekendSlot
        ? "Weekend"
        : "Absent";
    const lateHours = status === "Late" ? lateHoursForSlot(timeIn?.timeIn, slotKey, settings) : 0;
    const dailyWorked = Math.max(0, grossHours - lunchHours);
    const scheduledHours = isWeekendSlot ? 0 : scheduledDailyHours;
    const earlyShortageHours = timeIn && hasValidShift ? Math.max(0, scheduledDailyHours - dailyWorked - (status === "Late" ? lateGraceHours : 0)) : 0;
    const missingHours = isWeekendSlot
      ? 0
      : !timeIn
        ? scheduledDailyHours
        : !hasValidShift
          ? lateHours
          : Math.max(lateHours, earlyShortageHours);
    const regularHours = isWeekendSlot ? 0 : Math.max(0, scheduledDailyHours - missingHours);
    const overtimeHours = isWeekendSlot ? dailyWorked : 0;

    return {
      dateKey: slotKey,
      date: formatDtrDate(slotKey),
      day: formatDtrDay(slotKey),
      status,
      isWeekend: isWeekendSlot,
      timeIn: formatDtrTime(timeIn?.timeIn, settings.attendanceTimeZone || "Asia/Manila"),
      timeOut: formatDtrTime(timeOut?.timeIn, settings.attendanceTimeZone || "Asia/Manila"),
      lunchHours: roundHours(lunchHours),
      grossHours: roundHours(grossHours),
      lateHours,
      regularHours: roundHours(regularHours),
      overtimeHours: roundHours(overtimeHours),
      missingHours: roundHours(missingHours),
      scheduledHours: roundHours(scheduledHours),
      recordCount: dayRecords.length,
    };
  });

  const filteredRows = rows.filter(Boolean) as PayrollDtrRow[];
  const absentRows = filteredRows.filter((row) => !row.isWeekend && row.status === "Absent");
  const lateRows = filteredRows.filter((row) => !row.isWeekend && row.status === "Late");
  const summary: PayrollAttendanceSummary = {
    attendanceDays: filteredRows.filter((row) => !row.isWeekend && (row.status === "Present" || row.status === "Late")).length,
    absentDays: absentRows.length,
    absentHours: roundHours(absentRows.reduce((sum, row) => sum + row.scheduledHours, 0)),
    lateDays: lateRows.length,
    lateHours: roundHours(lateRows.reduce((sum, row) => sum + row.lateHours, 0)),
    workingDays,
    workedHours: roundHours(filteredRows.reduce((sum, row) => sum + row.regularHours, 0)),
    overtimeHours: roundHours(filteredRows.reduce((sum, row) => sum + row.overtimeHours, 0)),
    missingHours: roundHours(filteredRows.reduce((sum, row) => sum + row.missingHours, 0)),
    scheduledHours: roundHours(workingDays * scheduledDailyHours),
  };

  return {
    rows: filteredRows,
    summary,
  };
}

async function attendancePayrollSummary(employeeId: Types.ObjectId, payPeriod: string) {
  return (await attendancePayrollDtr(employeeId, payPeriod)).summary;
}

async function formatMoney(value: number) {
  return value.toLocaleString("en-US", { style: "currency", currency: await getCurrencyCode() });
}

function sanitizeStatus(value: unknown, fallback: PayrollStatus = "Pending") {
  return statuses.includes(value as PayrollStatus) ? (value as PayrollStatus) : fallback;
}

function sanitizePayType(value: unknown) {
  return payTypes.includes(value as PayrollPayType) ? (value as PayrollPayType) : "Semi-monthly";
}

function canRecalculatePayrollRecord(status: PayrollStatus) {
  return status !== "Paid" && status !== "Completed";
}

async function seedPayroll() {
  const itemCount = await PayrollListItem.countDocuments();

  if (itemCount > 0) return;

  await PayrollListItem.insertMany([
    { category: "Payroll Runs", name: "May 2024 Payroll", second: "May 1 - May 15", third: "$148,750.00", fourth: "180 paid", status: "Completed" },
    { category: "Payroll Runs", name: "April 2024 Payroll", second: "Apr 16 - Apr 30", third: "$142,300.00", fourth: "176 paid", status: "Completed" },
    { category: "Payouts", name: "ACH Batch #2841", second: "180 employees", third: "$130,000.00", fourth: "May 12, 2024", status: "Paid" },
    { category: "Payouts", name: "Manual Payouts", second: "4 employees", third: "$5,420.00", fourth: "Scheduled", status: "Pending" },
    { category: "Deductions", name: "Federal Tax", second: "$8,420.00", third: "Payroll tax", fourth: "Applied", status: "Applied" },
    { category: "Deductions", name: "Benefits", second: "$4,880.00", third: "Health and dental", fourth: "Applied", status: "Applied" },
    { category: "Tax Settings", name: "Federal withholding", second: "Enabled", third: "Default payroll tax withholding", fourth: todayLabel(), status: "Enabled" },
    { category: "Tax Settings", name: "Commission tax rule", second: "Review", third: "Supplemental wage rate pending admin review", fourth: todayLabel(), status: "Review" },
  ]);
}

async function syncEmployeePayrollRecords(payPeriod = "", payDate = "") {
  const settings = await getSystemSettings();
  const resolvedPayPeriod = payPeriod || currentPeriod(settings.payrollBillingCycle, settings);
  const resolvedPayType = payTypeForCycle(settings.payrollBillingCycle);
  const resolvedPayDate = selectedPayDateLabel(payDate) || scheduledPayDateLabel(settings.payrollBillingCycle, settings, resolvedPayPeriod);
  const employees = await Employee.find({ status: { $ne: "Archived" } }).sort({ employeeCode: 1 });
  const records = [];

  for (const employee of employees) {
    const cycleGrossPay = grossPayForCycle(toMoney(employee.salary), settings.payrollBillingCycle);
    const attendance = await attendancePayrollSummary(employee._id, resolvedPayPeriod);
    const scheduledHours = Math.max(attendance.scheduledHours, 0);
    const missingHours = Math.max(attendance.missingHours, 0);
    const hourlyRate = scheduledHours > 0 ? cycleGrossPay / scheduledHours : 0;
    const existingRecords = await PayrollRecord.find({ employeeId: employee.employeeCode, payPeriod: resolvedPayPeriod, isArchived: false }).sort({ updatedAt: -1, createdAt: -1 });
    const existingRecord = existingRecords[0];
    const approvedOvertimeHours = existingRecord?.overtimeApproved ? toMoney(existingRecord.overtimeHours) : 0;
    const grossPay = roundMoney(cycleGrossPay + approvedOvertimeHours * hourlyRate);
    const deductions = Math.min(grossPay, roundMoney(missingHours * hourlyRate));

    if (existingRecords.length > 1) {
      await PayrollRecord.updateMany(
        { _id: { $in: existingRecords.slice(1).map((record) => record._id) } },
        { isArchived: true }
      );
    }

    if (existingRecord) {
      if (canRecalculatePayrollRecord(existingRecord.status)) {
        existingRecord.employeeName = employee.name;
        existingRecord.email = String(employee.email || "").trim();
        existingRecord.department = employee.team || employee.role || "General";
        existingRecord.payType = resolvedPayType;
        existingRecord.grossPay = grossPay;
        existingRecord.deductions = deductions;
        existingRecord.netPay = Math.max(grossPay - deductions, 0);
        existingRecord.paidOn = resolvedPayDate;
        existingRecord.attendanceDays = attendance.attendanceDays;
        existingRecord.absentDays = attendance.absentDays;
        existingRecord.absentHours = attendance.absentHours;
        existingRecord.lateDays = attendance.lateDays;
        existingRecord.lateHours = attendance.lateHours;
        existingRecord.workedHours = attendance.workedHours;
        existingRecord.overtimeHours = approvedOvertimeHours;
        existingRecord.scheduledHours = attendance.scheduledHours;
        await existingRecord.save();
      }

      records.push(existingRecord);
      continue;
    }

    records.push(
      await PayrollRecord.create({
        employeeName: employee.name,
        email: String(employee.email || "").trim(),
        employeeId: employee.employeeCode,
        department: employee.team || employee.role || "General",
        payType: resolvedPayType,
        grossPay,
        deductions,
        netPay: Math.max(grossPay - deductions, 0),
        attendanceDays: attendance.attendanceDays,
        absentDays: attendance.absentDays,
        absentHours: attendance.absentHours,
        lateDays: attendance.lateDays,
        lateHours: attendance.lateHours,
        workedHours: attendance.workedHours,
        overtimeHours: 0,
        overtimeApproved: false,
        scheduledHours: attendance.scheduledHours,
        status: grossPay > 0 ? "Pending" : "Review",
        paidOn: resolvedPayDate,
        payPeriod: resolvedPayPeriod,
      })
    );
  }

  return records;
}

export async function getPayrollDtr(request: Request, response: Response) {
  const settings = await getSystemSettings();
  const employeeId = String(request.params.employeeId || "").trim();
  const payPeriod = String(request.query.payPeriod || currentPeriod(settings.payrollBillingCycle, settings)).trim();
  const employeeFilters: Record<string, unknown>[] = [{ employeeCode: employeeId }];

  if (Types.ObjectId.isValid(employeeId)) {
    employeeFilters.push({ _id: employeeId });
  }

  const employee = await Employee.findOne({ $or: employeeFilters });

  if (!employee) {
    response.status(404).json({ message: "Employee not found" });
    return;
  }

  const grossPay = grossPayForCycle(toMoney(employee.salary), settings.payrollBillingCycle);
  const dtr = await attendancePayrollDtr(employee._id, payPeriod);
  const hourlyRate = dtr.summary.scheduledHours > 0 ? grossPay / dtr.summary.scheduledHours : 0;
  const deductions = Math.min(grossPay, roundMoney(dtr.summary.missingHours * hourlyRate));

  response.json({
    employee: {
      _id: employee._id,
      name: employee.name,
      employeeCode: employee.employeeCode,
      department: employee.team || employee.role || "General",
    },
    payPeriod,
    payDate: scheduledPayDateLabel(settings.payrollBillingCycle, settings, payPeriod),
    payType: payTypeForCycle(settings.payrollBillingCycle),
    summary: {
      ...dtr.summary,
      grossPay: roundMoney(grossPay),
      hourlyRate: roundMoney(hourlyRate),
      deductions,
      netPay: Math.max(roundMoney(grossPay) - deductions, 0),
    },
    rows: dtr.rows,
  });
}

export async function updatePayrollOvertime(request: Request, response: Response) {
  const overtimeHours = toMoney(request.body.overtimeHours);
  const record = await PayrollRecord.findById(request.params.id);

  if (!record) {
    response.status(404).json({ message: "Payroll record not found" });
    return;
  }

  const settings = await getSystemSettings();
  const employee = await Employee.findOne({ employeeCode: record.employeeId });
  const baseGrossPay = employee
    ? grossPayForCycle(toMoney(employee.salary), settings.payrollBillingCycle)
    : Math.max(0, toMoney(record.grossPay) - toMoney(record.overtimeHours) * (record.scheduledHours > 0 ? toMoney(record.grossPay) / record.scheduledHours : 0));
  let scheduledHours = toMoney(record.scheduledHours);

  if (!scheduledHours && employee) {
    const attendance = await attendancePayrollSummary(employee._id, record.payPeriod);
    scheduledHours = attendance.scheduledHours;
    record.attendanceDays = attendance.attendanceDays;
    record.absentDays = attendance.absentDays;
    record.absentHours = attendance.absentHours;
    record.lateDays = attendance.lateDays;
    record.lateHours = attendance.lateHours;
    record.workedHours = attendance.workedHours;
    record.scheduledHours = attendance.scheduledHours;
    record.deductions = Math.min(baseGrossPay, roundMoney(attendance.missingHours * (scheduledHours > 0 ? baseGrossPay / scheduledHours : 0)));
  }

  const hourlyRate = scheduledHours > 0 ? baseGrossPay / scheduledHours : 0;
  const grossPay = roundMoney(baseGrossPay + overtimeHours * hourlyRate);

  record.overtimeHours = overtimeHours;
  record.overtimeApproved = overtimeHours > 0;
  record.grossPay = grossPay;
  record.netPay = Math.max(grossPay - record.deductions, 0);
  await record.save();

  response.json(record);
}

export async function listPayrollStats(_request: Request, response: Response) {
  await seedPayroll();
  const settings = await getSystemSettings();
  const payPeriod = currentPeriod(settings.payrollBillingCycle, settings);
  await syncEmployeePayrollRecords(payPeriod);
  const activeEmployees = await Employee.find({ status: { $ne: "Archived" } }).select("employeeCode");
  const activeEmployeeCodes = activeEmployees.map((employee) => employee.employeeCode);
  const records = await PayrollRecord.find({ isArchived: false, employeeId: { $in: activeEmployeeCodes }, payPeriod });
  const totalEmployees = activeEmployeeCodes.length;
  const gross = records.reduce((sum, record) => sum + record.grossPay, 0);
  const deductions = records.reduce((sum, record) => sum + record.deductions, 0);
  const net = records.reduce((sum, record) => sum + record.netPay, 0);

  response.json({
    totalEmployees: totalEmployees || records.length,
    totalPayroll: gross,
    totalDeductions: deductions,
    netPayroll: net,
    paidEmployees: records.filter((record) => record.status === "Paid").length,
  });
}

export async function listPayrollRecords(request: Request, response: Response) {
  await seedPayroll();
  const settings = await getSystemSettings();
  const showArchived = String(request.query.archived || "") === "true";
  const requestedPayPeriod = String(request.query.payPeriod || (showArchived ? "" : currentPeriod(settings.payrollBillingCycle, settings))).trim();

  if (!showArchived) {
    await syncEmployeePayrollRecords(requestedPayPeriod || currentPeriod(settings.payrollBillingCycle, settings));
  }

  const search = String(request.query.search || "").trim();
  const status = String(request.query.status || "");
  const payPeriod = requestedPayPeriod;
  const sortBy = String(request.query.sortBy || "employeeId");
  const sortDir = String(request.query.sortDir || "asc") === "desc" ? -1 : 1;
  const sortableFields = new Set(["employeeName", "employeeId", "department", "payType", "grossPay", "deductions", "netPay", "status", "paidOn", "payPeriod"]);
  const filter: Record<string, unknown> = { isArchived: showArchived };

  if (!showArchived) {
    const activeEmployees = await Employee.find({ status: { $ne: "Archived" } }).select("employeeCode");
    const activeEmployeeCodes = activeEmployees.map((employee) => employee.employeeCode);
    filter.employeeId = { $in: activeEmployeeCodes };
  }

  if (statuses.includes(status as PayrollStatus)) filter.status = status;
  if (payPeriod) filter.payPeriod = payPeriod;
  if (search) {
    filter.$or = [
      { employeeName: { $regex: search, $options: "i" } },
      { email: { $regex: search, $options: "i" } },
      { employeeId: { $regex: search, $options: "i" } },
      { department: { $regex: search, $options: "i" } },
    ];
  }

  const records = await PayrollRecord.find(filter).sort({
    [sortableFields.has(sortBy) ? sortBy : "employeeId"]: sortDir as SortOrder,
  });
  response.json(records);
}

export async function createPayrollRecord(request: Request, response: Response) {
  const settings = await getSystemSettings();
  const grossPay = toMoney(request.body.grossPay);
  const deductions = toMoney(request.body.deductions);
  const overtimeHours = toMoney(request.body.overtimeHours);
  const record = await PayrollRecord.create({
    employeeName: request.body.employeeName,
    email: request.body.email || "",
    employeeId: request.body.employeeId,
    department: request.body.department || "General",
    payType: sanitizePayType(request.body.payType),
    grossPay,
    deductions,
    netPay: Math.max(grossPay - deductions, 0),
    attendanceDays: toMoney(request.body.attendanceDays),
    absentDays: toMoney(request.body.absentDays),
    absentHours: toMoney(request.body.absentHours),
    lateDays: toMoney(request.body.lateDays),
    lateHours: toMoney(request.body.lateHours),
    workedHours: toMoney(request.body.workedHours),
    overtimeHours,
    overtimeApproved: overtimeHours > 0,
    scheduledHours: toMoney(request.body.scheduledHours),
    status: sanitizeStatus(request.body.status),
    paidOn: selectedPayDateLabel(request.body.paidOn) || "-",
    payPeriod: request.body.payPeriod || currentPeriod(settings.payrollBillingCycle, settings),
  });

  response.status(201).json(record);
}

export async function updatePayrollRecord(request: Request, response: Response) {
  const settings = await getSystemSettings();
  const grossPay = toMoney(request.body.grossPay);
  const deductions = toMoney(request.body.deductions);
  const overtimeHours = toMoney(request.body.overtimeHours);
  const record = await PayrollRecord.findByIdAndUpdate(
    request.params.id,
    {
      employeeName: request.body.employeeName,
      email: request.body.email || "",
      employeeId: request.body.employeeId,
      department: request.body.department || "General",
      payType: sanitizePayType(request.body.payType),
      grossPay,
      deductions,
      netPay: Math.max(grossPay - deductions, 0),
      attendanceDays: toMoney(request.body.attendanceDays),
      absentDays: toMoney(request.body.absentDays),
      absentHours: toMoney(request.body.absentHours),
      lateDays: toMoney(request.body.lateDays),
      lateHours: toMoney(request.body.lateHours),
      workedHours: toMoney(request.body.workedHours),
      overtimeHours,
      overtimeApproved: overtimeHours > 0,
      scheduledHours: toMoney(request.body.scheduledHours),
      status: sanitizeStatus(request.body.status),
      paidOn: selectedPayDateLabel(request.body.paidOn) || "-",
      payPeriod: request.body.payPeriod || currentPeriod(settings.payrollBillingCycle, settings),
    },
    { returnDocument: "after", runValidators: true }
  );

  if (!record) {
    response.status(404).json({ message: "Payroll record not found" });
    return;
  }

  response.json(record);
}

export async function markPayrollRecordPaid(request: Request, response: Response) {
  const record = await PayrollRecord.findByIdAndUpdate(
    request.params.id,
    { status: "Paid", paidOn: todayLabel() },
    { returnDocument: "after", runValidators: true }
  );

  if (!record) {
    response.status(404).json({ message: "Payroll record not found" });
    return;
  }

  response.json(record);
}

export async function markPayrollRecordUnpaid(request: Request, response: Response) {
  const record = await PayrollRecord.findByIdAndUpdate(
    request.params.id,
    { status: "Pending", paidOn: "-" },
    { returnDocument: "after", runValidators: true }
  );

  if (!record) {
    response.status(404).json({ message: "Payroll record not found" });
    return;
  }

  response.json(record);
}

export async function archivePayrollRecord(request: Request, response: Response) {
  const record = await PayrollRecord.findByIdAndUpdate(
    request.params.id,
    { isArchived: true },
    { returnDocument: "after", runValidators: true }
  );

  if (!record) {
    response.status(404).json({ message: "Payroll record not found" });
    return;
  }

  response.json(record);
}

export async function restorePayrollRecord(request: Request, response: Response) {
  const record = await PayrollRecord.findByIdAndUpdate(
    request.params.id,
    { isArchived: false },
    { returnDocument: "after", runValidators: true }
  );

  if (!record) {
    response.status(404).json({ message: "Payroll record not found" });
    return;
  }

  response.json(record);
}

export async function runPayroll(request: Request, response: Response) {
  const settings = await getSystemSettings();
  const payPeriod = String(request.body.payPeriod || currentPeriod(settings.payrollBillingCycle, settings)).trim();
  const payDate = String(request.body.payDate || "").trim();
  const records = await syncEmployeePayrollRecords(payPeriod, payDate);
  const created = records.filter((record) => record.payPeriod === payPeriod && record.status !== "Paid");

  const netTotal = created.reduce((sum, record) => sum + record.netPay, 0);
  await PayrollListItem.create({
    category: "Payroll Runs",
    name: `${payPeriod} Payroll`,
    second: payPeriod,
    third: await formatMoney(netTotal),
    fourth: `${created.length} created`,
    status: created.length > 0 ? "Pending" : "Review",
  });

  response.status(201).json({ created: created.length, records: created });
}

export async function listPayrollItems(request: Request, response: Response) {
  await seedPayroll();
  const category = String(request.query.category || "");
  const showArchived = String(request.query.archived || "") === "true";
  const filter: Partial<Pick<PayrollListItemDocument, "category" | "isArchived">> = { isArchived: showArchived };

  if (categories.includes(category as PayrollItemCategory)) {
    filter.category = category as PayrollItemCategory;
  }

  const items = await PayrollListItem.find(filter).sort({ createdAt: -1 });
  response.json(items);
}

export async function createPayrollItem(request: Request, response: Response) {
  const category = categories.includes(request.body.category) ? request.body.category : "Deductions";
  const item = await PayrollListItem.create({
    category,
    name: request.body.name,
    second: request.body.second || "",
    third: request.body.third || "",
    fourth: request.body.fourth || (category === "Deductions" ? "Every payroll" : todayLabel()),
    status: sanitizeStatus(request.body.status, category === "Tax Settings" ? "Enabled" : category === "Deductions" ? "Applied" : "Pending"),
  });

  response.status(201).json(item);
}

export async function archivePayrollItem(request: Request, response: Response) {
  const item = await PayrollListItem.findByIdAndUpdate(
    request.params.id,
    { isArchived: true },
    { returnDocument: "after", runValidators: true }
  );

  if (!item) {
    response.status(404).json({ message: "Payroll item not found" });
    return;
  }

  response.json(item);
}

export async function restorePayrollItem(request: Request, response: Response) {
  const item = await PayrollListItem.findByIdAndUpdate(
    request.params.id,
    { isArchived: false },
    { returnDocument: "after", runValidators: true }
  );

  if (!item) {
    response.status(404).json({ message: "Payroll item not found" });
    return;
  }

  response.json(item);
}
