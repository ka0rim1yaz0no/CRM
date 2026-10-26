import { useEffect, useRef, useState } from "react";
import { FiRefreshCw, FiX } from "react-icons/fi";
import { confirmMissingPayroll, previewMissingPayroll } from "../../api/payroll";
import { formatCurrency } from "../../lib/currency";
import type { CurrencyCode } from "../../api/systemSettings";
import type { PayrollGenerationPlan } from "../../../shared/payrollGeneration";

export default function PayrollGenerationDialog({ businessId, payPeriod, currencyCode, onClose, onSaved }: {
    businessId: string; payPeriod: string; currencyCode: CurrencyCode; onClose: () => void; onSaved: () => void;
}) {
    const [plan, setPlan] = useState<PayrollGenerationPlan | null>(null), [reason, setReason] = useState("");
    const [future, setFuture] = useState(false), [confirmed, setConfirmed] = useState(false), [busy, setBusy] = useState(true), [error, setError] = useState("");
    const dialog = useRef<HTMLElement>(null);
    useEffect(() => {
        const previous = document.activeElement as HTMLElement | null, controller = new AbortController();
        dialog.current?.focus();
        void previewMissingPayroll(payPeriod, businessId, controller.signal).then(value => { if (!controller.signal.aborted) setPlan(value); }).catch(caught => {
            if (!controller.signal.aborted) setError(caught?.response?.data?.message || "Unable to preview missing payroll.");
        }).finally(() => { if (!controller.signal.aborted) setBusy(false); });
        return () => { controller.abort(); if (previous?.isConnected) previous.focus(); };
    }, [businessId, payPeriod]);
    const money = (value: number) => formatCurrency(value, currencyCode);
    const apply = async () => {
        if (!plan || !confirmed || !reason.trim()) return;
        setBusy(true); setError("");
        try { await confirmMissingPayroll(plan, reason, future); onSaved(); onClose(); }
        catch (caught) { setError((caught as { response?: { data?: { message?: string } } })?.response?.data?.message || "Unable to generate. Refresh the preview."); setPlan(null); setConfirmed(false); }
        finally { setBusy(false); }
    };
    const refresh = async () => {
        setBusy(true); setError(""); setConfirmed(false); setPlan(null);
        try { setPlan(await previewMissingPayroll(payPeriod, businessId)); }
        catch (caught) { setError((caught as { response?: { data?: { message?: string } } })?.response?.data?.message || "Unable to preview missing payroll."); }
        finally { setBusy(false); }
    };
    return <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
        <section ref={dialog} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="payroll-generation-title" className="flex max-h-[90vh] w-full max-w-5xl flex-col overflow-hidden rounded-lg border border-slate-200 bg-white text-slate-950 shadow-xl" onKeyDown={event => {
            if (event.key === "Escape" && !busy) { event.preventDefault(); onClose(); }
            if (event.key !== "Tab") return;
            const controls = [...(dialog.current?.querySelectorAll<HTMLElement>('button:not([disabled]),input:not([disabled]),textarea:not([disabled])') || [])];
            const first = controls[0], last = controls.at(-1);
            if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
            else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
        }}>
            <header className="flex items-center justify-between gap-3 border-b border-slate-200 p-4"><div><h2 id="payroll-generation-title" className="text-lg font-semibold">Generate missing payroll</h2><p className="text-sm text-slate-600">{payPeriod}</p></div>
                <button type="button" aria-label="Close missing payroll" title="Close" disabled={busy} onClick={onClose} className="grid size-9 shrink-0 place-items-center rounded-md border border-slate-200"><FiX /></button></header>
            <div className="overflow-auto p-4">
                <div className="flex justify-end"><button type="button" aria-label="Refresh missing payroll preview" title="Refresh preview" disabled={busy} onClick={() => void refresh()} className="grid size-9 place-items-center rounded-md border border-slate-300 disabled:opacity-50"><FiRefreshCw /></button></div>
                {error && <p role="alert" className="my-3 text-sm text-red-700">{error}</p>}
                {busy && !plan && <p role="status" className="py-3 text-sm">Checking missing payroll...</p>}
                {plan && <><div className="mt-3 overflow-x-auto"><table className="w-full min-w-[48rem] text-left text-sm"><thead className="bg-slate-50"><tr>{["Employee", "Gross", "Deductions", "Net", "Attendance"].map(label => <th key={label} className="p-3">{label}</th>)}</tr></thead>
                    <tbody>{plan.rows.map(row => <tr key={row.employeeCode} className="border-b border-slate-200 align-top"><th scope="row" className="p-3">{row.employeeName}</th><td className="whitespace-nowrap p-3">{money(row.grossPay)}</td><td className="p-3"><span className="block whitespace-nowrap">{money(row.deductions)}</span><small className="mt-2 block">Non-billable Off the Phone</small><span className="block whitespace-nowrap text-xs">{row.nonBillableOffPhoneMinutes} min / {money(row.nonBillableOffPhoneDeduction)}</span></td><td className="whitespace-nowrap p-3 font-semibold">{money(row.netPay)}</td><td className="p-3">{row.incompleteShiftDays || row.scheduledDays ? "In-progress cutoff" : "Completed evidence"}</td></tr>)}</tbody></table></div>
                    {plan.rows.length === 0 && <p className="py-3 text-sm">No missing payroll is safe to generate.</p>}
                    {plan.held.length > 0 && <div className="mt-4 border-l-2 border-amber-500 pl-3 text-sm"><h3 className="font-semibold">Held for review ({plan.held.length})</h3>{plan.held.map(row => <p key={row.employeeCode} className="mt-2">{row.employeeName}: {row.reason}</p>)}</div>}
                    <label className="mt-4 flex items-start gap-2 text-sm"><input type="checkbox" checked={future || plan.automaticEnabled} disabled={plan.automaticEnabled || busy} onChange={event => { setFuture(event.target.checked); setConfirmed(false); }} />Automatically generate missing payroll for future current cutoffs</label>
                    <label className="mt-4 grid gap-1 text-sm">Audit reason<textarea value={reason} disabled={busy} maxLength={1000} onChange={event => setReason(event.target.value)} className="min-h-20 rounded-md border border-slate-300 p-2" /></label>
                    <label className="mt-3 flex items-start gap-2 text-sm"><input type="checkbox" checked={confirmed} disabled={busy} onChange={event => setConfirmed(event.target.checked)} />I confirm these new unpaid records and their business mirrors. Existing payroll stays unchanged; in-progress amounts require review before payment.</label>
                </>}
            </div>
            <footer className="flex justify-end gap-2 border-t border-slate-200 p-4"><button type="button" disabled={busy} onClick={onClose} className="h-10 rounded-md border border-slate-300 px-4">Cancel</button><button type="button" disabled={busy || !plan || (!plan.canApply && !future) || !confirmed || !reason.trim()} onClick={() => void apply()} className="h-10 rounded-md bg-violet-700 px-4 font-semibold text-white disabled:bg-slate-200 disabled:text-slate-600">Generate missing payroll</button></footer>
        </section>
    </div>;
}
