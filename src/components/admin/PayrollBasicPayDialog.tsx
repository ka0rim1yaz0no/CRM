import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FiRotateCcw, FiX } from "react-icons/fi";
import { getEmployeeBasicPay, updateEmployeeBasicPay, type EmployeeBasicPay, type PayrollRecord } from "../../api/payroll";
import { getActiveBusinessId } from "../../api/businessStorage";

function message(error: unknown) {
    const failure = error as { response?: { data?: { message?: string } }; message?: string };
    return failure.response?.data?.message || failure.message || "Unable to save monthly salary.";
}

export default function PayrollBasicPayDialog({ record, businessId, savedCutoffsProtected, onClose, onSaved }: {
    record: PayrollRecord; businessId: string; savedCutoffsProtected: boolean;
    onClose: () => void; onSaved: (salary: EmployeeBasicPay) => void;
}) {
    const dialog = useRef<HTMLDialogElement>(null), mounted = useRef(true), saving = useRef(false);
    const queryClient = useQueryClient();
    const [input, setInput] = useState<string | null>(null), [error, setError] = useState("");
    const queryKey = ["payroll-basic-pay", businessId, record.employeeId];
    const salary = useQuery({ queryKey, queryFn: ({ signal }) => getEmployeeBasicPay(record.employeeId, { businessId, signal }),
        staleTime: 0, retry: false, refetchOnMount: "always" });
    useEffect(() => {
        mounted.current = true;
        const previous = document.activeElement as HTMLElement | null, element = dialog.current;
        element?.showModal();
        return () => { mounted.current = false; element?.close(); if (previous?.isConnected) previous.focus(); };
    }, []);
    const mutation = useMutation({ mutationFn: async (value: number) => {
        if (getActiveBusinessId() !== businessId) throw Error("Business changed. Reopen the salary editor.");
        await updateEmployeeBasicPay(record.employeeId, value, { businessId });
        const saved = await getEmployeeBasicPay(record.employeeId, { businessId });
        if (saved.businessId !== businessId || saved.employeeId !== record.employeeId || saved.monthlySalary !== value) {
            throw Error("The saved salary could not be confirmed. Close and reopen this editor before trying again.");
        }
        return saved;
    }, onSuccess: saved => {
        queryClient.setQueryData(queryKey, saved);
        for (const key of ["employees", "payroll-current-previews", "payroll-compute"]) void queryClient.invalidateQueries({ queryKey: [key] });
        if (mounted.current && getActiveBusinessId() === businessId) onSaved(saved);
    } });
    const value = input ?? (salary.data ? String(salary.data.monthlySalary) : "");
    const ready = !salary.isPending && !salary.isFetching && !salary.isError && salary.data?.employeeId === record.employeeId && salary.data.businessId === businessId;
    const save = async () => {
        if (saving.current || mutation.isPending || !ready) return;
        const numeric = Number(value), cents = Math.round(numeric * 100);
        if (!value.trim() || !Number.isFinite(numeric) || numeric < 0 || !Number.isSafeInteger(cents) || Math.abs(numeric - cents / 100) > 1e-8) {
            setError("Enter a non-negative monthly salary with no more than two decimal places."); return;
        }
        saving.current = true; setError("");
        try { await mutation.mutateAsync(cents / 100); }
        catch (failure) { if (mounted.current) setError(message(failure)); }
        finally { saving.current = false; }
    };
    const close = () => { if (!saving.current && !mutation.isPending) onClose(); };
    return createPortal(<dialog ref={dialog} aria-labelledby="basic-pay-title"
        className="m-auto max-h-[90vh] w-[calc(100vw-2rem)] max-w-md overflow-hidden rounded-lg border border-slate-300 bg-white p-0 text-slate-950 shadow-2xl backdrop:bg-black/60"
        onCancel={event => { event.preventDefault(); close(); }}>
        <form noValidate className="flex max-h-[90vh] flex-col" onSubmit={event => { event.preventDefault(); void save(); }}>
            <header className="flex shrink-0 items-start justify-between gap-3 border-b border-slate-200 px-5 py-4">
                <div className="min-w-0"><h2 id="basic-pay-title" className="text-lg font-semibold">Monthly Basic Pay</h2>
                    <p className="mt-1 break-words text-sm font-semibold">{record.employeeName}</p></div>
                <button type="button" title="Close salary editor" aria-label="Close salary editor" disabled={mutation.isPending} onClick={close}
                    className="grid size-9 shrink-0 place-items-center rounded-md border border-slate-300 disabled:opacity-50"><FiX /></button>
            </header>
            <div className="min-h-0 space-y-3 overflow-auto p-5">
                <label className="block text-sm font-semibold" htmlFor="monthly-basic-pay">Monthly salary</label>
                <input id="monthly-basic-pay" type="number" min="0" step="0.01" inputMode="decimal" value={value}
                    disabled={!ready || mutation.isPending} aria-invalid={Boolean(error)}
                    onChange={event => { setInput(event.target.value); setError(""); }}
                    className="h-11 w-full rounded-md border border-slate-300 px-3 text-base tabular-nums disabled:opacity-50" />
                {salary.isFetching && <p role="status" className="text-sm text-slate-600">Loading current salary...</p>}
                {salary.isError && <div className="flex items-start gap-2 text-sm text-red-800"><p role="alert">{message(salary.error)}</p>
                    <button type="button" title="Reload current salary" aria-label="Reload current salary" onClick={() => void salary.refetch()}
                        className="grid size-8 shrink-0 place-items-center rounded-md border border-slate-300"><FiRotateCcw /></button></div>}
                {savedCutoffsProtected && <p className="text-xs text-slate-600">Saved cutoff amounts remain unchanged until a confirmed recompute.</p>}
                {error && <p role="alert" className="text-sm text-red-800">{error}</p>}
            </div>
            <footer className="flex shrink-0 justify-end gap-2 border-t border-slate-200 px-5 py-3">
                <button type="button" disabled={mutation.isPending} onClick={close} className="h-10 rounded-md border border-slate-300 px-4 text-sm font-semibold disabled:opacity-50">Cancel</button>
                <button type="submit" disabled={!ready || mutation.isPending} className="h-10 rounded-md bg-blue-700 px-4 text-sm font-semibold text-white disabled:opacity-50">
                    {mutation.isPending ? "Saving..." : "Save Basic Pay"}</button>
            </footer>
        </form>
    </dialog>, document.body);
}
