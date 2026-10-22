import type { Types } from "mongoose";
import type { CanonicalPhoneLead } from "../../../shared/leadPhonePolicy";
export type PhoneFact = CanonicalPhoneLead & { _id: Types.ObjectId };
type Entry = { until: number; pending: Promise<PhoneFact[]> };
const snapshots = new Map<string, Entry>();

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
