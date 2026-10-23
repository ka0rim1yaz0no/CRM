import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FiEdit2, FiLogOut, FiRotateCcw } from "react-icons/fi";
import { getActiveBusinessId } from "../api/businessStorage";
import { getAuthUser } from "../api/authStorage";
import { attendanceIntegrityEnabled, getAttendanceSession, previewAttendanceCommand, submitAttendanceCommand, type AttendanceCommand, type SessionEvent, type AttendanceSessionSnapshot } from "../api/attendanceSession";
import { attendanceInputValue } from "../lib/attendanceCommandDraft";
import { refreshAttendanceWorkspace } from "../lib/employeeWorkspaceCache";
import { attendanceCorrectionError, attendanceEventsForDay, attendanceUndoAvailability, attendanceUndoPlan } from "../lib/attendanceUndo";
import { missingTimeOutChanges, missingTimeOutDraft, missingTimeOutSessions } from "../lib/attendanceMissingTimeOut";

const errorText = attendanceCorrectionError;
export default function AttendanceCorrections({ employeeId, businessId = getActiveBusinessId(), dayKey, initialEvent, initialSnapshot }: { employeeId: string; businessId?: string; dayKey?: string; initialEvent?: SessionEvent; initialSnapshot?: AttendanceSessionSnapshot }) {
    const client = useQueryClient();
    const [target, setTarget] = useState<SessionEvent | null>(initialEvent || null);
    const [mode, setMode] = useState<"correct" | "undo" | "add-time-out" | null>(initialEvent ? "correct" : null);
    const [timeOutSessionId, setTimeOutSessionId] = useState("");
    const [closeRest, setCloseRest] = useState(false);
    const [at, setAt] = useState(attendanceInputValue(initialEvent?.at));
    const [source, setSource] = useState<SessionEvent["source"]>(initialEvent?.source || "Time In");
    const [baseline, setBaseline] = useState(initialSnapshot ? { revision: initialSnapshot.revision, fingerprint: initialSnapshot.fingerprint } : null);
    const [reason, setReason] = useState("");
    const [remove, setRemove] = useState(false);
    const [error, setError] = useState("");
    const [reviewing, setReviewing] = useState(false);
    const [preview, setPreview] = useState<{ command: AttendanceCommand; text: string; employeeId: string; businessId: string; dayKey?: string } | null>(null);
    const enabled = attendanceIntegrityEnabled && getAuthUser()?.userType === "admin";
    const query = useQuery({ queryKey: ["attendance-session", businessId, employeeId], queryFn: () => getAttendanceSession(employeeId, businessId), enabled });
    const save = useMutation({ mutationFn: (draft: NonNullable<typeof preview>) => {
        if (draft.employeeId !== employeeId || draft.businessId !== businessId || draft.dayKey !== dayKey) throw new Error("The employee or shift changed. Reopen the attendance change and review it again.");
        return submitAttendanceCommand(draft.employeeId, draft.command, draft.businessId);
    }, onSuccess: (snapshot, draft) => {
        client.setQueryData(["attendance-session", draft.businessId, draft.employeeId], snapshot);
        void refreshAttendanceWorkspace(client);
        if (draft.employeeId !== employeeId || draft.businessId !== businessId || draft.dayKey !== dayKey) return;
        setMode(null); setPreview(null); setReason(""); setError(snapshot.syncPending ? "Saved. Business synchronization is pending and will retry automatically." : "Saved and synchronized.");
    }, onError: (failure) => { setPreview(null); setError(errorText(failure)); void query.refetch(); } });
    if (!enabled) return null;
    const events = attendanceEventsForDay(query.data, dayKey);
    const lastEvent = events.at(-1);
    const lastUndo = attendanceUndoAvailability(query.data, lastEvent, dayKey);
    const missingSessions = missingTimeOutSessions(query.data, dayKey);
    const timeOutDraft = mode === "add-time-out" && query.data && missingSessions.some(session => session.id === timeOutSessionId)
        ? missingTimeOutDraft(query.data, dayKey, timeOutSessionId) : null;
    const begin = (next: "correct" | "undo", selected: SessionEvent | null) => {
        if (!query.data) return;
        const event = next === "undo" ? selected || lastEvent || null : selected;
        if (next === "undo") {
            const availability = attendanceUndoAvailability(query.data, event, dayKey);
            if (!availability.allowed) { setError(availability.reason); return; }
        }
        save.reset(); setBaseline({ revision: query.data.revision, fingerprint: query.data.fingerprint }); setTarget(event); setSource(event?.source || "Time In"); setMode(next); setAt(attendanceInputValue(event?.at)); setRemove(false); setReason(""); setPreview(null); setError("");
    };
    const beginTimeOut = (sessionId: string) => {
        if (!query.data) return;
        const draft = missingTimeOutDraft(query.data, dayKey, sessionId);
        save.reset(); setBaseline({ revision: query.data.revision, fingerprint: query.data.fingerprint });
        setTimeOutSessionId(sessionId); setCloseRest(false); setTarget(null); setMode("add-time-out");
        setAt(draft.value); setRemove(false); setReason(""); setPreview(null); setError("");
    };
    const review = async () => {
        if (reviewing) return;
        setReviewing(true);
        try {
            if (!query.data || !baseline || !reason.trim()) throw new Error("Enter a reason before reviewing this change.");
            if (mode === "undo") {
                const availability = attendanceUndoAvailability(query.data, target, dayKey);
                if (!availability.allowed) throw new Error(availability.reason);
            }
            const replacement = mode === "correct" && !remove ? (at === attendanceInputValue(target?.at) ? target!.at : new Date(`${at}+08:00`).toISOString()) : undefined;
            const undo = mode === "undo" ? attendanceUndoPlan(query.data, target!, dayKey) : null;
            const command: AttendanceCommand = { commandId: crypto.randomUUID(), expectedRevision: baseline.revision,
                fingerprint: baseline.fingerprint, operation: mode === "add-time-out" || undo?.paired ? "correct" : mode!, reason: reason.trim(),
                ...(mode === "undo" ? undo!.paired ? { changes: undo!.events.map(event => ({ targetId: event.id, remove: true })) } : { targetCommandId: target?.commandId }
                    : { changes: mode === "add-time-out" ? missingTimeOutChanges(query.data, dayKey, timeOutSessionId, at, closeRest)
                        : [{ targetId: target!.id, ...(remove ? { remove: true } : { source, at: replacement }) }] }) };
            const result = await previewAttendanceCommand(employeeId, command, businessId);
            const used = (state: typeof result.before, bucket: string) => `${Math.round((state.time?.actual[bucket] || 0) / 6000) / 10}m`;
            const timerStart = result.after.stateSince ? `${new Date(result.after.stateSince).toLocaleString("en-US", { timeZone: "Asia/Manila" })} PH` : "none";
            const description = undo?.paired ? `Reverse this completed rest interval: ${undo.events.map(event => `${event.source} at ${new Date(event.at).toLocaleString("en-US", { timeZone: "Asia/Manila" })} PH`).join(" and ")}. Unrelated newer actions stay unchanged.`
                : mode === "add-time-out" ? `Add ${command.changes!.map(change => `${change.source} at ${new Date(change.at!).toLocaleString("en-US", { timeZone: "Asia/Manila" })} PH`).join(" and ")}. Existing actions stay unchanged.`
                : target ? `${target.source} at ${new Date(target.at).toLocaleString("en-US", { timeZone: "Asia/Manila" })} PH.` : "Latest eligible action.";
            setPreview({ command, employeeId, businessId, dayKey, text: `Employee ${employeeId}. ${description} ${result.before.state} -> ${result.after.state}, timer starts ${timerStart}. Break used ${used(result.before, "break")} -> ${used(result.after, "break")}; lunch used ${used(result.before, "lunch")} -> ${used(result.after, "lunch")}. ${result.targets.length} original event(s) affected in ${result.businessIds.join(", ")}. ${result.payrollImpact}` });
            setError("");
        } catch (failure) { setError(errorText(failure)); }
        finally { setReviewing(false); }
    };
    return <section className="attendance-corrections" aria-label="Attendance corrections">
        <h3>Corrections</h3>
        <div className="attendance-corrections-actions">
            <button type="button" title={lastUndo.reason || "Review undo of the latest action in this shift"} disabled={!lastUndo.allowed || query.isError || save.isPending || reviewing} onClick={() => begin("undo", null)}><FiRotateCcw /> Undo last action</button>
            <button type="button" title={missingSessions.length ? "Add the missing checkout for this shift" : "No session with a missing Time Out in this shift"}
                disabled={!missingSessions.length || query.isError || save.isPending || reviewing} onClick={() => beginTimeOut(missingSessions[0].id)}><FiLogOut /> Add Time Out</button>
        </div>
        {query.data && !lastUndo.allowed && <p className="attendance-undo-unavailable">{lastUndo.reason}</p>}
        {query.isPending && <p>Loading authoritative timeline...</p>}
        {query.isError && <p role="alert">{errorText(query.error)}</p>}
        <div className="attendance-corrections-events">{events.map((event) => <div key={event.id}><span>{event.source} <time>{new Date(event.at).toLocaleString("en-US", { timeZone: "Asia/Manila" })}</time></span>
            <button type="button" disabled={save.isPending || reviewing} title={`Correct ${event.source}`} aria-label={`Correct ${event.source}`} onClick={() => begin("correct", event)}><FiEdit2 /></button>
            <button type="button" disabled={save.isPending || reviewing || !attendanceUndoAvailability(query.data, event, dayKey).allowed} title={attendanceUndoAvailability(query.data, event, dayKey).reason || `Undo ${event.source}`} aria-label={`Undo ${event.source}`} onClick={() => begin("undo", event)}><FiRotateCcw /></button></div>)}</div>
        {mode && <form onSubmit={(event) => { event.preventDefault(); if (!save.isPending && !reviewing) void review(); }}><fieldset disabled={save.isPending || reviewing}>
            <h4>{mode === "add-time-out" ? "Add Time Out" : mode === "undo" ? `Undo ${target?.source || "action"}` : `Correct ${target?.source}`}</h4>
            {mode === "add-time-out" && <>
                {missingSessions.length > 1 && <label>Session<select aria-label="Missing checkout session" value={timeOutSessionId} onChange={event => beginTimeOut(event.target.value)}>
                    {missingSessions.map(session => <option key={session.id} value={session.id}>Time In {new Date(session.startedAt).toLocaleString("en-US", { timeZone: "Asia/Manila" })}</option>)}
                </select></label>}
                <label>PH Time Out<input aria-label="PH Time Out" type="datetime-local" step="1" value={at} required min={timeOutDraft?.min} max={timeOutDraft?.max}
                    onChange={event => { setAt(event.target.value); setPreview(null); }} /></label>
                {timeOutDraft?.returnSource && <label><input type="checkbox" checked={closeRest} onChange={event => { setCloseRest(event.target.checked); setPreview(null); }} />
                    Add {timeOutDraft.returnSource} at the same time</label>}
            </>}
            {mode === "correct" && <><label>Action<select value={source} onChange={(event) => { setSource(event.target.value as SessionEvent["source"]); setPreview(null); }}>{["Time In", "Time Out", "Break Out", "Break In", "Lunch Break Out", "Lunch Break In", "Off the Phone Out", "Off the Phone In", "Login", "Logout"].map((item) => <option key={item}>{item}</option>)}</select></label><label>PH time<input type="datetime-local" step="1" value={at} required={!remove} disabled={remove} onChange={(event) => { setAt(event.target.value); setPreview(null); }} /></label>
                <label><input type="checkbox" checked={remove} onChange={(event) => { setRemove(event.target.checked); setPreview(null); }} /> Explicitly reverse this event without replacement</label></>}
            <label>Reason<textarea aria-label="Reason" value={reason} required maxLength={1000} onChange={(event) => { setReason(event.target.value); setPreview(null); }} /></label>
            <button type="submit">{reviewing ? "Reviewing..." : "Review change"}</button><button type="button" onClick={() => { setMode(null); setPreview(null); }}>Cancel</button>
            {preview && <div role="alertdialog" aria-label="Confirm attendance change"><p>{preview.text}</p><p>Original evidence is retained. Dependent events must remain valid.</p>
                <button type="button" disabled={save.isPending} onClick={() => save.mutate(preview)}>{save.isPending ? "Saving..." : "Confirm change"}</button></div>}
        </fieldset></form>}
        {error && <p role={save.isSuccess ? "status" : "alert"}>{error}</p>}
    </section>;
}
