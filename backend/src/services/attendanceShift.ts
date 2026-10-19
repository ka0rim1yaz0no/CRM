import type { AssignedShift } from "./attendanceSessionState";
import type { AttendanceSource, AttendanceStatus } from "../models/Attendance";
const zonedFormatters = new Map<string, Intl.DateTimeFormat>();

export function attendanceEventStatus(source: AttendanceSource, at: Date, shift: AssignedShift | null, graceMinutes = 0): AttendanceStatus {
  if (!shift) return "";
  if (source === "Time In" || source === "Login") return at.getTime() >= Date.parse(shift.start) + (graceMinutes + 1) * 60_000 ? "Late" : "On time";
  if (source === "Time Out" || source === "Logout") return at.getTime() < Date.parse(shift.end) ? "Undertime" : "";
  return "";
}

export function minutesFromTime(value = "23:00") {
  const [hours, minutes] = value.split(":").map(Number);
  return hours * 60 + minutes;
}
export function zonedParts(value: Date, timeZone = "Asia/Manila") {
  let formatter = zonedFormatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
    if (zonedFormatters.size >= 32) zonedFormatters.clear();
    zonedFormatters.set(timeZone, formatter);
  }
  const parts = formatter.formatToParts(value);
  const part = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((item) => item.type === type)?.value || 0);
  return { year: part("year"), month: part("month"), day: part("day"), hour: part("hour"), minute: part("minute") };
}
export function zonedDateTimeToUtc(year: number, month: number, day: number, hour: number, minute: number, timeZone = "Asia/Manila") {
  let utcTime = Date.UTC(year, month - 1, day, hour, minute);
  for (let index = 0; index < 2; index += 1) {
    const actual = zonedParts(new Date(utcTime), timeZone);
    utcTime += Date.UTC(year, month - 1, day, hour, minute) - Date.UTC(actual.year, actual.month - 1, actual.day, actual.hour, actual.minute);
  }
  return new Date(utcTime);
}
export function attendanceSlotKey(value: Date, timeZone: string, shiftStart: string, shiftEnd: string) {
  const parts = zonedParts(value, timeZone);
  const slotDate = new Date(Date.UTC(parts.year, parts.month - 1, parts.day));
  if (minutesFromTime(shiftEnd) <= minutesFromTime(shiftStart) && parts.hour * 60 + parts.minute <= minutesFromTime(shiftEnd)) slotDate.setUTCDate(slotDate.getUTCDate() - 1);
  return slotDate.toISOString().slice(0, 10);
}
export function assignAttendanceShift(value: Date, start = "23:00", end = "08:00", cutoff = "22:59"): AssignedShift {
  const dayKey = attendanceSlotKey(value, "Asia/Manila", start, end);
  const [year, month, day] = dayKey.split("-").map(Number);
  const [sh, sm] = start.split(":").map(Number); const [eh, em] = end.split(":").map(Number);
  const [ch, cm] = cutoff.split(":").map(Number);
  return { dayKey, start: zonedDateTimeToUtc(year, month, day, sh, sm).toISOString(),
    ambiguous: value.getTime() < zonedDateTimeToUtc(year, month, day, sh, sm).getTime() - 2 * 3_600_000,
    end: zonedDateTimeToUtc(year, month, day + Number(minutesFromTime(end) <= minutesFromTime(start)), eh, em).toISOString(),
    resetDeadline: zonedDateTimeToUtc(year, month, day + 1, ch, cm).toISOString() };
}
