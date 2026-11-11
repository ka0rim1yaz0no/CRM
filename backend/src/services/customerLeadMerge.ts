import crypto from "node:crypto";
import { Types } from "mongoose";
import { Lead, type LeadDocument } from "../models/Lead";
import { getCurrentBusinessId, getPublicBusinessById } from "../config/tenancy";
import { getCallBridgeScheduleModel } from "../models/CallBridge";
import { normalizeLeadPhone } from "../../../shared/leadPhonePolicy";

export type CustomerLead = Partial<LeadDocument> & { _id: Types.ObjectId };
export const customerNameKey = (value: unknown) => String(value || "").normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
const name = (row: CustomerLead) => customerNameKey(row.leadName || row.businessName);
const email = (row: CustomerLead) => String(row.email || "").trim().toLowerCase();
const phone = (row: CustomerLead) => normalizeLeadPhone(row.phone) || String(row.phone || "").replace(/\D/g, "") || null;
const at = (value: unknown) => value instanceof Date ? value.getTime() : value ? Date.parse(String(value)) || 0 : 0;

export class CustomerMergeReview extends Error {
    statusCode = 409;
}

export async function orderCustomerMergeEnabled() {
    const business = await getPublicBusinessById(getCurrentBusinessId());
    return customerNameKey(business?.name).replace(/ /g, "") === "orderthca";
}

// A repeated full name with complementary contacts is one customer. Conflicting
// contacts require a shared email/phone; name-only bridges cannot join strangers.
export function customerMergeGroups(records: CustomerLead[]) {
    const names = new Map<string, CustomerLead[]>();
    for (const row of records) {
        const key = name(row);
        if (row.status === "Archived" || row.duplicateOf || key.split(" ").length < 2) continue;
        const bucket = names.get(key) || []; bucket.push(row); names.set(key, bucket);
    }
    const groups: CustomerLead[][] = [];
    for (const rows of names.values()) {
        const phones = new Set(rows.map(phone).filter(Boolean)), emails = new Set(rows.map(email).filter(Boolean));
        if (phones.size <= 1 && emails.size <= 1) { groups.push(rows); continue; }
        const pending = new Set(rows);
        while (pending.size) {
            const first = pending.values().next().value!; pending.delete(first);
            const group = [first];
            for (let index = 0; index < group.length; index++) for (const row of pending) {
                if (email(row) && email(row) === email(group[index]) || phone(row) && phone(row) === phone(group[index])) {
                    group.push(row); pending.delete(row);
                }
            }
            groups.push(group);
        }
    }
    return groups;
}

function union<T>(arrays: T[][]) {
    const result: T[] = [], seen = new Map<string, T>();
    for (const row of arrays.flat()) {
        const id = (row as { _id?: unknown })._id;
        const key = id ? String(id) : JSON.stringify(row);
        if (seen.has(key) && JSON.stringify(seen.get(key)) !== JSON.stringify(row)) throw new CustomerMergeReview("Matching customer records have conflicting history entries. Administrator review is required.");
        if (!seen.has(key)) { seen.set(key, row); result.push(row); }
    }
    return result;
}

export function customerMergePatch(canonical: CustomerLead, additions: CustomerLead[]): Partial<LeadDocument> {
    const rows = [canonical, ...additions];
    const owners = new Set(rows.map(row => String(row.assignedAgent || row.assignedAgentName || "")).filter(Boolean));
    const appointments = new Set(rows.map(row => at(row.followUpAt)).filter(Boolean));
    const workflows = new Set(rows.map(row => row.status).filter(status => status && status !== "NEW"));
    if (owners.size > 1 || appointments.size > 1 || workflows.size > 1) throw new CustomerMergeReview("Matching customer records have conflicting assignments, appointments or workflow statuses. Administrator review is required.");
    const patch: Partial<LeadDocument> = {};
    for (const field of ["phone", "email", "leadName", "businessAddress", "website", "position", "category", "assignedAgent", "assignedAgentName", "assignedTeam", "followUpAt", "followUpNote"] as const) {
        if (!canonical[field]) {
            const value = additions.find(row => row[field])?.[field];
            if (value) Object.assign(patch, { [field]: value });
        }
    }
    let notes = canonical.notes || "";
    for (const row of additions) {
        const extra = [...(["phone", "email", "leadName", "businessName", "businessAddress", "website", "position", "category"] as const)
                .filter(field => row[field] && row[field] !== (patch[field] || canonical[field])).map(field => `${field}: ${row[field]}`),
            row.status && row.status !== canonical.status && `Previous status: ${row.status}`,
            row.followUpNote && row.followUpNote !== canonical.followUpNote && `Follow-up: ${row.followUpNote}`].filter(Boolean);
        if (row.source === canonical.source && (!row.notes || notes.includes(row.notes)) && !extra.length) continue;
        const details = [row.source && `Source: ${row.source}`, row.notes, ...extra].filter(Boolean).join("\n");
        const block = details ? `[Merged customer information]\n${details}` : "";
        if (block && !notes.includes(block)) notes = [notes, block].filter(Boolean).join("\n\n");
    }
    if (notes !== (canonical.notes || "")) patch.notes = notes;
    patch.comments = union(rows.map(row => row.comments || []));
    patch.activity = union(rows.map(row => row.activity || []));
    patch.callLogs = union(rows.map(row => row.callLogs || [])).sort((a, b) => at(a.calledAt) - at(b.calledAt));
    patch.favoriteByEmployees = [...new Map(rows.flatMap(row => row.favoriteByEmployees || []).map(id => [String(id), id])).values()];
    patch.callCount = rows.reduce((sum, row) => sum + (row.callCount || 0), 0);
    patch.lastCallAt = rows.map(row => row.lastCallAt).filter(value => at(value)).sort((a, b) => at(b) - at(a))[0] || null;
    patch.lastCallOutcomeAt = rows.map(row => row.lastCallOutcomeAt).filter(value => at(value)).sort((a, b) => at(b) - at(a))[0] || null;
    const calls = new Map<string, NonNullable<LeadDocument["callsByEmployee"]>[number]>();
    for (const row of rows.flatMap(row => row.callsByEmployee || [])) {
        const prior = calls.get(String(row.employee));
        calls.set(String(row.employee), { ...row, count: (prior?.count || 0) + row.count,
            lastCallAt: at(prior?.lastCallAt) > at(row.lastCallAt) ? prior!.lastCallAt : row.lastCallAt });
    }
    patch.callsByEmployee = [...calls.values()];
    return patch;
}

