import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { FiPhoneOff, FiUsers } from "react-icons/fi";
import { performAttendanceAction, type AttendanceSessionSnapshot, type SessionEvent } from "../api/attendanceSession";
import { getActiveBusinessId } from "../api/businessStorage";
import { allowanceClock, coachingRemainingMs, offPhoneRemainingMs } from "../lib/attendanceAllowances";
import { attendanceCorrectionError } from "../lib/attendanceUndo";

export default function AttendanceAwayControls({ employeeId, snapshot }: { employeeId: string; snapshot: AttendanceSessionSnapshot }) {
    const queryClient = useQueryClient();
    const businessId = getActiveBusinessId();
    const [clock, setClock] = useState(Date.now);
    useEffect(() => { const timer = setInterval(() => setClock(Date.now()), 1000); return () => clearInterval(timer); }, []);
    const now = Date.parse(snapshot.serverTime) + Math.max(0, clock - snapshot.receivedAt);
    const coached = snapshot.coachingBilling;
    const coaching = snapshot.state === "OFF THE PHONE" && Boolean(coached?.active);
    const offPhone = snapshot.state === "OFF THE PHONE" && !coaching;
    const remaining = coachingRemainingMs(coached, now);
    const mutation = useMutation({
        mutationFn: (source: SessionEvent["source"]) => performAttendanceAction(employeeId, source),
        onSuccess: result => {
            queryClient.setQueryData<AttendanceSessionSnapshot>(["attendance-session", businessId, employeeId], current =>
                !current || current.revision <= result.revision ? result : current);
            void queryClient.invalidateQueries({ queryKey: ["attendance-session"] });
            void queryClient.invalidateQueries({ queryKey: ["employee-dashboard-attendance"] });
        },
        onError: () => { void queryClient.invalidateQueries({ queryKey: ["attendance-session"] }); },
    });
    const disabled = (source: SessionEvent["source"]) => mutation.isPending || snapshot.reviewState !== "verified" || !snapshot.allowedActions?.includes(source);
    const coachingSource = coaching ? "Coaching In" : "Coaching Out";
    const offPhoneSource = offPhone ? "Off the Phone In" : "Off the Phone Out";
    return <section aria-label="Shift allowances" className="border-y border-slate-200 py-4">
        <div className="grid gap-4 sm:grid-cols-2">
            <div className="flex min-w-0 flex-wrap items-center justify-between gap-3">
                <div><p className="text-sm font-semibold text-slate-800">Off the Phone remaining</p>
                    <output data-allowance="off-phone" className="font-mono text-xl font-semibold tabular-nums text-sky-800">{allowanceClock(offPhoneRemainingMs(snapshot.offPhoneBilling, now))}</output></div>
                <button type="button" data-attendance-action="OFF THE PHONE" disabled={coaching || disabled(offPhoneSource)} onClick={() => mutation.mutate(offPhoneSource)}
                    aria-pressed={offPhone} className="inline-flex min-h-11 items-center gap-2 rounded-lg border border-sky-300 bg-sky-50 px-3 py-2 text-sm font-semibold text-sky-900 disabled:cursor-not-allowed disabled:opacity-50">
                    <FiPhoneOff aria-hidden="true" />{offPhone ? "Back on Phone" : "Off the Phone"}</button>
            </div>
            <div className="flex min-w-0 flex-wrap items-center justify-between gap-3">
                <div><p className="text-sm font-semibold text-slate-800">Coaching remaining</p>
                    <output data-allowance="coaching" className="font-mono text-xl font-semibold tabular-nums text-emerald-800">{allowanceClock(remaining)}</output></div>
                <button type="button" data-attendance-action="COACHING" disabled={offPhone || remaining === null || remaining <= 0 || disabled(coachingSource)}
                    title={remaining === 0 ? "Coaching allowance used for this shift" : undefined} onClick={() => mutation.mutate(coachingSource)}
                    aria-pressed={coaching} className="inline-flex min-h-11 items-center gap-2 rounded-lg border border-emerald-300 bg-emerald-50 px-3 py-2 text-sm font-semibold text-emerald-900 disabled:cursor-not-allowed disabled:opacity-50">
                    <FiUsers aria-hidden="true" />{coaching ? remaining === 0 ? "Returning Online" : "Coaching Out" : "Coaching"}</button>
            </div>
        </div>
        {mutation.isError && <p role="alert" className="mt-2 text-sm text-red-700">{attendanceCorrectionError(mutation.error)}</p>}
    </section>;
}
