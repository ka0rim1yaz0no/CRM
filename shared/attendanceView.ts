export type ShiftView = "today" | "date" | "all";
export const attendanceHistoryWindowDays = 31;

export function manilaCalendarDate(now: Date) {
    return new Date(now.getTime() + 8 * 60 * 60_000).toISOString().slice(0, 10);
}

export function shiftDateOffset(day: string, days: number) {
    const date = new Date(`${day}T00:00:00Z`);
    date.setUTCDate(date.getUTCDate() + days);
    return date.toISOString().slice(0, 10);
}

export function attendanceViewRange(view: ShiftView, now: Date, date?: string, historyPage = 1) {
    const today = manilaCalendarDate(now);
    if (view === "today") return { from: today, to: today };
    if (view === "date") {
        if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(`${date}T00:00:00Z`))
            || new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date || date > today) {
            throw new Error("Invalid shift date. Choose today or an earlier date.");
        }
        return { from: date, to: date };
    }
    if (!Number.isInteger(historyPage) || historyPage < 1 || historyPage > 1200) throw new Error("Invalid history page.");
    const to = shiftDateOffset(today, -(historyPage - 1) * attendanceHistoryWindowDays);
    return { from: shiftDateOffset(to, 1 - attendanceHistoryWindowDays), to };
}
