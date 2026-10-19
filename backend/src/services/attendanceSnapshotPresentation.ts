import type { AssignedShift, SessionEvent } from "./attendanceSessionState";
import { attendanceEventStatus } from "./attendanceShift";

// Preserve the existing server classifier when adapting canonical events for legacy views.
export function withAttendanceStatuses<T extends { records: SessionEvent[]; sessions: Array<{ shift: AssignedShift | null; events: SessionEvent[] }> }>(snapshot: T, graceMinutes: number) {
    const { records, sessions, ...rest } = snapshot;
    const shifts = new Map(sessions.flatMap((session) => session.events.map((event) => [event.id, session.shift] as const)));
    const present = (event: SessionEvent) => ({ ...event,
        attendanceStatus: attendanceEventStatus(event.source, new Date(event.at), shifts.get(event.id) || null, graceMinutes) });
    return { ...rest, records: records.map(present),
        sessions: sessions.map((session) => ({ ...session, events: session.events.map(present) })) };
}
