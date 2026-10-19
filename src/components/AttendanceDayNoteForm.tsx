import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { getAttendanceHubDay, saveAttendanceHubNote, type HubDay } from "../api/attendanceHub";

export default function AttendanceDayNoteForm({ day }: { day: HubDay }) {
    const client = useQueryClient();
    const [draft, setDraft] = useState<{ reason: string; excused: boolean } | null>(null);
    const reason = draft?.reason ?? day.note;
    const excused = draft?.excused ?? day.excused;
    const save = useMutation({
        mutationFn: async (input: { reason: string; excused: boolean }) => {
            await saveAttendanceHubNote(day, input.reason, input.excused);
            const confirmed = await getAttendanceHubDay(day.dayKey, day.employeeCode, day.businessId);
            if (confirmed.note !== input.reason) throw new Error("The saved note could not be confirmed. Refresh this shift before trying again.");
            return confirmed;
        },
        onSuccess: async (confirmed) => {
            client.setQueryData(["attendance-hub-day", day.businessId, day.dayKey, day.employeeCode], confirmed);
            setDraft(null);
            await client.invalidateQueries({ queryKey: ["attendance-hub"] });
        },
    });
    const failure = save.error as { response?: { data?: { message?: string } }; message?: string } | null;
    return <form className="attendance-hub-note" onSubmit={(event) => {
        event.preventDefault();
        if (!save.isPending) save.mutate({ reason: reason.trim(), excused });
    }}>
        <h3>Admin note / excuse</h3>
        <textarea aria-label="Attendance note" value={reason} disabled={save.isPending} maxLength={1000}
            onChange={(event) => { save.reset(); setDraft({ reason: event.target.value, excused }); }} />
        <label><input type="checkbox" checked={excused} disabled={save.isPending}
            onChange={(event) => { save.reset(); setDraft({ reason, excused: event.target.checked }); }} /> Excused</label>
        <button type="submit" disabled={save.isPending || (excused && !reason.trim())}>{save.isPending ? "Saving note..." : "Save note"}</button>
        {save.isSuccess && <p role="status">Note saved.</p>}
        {save.isError && <p className="attendance-hub-error" role="alert">{failure?.response?.data?.message || failure?.message || "Could not save the note. Your text is still here."}</p>}
    </form>;
}
