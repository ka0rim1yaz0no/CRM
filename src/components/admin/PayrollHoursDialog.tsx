import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useQueryClient } from "@tanstack/react-query";
import { FiX } from "react-icons/fi";
import { confirmPayrollWorkedHours, previewPayrollWorkedHours, type PayrollHoursPreview, type PayrollRecord } from "../../api/payroll";
import { getActiveBusinessId } from "../../api/businessStorage";
import { formatPayrollHours } from "../../lib/payrollFormatting";

const money = (value: number) => new Intl.NumberFormat("en-PH", { style: "currency", currency: "PHP" }).format(value);
export default function PayrollHoursDialog({ record, businessId, onClose }: {
    record: PayrollRecord; businessId: string; onClose: () => void;
}) {
    const queryClient = useQueryClient();
    const dialog = useRef<HTMLDialogElement>(null);
    const request = useRef<AbortController | null>(null);
    const mounted = useRef(true);
    const [hours, setHours] = useState(String(Number(((record.workedMinutesOverride ?? Math.round((record.workedHours ?? 0) * 60)) / 60).toFixed(6))));
    const [reason, setReason] = useState("");
    const [preview, setPreview] = useState<PayrollHoursPreview | null>(null);
    const [confirmed, setConfirmed] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const locked = ["Paid", "Completed"].includes(record.status);
    const validScope = () => {
        if (getActiveBusinessId() === businessId) return true;
        setPreview(null); setError("Business changed. Close and reopen the hours editor."); return false;
    };
    useEffect(() => {
        mounted.current = true;
        const previous = document.activeElement as HTMLElement | null;
        const element = dialog.current; element?.showModal();
        return () => { mounted.current = false; request.current?.abort(); element?.close(); if (previous?.isConnected) previous.focus(); };
    }, []);
    const showError = (failure: unknown) => {
        const item = failure as { response?: { data?: { message?: string } }; message?: string };
        setPreview(null); setConfirmed(false); setError(item.response?.data?.message || item.message || "Unable to update total hours.");
    };
    const loadPreview = async () => {
        if (busy || !validScope()) return;
        const numeric = Number(hours), minutes = Math.round(numeric * 60);
        if (!hours.trim() || !Number.isFinite(numeric) || numeric < 0 || !Number.isSafeInteger(minutes) || minutes > Math.round((record.scheduledHours ?? 0) * 60)) {
            setError("Enter total hours between zero and the scheduled cutoff hours."); return;
        }
        setBusy(true); setError(""); setPreview(null); setConfirmed(false);
        const controller = new AbortController(); request.current = controller;
        try {
            const result = await previewPayrollWorkedHours(record._id, minutes, businessId, controller.signal);
            if (mounted.current && validScope()) setPreview(result);
        } catch (failure) { if (mounted.current && !controller.signal.aborted) showError(failure); }
        finally { if (mounted.current) setBusy(false); }
    };
    const save = async () => {
        if (!preview || busy || !confirmed || !reason.trim() || !validScope()) return;
        setBusy(true); setError("");
        try {
            await confirmPayrollWorkedHours(preview, reason.trim(), businessId);
            await Promise.all(["payroll-records", "payroll-stats", "payroll-dtr", "payroll-payslip-dtr", "employee-payments"].map(key =>
                queryClient.invalidateQueries({ queryKey: [key] })));
            if (mounted.current) onClose();
        } catch (failure) { if (mounted.current) showError(failure); }
        finally { if (mounted.current) setBusy(false); }
    };
    return createPortal(<dialog ref={dialog} aria-labelledby="payroll-hours-title"
        className="m-auto max-h-[90vh] w-[calc(100vw-2rem)] max-w-xl overflow-hidden rounded-lg border border-slate-300 bg-white p-0 text-slate-950 shadow-2xl backdrop:bg-black/60"
        onCancel={event => { event.preventDefault(); if (!busy) onClose(); }}>
        <div className="flex max-h-[90vh] flex-col">
        <header className="flex shrink-0 items-start justify-between gap-3 border-b border-slate-200 px-5 py-4">
            <div className="min-w-0"><h2 id="payroll-hours-title" className="text-lg font-semibold">Edit total hours</h2>
                <p className="mt-1 break-words text-sm font-semibold">{record.employeeName}</p>
                <p className="mt-1 break-words text-xs text-slate-600">{record.payPeriod}</p></div>
            <button type="button" title="Close hours editor" aria-label="Close hours editor" disabled={busy} onClick={onClose}
                className="grid size-9 shrink-0 place-items-center rounded-md border border-slate-300 disabled:opacity-50"><FiX /></button>
        </header>
        <div className="min-h-0 space-y-4 overflow-auto p-5">
            <dl className="grid grid-cols-2 gap-4 text-sm">
                <div><dt className="text-slate-600">Saved total hours</dt><dd className="mt-1 font-semibold tabular-nums">{formatPayrollHours(record.workedHours)}</dd></div>
                <div><dt className="text-slate-600">Scheduled cutoff hours</dt><dd className="mt-1 font-semibold tabular-nums">{formatPayrollHours(record.scheduledHours)}</dd></div>
            </dl>
            <label className="block text-sm font-semibold" htmlFor="payroll-total-hours">Total hours for this cutoff</label>
            <input id="payroll-total-hours" type="number" min="0" max={record.scheduledHours ?? 0} step="any" value={hours} disabled={busy || locked}
                onChange={event => { setHours(event.target.value); setPreview(null); setConfirmed(false); setError(""); }}
                className="h-11 w-full rounded-md border border-slate-300 px-3 text-base tabular-nums disabled:opacity-50" />
            {locked && <p role="alert" className="text-sm text-amber-800">Paid or completed payroll is locked.</p>}
            {error && <p role="alert" className="text-sm text-red-800">{error}</p>}
            {preview && <>
                <table className="w-full table-fixed text-left text-sm"><thead className="border-b border-slate-200 text-xs text-slate-600"><tr>
                    <th className="w-[40%] py-2">Cutoff</th><th className="py-2 text-right">Before</th><th className="py-2 text-right">After</th></tr></thead>
                    <tbody>{([ ["Total hours", formatPayrollHours(preview.before.workedHours), formatPayrollHours(preview.after.workedHours)],
                        ["Gross pay", money(preview.before.grossPay), money(preview.after.grossPay)],
                        ["Deductions", money(preview.before.deductions), money(preview.after.deductions)],
                        ["Net pay", money(preview.before.netPay), money(preview.after.netPay)],
                        ["Payment status", preview.before.status, preview.after.status] ]).map(([label, before, after]) => <tr key={label} className="border-b border-slate-100">
                        <th className="py-3 font-medium">{label}</th><td className="break-words py-3 text-right tabular-nums">{before}</td><td className="break-words py-3 text-right font-semibold tabular-nums">{after}</td></tr>)}</tbody>
                </table>
                <p className="text-xs text-slate-600">Attendance punches unchanged. Saved excess break and lunch included once. {preview.businessIds.length} business {preview.businessIds.length === 1 ? "copy" : "copies"}.</p>
                <label htmlFor="payroll-hours-reason" className="block text-sm font-semibold">Reason</label>
                <textarea id="payroll-hours-reason" value={reason} maxLength={1000} disabled={busy} onChange={event => setReason(event.target.value)}
                    className="min-h-20 w-full rounded-md border border-slate-300 p-3 text-sm" />
                <label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={confirmed} disabled={busy} onChange={event => setConfirmed(event.target.checked)} className="mt-1" />Confirm these payroll changes</label>
            </>}
        </div>
        <footer className="flex shrink-0 justify-end gap-2 border-t border-slate-200 px-5 py-3">
            {preview ? <button type="button" onClick={() => void save()} disabled={busy || !confirmed || !reason.trim() || locked}
                className="h-10 rounded-md bg-blue-700 px-4 text-sm font-semibold text-white disabled:opacity-50">{busy ? "Saving..." : "Save total hours"}</button>
                : <button type="button" onClick={() => void loadPreview()} disabled={busy || locked} className="h-10 rounded-md border border-slate-300 px-4 text-sm font-semibold disabled:opacity-50">{busy ? "Loading..." : "Preview changes"}</button>}
        </footer></div>
    </dialog>, document.body);
}
