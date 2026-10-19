import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useQuery } from "@tanstack/react-query";
import { FiX } from "react-icons/fi";
import { getAttendanceSession, type AttendanceSessionSnapshot } from "../api/attendanceSession";
import AttendanceCorrections from "./AttendanceCorrections";
import "./AttendanceHub.css";

export default function AttendanceEditDialog({ employeeId, businessId, dayKey, eventId, onClose }: {
    employeeId: string; businessId: string; dayKey: string; eventId?: string; onClose: () => void;
}) {
    const dialog = useRef<HTMLDialogElement>(null);
    const query = useQuery({ queryKey: ["attendance-session", businessId, employeeId],
        queryFn: () => getAttendanceSession(employeeId, businessId), staleTime: 0 });
    useEffect(() => {
        const previous = document.activeElement as HTMLElement | null;
        const element = dialog.current;
        element?.showModal();
        return () => { element?.close(); if (previous?.isConnected) previous.focus(); };
    }, []);
    return createPortal(<dialog ref={dialog} className="attendance-edit-dialog" aria-labelledby="attendance-edit-title"
        onCancel={(event) => { event.preventDefault(); onClose(); }}
        onClick={(event) => { if (event.target === event.currentTarget) {
            const rect = event.currentTarget.getBoundingClientRect();
            if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) onClose();
        } }}>
        <header><div><h2 id="attendance-edit-title">Edit attendance</h2><p>{dayKey} · PH time</p></div>
            <button type="button" aria-label="Close attendance editor" onClick={onClose}><FiX /></button></header>
        <div className="attendance-edit-dialog-body">
            {query.isPending && <p role="status">Loading attendance...</p>}
            {query.isError && <div role="alert"><p>Attendance could not be loaded.</p><button type="button" onClick={() => void query.refetch()}>Retry</button></div>}
            {query.data && <LoadedEditor snapshot={query.data} employeeId={employeeId} businessId={businessId} dayKey={dayKey} eventId={eventId} />}
        </div>
    </dialog>, document.body);
}

function LoadedEditor({ snapshot, employeeId, businessId, dayKey, eventId }: {
    snapshot: AttendanceSessionSnapshot; employeeId: string; businessId: string; dayKey: string; eventId?: string;
}) {
    // Retain the opened event while its successful correction replaces it in the refreshed timeline.
    const [initial] = useState(() => ({ snapshot, event: eventId ? snapshot.records.find((event) => event.id === eventId) : undefined }));
    if (eventId && !initial.event) return <p role="alert">This event has changed or was removed. Close the editor and refresh attendance.</p>;
    return <AttendanceCorrections employeeId={employeeId} businessId={businessId} dayKey={dayKey} initialEvent={initial.event} initialSnapshot={initial.snapshot} />;
}
