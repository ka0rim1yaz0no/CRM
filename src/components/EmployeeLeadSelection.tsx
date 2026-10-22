import { useRef, useState } from "react";
import { FiArchive, FiX } from "react-icons/fi";
import { archiveEmployeeLeads, type Lead } from "../api/leads";
import { getAuthUser } from "../api/authStorage";
import { getActiveBusinessId } from "../api/businessStorage";
import { leadBelongsToEmployee } from "../../shared/leadAssignmentPolicy";
import { useToast } from "../lib/toast";
import { reportRequestError } from "../lib/requestErrorToast";
import { EmployeeLeadArchiveDialog } from "./EmployeeLeadArchiveDialog";

type Props = { businessId: string; employeeId: string; employeeNames: string[]; employeeSession?: string; leads: Lead[];
    blocked: boolean; beforeArchive: (operation: () => Promise<unknown>) => Promise<unknown>; onArchived: (ids: string[]) => void };
type Confirmation = { scope: string; leads: Lead[]; businessId: string; employeeSession?: string };

export function useEmployeeLeadSelection(props: Props) {
    const { showToast } = useToast();
    const scope = `${props.businessId}|${props.employeeId}|${props.employeeSession || ""}`;
    const [selection, setSelection] = useState<{ scope: string; leads: Record<string, Lead> }>({ scope, leads: {} });
    const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
    const [pending, setPending] = useState(false);
    const pendingRef = useRef(false);
    const [seenScope, setSeenScope] = useState(scope);
    if (seenScope !== scope) {
        setSeenScope(scope); setSelection({ scope, leads: {} }); setConfirmation(null);
    }
    const selected = selection.scope === scope ? selection.leads : {};
    const canSelect = (lead: Lead) => lead.status !== "Archived" && leadBelongsToEmployee(lead, props.employeeId, props.employeeNames);
    const eligible = props.leads.filter(canSelect);
    const selectedCount = Object.keys(selected).length;
    const all = eligible.length > 0 && eligible.every(lead => Boolean(selected[lead._id]));
    const some = eligible.some(lead => Boolean(selected[lead._id]));
    const toggle = (lead: Lead) => {
        if (!canSelect(lead) || pendingRef.current) return;
        setSelection(previous => {
            const leads = previous.scope === scope ? { ...previous.leads } : {};
            if (leads[lead._id]) delete leads[lead._id];
            else if (Object.keys(leads).length < 100) leads[lead._id] = lead;
            return { scope, leads };
        });
    };
    const current = () => getActiveBusinessId() === props.businessId && getAuthUser()?.attendanceHubSession === props.employeeSession;
    const confirm = async () => {
        if (!confirmation || confirmation.scope !== scope || pendingRef.current || props.blocked || !current()) return;
        const captured = confirmation;
        pendingRef.current = true; setPending(true);
        try {
            await props.beforeArchive(async () => {
                if (getActiveBusinessId() !== captured.businessId || getAuthUser()?.attendanceHubSession !== captured.employeeSession) return;
                const result = await archiveEmployeeLeads(captured.leads, captured);
                if (!current()) return;
                props.onArchived(result.archivedIds);
                setSelection(previous => {
                    const leads = previous.scope === scope ? { ...previous.leads } : {};
                    for (const id of result.archivedIds) delete leads[id];
                    for (const lead of captured.leads) if (!result.busyIds.includes(lead._id) && !result.conflictIds.includes(lead._id)) delete leads[lead._id];
                    return { scope, leads };
                });
                setConfirmation(null);
                const skipped = result.busyIds.length + result.conflictIds.length;
                showToast({ tone: "success", message: `${result.archivedCount} lead records archived.${skipped ? ` ${skipped} busy or changed records skipped.` : ""}` });
            });
        } catch (error) { if (current()) reportRequestError(error, "Could not archive the selected leads."); }
        finally { pendingRef.current = false; setPending(false); }
    };
    const checkbox = (lead: Lead) => canSelect(lead) ? <input type="checkbox" className="size-4 shrink-0 accent-violet-600" aria-label={`Select ${lead.leadName || lead.businessName}`}
        checked={Boolean(selected[lead._id])} disabled={pending} onChange={() => toggle(lead)} /> : null;
    const toolbar = <div className="flex flex-wrap items-center gap-2 border-b border-white/10 px-3 py-2 text-xs text-white">
        <label className="flex min-h-8 items-center gap-2"><input type="checkbox" aria-label="Select visible leads (up to 100)" checked={all}
            ref={node => { if (node) node.indeterminate = some && !all; }} disabled={!eligible.length || pending}
            onChange={() => setSelection(previous => {
                const leads = previous.scope === scope ? { ...previous.leads } : {};
                for (const lead of eligible) { if (all) delete leads[lead._id]; else if (Object.keys(leads).length < 100) leads[lead._id] = lead; }
                return { scope, leads };
            })} />Select visible (100 max)</label>
        <span aria-live="polite">{selectedCount} selected</span>
        <button type="button" className="flex h-8 items-center gap-1 rounded-md border border-white/20 px-2 disabled:opacity-40" disabled={!selectedCount || pending || props.blocked}
            onClick={() => setConfirmation({ scope, leads: Object.values(selected), businessId: props.businessId, employeeSession: props.employeeSession })}><FiArchive aria-hidden="true" />Archive Selected</button>
        <button type="button" className="flex size-8 items-center justify-center rounded-md border border-white/20 disabled:opacity-40" aria-label="Clear lead selection" title="Clear selection" disabled={!selectedCount || pending}
            onClick={() => setSelection({ scope, leads: {} })}><FiX aria-hidden="true" /></button>
    </div>;
    return { checkbox, toolbar, pending, confirming: confirmation?.scope === scope,
        dialog: confirmation?.scope === scope ? <EmployeeLeadArchiveDialog count={confirmation.leads.length} pending={pending} close={() => { if (!pending) setConfirmation(null); }} confirm={() => void confirm()} /> : null };
}
