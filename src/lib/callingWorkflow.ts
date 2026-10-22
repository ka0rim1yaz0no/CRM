import type { Lead } from "../api/leads";
export type CallingScope = { employeeId: string; businessId: string };
export const callingWorkflowChanged = "crm:calling-workflow-changed";
const work = new Map<string, { owner: symbol; message: string }>();
const progress = new Map<string, string>();
const saves = new Map<string, Set<Promise<unknown>>>();
const noteDrafts = new Map<string, { lead: Lead; body: string }>();
const key = (scope: CallingScope) => JSON.stringify([scope.employeeId, scope.businessId]);
const notify = () => window.dispatchEvent(new Event(callingWorkflowChanged));
export function setCallingWork(scope: CallingScope, owner: symbol, message: string) {
    const id = key(scope), previous = work.get(id);
    if (!message) { if (previous?.owner === owner) { work.delete(id); notify(); } return; }
    if (previous?.owner === owner && previous.message === message) return;
    work.set(id, { owner, message }); notify();
}
export const callingWorkMessage = (scope: CallingScope) => saves.get(key(scope))?.size ? "Saving lead changes" : work.get(key(scope))?.message || "";
export function trackCallingSave(scope: CallingScope, promise: Promise<unknown>) {
    const id = key(scope), pending = saves.get(id) || new Set<Promise<unknown>>();
    pending.add(promise); saves.set(id, pending); notify();
    const finish = () => { pending.delete(promise); if (!pending.size && saves.get(id) === pending) saves.delete(id); notify(); };
    void promise.then(finish, finish);
}
export const getLeadNoteDraft = (scope: CallingScope) => noteDrafts.get(key(scope)) || null;
export function setLeadNoteDraft(scope: CallingScope, lead: Lead, body: string) {
    if (body.trim()) noteDrafts.set(key(scope), { lead, body }); else noteDrafts.delete(key(scope));
}
export function clearSavedLeadNoteDraft(scope: CallingScope, leadId: string, body: string) {
    const draft = noteDrafts.get(key(scope));
    if (draft?.lead._id === leadId && draft.body.trim() === body.trim()) noteDrafts.delete(key(scope));
}
export const callingProgress = (scope: CallingScope) => progress.get(key(scope)) || "Checking calling queue";
export function setCallingProgress(scope: CallingScope, message: string) {
    if (progress.get(key(scope)) === message) return;
    progress.set(key(scope), message); window.dispatchEvent(new Event("crm:calling-progress-changed"));
}
export const subscribeCallingWorkflow = (listener: () => void) => {
    window.addEventListener(callingWorkflowChanged, listener);
    window.addEventListener("crm:calling-progress-changed", listener);
    return () => { window.removeEventListener(callingWorkflowChanged, listener); window.removeEventListener("crm:calling-progress-changed", listener); };
};
export const callingQueueKey = (scope: CallingScope) => ["calling-queue", scope.businessId, scope.employeeId] as const;
