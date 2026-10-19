import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { attendanceIntegrityEnabled, getAttendancePolicy, saveAttendancePolicy, type AttendancePolicy } from "../api/attendanceSession";

export default function AttendancePolicyEditor() {
    const client = useQueryClient();
    const query = useQuery({ queryKey: ["attendance-policy"], queryFn: getAttendancePolicy, enabled: attendanceIntegrityEnabled });
    const [draft, setDraft] = useState<AttendancePolicy | null>(null);
    const save = useMutation({ mutationFn: () => saveAttendancePolicy(draft!), onSuccess: () => { setDraft(null); void client.invalidateQueries({ queryKey: ["attendance-policy"] }); void client.invalidateQueries({ queryKey: ["attendance-hub"] }); } });
    if (!attendanceIntegrityEnabled) return null;
    const policy = draft || query.data;
    return <details className="attendance-corrections"><summary>Attendance configuration</summary>
        {query.isPending && <p>Loading configuration...</p>}
        {policy && <form onSubmit={(event) => { event.preventDefault(); if (draft) save.mutate(); }}>
            <p>Official shift: 23:00 to 08:00 Asia/Manila. Settings apply across assigned businesses.</p>
            {([['graceMinutes', 'Late grace (minutes)'], ['breakMinutes', 'Break allowance (minutes)'], ['lunchMinutes', 'Lunch allowance (minutes)']] as const).map(([key, label]) =>
                <label key={key}>{label}<input type="number" min={key === "graceMinutes" ? 0 : 1} max={240} step={1} value={policy[key]} onChange={(event) => setDraft({ ...policy, [key]: Number(event.target.value) })} /></label>)}
            <label><input type="checkbox" checked={policy.recoveryEnabled} onChange={(event) => setDraft({ ...policy, recoveryEnabled: event.target.checked })} /> Enable administrative missing-checkout recovery</label>
            <label>Recovery cutoff (PH time)<input type="time" value={policy.recoveryTime} onChange={(event) => setDraft({ ...policy, recoveryTime: event.target.value })} /></label>
            <p>Recovery records a system closure, never a Time Out or invented working hours. It is off by default.</p>
            <button type="submit" disabled={!draft || save.isPending}>{save.isPending ? "Saving..." : "Save configuration"}</button>
        </form>}
        {(save.isError || query.isError) && <p role="alert">{(save.error || query.error) instanceof Error ? (save.error || query.error)?.message : "Unable to save configuration. Refresh and review your draft."}</p>}
        {save.isSuccess && <p role="status">Configuration saved.</p>}
    </details>;
}
