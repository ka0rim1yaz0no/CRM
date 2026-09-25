import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { FiPhoneCall } from "react-icons/fi";
import { getCallDashboard, type CallDashboardRow } from "../api/callDashboard";
import { socket } from "../lib/socket";
import { formatPhDate, formatPhTime } from "../lib/dateTime";

function duration(milliseconds: number) {
    const seconds = Math.max(0, Math.floor(milliseconds / 1000));
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

function statusClasses(status: CallDashboardRow["status"]) {
    if (status === "ON CALL") return "border-emerald-200 bg-emerald-50 text-emerald-800";
    if (status === "CALL WAITING") return "border-sky-200 bg-sky-50 text-sky-800";
    if (status === "OFF THE PHONE") return "border-amber-200 bg-amber-50 text-amber-800";
    return "border-slate-200 bg-slate-100 text-slate-600";
}

function visibleStatus(row: CallDashboardRow, now: number, shiftStart: number, shiftEnd: number) {
    if (now < shiftStart || now >= shiftEnd) {
        return { status: row.status === "OFF THE PHONE" ? "OFF THE PHONE" as const : "OFFLINE" as const, startedAt: 0, detail: "Outside call shift" };
    }
    const deadline = row.transitionUntil ? new Date(row.transitionUntil).getTime() : 0;
    if (deadline && now >= deadline) {
        return {
            status: "OFFLINE" as const,
            startedAt: deadline,
            detail: row.status === "CALL WAITING" ? "Ready to dial" : "Dial not confirmed",
        };
    }
    return {
        status: row.status,
        startedAt: row.statusStartedAt ? new Date(row.statusStartedAt).getTime() : 0,
        detail: row.detail,
    };
}

export default function CallDashboardPanel() {
    const queryClient = useQueryClient();
    const [clock, setClock] = useState(Date.now);
    const { data, isLoading, isError } = useQuery({
        queryKey: ["admin-call-dashboard"],
        queryFn: async () => ({ ...(await getCallDashboard()), receivedAt: Date.now() }),
        refetchInterval: 15_000,
        refetchOnWindowFocus: true,
    });

    useEffect(() => {
        const interval = window.setInterval(() => setClock(Date.now()), 1_000);
        return () => window.clearInterval(interval);
    }, []);

    useEffect(() => {
        socket.connect();
        let refreshTimer: number | undefined;
        const update = () => {
            window.clearTimeout(refreshTimer);
            refreshTimer = window.setTimeout(() => {
                void queryClient.invalidateQueries({ queryKey: ["admin-call-dashboard"] });
            }, 250);
        };
        socket.on("call-dashboard:updated", update);
        socket.on("employee:availability-updated", update);
        socket.on("connect", update);
        return () => {
            window.clearTimeout(refreshTimer);
            socket.off("call-dashboard:updated", update);
            socket.off("employee:availability-updated", update);
            socket.off("connect", update);
        };
    }, [queryClient]);

    const serverOffset = data ? new Date(data.generatedAt).getTime() - data.receivedAt : 0;
    const serverNow = clock + serverOffset;
    const shiftStart = data ? new Date(data.shift.start).getTime() : 0;
    const shiftEnd = data ? new Date(data.shift.end).getTime() : 0;
    const rows = data?.employees.map((row) => ({ row, visible: visibleStatus(row, serverNow, shiftStart, shiftEnd) })) || [];
    const counts = {
        onCall: rows.filter(({ visible }) => visible.status === "ON CALL").length,
        waiting: rows.filter(({ visible }) => visible.status === "CALL WAITING").length,
        offPhone: rows.filter(({ visible }) => visible.status === "OFF THE PHONE").length,
        offline: rows.filter(({ visible }) => visible.status === "OFFLINE").length,
    };
    const displayRows = rows.map(({ row, visible }) => {
        const startedAt = visible.startedAt;
        const activeOffPhoneAt = row.offPhoneActiveStartedAt ? new Date(row.offPhoneActiveStartedAt).getTime() : 0;
        const offPhoneMs = row.offPhoneCompletedMs + (activeOffPhoneAt ? Math.max(0, Math.min(serverNow, shiftEnd) - activeOffPhoneAt) : 0);

        return {
            row,
            visible,
            statusTime: startedAt ? duration(Math.min(serverNow, shiftEnd) - Math.max(startedAt, shiftStart)) : "--:--:--",
            statusTimeTitle: startedAt ? formatPhTime(new Date(startedAt)) : "No recorded status transition",
            offPhoneTime: duration(offPhoneMs),
        };
    });

    return (
        <section className="overflow-hidden rounded-lg border border-slate-300 bg-white text-slate-950 shadow-lg shadow-slate-950/10" aria-labelledby="call-dashboard-title">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 bg-slate-50 px-4 py-3">
                <div className="min-w-0">
                    <div className="flex items-center gap-2">
                        <FiPhoneCall className="size-4 text-[#842cff]" aria-hidden="true" />
                        <h3 id="call-dashboard-title" className="text-base font-semibold">Call Dashboard</h3>
                    </div>
                    <p className="mt-0.5 text-xs text-slate-500">
                        {data ? `${formatPhDate(data.shift.start)} · ${formatPhTime(data.shift.start)} to ${formatPhTime(data.shift.end)} PH shift` : "Loading shift"}
                    </p>
                </div>
                {data && <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs font-medium text-slate-600">
                    <span><span className="mr-1 inline-block size-2 rounded-full bg-emerald-500" />{counts.onCall} on call</span>
                    <span><span className="mr-1 inline-block size-2 rounded-full bg-sky-500" />{counts.waiting} waiting</span>
                    <span><span className="mr-1 inline-block size-2 rounded-full bg-amber-500" />{counts.offPhone} off phone</span>
                    <span><span className="mr-1 inline-block size-2 rounded-full bg-slate-400" />{counts.offline} offline</span>
                </div>}
            </div>
            <div className="hidden md:block">
                <table className="w-full table-fixed">
                    <colgroup><col className="w-[34%]" /><col className="w-[25%]" /><col className="w-[18%]" /><col className="w-[23%]" /></colgroup>
                    <thead className="border-b border-slate-200 bg-white text-xs uppercase text-slate-500">
                        <tr>
                            <th className="px-4 py-2.5 text-left font-semibold">User</th>
                            <th className="px-4 py-2.5 text-left font-semibold">Status</th>
                            <th className="px-4 py-2.5 text-right font-semibold">Time</th>
                            <th className="px-4 py-2.5 text-right font-semibold">Total Off the Phone</th>
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                        {isLoading && <tr><td colSpan={4} className="px-4 py-6 text-center text-sm text-slate-500">Loading live call status...</td></tr>}
                        {isError && !data && <tr><td colSpan={4} className="px-4 py-6 text-center text-sm text-red-700">Call status could not load.</td></tr>}
                        {data?.employees.length === 0 && <tr><td colSpan={4} className="px-4 py-6 text-center text-sm text-slate-500">No sales employees are available for this business.</td></tr>}
                        {displayRows.map(({ row, visible, statusTime, statusTimeTitle, offPhoneTime }) => (
                            <tr key={row.employeeId} className="hover:bg-slate-50/80">
                                <td className="px-4 py-2.5">
                                    <div className="flex min-w-0 items-center gap-2.5">
                                        <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-[#842cff] text-xs font-semibold text-white">{row.name.trim().charAt(0).toUpperCase() || "?"}</span>
                                        <div className="min-w-0">
                                            <p className="truncate text-sm font-semibold" title={row.name}>{row.name}</p>
                                            <p className="truncate text-xs text-slate-500" title={[row.role, row.team].filter(Boolean).join(" · ")}>{[row.role, row.team].filter(Boolean).join(" · ")}</p>
                                        </div>
                                    </div>
                                </td>
                                <td className="px-4 py-2.5">
                                    <span className={`inline-flex whitespace-nowrap rounded-md border px-2 py-1 text-xs font-semibold ${statusClasses(visible.status)}`}>{visible.status}</span>
                                    <p className="mt-0.5 truncate text-xs text-slate-500" title={visible.detail}>{visible.detail}</p>
                                </td>
                                <td className="px-4 py-2.5 text-right font-mono text-sm tabular-nums" title={statusTimeTitle}>{statusTime}</td>
                                <td className="px-4 py-2.5 text-right font-mono text-sm tabular-nums">{offPhoneTime}</td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
            <div className="divide-y divide-slate-200 md:hidden">
                {isLoading && <p className="px-4 py-6 text-center text-sm text-slate-500">Loading live call status...</p>}
                {isError && !data && <p className="px-4 py-6 text-center text-sm text-red-700">Call status could not load.</p>}
                {data?.employees.length === 0 && <p className="px-4 py-6 text-center text-sm text-slate-500">No sales employees are available for this business.</p>}
                {displayRows.map(({ row, visible, statusTime, statusTimeTitle, offPhoneTime }) => (
                    <article key={row.employeeId} className="p-4">
                        <div className="flex min-w-0 items-start justify-between gap-3">
                            <div className="flex min-w-0 items-center gap-2.5">
                                <span className="flex size-9 shrink-0 items-center justify-center rounded-md bg-[#842cff] text-xs font-semibold text-white">
                                    {row.name.trim().charAt(0).toUpperCase() || "?"}
                                </span>
                                <div className="min-w-0">
                                    <p className="break-words text-sm font-semibold">{row.name}</p>
                                    <p className="break-words text-xs text-slate-500">{[row.role, row.team].filter(Boolean).join(" · ")}</p>
                                </div>
                            </div>
                            <span className={`inline-flex shrink-0 whitespace-nowrap rounded-md border px-2 py-1 text-xs font-semibold ${statusClasses(visible.status)}`}>
                                {visible.status}
                            </span>
                        </div>
                        <p className="mt-2 break-words text-xs text-slate-500">{visible.detail}</p>
                        <dl className="mt-3 grid grid-cols-2 gap-3 rounded-md border border-slate-200 bg-slate-50 p-3">
                            <div className="min-w-0">
                                <dt className="text-[11px] font-semibold uppercase text-slate-500">Time</dt>
                                <dd className="mt-1 font-mono text-sm tabular-nums" title={statusTimeTitle}>{statusTime}</dd>
                            </div>
                            <div className="min-w-0 text-right">
                                <dt className="text-[11px] font-semibold uppercase text-slate-500">Total Off Phone</dt>
                                <dd className="mt-1 font-mono text-sm tabular-nums">{offPhoneTime}</dd>
                            </div>
                        </dl>
                    </article>
                ))}
            </div>
        </section>
    );
}
