import { parsePhoneNumberFromString } from "libphonenumber-js";
const normalizedPhones = new Map<string, string | null>();

export function normalizeLeadPhone(value: unknown): string | null {
    const text = String(value || "").trim().replace(/^00(?=\d)/, "+");
    if (!text) return null;
    if (normalizedPhones.has(text)) return normalizedPhones.get(text)!;
    const phone = parsePhoneNumberFromString(text, { defaultCountry: "US", extract: false });
    const normalized = phone?.isValid() ? String(phone.number) : null;
    if (normalizedPhones.size >= 65536) normalizedPhones.clear();
    normalizedPhones.set(text, normalized);
    return normalized;
}

export function leadPhoneDigitVariants(value: unknown) {
    const phone = normalizeLeadPhone(value);
    if (!phone) return [];
    const digits = phone.slice(1);
    return [...new Set([digits, `00${digits}`, ...(phone.startsWith("+1") && digits.length === 11 ? [digits.slice(1)] : [])])];
}

export type CanonicalPhoneLead = {
    _id: unknown; phone?: unknown; status?: string; followUpAt?: string | Date | null;
    assignedAgent?: unknown; assignedAgentName?: string; createdAt?: string | Date;
    callCount?: number; callLogCount?: number; manualCommentCount?: number; notes?: string;
    comments?: Array<{ authorName?: string; authorType?: string }>;
    callLogs?: unknown[]; googlePlaceId?: string; providerPlaceId?: string; placeProvider?: string;
    website?: string; businessName?: string; businessAddress?: string;
};

const instant = (value: unknown) => { const time = value instanceof Date ? +value : typeof value === "number" ? value : value ? Date.parse(String(value)) : NaN; return Number.isFinite(time) ? time : null; };
const normalized = (value: unknown) => String(value || "").trim().toLowerCase().replace(/\s+/g, " ");

export function logicalLeadKey(lead: CanonicalPhoneLead) {
    const phone = normalizeLeadPhone(lead.phone);
    if (phone) return `phone:${phone}`;
    if (lead.googlePlaceId) return `google:${lead.googlePlaceId}`;
    if (lead.providerPlaceId) return `provider:${lead.placeProvider || "unknown"}:${lead.providerPlaceId}`;
    const name = normalized(lead.businessName), address = normalized(lead.businessAddress);
    if (name && address) return `address:${name}|${address}`;
    return `record:${String(lead._id)}`;
}

export function compareCanonicalPhoneLeads(a: CanonicalPhoneLead, b: CanonicalPhoneLead, now: Date) {
    const due = (lead: CanonicalPhoneLead) => lead.status === "Follow up" && instant(lead.followUpAt) !== null && instant(lead.followUpAt)! <= +now;
    if (due(a) !== due(b)) return due(a) ? -1 : 1;
    if (due(a) && instant(a.followUpAt) !== instant(b.followUpAt)) return instant(a.followUpAt)! - instant(b.followUpAt)!;
    // Keep scheduled commitments and existing human work ahead of empty imported copies.
    const scheduled = (lead: CanonicalPhoneLead) => lead.status === "Follow up" && Boolean(lead.followUpAt);
    if (scheduled(a) !== scheduled(b)) return scheduled(a) ? -1 : 1;
    const work = (lead: CanonicalPhoneLead) => Number(Boolean(lead.notes?.trim())) +
        (lead.callCount || 0) + (lead.callLogCount ?? lead.callLogs?.length ?? 0) +
        (lead.manualCommentCount ?? lead.comments?.filter(comment => comment.authorName !== "CSV Import").length ?? 0);
    if (work(a) !== work(b)) return work(b) - work(a);
    const assigned = (lead: CanonicalPhoneLead) => Boolean(lead.assignedAgent || lead.assignedAgentName?.trim());
    if (assigned(a) !== assigned(b)) return assigned(a) ? -1 : 1;
    return (instant(a.createdAt) ?? Number.MAX_SAFE_INTEGER) - (instant(b.createdAt) ?? Number.MAX_SAFE_INTEGER) || String(a._id).localeCompare(String(b._id));
}

export function canonicalPhoneLeads<T extends CanonicalPhoneLead>(leads: T[], now = new Date()) {
    const groups = new Map<string, T[]>();
    for (const lead of leads) { const key = logicalLeadKey(lead), group = groups.get(key) || []; group.push(lead); groups.set(key, group); }
    return [...groups.values()].map(group => group.sort((a, b) => compareCanonicalPhoneLeads(a, b, now))[0]);
}
