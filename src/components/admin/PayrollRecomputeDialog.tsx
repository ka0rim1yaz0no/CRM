import { useEffect, useRef, useState } from "react";
import { FiX, FiRefreshCw } from "react-icons/fi";
import { previewPayrollCutoff, confirmPayrollCutoff, type PayrollPreview } from "../../api/payroll";
import { formatCurrency } from "../../lib/currency";
import type { CurrencyCode } from "../../api/systemSettings";

const errorText = (error: unknown) => (error as { response?: { data?: { message?: string } } })?.response?.data?.message || "Unable to confirm payroll. Preview again.";
export default function PayrollRecomputeDialog({ onClose, onSaved, currencyCode = "PHP", initialPeriod = "" }: { onClose: () => void; onSaved: () => void; currencyCode?: CurrencyCode; initialPeriod?: string }) {
    const dates = initialPeriod.split(" - ").map(value => {
        const parsed = new Date(`${value} 12:00:00 UTC`);
        return Number.isFinite(+parsed) ? parsed.toISOString().slice(0, 10) : "";
    });
    const [from, setFrom] = useState(dates[0] || "");
    const [to, setTo] = useState(dates[1] || "");
    const [preview, setPreview] = useState<PayrollPreview | null>(null);
    const [approvals, setApprovals] = useState<Record<string, number>>({});
    const [reason, setReason] = useState("");
    const [confirmed, setConfirmed] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const dialog = useRef<HTMLElement>(null);
    useEffect(() => {
        const previous = document.activeElement as HTMLElement | null;
        dialog.current?.querySelector<HTMLInputElement>("input")?.focus();
        return () => { if (previous?.isConnected) previous.focus(); };
    }, []);
    const money = (value: number) => formatCurrency(value, currencyCode);
    const period = () => [from, to].map(value => new Date(`${value}T12:00:00Z`).toLocaleDateString("en-US", { timeZone: "UTC", month: "short", day: "numeric", year: "numeric" })).join(" - ");
    const load = async () => {
        setBusy(true); setError(""); setConfirmed(false); setPreview(null);
        try { setPreview(await previewPayrollCutoff(period(), approvals)); } catch (caught) { setError(errorText(caught)); }
        finally { setBusy(false); }
    };
    const apply = async () => {
        if (!preview || !confirmed || !reason.trim()) return;
        setBusy(true); setError("");
        try { await confirmPayrollCutoff(preview, reason, approvals); onSaved(); onClose(); }
        catch (caught) { setError(errorText(caught)); setPreview(null); setConfirmed(false); }
        finally { setBusy(false); }
    };
    return <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" role="presentation">
        <section ref={dialog} role="dialog" aria-modal="true" aria-labelledby="payroll-recompute-title" onKeyDown={event => {
            if (event.key === "Escape" && !busy) { event.preventDefault(); onClose(); }
            if (event.key !== "Tab") return;
            const controls = [...(dialog.current?.querySelectorAll<HTMLElement>('button:not([disabled]),input:not([disabled]),textarea:not([disabled])') || [])];
            const first = controls[0], last = controls.at(-1);
            if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
            else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
        }} className="flex max-h-[90vh] w-full max-w-6xl flex-col overflow-hidden rounded-lg border border-slate-200 bg-white text-slate-950 shadow-xl">
            <header className="flex items-center justify-between border-b border-slate-200 px-5 py-4"><h2 id="payroll-recompute-title" className="text-lg font-semibold">Generate / Recompute cutoff</h2>
                <button type="button" onClick={onClose} disabled={busy} title="Close" aria-label="Close payroll preview" className="grid size-9 place-items-center rounded-md border border-slate-200"><FiX /></button></header>
            <div className="overflow-auto p-5">
                <div className="flex flex-wrap items-end gap-3"><label className="grid gap-1 text-sm">First shift day<input type="date" value={from} onChange={event => { setFrom(event.target.value); setPreview(null); }} className="h-10 rounded-md border border-slate-300 px-3" /></label>
                    <label className="grid gap-1 text-sm">Last shift day<input type="date" value={to} min={from} onChange={event => { setTo(event.target.value); setPreview(null); }} className="h-10 rounded-md border border-slate-300 px-3" /></label>
                    <button type="button" disabled={busy || !from || !to || from > to} onClick={() => void load()} className="inline-flex h-10 items-center gap-2 rounded-md border border-slate-300 px-3 text-sm font-semibold disabled:opacity-50"><FiRefreshCw />{busy ? "Checking..." : "Preview differences"}</button></div>
                {error && <p role="alert" className="mt-4 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-800">{error}</p>}
                {preview && <><div className="mt-5 overflow-x-auto"><table className="w-full text-left text-sm"><thead className="bg-slate-50"><tr>
                    <th className="p-2">Employee / owner</th><th className="p-2">Gross old / new</th><th className="p-2">Deductions old / new</th><th className="p-2">Net old / new</th><th className="p-2">Difference</th><th className="p-2">Approved weekend OT</th><th className="p-2">Review</th></tr></thead>
                    <tbody>{preview.rows.map(row => <tr key={row.employeeCode} className="border-b border-slate-200"><td className="p-2 font-semibold">{row.employeeName}<small className="block font-normal text-slate-600">{row.employeeCode} · {row.ownerBusinessId}</small></td>
                        <td className="p-2 whitespace-nowrap">{money(row.before.grossPay)} / {money(row.after.grossPay)}</td><td className="p-2 whitespace-nowrap">{money(row.before.deductions)} / {money(row.after.deductions)}</td>
                        <td className="p-2 whitespace-nowrap">{money(row.before.netPay)} / {money(row.after.netPay)}</td><td className="p-2">{money(row.difference)}</td>
                        <td className="p-2"><input type="number" min="0" max={row.potentialOvertimeHours} step="any" aria-label={`Approved overtime for ${row.employeeName}`} value={approvals[row.employeeCode] ?? row.approvedOvertimeHours}
                            onChange={event => { setApprovals(value => ({ ...value, [row.employeeCode]: Number(event.target.value) })); setPreview(null); setConfirmed(false); }} className="h-9 w-24 rounded-md border border-slate-300 px-2" /><small className="block text-slate-600">of {row.potentialOvertimeHours.toFixed(2)}h verified</small></td>
                        <td className="p-2">{row.reviewDays ? `${row.reviewDays} Needs Review` : "Resolved"}</td></tr>)}</tbody></table></div>
                    <p className="mt-4 font-semibold">Total net difference: {money(preview.totalDifference)}</p>
                    {!preview.canApply && <p role="alert" className="mt-3 text-sm text-amber-800">Resolve Needs Review attendance before applying this cutoff.</p>}
                    <label className="mt-4 grid gap-1 text-sm">Audit reason<textarea maxLength={1000} value={reason} onChange={event => setReason(event.target.value)} className="min-h-20 rounded-md border border-slate-300 p-2" /></label>
                    <label className="mt-3 flex items-start gap-2 text-sm"><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} />I confirm these before/after amounts and the affected business mirrors.</label></>}
            </div><footer className="flex justify-end gap-2 border-t border-slate-200 p-4"><button type="button" onClick={onClose} disabled={busy} className="h-10 rounded-md border border-slate-300 px-4">Cancel</button>
                <button type="button" disabled={busy || !preview?.canApply || !confirmed || !reason.trim()} onClick={() => void apply()} className="h-10 rounded-md bg-violet-700 px-4 font-semibold text-white disabled:cursor-not-allowed disabled:!bg-slate-200 disabled:!text-slate-600 disabled:!opacity-100">Confirm cutoff</button></footer>
        </section></div>;
}
