import type { AttendanceHubNoteResponse, HubDay } from "../api/attendanceHub";

export type AttendanceNoteDraft = { reason: string; excused: boolean; expectedRevision?: number; expectedNoteRevision?: number };

export function attendanceNoteDraft(day: HubDay, current: AttendanceNoteDraft | null, values: { reason: string; excused: boolean }): AttendanceNoteDraft {
    return { ...values, expectedRevision: current ? current.expectedRevision : day.attendanceRevision,
        expectedNoteRevision: current ? current.expectedNoteRevision : day.noteRevision };
}

export function mergeConfirmedAttendanceNote(current: HubDay | undefined, saved: AttendanceHubNoteResponse): HubDay | undefined {
    if (!current || saved.employeeCode !== current.employeeCode || saved.dayKey !== current.dayKey ||
        (saved.businessId && saved.businessId !== current.businessId) || (saved.noteRevision ?? 0) < (current.noteRevision ?? 0)) return current;
    return { ...current, note: saved.reason, noteExcused: saved.excused, excused: saved.excused || Boolean(current.leave),
        noteRevision: saved.noteRevision, attendanceRevision: Math.max(current.attendanceRevision ?? 0, saved.attendanceRevision ?? 0), syncPending: saved.syncPending };
}
