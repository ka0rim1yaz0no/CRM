import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { attendanceDurationModelEnabled, attendanceIntegrityEnabled, getAttendancePolicy, saveAttendancePolicy, type AttendancePolicy } from "../api/attendanceSession";
import { getAuthUser } from "../api/authStorage";
import { validAttendanceCutoff } from "../lib/attendanceDurationUi";
import { refreshAttendanceWorkspace } from "../lib/employeeWorkspaceCache";
import { FiSave } from "react-icons/fi";

export default function AttendancePolicyEditor() {
    const client = useQueryClient();
    const enabled = getAuthUser()?.userType === "admin" && (attendanceIntegrityEnabled || attendanceDurationModelEnabled);
    const query = useQuery({ queryKey: ["attendance-policy"], queryFn: getAttendancePolicy, enabled });
    const [draft, setDraft] = useState<AttendancePolicy | null>(null);
    const [validationError, setValidationError] = useState("");
    const save = useMutation({ mutationFn: () => saveAttendancePolicy({ ...draft!,
        ...(attendanceDurationModelEnabled ? { autoTimeOutTime: draft?.autoTimeOutTime ?? "08:05" } : {}) }), onSuccess: (saved) => {
        setDraft(null); client.setQueryData(["attendance-policy"], saved);
        void client.invalidateQueries({ queryKey: ["attendance-policy"] }); void refreshAttendanceWorkspace(client);
    } });
    if (!enabled) return null;
    const policy = draft || query.data;
    const cutoff = policy?.autoTimeOutTime ?? "08:05";
    const change = (next: AttendancePolicy) => { setValidationError(""); save.reset(); setDraft(next); };
    return <details className="attendance-corrections"><summary>Attendance configuration</summary>
        {query.isPending && <p>Loading configuration...</p>}
        {policy && <form onSubmit={(event) => {
            event.preventDefault();
            if (attendanceDurationModelEnabled && (!validAttendanceCutoff(cutoff) || cutoff < policy.shiftEnd)) { setValidationError("Enter a valid cutoff at or after the 08:00 shift end."); return; }
            if (draft) save.mutate();
        }}>
            <p>Official shift: 23:00 to 08:00 Asia/Manila. Settings apply across assigned businesses.</p>
            <fieldset disabled={save.isPending}>
            {([['graceMinutes', 'Late grace (minutes)'], ['breakMinutes', 'Break allowance (minutes)'], ['lunchMinutes', 'Lunch allowance (minutes)']] as const).map(([key, label]) =>
                <label key={key}>{label}<input type="number" required min={key === "graceMinutes" ? 0 : 1} max={240} step={1} value={policy[key]} onChange={(event) => change({ ...policy, [key]: Number(event.target.value) })} /></label>)}
            {attendanceDurationModelEnabled && <>
                <label>Auto time-out cutoff (Asia/Manila)<input type="time" required min={policy.shiftEnd} step={60} value={cutoff}
                    aria-invalid={Boolean(validationError)} aria-describedby={validationError ? "attendance-cutoff-error" : undefined}
                    onChange={(event) => change({ ...policy, autoTimeOutTime: event.target.value })} /></label>
                {policy.autoTimeOutEnabled !== undefined && <p>Automatic time-out: {policy.autoTimeOutEnabled ? "Enabled" : "Disabled"}</p>}
            </>}
            <label><input type="checkbox" checked={policy.recoveryEnabled} onChange={(event) => change({ ...policy, recoveryEnabled: event.target.checked })} /> Enable administrative missing-checkout recovery</label>
            <label>Recovery cutoff (PH time)<input type="time" value={policy.recoveryTime} onChange={(event) => change({ ...policy, recoveryTime: event.target.value })} /></label>
            <p>Recovery records a system closure, never a Time Out or invented working hours. It is off by default.</p>
            </fieldset>
            {validationError && <p id="attendance-cutoff-error" role="alert">{validationError}</p>}
            <button type="submit" disabled={!draft || save.isPending || (attendanceDurationModelEnabled && !validAttendanceCutoff(cutoff))}><FiSave aria-hidden="true" />{save.isPending ? "Saving..." : "Save configuration"}</button>
        </form>}
        {(save.isError || query.isError) && <p role="alert">{(save.error || query.error) instanceof Error ? (save.error || query.error)?.message : "Unable to save configuration. Refresh and review your draft."}</p>}
        {save.isSuccess && <p role="status">{query.data?.policySyncPending ? "Configuration saved. Attendance and payroll synchronization is pending and will retry." : "Configuration saved."}</p>}
    </details>;
}
