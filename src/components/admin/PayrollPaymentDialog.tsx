import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { FiRefreshCw, FiX } from "react-icons/fi";
import { previewPayrollPaymentStatus, confirmPayrollPaymentStatus, type PayrollRecord } from "../../api/payroll";
import { getActiveBusinessId } from "../../api/businessStorage";

export default function PayrollPaymentDialog({ record, businessId, paid, currencyCode = "PHP", onClose }: {
    record: PayrollRecord; businessId: string; paid: boolean; currencyCode?: string; onClose: () => void;
}) {
    const dialog = useRef<HTMLDialogElement>(null), mounted = useRef(true), saving = useRef(false);
    const queryClient = useQueryClient();
    const [reason, setReason] = useState(""), [acknowledged, setAcknowledged] = useState(false), [confirmed, setConfirmed] = useState(false);
    const [busy, setBusy] = useState(false), [error, setError] = useState(""), [stale, setStale] = useState(false);
    const query = useQuery({ queryKey: ["payroll-payment-preview", businessId, record._id, paid],
        queryFn: ({ signal }) => previewPayrollPaymentStatus(record._id, paid, businessId, signal), staleTime: 0, gcTime: 0,
        retry: false, refetchOnWindowFocus: false });
    const preview = query.data;
    const money = (value: number) => new Intl.NumberFormat("en-PH", { style: "currency", currency: currencyCode }).format(value);
    const errorText = (failure: unknown) => {
        const item = failure as { response?: { data?: { message?: string } }; message?: string };
        return item.response?.data?.message || item.message || "Unable to update payment status.";
    };
    useEffect(() => {
        mounted.current = true; const element = dialog.current, previous = document.activeElement as HTMLElement | null;
        element?.showModal();
        return () => { mounted.current = false; element?.close(); if (previous?.isConnected) previous.focus(); };
    }, []);
    const validScope = () => {
        if (getActiveBusinessId() === businessId) return true;
        setError("Business changed. Close and reopen payment confirmation."); setStale(true); return false;
    };
    const save = async () => {
        if (!preview?.canApply || !confirmed || !reason.trim() || (preview.warnings.length > 0 && !acknowledged) || saving.current || stale || !validScope()) return;
        saving.current = true; setBusy(true); setError("");
        try {
            await confirmPayrollPaymentStatus(preview, reason.trim(), acknowledged, businessId);
            await Promise.all(["payroll-records", "payroll-stats", "payroll-dtr", "payroll-payslip-dtr", "payroll-compute", "employee-payments"].map(key => queryClient.invalidateQueries({ queryKey: [key] })));
            if (mounted.current) onClose();
        } catch (failure) { if (mounted.current) { setError(errorText(failure)); setStale(true); setConfirmed(false); setAcknowledged(false); } }
        finally { saving.current = false; if (mounted.current) setBusy(false); }
    };
    return createPortal(<dialog ref={dialog} aria-labelledby="payroll-payment-title"
        className="m-auto max-h-[90vh] w-[calc(100vw-2rem)] max-w-2xl overflow-hidden rounded-lg border border-slate-300 bg-white p-0 text-slate-950 shadow-2xl backdrop:bg-black/60"
        onCancel={event => { event.preventDefault(); if (!busy) onClose(); }}>
        <div className="flex max-h-[90vh] flex-col">
            <header className="flex shrink-0 items-start justify-between gap-3 border-b border-slate-200 px-5 py-4">
                <div className="min-w-0"><h2 id="payroll-payment-title" className="text-lg font-semibold">{paid ? "Mark payroll paid" : "Set payroll unpaid"}</h2>
                    <p className="mt-1 break-words text-sm font-semibold">{record.employeeName}</p><p className="mt-1 text-xs text-slate-600">{record.payPeriod}</p></div>
                <button type="button" aria-label="Close payment confirmation" title="Close payment confirmation" disabled={busy} onClick={onClose}
                    className="grid size-9 shrink-0 place-items-center rounded-md border border-slate-300 disabled:opacity-50"><FiX /></button>
            </header>
            <div className="min-h-0 space-y-4 overflow-auto p-5">
                {query.isPending && <p role="status">Loading saved payroll...</p>}
                {(error || query.isError) && <p role="alert" className="text-sm text-red-800">{error || errorText(query.error)}</p>}
                {preview && <>
                    <dl className="grid grid-cols-2 gap-3 text-sm"><div><dt className="text-slate-600">Payment status</dt><dd className="mt-1 font-semibold">{paid ? "Paid" : "Pending"}</dd></div>
                        <div><dt className="text-slate-600">Paid date</dt><dd className="mt-1 font-semibold">{preview.paidOn}</dd></div>
                        <div className="col-span-2 border-t border-slate-200 pt-3"><dt className="text-slate-600">Saved net pay</dt>
                            <dd className="mt-1 text-lg font-semibold tabular-nums">{money((preview.rows.find(row => row.businessId === businessId) || preview.rows[0])?.netPay ?? record.netPay)}</dd></div></dl>
                    <div className="overflow-x-auto"><table className="w-full min-w-[26rem] text-left text-sm"><thead className="border-b border-slate-200 text-xs text-slate-600"><tr>
                        <th className="py-2">Business</th><th className="py-2 text-right">Gross</th><th className="py-2 text-right">Deductions</th><th className="py-2 text-right">Net pay</th></tr></thead>
                        <tbody>{preview.rows.map(row => <tr key={row.businessId} className="border-b border-slate-100"><th className="py-3 pr-3 font-medium">{row.businessName}</th>
                            <td className="whitespace-nowrap px-2 py-3 text-right tabular-nums">{money(row.grossPay)}</td><td className="whitespace-nowrap px-2 py-3 text-right tabular-nums">{money(row.deductions)}</td>
                            <td className="whitespace-nowrap py-3 text-right font-semibold tabular-nums">{money(row.netPay)}</td></tr>)}</tbody></table></div>
                    {preview.blockers.map(message => <p key={message} role="alert" className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-800">{message}</p>)}
                    {preview.warnings.map(message => <p key={message} className="text-sm text-amber-900">{message}</p>)}
                    {preview.canApply && <>
                        <label htmlFor="payroll-payment-reason" className="block text-sm font-semibold">Reason</label>
                        <textarea id="payroll-payment-reason" value={reason} maxLength={1000} disabled={busy} onChange={event => setReason(event.target.value)} className="min-h-20 w-full rounded-md border border-slate-300 p-3 text-sm" />
                        {preview.warnings.length > 0 && <label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={acknowledged} disabled={busy} onChange={event => setAcknowledged(event.target.checked)} className="mt-1" />I acknowledge the attendance history and approve the saved amounts without recalculating pay.</label>}
                        <label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={confirmed} disabled={busy} onChange={event => setConfirmed(event.target.checked)} className="mt-1" />Confirm payment status only; amounts and attendance stay unchanged.</label>
                    </>}
                </>}
            </div>
            <footer className="flex shrink-0 justify-end gap-2 border-t border-slate-200 px-5 py-3">
                <button type="button" title="Refresh payment preview" aria-label="Refresh payment preview" disabled={busy || query.isFetching}
                    onClick={() => { if (validScope()) { setError(""); setStale(false); setConfirmed(false); setAcknowledged(false); void query.refetch(); } }}
                    className="grid size-10 place-items-center rounded-md border border-slate-300 disabled:opacity-50"><FiRefreshCw className={query.isFetching ? "animate-spin" : ""} /></button>
                <button type="button" onClick={() => void save()} disabled={busy || query.isFetching || !preview?.canApply || !confirmed || !reason.trim() || stale || Boolean(preview.warnings.length && !acknowledged)}
                    className="h-10 rounded-md bg-emerald-700 px-4 text-sm font-semibold text-white disabled:opacity-50">{busy ? "Saving..." : paid ? "Mark Paid" : "Set Unpaid"}</button>
            </footer>
        </div>
    </dialog>, document.body);
}
