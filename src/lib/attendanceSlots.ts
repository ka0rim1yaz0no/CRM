export const ATTENDANCE_TIME_ZONE = "Asia/Manila";
export const DEFAULT_ATTENDANCE_SHIFT_START = "23:00";
export const DEFAULT_ATTENDANCE_SHIFT_END = "08:00";

export type AttendanceSlotSettings = {
    attendanceTimeZone?: string | null;
    officialShiftStartTime?: string | null;
    officialShiftEndTime?: string | null;
    lateGraceMinutes?: number | null;
};

export type AttendanceSlotRecord = {
    source: string;
    timeIn: Date | string;
    attendanceStatus?: string | null;
    sequence?: number;
    shiftDayKey?: string;
    eventId?: string;
    _id?: string;
    derived?: { dayKey: string; eventIds: string[] };
};

export function isAttendanceTimeInSource(source?: string) {
    return source === "Login" || source === "Time In";
}

export function isAttendanceTimeOutSource(source?: string) {
    return source === "Logout" || source === "Time Out";
}

export function attendanceSlotTimeZone(settings?: AttendanceSlotSettings | null) {
    return settings?.attendanceTimeZone || ATTENDANCE_TIME_ZONE;
}

export function attendanceSlotShiftStart(settings?: AttendanceSlotSettings | null) {
    return settings?.officialShiftStartTime || DEFAULT_ATTENDANCE_SHIFT_START;
}

export function attendanceSlotShiftEnd(settings?: AttendanceSlotSettings | null) {
    return settings?.officialShiftEndTime || DEFAULT_ATTENDANCE_SHIFT_END;
}

export function minutesFromAttendanceTime(value = "00:00") {
    const [hours, minutes] = value.split(":").map((part) => Number(part));
    if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return 0;
    return hours * 60 + minutes;
}

export function isAttendanceTimeOutUndertime(
    record?: AttendanceSlotRecord | null,
    settings?: AttendanceSlotSettings | null
) {
    if (!record || !isAttendanceTimeOutSource(record.source)) return false;
    const parts = zonedDateParts(record.timeIn, attendanceSlotTimeZone(settings));
    if (!parts) return false;

    const shiftStartMinutes = minutesFromAttendanceTime(attendanceSlotShiftStart(settings));
    const shiftEndMinutes = minutesFromAttendanceTime(attendanceSlotShiftEnd(settings));
    const isOvernightShift = shiftEndMinutes <= shiftStartMinutes;

    if (isOvernightShift) {
        return parts.minutes >= shiftStartMinutes || parts.minutes < shiftEndMinutes;
    }

    return parts.minutes < shiftEndMinutes;
}

export function attendanceRecordStatus(record?: AttendanceSlotRecord | null, settings?: AttendanceSlotSettings | null) {
    if (!record) return "";
    if (isAttendanceTimeOutSource(record.source)) return isAttendanceTimeOutUndertime(record, settings) ? "Undertime" : "";
    const status = String(record.attendanceStatus || "").trim();
    return status.toLowerCase() === "undertime" ? "" : status;
}

export function isAttendanceTimeInLate(
    record?: AttendanceSlotRecord | null,
    settings?: AttendanceSlotSettings | null
) {
    if (!record || !isAttendanceTimeInSource(record.source)) return false;
    const parts = zonedDateParts(record.timeIn, attendanceSlotTimeZone(settings));
    if (!parts) return false;

    const shiftStartMinutes = minutesFromAttendanceTime(attendanceSlotShiftStart(settings));
    const shiftEndMinutes = minutesFromAttendanceTime(attendanceSlotShiftEnd(settings));
    const isOvernightShift = shiftEndMinutes <= shiftStartMinutes;
    const normalizedMinutes = isOvernightShift && parts.minutes < shiftEndMinutes
        ? parts.minutes + 1440
        : parts.minutes;
    const graceMinutes = Math.max(0, Number(settings?.lateGraceMinutes || 0));

    return normalizedMinutes >= shiftStartMinutes + graceMinutes + 1;
}

