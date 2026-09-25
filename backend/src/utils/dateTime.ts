export const APP_TIME_ZONE = "America/Chicago";
const CDT_OFFSET_MS = 5 * 60 * 60 * 1000;

const cstDateTimeFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: "UTC",
  month: "short",
  day: "numeric",
  year: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

const cstDateFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: "UTC",
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

const phDateFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: "Asia/Manila",
  month: "short",
  day: "numeric",
  year: "numeric",
});

export function formatCstDateTime(value?: Date | string | null) {
  if (!value) {
    return "";
  }

  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : `${cstDateTimeFormatter.format(new Date(date.getTime() - CDT_OFFSET_MS))} CDT`;
}

export function formatCstDate(value?: Date | string | null) {
  if (!value) {
    return "";
  }

  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : cstDateFormatter.format(new Date(date.getTime() - CDT_OFFSET_MS));
}

export function formatPhDateTime(value?: Date | string | null) {
  if (!value) {
    return "";
  }

  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : phDateTimeFormatter.format(date);
}

export function formatPhDate(value?: Date | string | null) {
  if (!value) {
    return "";
  }

  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : phDateFormatter.format(date);
}
