import type { Lead } from "../api/leads";
export type CallingScope = { employeeId: string; businessId: string };
export const callingWorkflowChanged = "crm:calling-workflow-changed";
type OwnedMessages = Map<string, Map<symbol, string>>;
const work: OwnedMessages = new Map();
const drafts: OwnedMessages = new Map();
const progress = new Map<string, string>();
const saves = new Map<string, Set<Promise<unknown>>>();
const noteDrafts = new Map<string, Map<string, { lead: Lead; body: string }>>();
const key = (scope: CallingScope) => JSON.stringify([scope.employeeId, scope.businessId]);
const notify = () => window.dispatchEvent(new Event(callingWorkflowChanged));
function setOwnedMessage(store: OwnedMessages, scope: CallingScope, owner: symbol, message: string) {
    const id = key(scope), messages = store.get(id) || new Map<symbol, string>();
    if (!message) {
        if (!messages.delete(owner)) return;
        if (!messages.size) store.delete(id);
    } else {
        if (messages.get(owner) === message) return;
        messages.set(owner, message); store.set(id, messages);
    }
    notify();
}
export const setCallingWork = (scope: CallingScope, owner: symbol, message: string) => setOwnedMessage(work, scope, owner, message);
export const setCallingDraft = (scope: CallingScope, owner: symbol, message: string) => setOwnedMessage(drafts, scope, owner, message);
export const callingDraftMessage = (scope: CallingScope) => drafts.get(key(scope))?.values().next().value || "";
export const callingWorkMessage = (scope: CallingScope, exceptOwner?: symbol) => {
    if (saves.get(key(scope))?.size) return "Saving lead changes";
    for (const [owner, message] of work.get(key(scope)) || []) if (owner !== exceptOwner) return message;
    return "";
};
export function trackCallingSave(scope: CallingScope, promise: Promise<unknown>) {
    const id = key(scope), pending = saves.get(id) || new Set<Promise<unknown>>();
    pending.add(promise); saves.set(id, pending); notify();
    const finish = () => { pending.delete(promise); if (!pending.size && saves.get(id) === pending) saves.delete(id); notify(); };
    void promise.then(finish, finish);
}
export const getLeadNoteDraft = (scope: CallingScope, leadId?: string) => {
    const current = noteDrafts.get(key(scope));
    return (leadId ? current?.get(leadId) : [...current?.values() || []].at(-1)) || null;
};
export function setLeadNoteDraft(scope: CallingScope, lead: Lead, body: string) {
    const id = key(scope), current = noteDrafts.get(id) || new Map();
    current.delete(lead._id);
    if (body.trim()) { current.set(lead._id, { lead, body }); noteDrafts.set(id, current); }
    else if (!current.size) noteDrafts.delete(id);
}
export function clearSavedLeadNoteDraft(scope: CallingScope, leadId: string, body: string) {
    const id = key(scope), current = noteDrafts.get(id), draft = current?.get(leadId);
    if (draft?.body.trim() === body.trim()) { current!.delete(leadId); if (!current!.size) noteDrafts.delete(id); }
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
