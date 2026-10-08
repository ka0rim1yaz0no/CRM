export const APP_TIME_ZONE = "America/Chicago";
export const LEAD_SCHEDULE_TIME_ZONE = "America/New_York";
const CDT_OFFSET_MS = 5 * 60 * 60 * 1000;

const dateTimeFormatter = new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
});

const dateFormatter = new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    month: "short",
    day: "numeric",
    year: "numeric",
});

const timeFormatter = new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    hour: "numeric",
    minute: "2-digit",
});

const phDateFormatter = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Manila",
    month: "short",
    day: "numeric",
    year: "numeric",
});

const phDateTimeFormatter = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Manila",
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
});

const phTimeFormatter = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Manila",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
});

function makeFormatter(options: Intl.DateTimeFormatOptions) {
    return new Intl.DateTimeFormat("en-US", options);
}

function zonedDateTimeParts(value: Date, timeZone: string) {
    const parts = new Intl.DateTimeFormat("en-CA", {
        timeZone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
    }).formatToParts(value);
    const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));

    return {
        year: Number(values.year),
        month: Number(values.month),
        day: Number(values.day),
        hour: Number(values.hour === "24" ? "00" : values.hour),
        minute: Number(values.minute),
    };
}

function zonedDateTimeToUtc(
    year: number,
    month: number,
    day: number,
    hour: number,
    minute: number,
    timeZone: string
) {
    const requestedWallClock = Date.UTC(year, month - 1, day, hour, minute);
    let utcTime = requestedWallClock;

    for (let attempt = 0; attempt < 4; attempt += 1) {
        const actual = zonedDateTimeParts(new Date(utcTime), timeZone);
        const actualWallClock = Date.UTC(actual.year, actual.month - 1, actual.day, actual.hour, actual.minute);
        const adjustment = requestedWallClock - actualWallClock;

        if (adjustment === 0) {
            return new Date(utcTime);
        }

        utcTime += adjustment;
    }

    return null;
}

export function formatCstDateTime(value?: Date | string | null) {
    if (!value) {
        return "";
    }

    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? "" : `${dateTimeFormatter.format(new Date(date.getTime() - CDT_OFFSET_MS))} CDT`;
}

export function formatCstDate(value?: Date | string | null) {
    if (!value) {
        return "";
    }

    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? "" : dateFormatter.format(new Date(date.getTime() - CDT_OFFSET_MS));
}

export function formatCstTime(value?: Date | string | null) {
    if (!value) {
        return "";
    }

    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? "" : `${timeFormatter.format(new Date(date.getTime() - CDT_OFFSET_MS))} CDT`;
}

export function formatLeadScheduleDateTime(value?: Date | string | null) {
    if (!value) {
        return "";
    }

    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "";

    return makeFormatter({
        timeZone: LEAD_SCHEDULE_TIME_ZONE,
        month: "short",
        day: "numeric",
        year: "numeric",
        hour: "numeric",
        minute: "2-digit",
        timeZoneName: "short",
    }).format(date);
}

export function formatLeadScheduleDate(value?: Date | string | null) {
    return formatDateInTimeZone(value, LEAD_SCHEDULE_TIME_ZONE);
}

export function formatLeadScheduleDateTimeInput(value?: Date | string | null) {
    if (!value) {
        return "";
    }

    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "";
    const parts = zonedDateTimeParts(date, LEAD_SCHEDULE_TIME_ZONE);

    return [
        String(parts.year).padStart(4, "0"),
        String(parts.month).padStart(2, "0"),
        String(parts.day).padStart(2, "0"),
    ].join("-") + `T${String(parts.hour).padStart(2, "0")}:${String(parts.minute).padStart(2, "0")}`;
}

export function getCurrentLeadScheduleDateTimeInput() {
    return formatLeadScheduleDateTimeInput(new Date());
}

export function parseLeadScheduleDateTimeInput(value: string) {
    const match = value.trim().match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/);

    if (!match) {
        return null;
    }

    const [, year, month, day, hour, minute] = match;
    return zonedDateTimeToUtc(
        Number(year),
        Number(month),
        Number(day),
        Number(hour),
        Number(minute),
        LEAD_SCHEDULE_TIME_ZONE
    );
}

