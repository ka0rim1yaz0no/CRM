import type { AttendanceCommand, AttendanceSessionSnapshot, SessionEvent } from "../api/attendanceSession";
import { attendanceInputValue, buildAttendanceDraftChanges } from "./attendanceCommandDraft";

const checkout = (event: SessionEvent) => event.source === "Time Out" || event.source === "Logout";
const returnSources: Partial<Record<SessionEvent["source"], SessionEvent["source"]>> = {
    "Break Out": "Break In", "Lunch Break Out": "Lunch Break In", "Off the Phone Out": "Off the Phone In",
};

// Select server-assigned sessions only. All durations and deductions remain server calculations.
export function missingTimeOutSessions(snapshot: AttendanceSessionSnapshot | undefined, dayKey?: string) {
    if (!snapshot) return [];
    return snapshot.sessions.filter(session => (dayKey ? session.shift?.dayKey === dayKey : session.id === snapshot.sessions.at(-1)?.id)
        && session.shift && session.events.some(event => event.source === "Time In" || event.source === "Login")
        && !session.events.some(checkout));
}

export function missingTimeOutDraft(snapshot: AttendanceSessionSnapshot, dayKey: string | undefined, sessionId: string) {
    const session = missingTimeOutSessions(snapshot, dayKey).find(item => item.id === sessionId);
    if (!session) throw new Error("This session already has a Time Out or changed. Refresh attendance and select the shift again.");
    const last = session.events.at(-1)!;
    const next = snapshot.sessions.find(item => Date.parse(item.startedAt) > Date.parse(session.startedAt));
    const limit = Math.min(Date.parse(snapshot.serverTime), next ? Date.parse(next.startedAt) - 1000 : Infinity);
    const proposed = Math.min(Date.parse(session.shift!.end), limit);
    const value = Number.isFinite(proposed) ? attendanceInputValue(new Date(proposed).toISOString()) : "";
    return { session, returnSource: returnSources[last.source], min: attendanceInputValue(last.at),
        max: Number.isFinite(limit) ? attendanceInputValue(new Date(limit).toISOString()) : "",
        value: value && Date.parse(`${value}+08:00`) >= Date.parse(last.at) ? value : "" };
}

export function missingTimeOutChanges(snapshot: AttendanceSessionSnapshot, dayKey: string | undefined, sessionId: string, value: string, closeRest: boolean): NonNullable<AttendanceCommand["changes"]> {
    const draft = missingTimeOutDraft(snapshot, dayKey, sessionId);
    const change = buildAttendanceDraftChanges([{ source: "Time Out", value }])[0];
    const at = change?.at;
    if (!at || Date.parse(at) < Date.parse(draft.session.events.at(-1)!.at)) throw new Error("Time Out must be at or after the last action in this session.");
    if (Date.parse(at) > Date.parse(snapshot.serverTime)) throw new Error("Time Out cannot be in the future. Refresh attendance if you need the current time.");
    const next = snapshot.sessions.find(item => Date.parse(item.startedAt) > Date.parse(draft.session.startedAt));
    if (next && Date.parse(at) >= Date.parse(next.startedAt)) throw new Error("Time Out must be before the next session's Time In.");
    if (draft.returnSource && !closeRest) throw new Error("Confirm closing the open break, lunch or off-phone interval at the same time, or correct its return first.");
    return [...(draft.returnSource ? [{ source: draft.returnSource, at }] : []), { source: "Time Out", at }];
}
