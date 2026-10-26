import type { AttendanceSessionSnapshot, SessionEvent } from "../api/attendanceSession";

export function attendanceEventsForDay(snapshot: AttendanceSessionSnapshot | undefined, dayKey?: string) {
    if (!snapshot) return [];
    const ids = dayKey ? new Set(snapshot.sessions.filter(session => session.shift?.dayKey === dayKey).flatMap(session => session.events.map(event => event.id))) : null;
    return snapshot.records.filter(event => !ids || ids.has(event.id));
}

// This is a UI availability check, not a second attendance calculator. The
// server still previews and validates every undo against the current ledger.
export function attendanceUndoAvailability(snapshot: AttendanceSessionSnapshot | undefined, target: SessionEvent | null | undefined, dayKey?: string) {
    const blocked = (reason: string) => ({ allowed: false, reason });
    if (!snapshot || !target) return blocked("There is no attendance action to undo for this shift.");
    const current = snapshot.records.find(event => event.id === target.id);
    if (!current || !attendanceEventsForDay(snapshot, dayKey).some(event => event.id === current.id)) return blocked("This event changed or belongs to another shift. Refresh attendance and select it again.");
    const visibleIds = new Set(attendanceEventsForDay(snapshot, dayKey).map(event => event.id));
    const group = snapshot.records.filter(event => event.commandId === current.commandId);
    if (group.some(event => !visibleIds.has(event.id))) return blocked("This recorded action includes another shift. Use a reviewed attendance correction instead.");
    const audit = snapshot.audit.find(item => item.commandId === current.commandId);
    const addedTimeOut = audit?.operation === "add-time-out" && audit.actor.role === "admin";
    if (!addedTimeOut && (!audit || audit.operation !== "action" || audit.actor.role !== "employee" || group.some(event => event.autoTimeOut))) {
        return blocked("Imported, automatic and administratively corrected events require a reviewed attendance correction, not Undo.");
    }
    const session = snapshot.sessions.find(item => item.events.some(event => group.some(member => member.id === event.id)));
    if (session?.lifecycle === "system-closed") return blocked("This session was closed by the system. Use a reviewed attendance correction instead.");
    if (!addedTimeOut && group.some(event => event.source === "Time Out" || event.source === "Logout") &&
        (!session || snapshot.sessions.at(-1)?.id !== session.id || (session.shift && Date.parse(snapshot.serverTime) >= Date.parse(session.shift.resetDeadline)))) {
        return blocked("This checkout cannot reopen an old session. Use a reviewed attendance correction instead.");
    }
    return { allowed: true, reason: "" };
}

// A completed rest interval can be reversed as one explicit, reviewed
// correction. Never remove unrelated newer actions or half an atomic command.
export function attendanceUndoPlan(snapshot: AttendanceSessionSnapshot, target: SessionEvent, dayKey?: string) {
    const availability = attendanceUndoAvailability(snapshot, target, dayKey);
    if (!availability.allowed) throw new Error(availability.reason);
    const current = snapshot.records.find(event => event.id === target.id)!;
    const group = snapshot.records.filter(event => event.commandId === current.commandId);
    const session = snapshot.sessions.find(item => item.events.some(event => event.id === current.id));
    const pairs = [["Break Out", "Break In"], ["Lunch Break Out", "Lunch Break In"], ["Off the Phone Out", "Off the Phone In", "Non-Billable Off the Phone Out"]];
    const pair = pairs.find(sources => sources.includes(current.source));
    const isLatest = snapshot.records.at(-1)?.commandId === current.commandId;
    if (!session || !pair || group.length !== 1 || (current.source === pair[1] && isLatest)) {
        return { events: group, paired: false };
    }
    const index = session.events.findIndex(event => event.id === current.id);
    const candidates = current.source !== pair[1] ? session.events.slice(index + 1) : session.events.slice(0, index).reverse();
    const other = candidates.find(event => pair.includes(event.source));
    if (!other || (other.source === pair[1]) === (current.source === pair[1])) return { events: group, paired: false };
    const otherGroup = snapshot.records.filter(event => event.commandId === other.commandId);
    if (otherGroup.length !== 1 || !attendanceUndoAvailability(snapshot, other, dayKey).allowed) {
        return { events: group, paired: false };
    }
    return { events: session.events.filter(event => event.id === current.id || event.id === other.id), paired: true };
}

export function attendanceCorrectionError(error: unknown) {
    const response = (error as { response?: { data?: { message?: string; details?: Array<{ message?: string }> } } })?.response?.data;
    const message = response?.message || (error instanceof Error ? error.message : "Attendance is unavailable.");
    const details = [...new Set((Array.isArray(response?.details) ? response.details : []).map(detail => detail?.message).filter((detail): detail is string => typeof detail === "string" && Boolean(detail.trim())))];
    return [message, ...details.filter(detail => detail !== message)].join(" ");
}
