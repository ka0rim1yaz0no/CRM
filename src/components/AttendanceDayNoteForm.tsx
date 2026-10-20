import { useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { FiRefreshCw, FiSave } from "react-icons/fi";
import { getAttendanceHubDay, saveAttendanceHubNote, type AttendanceHubNoteRequest, type HubDay } from "../api/attendanceHub";
import { refreshAttendanceWorkspace } from "../lib/employeeWorkspaceCache";
import { attendanceNoteDraft, mergeConfirmedAttendanceNote, type AttendanceNoteDraft } from "../lib/attendanceNoteState";

type Draft = AttendanceNoteDraft;
export default function AttendanceDayNoteForm({ day }: { day: HubDay }) {
    const client = useQueryClient();
    const [draft, setDraft] = useState<Draft | null>(null);
    const [reloading, setReloading] = useState(false);
    const [reloadError, setReloadError] = useState("");
    const pending = useRef<(AttendanceHubNoteRequest & Draft) | null>(null);
    const reason = draft?.reason ?? day.note;
    const excused = draft?.excused ?? day.noteExcused ?? day.excused;
    const key = ["attendance-hub-day", day.businessId, day.dayKey, day.employeeCode];
    const save = useMutation({
        mutationFn: async (input: Draft) => {
            const request = pending.current ??= { ...input, commandId: crypto.randomUUID() };
            const saved = await saveAttendanceHubNote(day, request.reason, request.excused, request);
            if (saved.reason !== request.reason || saved.excused !== request.excused) throw new Error("The committed note did not match your draft. Reload revisions before retrying.");
            if (saved.attendanceRevision === undefined) {
                const confirmed = await getAttendanceHubDay(day.dayKey, day.employeeCode, day.businessId);
                if (confirmed.note !== input.reason || (confirmed.noteExcused ?? confirmed.excused) !== input.excused) throw new Error("The saved note could not be confirmed. Your draft is retained.");
                client.setQueryData(key, confirmed);
            } else {
                client.setQueryData<HubDay>(key, (current) => mergeConfirmedAttendanceNote(current, saved));
            }
            return saved;
        },
        onSuccess: async () => {
            pending.current = null; setDraft(null);
            await refreshAttendanceWorkspace(client);
        },
    });
    const change = (next: { reason: string; excused: boolean }) => {
        save.reset(); setReloadError(""); pending.current = null;
        setDraft(attendanceNoteDraft(day, draft, next));
    };
    const reload = async () => {
        setReloading(true); setReloadError("");
        try {
            const confirmed = await getAttendanceHubDay(day.dayKey, day.employeeCode, day.businessId);
            client.setQueryData(key, confirmed);
            setDraft((current) => current ? { ...current, expectedRevision: confirmed.attendanceRevision, expectedNoteRevision: confirmed.noteRevision } : null);
            pending.current = null; save.reset();
        } catch { setReloadError("Could not reload revisions. Your note draft is retained."); }
        finally { setReloading(false); }
    };
    const failure = save.error as { response?: { data?: { message?: string } }; message?: string } | null;
    return <form className="attendance-hub-note" onSubmit={(event) => {
        event.preventDefault();
        if (!save.isPending && !reloading) {
            const input = attendanceNoteDraft(day, draft, { reason: reason.trim(), excused });
            setDraft(input); save.mutate(input);
        }
    }}>
        <h3>Admin note / excuse</h3>
        <textarea aria-label="Attendance note" value={reason} disabled={save.isPending || reloading} maxLength={1000}
            onChange={(event) => change({ reason: event.target.value, excused })} />
        <label><input type="checkbox" checked={excused} disabled={save.isPending || reloading}
            onChange={(event) => change({ reason, excused: event.target.checked })} /> Excused</label>
        <button type="submit" disabled={save.isPending || reloading || (excused && !reason.trim())}><FiSave aria-hidden="true" /> {save.isPending ? "Saving note..." : "Save note"}</button>
        <button type="button" title="Reload note revisions" aria-label="Reload note revisions" disabled={save.isPending || reloading} onClick={() => void reload()}><FiRefreshCw aria-hidden="true" /></button>
        {save.isSuccess && <p role="status">{save.data?.syncPending ? "Note saved. Business synchronization is pending and will retry automatically." : "Note saved."}</p>}
        {save.isError && <p className="attendance-hub-error" role="alert">{failure?.response?.data?.message || failure?.message || "Could not save the note. Your text is still here."}</p>}
        {reloadError && <p className="attendance-hub-error" role="alert">{reloadError}</p>}
    </form>;
}
