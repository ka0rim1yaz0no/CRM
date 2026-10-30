type TimeOutEvent = { id: string; source: string; at: string; sequence?: number };
type TimeOutSession = { id: string; startedAt: string; events: TimeOutEvent[] };

export const timeOutBeforeTimeInMessage = "Time Out is before Time In. Check the date and AM/PM; an overnight checkout may belong to the next day.";

export function validateTimeOutOrder(timeIn: string, timeOut: string) {
    const start = Date.parse(timeIn), end = Date.parse(timeOut);
    if (Number.isFinite(start) && Number.isFinite(end) && end < start) throw new Error(timeOutBeforeTimeInMessage);
}

export function attendanceTimeOutPlan(sessions: TimeOutSession[], sessionId: string, at: string, serverTime: string) {
    const session = sessions.find(item => item.id === sessionId);
    if (!session || session.events.some(event => ["Time Out", "Logout"].includes(event.source))) {
        throw new Error("This session already has a Time Out or changed. Refresh attendance and select the shift again.");
    }
    const cutoff = Date.parse(at), now = Date.parse(serverTime), start = Date.parse(session.startedAt);
    if (!Number.isFinite(cutoff) || !Number.isFinite(start)) throw new Error("Check the Time In and Time Out date and time values.");
    validateTimeOutOrder(session.startedAt, at);
    if (!Number.isFinite(now) || cutoff > now) throw new Error("Time Out cannot be in the future. Refresh attendance if you need the current time.");
    const next = sessions.filter(item => Date.parse(item.startedAt) > start).sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt))[0];
    if (next && cutoff >= Date.parse(next.startedAt)) throw new Error("Time Out must be before the next session's Time In.");
    const ordered = [...session.events].sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || (a.sequence ?? 0) - (b.sequence ?? 0));
    const replaced = ordered.filter(event => Date.parse(event.at) > cutoff);
    const last = ordered.filter(event => Date.parse(event.at) <= cutoff).at(-1);
    const incoming: Record<string, string> = { "Break Out": "Break In", "Lunch Break Out": "Lunch Break In",
        "Off the Phone Out": "Off the Phone In", "Non-Billable Off the Phone Out": "Off the Phone In", "Coaching Out": "Coaching In" };
    return { at: new Date(cutoff).toISOString(), replaced, returnSource: last ? incoming[last.source] : undefined };
}