export function preferredCustomerLead(rows: CustomerLead[]) {
    return [...rows].sort((a, b) => Number(Boolean(b.assignedAgent)) - Number(Boolean(a.assignedAgent)) ||
        Number(Boolean(b.callCount || b.callLogs?.length)) - Number(Boolean(a.callCount || a.callLogs?.length)) ||
        Number(Boolean(b.phone)) - Number(Boolean(a.phone)) || at(a.createdAt) - at(b.createdAt) || String(a._id).localeCompare(String(b._id)))[0]!;
}

export async function assertCustomerLeadsIdle(ids: string[]) {
    const now = new Date();
    const active = await getCallBridgeScheduleModel().exists({ reservedBusinessId: getCurrentBusinessId(), reservedLeadId: { $in: ids },
        $or: [{ callLeaseUntil: { $gt: now } }, { dialIntentUntil: { $gt: now } },
            { $expr: { $gt: [{ $ifNull: ["$lastCallStartedAt", new Date(0)] }, { $ifNull: ["$lastCallEndedAt", new Date(0)] }] } }] });
    if (active) throw new CustomerMergeReview("A matching customer has an active call or dial reservation. Retry the import after that call finishes.");
}

export async function storeOrderCustomerLead(input: Partial<LeadDocument>) {
    if (!await orderCustomerMergeEnabled()) throw new CustomerMergeReview("Customer consolidation is only enabled in Order THCA.");
    const incoming: CustomerLead = { ...input, _id: new Types.ObjectId() }, key = name(incoming);
    if (key.split(" ").length < 2) return null;
    const guards = Lead.db.db!.collection<{ _id: string; revision: number }>("leadcustomerguards");
    const guardId = crypto.createHash("sha256").update(key).digest("hex");
    try { await guards.updateOne({ _id: guardId }, { $setOnInsert: { revision: 0 } }, { upsert: true }); }
    catch (error) { if ((error as { code?: number }).code !== 11000) throw error; }
    return Lead.db.transaction(async session => {
        await guards.updateOne({ _id: guardId }, { $inc: { revision: 1 } }, { session });
        const active = await Lead.find({ status: { $ne: "Archived" } }).limit(10001).session(session).lean();
        if (active.length > 10000) throw new CustomerMergeReview("Customer matching requires administrator review for this import size.");
        const matches = active.filter(row => name(row) === key);
        const group = customerMergeGroups([...matches, incoming]).find(rows => rows.includes(incoming)) || [incoming];
        const existing = group.filter(row => row !== incoming);
        if (!existing.length) {
            if (matches.length) throw new CustomerMergeReview("This customer name has conflicting contact details. Review the existing leads before importing another record.");
            const [created] = await Lead.create([incoming], { session }); return { id: String(created!._id), merged: false };
        }
        if (existing.length !== matches.length) throw new CustomerMergeReview("This customer name is ambiguous. Review the existing contact details before merging.");
        const canonical = preferredCustomerLead(existing), donors = existing.filter(row => row !== canonical);
        await assertCustomerLeadsIdle(existing.map(row => String(row._id)));
        const patch = customerMergePatch(canonical, [...donors, { ...incoming, assignedAgent: null, assignedAgentName: "", assignedTeam: null, status: canonical.status,
            comments: incoming.comments?.filter(comment => !existing.some(row => row.comments?.some(old => old.authorName === comment.authorName && old.authorType === comment.authorType && old.body === comment.body))),
            activity: incoming.activity?.filter(activity => !existing.some(row => row.activity?.some(old => old.label === activity.label && old.detail === activity.detail && old.actorName === activity.actorName))) }]);
        for (const donor of donors) await Lead.updateOne({ _id: donor._id, status: donor.status }, {
            $set: { status: "Archived", duplicateOf: canonical._id, duplicateArchivedAt: new Date(), duplicateArchivePlan: "order-customer-merge-v1" },
        }, { session });
        await Lead.updateOne({ _id: canonical._id, status: canonical.status }, { $set: patch }, { session });
        return { id: String(canonical._id), merged: true };
    }, { maxCommitTimeMS: 5000 });
}
