import { useEffect, useRef } from "react";
import { FiArchive, FiX } from "react-icons/fi";

export function EmployeeLeadArchiveDialog({ count, pending, close, confirm }: { count: number; pending: boolean; close: () => void; confirm: () => void }) {
    const dialog = useRef<HTMLDialogElement>(null);
    useEffect(() => { dialog.current?.showModal(); }, []);
    return <dialog ref={dialog} aria-labelledby="employee-bulk-archive-title" aria-busy={pending}
        onCancel={event => { event.preventDefault(); if (!pending) close(); }}
        className="fixed inset-0 m-auto max-h-[calc(100dvh-2rem)] w-[min(28rem,calc(100vw-2rem))] overflow-y-auto rounded-lg border border-slate-200 bg-white p-5 text-slate-900 shadow-xl backdrop:bg-black/50">
        <div className="flex items-start justify-between gap-3"><h2 id="employee-bulk-archive-title" className="text-lg font-semibold">Archive selected leads</h2>
            <button type="button" className="flex size-8 shrink-0 items-center justify-center rounded-md border border-slate-200" aria-label="Close archive confirmation" disabled={pending} onClick={close}><FiX aria-hidden="true" /></button></div>
        <p className="mt-4 text-sm">Archive {count} selected {count === 1 ? "lead" : "leads"} and their same-owner duplicate copies? History will be preserved. Other employees’ leads and active calls will not be archived.</p>
        <div className="mt-5 flex flex-wrap justify-end gap-2"><button type="button" className="h-9 rounded-md border border-slate-300 px-3 text-sm" disabled={pending} onClick={close}>Cancel</button>
            <button type="button" className="flex h-9 items-center gap-2 rounded-md bg-red-700 px-3 text-sm font-semibold text-white disabled:opacity-50" disabled={pending} onClick={confirm}><FiArchive aria-hidden="true" />{pending ? "Saving..." : "Confirm Archive"}</button></div>
    </dialog>;
}
