import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { FiEye, FiRefreshCw, FiX } from "react-icons/fi";
import { getCurrentPayrollPreviews } from "../../api/payroll";
import { formatCurrency } from "../../lib/currency";
import { formatPayrollHours } from "../../lib/payrollFormatting";
import type { CurrencyCode } from "../../api/systemSettings";

export default function PayrollDraftPreviewDialog({ businessId, payPeriod, currencyCode }: { businessId: string; payPeriod: string; currencyCode: CurrencyCode }) {
    const [open, setOpen] = useState(false), dialog = useRef<HTMLElement>(null);
    const query = useQuery({ queryKey: ["payroll-current-previews", businessId, payPeriod],
        queryFn: ({ signal }) => getCurrentPayrollPreviews(payPeriod, businessId, signal), staleTime: 30_000,
        refetchOnMount: "always", refetchInterval: 60_000, refetchIntervalInBackground: false });
    useEffect(() => {
        if (!open) return;
        const previous = document.activeElement as HTMLElement | null;
        dialog.current?.querySelector<HTMLButtonElement>("button")?.focus();
        return () => { if (previous?.isConnected) previous.focus(); };
    }, [open]);
    const money = (value: number) => formatCurrency(value, currencyCode);
    const data = query.data, stale = query.isError || query.isFetching;
    return <>
        <button type="button" onClick={() => setOpen(true)} className="inline-flex h-11 items-center gap-2 rounded-lg border border-white/10 bg-[#090b13]/80 px-4 text-sm font-semibold text-white/75 transition hover:bg-white/10">
            <FiEye aria-hidden="true" />Unsaved previews{data ? ` (${data.rows.length})` : ""}
        </button>
        {open && <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
            <section ref={dialog} role="dialog" aria-modal="true" aria-labelledby="payroll-draft-title" className="flex max-h-[90vh] w-full max-w-6xl flex-col overflow-hidden rounded-lg border border-slate-200 bg-white text-slate-950 shadow-xl" onKeyDown={event => {
                if (event.key === "Escape") { event.preventDefault(); setOpen(false); }
                if (event.key !== "Tab") return;
                const controls = [...(dialog.current?.querySelectorAll<HTMLElement>('button:not([disabled]),summary,[tabindex="0"]') || [])];
                const first = controls[0], last = controls.at(-1);
                if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
                else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
            }}>
                <header className="flex items-center justify-between gap-3 border-b border-slate-200 px-5 py-4">
                    <div className="min-w-0"><h2 id="payroll-draft-title" className="text-lg font-semibold">Unsaved payroll previews</h2><p className="text-sm text-slate-600">{payPeriod}</p></div>
                    <button type="button" aria-label="Close unsaved previews" title="Close" onClick={() => setOpen(false)} className="grid size-9 shrink-0 place-items-center rounded-md border border-slate-200"><FiX /></button>
                </header>
                <div className="overflow-auto p-5">
                    <div className="mb-4 flex flex-wrap items-center justify-between gap-3 text-xs text-slate-600"><span>Unsaved · Approval required{data ? ` · ${new Date(data.asOf).toLocaleString("en-PH", { timeZone: "Asia/Manila" })} PH` : ""}</span>
                        <button type="button" disabled={query.isFetching} onClick={() => void query.refetch()} aria-label="Refresh unsaved previews" title="Refresh previews" className="grid size-9 place-items-center rounded-md border border-slate-300 disabled:opacity-50"><FiRefreshCw /></button></div>
                    {query.isError && <p role="alert" className="mb-4 text-sm text-red-700">Unable to refresh payroll previews. Previously loaded figures are not current.</p>}
                    {query.isPending && <p role="status" className="text-sm">Preparing previews...</p>}
                    {data && <div role="region" aria-label="Unsaved payroll amounts" tabIndex={0} className="overflow-x-auto"><table className={`w-full min-w-[68rem] text-left text-sm ${stale ? "opacity-50" : ""}`} aria-busy={query.isFetching}>
                        <thead className="bg-slate-50"><tr>{["Employee", "Cutoff basic pay", "Gross", "Deductions", "Net", "Details"].map(label => <th key={label} className="px-3 py-3">{label}</th>)}</tr></thead>
                        <tbody>{data.rows.map(row => { const value = row.calculation; return <tr key={row.employeeCode} className="border-b border-slate-200 align-top">
                            <th scope="row" className="px-3 py-3 font-semibold">{row.employeeName}</th>
                            <td className="whitespace-nowrap px-3 py-3">{value ? money(value.basicPay) : "--"}</td>
                            <td className="whitespace-nowrap px-3 py-3">{value ? money(value.grossPay) : "--"}</td>
                            <td className="px-3 py-3">{value ? <><span className="block whitespace-nowrap">{money(value.deductions)}</span><details className="mt-2 text-xs"><summary className="cursor-pointer">Deduction breakdown</summary><dl className="mt-2 min-w-48 space-y-2">{value.deductionDetails.map(item => <div key={item.label}><dt>{item.label} ({item.minutes} min)</dt><dd className="font-semibold">{money(item.amount)}</dd></div>)}</dl></details></> : "--"}</td>
                            <td className="whitespace-nowrap px-3 py-3 font-semibold">{value ? money(value.netPay) : "--"}</td>
                            <td className="min-w-64 px-3 py-3"><details><summary className="cursor-pointer font-semibold text-slate-700">{row.warnings.length ? "Provisional / review" : "Proposed"}</summary>
                                {row.warnings.map(warning => <p key={warning} className="mt-2 text-xs text-amber-800">{warning}</p>)}
                                {value && <dl className="mt-2 space-y-1 text-xs">{[["Monthly basic pay", money(value.monthlySalary)], ["Hourly rate", money(value.hourlyRate)], ["Deduction rate / min", money(value.minuteRate)],
                                    ["Paid hours / day", `${value.paidHoursPerDay}h`], ["Completed days", value.attendanceDays], ["Worked hours", formatPayrollHours(value.workedHours)]].map(([label, amount]) => <div key={label} className="flex justify-between gap-4"><dt>{label}</dt><dd className="shrink-0 tabular-nums">{amount}</dd></div>)}</dl>}
                            </details></td>
                        </tr>; })}</tbody>
                    </table>{data.rows.length === 0 && <p className="py-4 text-sm text-slate-600">No ungenerated employees in this cutoff.</p>}</div>}
                </div>
            </section>
        </div>}
    </>;
}
