import { formatTimeInTimeZone } from "./dateTime";

export function attendanceEventPresentation(source?: string) {
    switch (source) {
        case "Login": case "Time In": return { label: "ONLINE", kind: "online" as const };
        case "Logout": case "Time Out": return { label: "OFFLINE", kind: "offline" as const };
        case "Break Out": return { label: "Break", kind: "break" as const };
        case "Break In": return { label: "Break ended", kind: "break" as const };
        case "Lunch Break Out": return { label: "LUNCH", kind: "lunch" as const };
        case "Lunch Break In": return { label: "Lunch ended", kind: "lunch" as const };
        case "Off the Phone Out": return { label: "Off the Phone", kind: "off-phone" as const };
        case "Non-Billable Off the Phone Out": return { label: "Non-Billable Off the Phone", kind: "off-phone" as const };
        case "Off the Phone In": return { label: "Off the phone ended", kind: "off-phone" as const };
        default: return { label: "No attendance yet", kind: "unknown" as const };
    }
}

export function attendanceOnlineActionLabel(status: string) {
    switch (status) {
        case "OFFLINE": return "Time in";
        case "BREAK": return "End break";
        case "LUNCH": return "End lunch";
        case "OFF THE PHONE": return "End off the phone";
        default: return "ONLINE";
    }
}

export function displayedAttendanceSession<T extends { id: string; startedAt: string }>(sessions: T[], activeId: string | null) {
    return sessions.find((session) => session.id === activeId) ||
        [...sessions].sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt))[0];
}

export function compareAttendanceRecords(first: { timeIn: string; sequence?: number }, second: { timeIn: string; sequence?: number }) {
    return Date.parse(first.timeIn) - Date.parse(second.timeIn) ||
        (first.sequence !== undefined && second.sequence !== undefined ? first.sequence - second.sequence : 0);
}

export function mergeAttendanceHistory<T extends { _id: string; timeIn: string; sequence?: number }>(current: T[], incoming: T[]) {
    const records = new Map(current.map((record) => [record._id, record]));
    for (const record of incoming) records.set(record._id, record);
    return [...records.values()].sort((a, b) => compareAttendanceRecords(b, a));
}

export function formatAttendanceTimePair(first?: string, second?: string, timeZone = "Asia/Manila") {
    const firstLabel = formatTimeInTimeZone(first, timeZone) || "Not recorded";
    const secondLabel = formatTimeInTimeZone(second, timeZone) || "Not recorded";
    return `${firstLabel} - ${secondLabel}`;
}
