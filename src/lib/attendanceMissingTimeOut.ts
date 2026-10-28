import type { AttendanceCommand, AttendanceSessionSnapshot, SessionEvent } from "../api/attendanceSession";
import { attendanceInputValue, buildAttendanceDraftChanges } from "./attendanceCommandDraft";
import { attendanceTimeOutPlan } from "../../shared/attendanceTimeOut";

const checkout = (event: SessionEvent) => event.source === "Time Out" || event.source === "Logout";

// Select server-assigned sessions only. All durations and deductions remain server calculations.
export function missingTimeOutSessions(snapshot: AttendanceSessionSnapshot | undefined, dayKey?: string) {
    if (!snapshot) return [];
    return snapshot.sessions.filter(session => (dayKey ? session.shift?.dayKey === dayKey : session.id === snapshot.sessions.at(-1)?.id)
        && session.shift && session.events.some(event => event.source === "Time In" || event.source === "Login")
        && !session.events.some(checkout));
}

export function missingTimeOutDraft(snapshot: AttendanceSessionSnapshot, dayKey: string | undefined, sessionId: string, selectedValue?: string) {
    const session = missingTimeOutSessions(snapshot, dayKey).find(item => item.id === sessionId);
    if (!session) throw new Error("This session already has a Time Out or changed. Refresh attendance and select the shift again.");
    const next = snapshot.sessions.find(item => Date.parse(item.startedAt) > Date.parse(session.startedAt));
    const limit = Math.min(Date.parse(snapshot.serverTime), next ? Date.parse(next.startedAt) - 1000 : Infinity);
    const proposed = Math.min(Date.parse(session.shift!.end), limit);
    const value = Number.isFinite(proposed) ? attendanceInputValue(new Date(proposed).toISOString()) : "";
    const selected = selectedValue ?? value;
    let plan: ReturnType<typeof attendanceTimeOutPlan> | undefined;
    let validationError = "";
    try { plan = attendanceTimeOutPlan(snapshot.sessions, sessionId, new Date(`${selected}+08:00`).toISOString(), snapshot.serverTime); }
    catch (error) { validationError = error instanceof Error ? error.message : "Check the Time Out date and time."; }
    return { session, returnSource: plan?.returnSource as SessionEvent["source"] | undefined, replaced: plan?.replaced || [], min: attendanceInputValue(session.startedAt),
        max: Number.isFinite(limit) ? attendanceInputValue(new Date(limit).toISOString()) : "",
        value, validationError };
}

export function missingTimeOutChanges(snapshot: AttendanceSessionSnapshot, dayKey: string | undefined, sessionId: string, value: string, closeRest: boolean): NonNullable<AttendanceCommand["changes"]> {
    missingTimeOutDraft(snapshot, dayKey, sessionId);
    const change = buildAttendanceDraftChanges([{ source: "Time Out", value }])[0];
    const at = change?.at;
    const plan = attendanceTimeOutPlan(snapshot.sessions, sessionId, at || "", snapshot.serverTime);
    if (plan.returnSource && !closeRest) throw new Error("Confirm closing the open break, lunch or off-phone interval at the same time, or correct its return first.");
    return [...plan.replaced.map(event => ({ targetId: event.id, remove: true })),
        ...(plan.returnSource ? [{ source: plan.returnSource as SessionEvent["source"], at: plan.at }] : []), { source: "Time Out", at: plan.at }];
}