function zonedDateParts(value?: Date | string | null, timeZone = ATTENDANCE_TIME_ZONE) {
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

function dateKeyFromUtcDate(date: Date) {
    const year = date.getUTCFullYear();
    const month = String(date.getUTCMonth() + 1).padStart(2, "0");
    const day = String(date.getUTCDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
}

export function formatAttendanceSlotKey(value?: Date | string | null, settings?: AttendanceSlotSettings | null) {
    const timeZone = attendanceSlotTimeZone(settings);
    const parts = zonedDateParts(value, timeZone);
    if (!parts) return "";

    const shiftStartMinutes = minutesFromAttendanceTime(attendanceSlotShiftStart(settings));
    const shiftEndMinutes = minutesFromAttendanceTime(attendanceSlotShiftEnd(settings));
    const isOvernightShift = shiftEndMinutes <= shiftStartMinutes;
    const slotDate = new Date(Date.UTC(parts.year, parts.month - 1, parts.day));

    if (isOvernightShift && parts.minutes <= shiftEndMinutes) {
        slotDate.setUTCDate(slotDate.getUTCDate() - 1);
    }

    return dateKeyFromUtcDate(slotDate);
}

export function formatAttendanceSlotLabel(dateKey?: string) {
    const match = String(dateKey || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!match) return "";
    const [, year, month, day] = match;
    return new Intl.DateTimeFormat("en-US", {
        timeZone: "UTC",
        month: "short",
        day: "numeric",
        year: "numeric",
    }).format(new Date(Date.UTC(Number(year), Number(month) - 1, Number(day))));
}

export function isWeekendAttendanceSlotKey(dateKey?: string) {
    const match = String(dateKey || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!match) return false;
    const [, year, month, day] = match;
    const weekday = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day))).getUTCDay();
    return weekday === 0 || weekday === 6;
}

export function groupAttendanceRecordsBySlot<TRecord extends AttendanceSlotRecord>(records: TRecord[], settings?: AttendanceSlotSettings | null) {
    const groups: Record<string, TRecord[]> = {};
    let activeSlotKey = "";
    const shiftStart = minutesFromAttendanceTime(attendanceSlotShiftStart(settings));
    const validDay = (value?: string) => Boolean(value && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
        Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value);

    [...records]
        .sort((left, right) => new Date(left.timeIn).getTime() - new Date(right.timeIn).getTime() || (left.sequence ?? 0) - (right.sequence ?? 0))
        .forEach((record) => {
            const isShiftStart = isAttendanceTimeInSource(record.source);
            const recordSlotKey = formatAttendanceSlotKey(record.timeIn, settings);
            const derivedDay = record.derived?.eventIds.includes(record.eventId || record._id || "") ? record.derived.dayKey : undefined;
            const assignedDay = validDay(record.shiftDayKey) ? record.shiftDayKey : validDay(derivedDay) ? derivedDay : undefined;
            const parts = zonedDateParts(record.timeIn, attendanceSlotTimeZone(settings));
            if (!parts) return;
            // A checkout after 08:00 still belongs to its open overnight shift.
            // Without canonical evidence, never carry it past the next shift start.
            const minutesSinceDay = activeSlotKey
                ? (Date.UTC(parts.year, parts.month - 1, parts.day) - Date.parse(activeSlotKey)) / 60000 + parts.minutes : Infinity;
            if (minutesSinceDay >= 1440 + shiftStart) activeSlotKey = "";
            const slotKey = assignedDay || (!isShiftStart && activeSlotKey ? activeSlotKey : recordSlotKey);
            if (!slotKey) return;

            groups[slotKey] = [...(groups[slotKey] || []), record];
            if (isShiftStart) activeSlotKey = slotKey;
            if (isAttendanceTimeOutSource(record.source)) activeSlotKey = "";
        });

    return groups;
}