export function formatPhDate(value?: Date | string | null) {
    if (!value) {
        return "";
    }

    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? "" : phDateFormatter.format(date);
}

export function formatPhDateTime(value?: Date | string | null) {
    if (!value) {
        return "";
    }

    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? "" : phDateTimeFormatter.format(date);
}

export function formatPhTime(value?: Date | string | null) {
    if (!value) {
        return "";
    }

    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? "" : phTimeFormatter.format(date);
}

export function formatPhDateTimeInput(value?: Date | string | null) {
    if (!value) {
        return "";
    }

    const date = new Date(value);

    if (Number.isNaN(date.getTime())) {
        return "";
    }

    const parts = new Intl.DateTimeFormat("en-US", {
        timeZone: "Asia/Manila",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
    }).formatToParts(date);
    const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    const hour = values.hour === "24" ? "00" : values.hour;

    return `${values.year}-${values.month}-${values.day}T${hour}:${values.minute}`;
}

export function getCurrentPhDateTimeInput() {
    return formatPhDateTimeInput(new Date());
}

export function parsePhDateTimeInput(value: string) {
    const match = value.trim().match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/);

    if (!match) {
        return null;
    }

    const [, year, month, day, hour, minute] = match;
    const parsedDate = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour) - 8, Number(minute)));

    return Number.isNaN(parsedDate.getTime()) ? null : parsedDate;
}

export function formatDateInTimeZone(value?: Date | string | null, timeZone = "America/Chicago") {
    if (!value) {
        return "";
    }

    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "";
    return makeFormatter({
        timeZone,
        month: "short",
        day: "numeric",
        year: "numeric",
    }).format(date);
}

export function formatTimeInTimeZone(value?: Date | string | null, timeZone = "America/Chicago") {
    if (!value) {
        return "";
    }

    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "";
    return makeFormatter({
        timeZone,
        hour: "numeric",
        minute: "2-digit",
        second: "2-digit",
    }).format(date);
}

export function formatCstDateTimeInput(value?: Date | string | null) {
    if (!value) {
        return "";
    }

    const date = new Date(value);

    if (Number.isNaN(date.getTime())) {
        return "";
    }

    const cstDate = new Date(date.getTime() - CDT_OFFSET_MS);
    const year = cstDate.getUTCFullYear();
    const month = String(cstDate.getUTCMonth() + 1).padStart(2, "0");
    const day = String(cstDate.getUTCDate()).padStart(2, "0");
    const hours = String(cstDate.getUTCHours()).padStart(2, "0");
    const minutes = String(cstDate.getUTCMinutes()).padStart(2, "0");

    return `${year}-${month}-${day}T${hours}:${minutes}`;
}

export function formatCstDateInput(value?: Date | string | null) {
    if (!value) {
        return "";
    }

    const date = new Date(value);

    if (Number.isNaN(date.getTime())) {
        return "";
    }

    const cstDate = new Date(date.getTime() - CDT_OFFSET_MS);
    const year = cstDate.getUTCFullYear();
    const month = String(cstDate.getUTCMonth() + 1).padStart(2, "0");
    const day = String(cstDate.getUTCDate()).padStart(2, "0");

    return `${year}-${month}-${day}`;
}

export function getCurrentCstDateTimeInput() {
    return formatCstDateTimeInput(new Date());
}

export function getCurrentCstDateInput() {
    return formatCstDateInput(new Date());
}

export function parseCstDateTimeInput(value: string) {
    const normalizedValue = value.trim();

    if (!normalizedValue) {
        return null;
    }

    const parsedDate = new Date(`${normalizedValue}:00-05:00`);

    return Number.isNaN(parsedDate.getTime()) ? null : parsedDate;
}

export function parseCstDateInput(value: string, boundary: "start" | "end" = "start") {
    const normalizedValue = value.trim();

    if (!normalizedValue) {
        return null;
    }

    const time = boundary === "end" ? "23:59:59.999" : "00:00:00.000";
    const parsedDate = new Date(`${normalizedValue}T${time}-05:00`);

    return Number.isNaN(parsedDate.getTime()) ? null : parsedDate;
}
