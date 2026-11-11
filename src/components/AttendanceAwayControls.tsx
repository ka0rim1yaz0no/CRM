import { useEffect, useId, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { FiPhoneOff, FiUsers } from "react-icons/fi";
import { performAttendanceAction, type AttendanceSessionSnapshot, type SessionEvent } from "../api/attendanceSession";
import { getActiveBusinessId } from "../api/businessStorage";
import { allowanceClock, attendanceAwayDisabledReason, coachingElapsedMs, coachingRemainingMs, offPhoneRemainingMs } from "../lib/attendanceAllowances";
import { attendanceCorrectionError } from "../lib/attendanceUndo";

export default function AttendanceAwayControls({ employeeId, snapshot }: { employeeId: string; snapshot: AttendanceSessionSnapshot }) {
    const queryClient = useQueryClient();
    const businessId = getActiveBusinessId();
    const [clock, setClock] = useState(Date.now);
    const reasonId = useId();
    useEffect(() => { const timer = setInterval(() => setClock(Date.now()), 1000); return () => clearInterval(timer); }, []);
    const now = Date.parse(snapshot.serverTime) + Math.max(0, clock - snapshot.receivedAt);
    const coached = snapshot.coachingBilling;
    const coaching = snapshot.state === "OFF THE PHONE" && Boolean(coached?.active);
    const offPhone = snapshot.state === "OFF THE PHONE" && !coaching;
    const remaining = coachingRemainingMs(coached, now);
    const coachingUnlimited = coached?.limited === false;
    const coachingTime = coachingElapsedMs(coached, now, Date.parse(snapshot.serverTime));
    const offPhoneRemaining = offPhoneRemainingMs(snapshot.offPhoneBilling, now);
    const offPhoneBudget = (snapshot.offPhonePolicy?.paidMinutes ?? 20) * 60_000;
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
    const offPhoneDisabled = coaching || disabled(offPhoneSource);
    const coachingDisabled = offPhone || (!coachingUnlimited && (remaining === null || remaining <= 0)) || disabled(coachingSource);
    const offPhoneReason = offPhoneDisabled ? attendanceAwayDisabledReason(snapshot, "off-phone", now, mutation.isPending) : "20 min paid per shift";
    const coachingReason = coachingDisabled ? attendanceAwayDisabledReason(snapshot, "coaching", now, mutation.isPending) : coachingUnlimited ? "Billable, no time limit" : "20 min billable per shift";
    return <section aria-label="Shift allowances" className="employee-away-controls border-y border-slate-200 py-4">
        <div className="employee-away-grid grid gap-4 sm:grid-cols-2">
            <div className="employee-away-item" data-active={offPhone} data-mode="off-phone">
                <div><p className="text-sm font-semibold text-slate-800">Off the Phone remaining</p>
                    <output data-allowance="off-phone" className="font-mono text-xl font-semibold tabular-nums text-sky-800">{allowanceClock(offPhoneRemaining)}</output>
                    {offPhoneRemaining !== null && Number.isFinite(offPhoneBudget) && offPhoneBudget > 0 && <progress className="employee-away-progress" aria-label="Off the Phone allowance remaining" aria-valuetext={allowanceClock(offPhoneRemaining)} max={offPhoneBudget} value={Math.min(offPhoneBudget, offPhoneRemaining)} />}</div>
                <button type="button" data-attendance-action="OFF THE PHONE" disabled={offPhoneDisabled} onClick={() => mutation.mutate(offPhoneSource)}
                    title={offPhoneReason} aria-describedby={`${reasonId}-off-phone`}
                    aria-pressed={offPhone} className="inline-flex min-h-11 items-center gap-2 rounded-lg border border-sky-300 bg-sky-50 px-3 py-2 text-sm font-semibold text-sky-900 disabled:cursor-not-allowed disabled:opacity-50">
                    <FiPhoneOff aria-hidden="true" />{offPhone ? "Back on Phone" : "Off the Phone"}</button>
                <p id={`${reasonId}-off-phone`} className="employee-away-reason">{offPhoneReason}</p>
            </div>
            <div className="employee-away-item" data-active={coaching} data-mode="coaching">
                <div><p className="text-sm font-semibold text-slate-800">{coachingUnlimited ? "Coaching this shift" : "Coaching remaining"}</p>
                    <output data-allowance="coaching" className="font-mono text-xl font-semibold tabular-nums text-emerald-800">{allowanceClock(coachingUnlimited ? coachingTime === null ? null : Math.floor(coachingTime / 1000) * 1000 : remaining)}</output>
                    {!coachingUnlimited && remaining !== null && <progress className="employee-away-progress" aria-label="Coaching allowance remaining" aria-valuetext={allowanceClock(remaining)} max={20 * 60_000} value={Math.min(20 * 60_000, remaining)} />}</div>
                <button type="button" data-attendance-action="COACHING" disabled={coachingDisabled}
                    title={coachingReason} aria-describedby={`${reasonId}-coaching`} onClick={() => mutation.mutate(coachingSource)}
                    aria-pressed={coaching} className="inline-flex min-h-11 items-center gap-2 rounded-lg border border-emerald-300 bg-emerald-50 px-3 py-2 text-sm font-semibold text-emerald-900 disabled:cursor-not-allowed disabled:opacity-50">
                    <FiUsers aria-hidden="true" />{coaching ? remaining === 0 ? "Returning Online" : "Coaching Out" : "Coaching"}</button>
                <p id={`${reasonId}-coaching`} className="employee-away-reason">{coachingReason}</p>
            </div>
        </div>
        {mutation.isError && <p role="alert" className="mt-2 text-sm text-red-700">{attendanceCorrectionError(mutation.error)}</p>}
    </section>;
}
