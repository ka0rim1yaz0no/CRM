import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FiEdit2, FiRotateCcw } from "react-icons/fi";
import { getActiveBusinessId } from "../api/businessStorage";
import { getAuthUser } from "../api/authStorage";
import { attendanceIntegrityEnabled, getAttendanceSession, previewAttendanceCommand, submitAttendanceCommand, type AttendanceCommand, type SessionEvent, type AttendanceSessionSnapshot } from "../api/attendanceSession";
import { attendanceInputValue } from "../lib/attendanceCommandDraft";
import { refreshAttendanceWorkspace } from "../lib/employeeWorkspaceCache";

const errorText = (error: unknown) => (error as { response?: { data?: { message?: string } } })?.response?.data?.message || (error instanceof Error ? error.message : "Attendance is unavailable.");
export default function AttendanceCorrections({ employeeId, businessId = getActiveBusinessId(), dayKey, initialEvent, initialSnapshot }: { employeeId: string; businessId?: string; dayKey?: string; initialEvent?: SessionEvent; initialSnapshot?: AttendanceSessionSnapshot }) {
    const client = useQueryClient();
    const [target, setTarget] = useState<SessionEvent | null>(initialEvent || null);
    const [mode, setMode] = useState<"correct" | "undo" | null>(initialEvent ? "correct" : null);
    const [at, setAt] = useState(attendanceInputValue(initialEvent?.at));
    const [source, setSource] = useState<SessionEvent["source"]>(initialEvent?.source || "Time In");
    const [baseline, setBaseline] = useState(initialSnapshot ? { revision: initialSnapshot.revision, fingerprint: initialSnapshot.fingerprint } : null);
    const [reason, setReason] = useState("");
    const [remove, setRemove] = useState(false);
    const [error, setError] = useState("");
    const [reviewing, setReviewing] = useState(false);
    const [preview, setPreview] = useState<{ command: AttendanceCommand; text: string } | null>(null);
    const enabled = attendanceIntegrityEnabled && getAuthUser()?.userType === "admin";
    const query = useQuery({ queryKey: ["attendance-session", businessId, employeeId], queryFn: () => getAttendanceSession(employeeId, businessId), enabled });
    const save = useMutation({ mutationFn: () => submitAttendanceCommand(employeeId, preview!.command, businessId), onSuccess: (snapshot) => {
        setMode(null); setPreview(null); setReason(""); setError(snapshot.syncPending ? "Saved. Business synchronization is pending and will retry automatically." : "Saved and synchronized.");
        void refreshAttendanceWorkspace(client);
    }, onError: (failure) => { setError(errorText(failure)); void query.refetch(); } });
    if (!enabled) return null;
    const events = dayKey ? query.data?.sessions.filter((session) => session.shift?.dayKey === dayKey).flatMap((session) => session.events) || [] : query.data?.records || [];
    const begin = (next: "correct" | "undo", event: SessionEvent | null) => { if (!query.data) return; setBaseline({ revision: query.data.revision, fingerprint: query.data.fingerprint }); setTarget(event); setSource(event?.source || "Time In"); setMode(next); setAt(attendanceInputValue(event?.at)); setRemove(false); setReason(""); setPreview(null); setError(""); };
    const review = async () => {
        if (reviewing) return;
        setReviewing(true);
        try {
            if (!query.data || !baseline || !reason.trim()) throw new Error("Enter a reason before reviewing this change.");
            const replacement = mode === "correct" && !remove ? (at === attendanceInputValue(target?.at) ? target!.at : new Date(`${at}+08:00`).toISOString()) : undefined;
            const command: AttendanceCommand = { commandId: crypto.randomUUID(), expectedRevision: baseline.revision,
                fingerprint: baseline.fingerprint, operation: mode!, reason: reason.trim(),
                ...(mode === "undo" ? { targetCommandId: target?.commandId } : { changes: [{ targetId: target!.id, ...(remove ? { remove: true } : { source, at: replacement }) }] }) };
            const result = await previewAttendanceCommand(employeeId, command, businessId);
            const used = (state: typeof result.before, bucket: string) => `${Math.round((state.time?.actual[bucket] || 0) / 6000) / 10}m`;
            const timerStart = result.after.stateSince ? `${new Date(result.after.stateSince).toLocaleString("en-US", { timeZone: "Asia/Manila" })} PH` : "none";
            setPreview({ command, text: `Employee ${employeeId}. ${target ? `${target.source} at ${new Date(target.at).toLocaleString("en-US", { timeZone: "Asia/Manila" })} PH.` : "Latest eligible action."} ${result.before.state} -> ${result.after.state}, timer starts ${timerStart}. Break used ${used(result.before, "break")} -> ${used(result.after, "break")}; lunch used ${used(result.before, "lunch")} -> ${used(result.after, "lunch")}. ${result.targets.length} original event(s) affected in ${result.businessIds.join(", ")}. ${result.payrollImpact}` });
            setError("");
        } catch (failure) { setError(errorText(failure)); }
        finally { setReviewing(false); }
    };
    return <section className="attendance-corrections" aria-label="Attendance corrections">
        <h3>Corrections</h3>
        <button type="button" disabled={!query.data?.records.length || query.isError || save.isPending || reviewing} onClick={() => begin("undo", null)}><FiRotateCcw /> Undo last action</button>
        {query.isPending && <p>Loading authoritative timeline...</p>}
        {query.isError && <p role="alert">{errorText(query.error)}</p>}
        <div className="attendance-corrections-events">{events.map((event) => <div key={event.id}><span>{event.source} <time>{new Date(event.at).toLocaleString("en-US", { timeZone: "Asia/Manila" })}</time></span>
            <button type="button" disabled={save.isPending || reviewing} title={`Correct ${event.source}`} aria-label={`Correct ${event.source}`} onClick={() => begin("correct", event)}><FiEdit2 /></button>
            <button type="button" disabled={save.isPending || reviewing} title={`Undo ${event.source}`} aria-label={`Undo ${event.source}`} onClick={() => begin("undo", event)}><FiRotateCcw /></button></div>)}</div>
        {mode && <form onSubmit={(event) => { event.preventDefault(); if (!save.isPending && !reviewing) void review(); }}><fieldset disabled={save.isPending || reviewing}>
            <h4>{mode === "undo" ? "Undo action" : `Correct ${target?.source}`}</h4>
            {mode === "correct" && <><label>Action<select value={source} onChange={(event) => { setSource(event.target.value as SessionEvent["source"]); setPreview(null); }}>{["Time In", "Time Out", "Break Out", "Break In", "Lunch Break Out", "Lunch Break In", "Off the Phone Out", "Off the Phone In", "Login", "Logout"].map((item) => <option key={item}>{item}</option>)}</select></label><label>PH time<input type="datetime-local" step="1" value={at} required={!remove} disabled={remove} onChange={(event) => { setAt(event.target.value); setPreview(null); }} /></label>
                <label><input type="checkbox" checked={remove} onChange={(event) => { setRemove(event.target.checked); setPreview(null); }} /> Explicitly reverse this event without replacement</label></>}
            <label>Reason<textarea value={reason} required maxLength={1000} onChange={(event) => { setReason(event.target.value); setPreview(null); }} /></label>
            <button type="submit">{reviewing ? "Reviewing..." : "Review change"}</button><button type="button" onClick={() => { setMode(null); setPreview(null); }}>Cancel</button>
            {preview && <div role="alertdialog" aria-label="Confirm attendance change"><p>{preview.text}</p><p>Original evidence is retained. Dependent events must remain valid.</p>
                <button type="button" disabled={save.isPending} onClick={() => save.mutate()}>{save.isPending ? "Saving..." : "Confirm change"}</button></div>}
        </fieldset></form>}
        {error && <p role="status">{error}</p>}
    </section>;
}
