import type { Types } from "mongoose";
import type { CanonicalPhoneLead } from "../../../shared/leadPhonePolicy";
import { canonicalPhoneLeads, logicalLeadKey } from "../../../shared/leadPhonePolicy";
export type PhoneFact = CanonicalPhoneLead & { _id: Types.ObjectId };
type Entry<T> = { until: number; pending: Promise<T[]>; bytes: number; timer?: ReturnType<typeof setTimeout>; drop?: () => void };
const snapshots = new Map<string, Entry<PhoneFact>>();
export type PhoneCommentFact = { phone?: string; latest: Date | null; invalid: boolean };
const commentSnapshots = new Map<string, Entry<PhoneCommentFact>>();
const retained = new Set<Entry<unknown>>();
let retainedBytes = 0;
export const leadFactCacheBudget = { entryBytes: 24 * 1024 * 1024, totalBytes: 64 * 1024 * 1024, ttlMs: 2000 } as const;
type PendingRead = { promise: Promise<unknown[]> };
const displayReads = new Map<string, Map<string, PendingRead>>();
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

export function invalidateLeadPhoneSnapshot(businessId: string) {
    snapshots.get(businessId)?.drop?.(); commentSnapshots.get(businessId)?.drop?.(); displayReads.delete(businessId);
}

// Only simultaneous display reads share facts. No completed result or dispatch
// permission is cached here; writes invalidate even an unfinished read.
export async function coalesceDisplayLeadFacts<T>(businessId: string, scope: string, load: () => Promise<T[]>): Promise<T[]> {
    let group = displayReads.get(businessId);
    if (!group) { group = new Map(); displayReads.set(businessId, group); }
    const previous = group.get(scope);
    if (previous) return previous.promise as Promise<T[]>;
    const current = group, entry: PendingRead = { promise: Promise.resolve([]) };
    entry.promise = load().then(records => displayReads.get(businessId) === current && current.get(scope) === entry
        ? records : coalesceDisplayLeadFacts(businessId, scope, load)).finally(() => {
        if (current.get(scope) === entry) current.delete(scope);
        if (!current.size && displayReads.get(businessId) === current) displayReads.delete(businessId);
    });
    current.set(scope, entry);
    return entry.promise as Promise<T[]>;
}

export function leadFactCacheUsage() { return { retainedEntries: retained.size, retainedBytes, pendingDisplayReads: [...displayReads.values()].reduce((sum, group) => sum + group.size, 0) }; }

function flatFactBytes(records: readonly unknown[]) {
    // Estimate retained flat facts without making a second serialized copy.
    let bytes = 64 + records.length * 8;
    for (const row of records) {
        if (!row || typeof row !== "object") return leadFactCacheBudget.entryBytes + 1;
        bytes += 64;
        for (const field in row) if (Object.hasOwn(row, field)) {
            const value = (row as Record<string, unknown>)[field];
            bytes += 32 + field.length * 2;
            if (typeof value === "string") bytes += value.length * 2;
            else if (value && typeof value === "object") {
                if (!(value instanceof Date) && typeof (value as { toHexString?: unknown }).toHexString !== "function") return leadFactCacheBudget.entryBytes + 1;
                bytes += 64;
            } else bytes += 8;
            if (bytes > leadFactCacheBudget.entryBytes) return bytes;
        }
    }
    return bytes;
}

// Cache facts, not time-dependent winners: due callbacks are re-evaluated on
// every request. Writes in this API invalidate immediately; other processes
// are bounded by the short TTL. Dispatch still verifies ownership and a slot.
export async function cachedLeadPhoneFacts(businessId: string, load: () => Promise<PhoneFact[]>, now = performance.now()) {
    return cachedFacts(snapshots, businessId, load, now);
}

export async function cachedLeadPhoneCommentFacts(businessId: string, load: () => Promise<PhoneCommentFact[]>, now = performance.now()) {
    return cachedFacts(commentSnapshots, businessId, load, now);
}

async function cachedFacts<T>(cache: Map<string, Entry<T>>, businessId: string, load: () => Promise<T[]>, now: number): Promise<T[]> {
    const previous = cache.get(businessId);
    if (previous && previous.until > now) {
        if (retained.delete(previous)) retained.add(previous);
        return previous.pending;
    }
    previous?.drop?.();
    const entry: Entry<T> = { until: Number.POSITIVE_INFINITY, pending: Promise.resolve([]), bytes: 0 };
    entry.drop = () => {
        if (cache.get(businessId) === entry) cache.delete(businessId);
        clearTimeout(entry.timer);
        if (retained.delete(entry)) retainedBytes -= entry.bytes;
    };
    entry.pending = load().then(records => {
        if (cache.get(businessId) !== entry) return cachedFacts(cache, businessId, load, performance.now());
        entry.until = performance.now() + leadFactCacheBudget.ttlMs;
        entry.bytes = flatFactBytes(records);
        if (entry.bytes > leadFactCacheBudget.entryBytes) { entry.drop!(); return records; }
        retained.add(entry); retainedBytes += entry.bytes;
        while (retainedBytes > leadFactCacheBudget.totalBytes) retained.values().next().value?.drop?.();
        if (cache.get(businessId) === entry) { entry.timer = setTimeout(entry.drop!, leadFactCacheBudget.ttlMs); entry.timer.unref?.(); }
        return records;
    }).catch(error => { entry.drop!(); throw error; });
    cache.set(businessId, entry);
    return entry.pending;
}
