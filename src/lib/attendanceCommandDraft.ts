export type DraftRecord = { id: string; source: string; at: string };
export type DraftField = { value: string; original?: DraftRecord; source: string };
export type DraftChange = { targetId?: string; remove?: boolean; source?: string; at?: string };
export function attendanceInputValue(value?: string) {
    if (!value) return "";
    const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Manila", year: "numeric", month: "2-digit", day: "2-digit",
        hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).formatToParts(new Date(value));
    const part = (key: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === key)?.value || "00";
    return `${part("year")}-${part("month")}-${part("day")}T${part("hour")}:${part("minute")}:${part("second")}`;
}
export function buildAttendanceDraftChanges(fields: DraftField[]) {
    return fields.flatMap<DraftChange>((field) => {
        const originalValue = field.original ? attendanceInputValue(field.original.at) : "";
        if (field.value === originalValue) return [];
        if (!field.value) return field.original ? [{ targetId: field.original.id, remove: true }] : [];
        const date = new Date(`${field.value}+08:00`);
        if (!Number.isFinite(date.getTime())) throw new Error("Check the date and time values before saving.");
        return [{ ...(field.original ? { targetId: field.original.id } : {}), source: field.original?.source || field.source, at: date.toISOString() }];
    });
}
