import type { Types } from "mongoose";
import type { CanonicalPhoneLead } from "../../../shared/leadPhonePolicy";
import { canonicalPhoneLeads, logicalLeadKey } from "../../../shared/leadPhonePolicy";
export type PhoneFact = CanonicalPhoneLead & { _id: Types.ObjectId };
type Entry = { until: number; pending: Promise<PhoneFact[]> };
const snapshots = new Map<string, Entry>();
type Selection = { records: PhoneFact[]; canonical: PhoneFact[]; canonicalByKey: Map<string, PhoneFact>; ids: Set<string> };
const selections = new WeakMap<PhoneFact[], { from: number; until: number; value: Selection }>();

export function cachedCanonicalPhoneSelection(records: PhoneFact[], now: Date) {
    const time = now.getTime(), previous = selections.get(records);
    if (previous && time >= previous.from && time < previous.until) return previous.value;
    const canonical = canonicalPhoneLeads(records, now);
    const value = { records, canonical, canonicalByKey: new Map(canonical.map(lead => [logicalLeadKey(lead), lead])),
        ids: new Set(canonical.map(lead => String(lead._id))) };
    const until = records.reduce((next, lead) => {
        const due = lead.status === "Follow up" && lead.followUpAt ? new Date(lead.followUpAt).getTime() : NaN;
        return Number.isFinite(due) && due > time ? Math.min(next, due) : next;
    }, Infinity);
    selections.set(records, { from: time, until, value });
    return value;
}

export function invalidateLeadPhoneSnapshot(businessId: string) { snapshots.delete(businessId); }

// Cache facts, not time-dependent winners: due callbacks are re-evaluated on
// every request. Writes in this API invalidate immediately; other processes
// are bounded by the short TTL. Dispatch still verifies ownership and a slot.
export async function cachedLeadPhoneFacts(businessId: string, load: () => Promise<PhoneFact[]>, now = performance.now()) {
    const previous = snapshots.get(businessId);
    if (previous && previous.until > now) return previous.pending;
    const entry: Entry = { until: Number.POSITIVE_INFINITY, pending: Promise.resolve([]) };
    entry.pending = load().then(records => {
        if (snapshots.get(businessId) !== entry) return cachedLeadPhoneFacts(businessId, load);
        entry.until = performance.now() + 2000;
        return records;
    }).catch(error => { if (snapshots.get(businessId) === entry) snapshots.delete(businessId); throw error; });
    snapshots.set(businessId, entry);
    return entry.pending;
}
