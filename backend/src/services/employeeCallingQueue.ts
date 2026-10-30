import crypto from "node:crypto";
import { Types } from "mongoose";
import { parsePhoneNumberFromString } from "libphonenumber-js";
import { Lead } from "../models/Lead";
import { uniquelyOwnedLegacyNames } from "./leadAssignment";
import { leadPhoneDedupEnabled } from "../config/rolloutFlags";
import { leadPhoneCanonicalSnapshot } from "./leadPhoneCanonical";
import { busyPhonesForEmployee } from "./leadPhoneDispatch";
import { autoCallPhoneCandidates, shouldBlockCommentedPhone } from "./leadAutoCallEligibility";
import { AUTO_CALL_COMMENT_COOLDOWN_MS, CALLING_QUEUE_POLICY_VERSION, callingWindow, compareCallingLeads, evaluateCallingLead, type CallingDecision, type CallingPolicyLead } from "../../../shared/leadCallingPolicy";

export type CallingEmployee = { _id: unknown; employeeCode: string; name?: string; aliases?: string[] };
type Candidate = CallingPolicyLead & { _id: Types.ObjectId; phone?: string; updatedAt?: Date };
export type CallingQueueEntry = CallingDecision & { leadId: string; normalizedPhone: string | null };
const normalizedPhones = new Map<string, string | null>();

export function normalizeCallingPhone(phone: unknown) {
    const text = String(phone || "").trim();
    if (normalizedPhones.has(text)) return normalizedPhones.get(text)!;
    const parsed = parsePhoneNumberFromString(text, "US");
    const value = parsed?.isValid() ? String(parsed.number) : null;
    if (normalizedPhones.size >= 65536) normalizedPhones.clear();
    normalizedPhones.set(text, value);
    return value;
}

const commentSummary = {
    $map: { input: { $filter: { input: { $ifNull: ["$comments", []] }, as: "comment", cond: { $eq: ["$$comment.authorType", "employee"] } } },
        as: "comment", in: { $convert: { input: "$$comment.createdAt", to: "date", onError: null, onNull: null } } },
};
const summarize = (latest: Date | null, invalid: boolean) => invalid
    ? [{ authorType: "employee", createdAt: null }]
    : latest ? [{ authorType: "employee", createdAt: latest }] : [];

export async function employeeCallingQueue(employee: CallingEmployee, businessId: string, now = new Date(), freshPhoneFacts = false) {
    const names = [...new Set([employee.name, employee.employeeCode, ...(employee.aliases || [])].filter((name): name is string => Boolean(name)))];
    const legacyNames = await uniquelyOwnedLegacyNames(String(employee._id), names);
    const escaped = legacyNames.map(name => new RegExp(`^${name.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i"));
    const [facts, phoneFacts] = await Promise.all([
        Lead.aggregate<Candidate & { latest: Date | null; invalid: boolean }>([
            { $match: { status: { $in: ["NEW", "Follow up"] }, $or: [
                { assignedAgent: new Types.ObjectId(String(employee._id)) }, { assignedAgent: null, assignedAgentName: { $in: escaped } },
            ] } },
            { $project: { phone: 1, status: 1, followUpAt: 1, createdAt: 1, updatedAt: 1, commentTimes: commentSummary } },
            { $project: { phone: 1, status: 1, followUpAt: 1, createdAt: 1, updatedAt: 1,
                latest: { $max: "$commentTimes" }, invalid: { $in: [null, "$commentTimes"] } } },
        ]).option({ maxTimeMS: 5000 }),
        Lead.aggregate<{ phone?: string; latest: Date | null; invalid: boolean }>([
            { $match: { "comments.authorType": "employee" } },
            { $project: { _id: 0, phone: 1, commentTimes: commentSummary } },
            { $project: { phone: 1, latest: { $max: "$commentTimes" }, invalid: { $in: [null, "$commentTimes"] } } },
        ]).option({ maxTimeMS: 5000 }),
    ]);
    // Match full digit strings against the existing candidate variants. Sharing a
    // suffix alone must not suppress an unrelated international phone number.
    const commentsByDigits = new Map<string, Array<{ createdAt: Date | null }>>();
    for (const fact of phoneFacts) {
        const digits = String(fact.phone || "").replace(/\D/g, "");
        const comments = commentsByDigits.get(digits) || [];
        comments.push(...summarize(fact.latest, fact.invalid));
        commentsByDigits.set(digits, comments);
    }
    const canonicalIds = leadPhoneDedupEnabled() ? (await leadPhoneCanonicalSnapshot(now, freshPhoneFacts)).ids : null;
    const candidates: Candidate[] = facts.filter(fact => !canonicalIds || canonicalIds.has(String(fact._id))).map(fact => ({ ...fact, comments: summarize(fact.latest, fact.invalid) }));
    const busyPhones = canonicalIds ? await busyPhonesForEmployee(candidates.flatMap(lead => normalizeCallingPhone(lead.phone) || []), employee.employeeCode, now) : new Set<string>();
    const decisions = new Map<string, CallingQueueEntry>();
    const policyDecisions = new Map<string, CallingDecision>();
    for (const lead of candidates) {
        const normalizedPhone = normalizeCallingPhone(lead.phone);
        let decision = evaluateCallingLead(lead, now);
        policyDecisions.set(String(lead._id), decision);
        if (!normalizedPhone) decision = { callable: false, reason: "INVALID_PHONE", priority: 9, nextEligibleAt: null };
        else if (busyPhones.has(normalizedPhone)) decision = { callable: false, reason: "PHONE_IN_USE", priority: 9, nextEligibleAt: null };
        if (decision.callable) {
            const comments = autoCallPhoneCandidates(lead.phone).flatMap(digits => commentsByDigits.get(digits) || []);
            if (shouldBlockCommentedPhone(comments, lead.followUpAt, now)) {
                const invalid = comments.some(comment => !comment.createdAt);
                const until = invalid ? null : new Date(Math.max(...comments.map(comment => +comment.createdAt!)) + AUTO_CALL_COMMENT_COOLDOWN_MS).toISOString();
                decision = { callable: false, reason: "DUPLICATE_PHONE", priority: 9, nextEligibleAt: until };
            }
        }
        decisions.set(String(lead._id), { ...decision, leadId: String(lead._id), normalizedPhone });
    }
    candidates.sort((a, b) => {
        const first = decisions.get(String(a._id))!, second = decisions.get(String(b._id))!;
        return Number(second.callable) - Number(first.callable) || compareCallingLeads(a, b, now, policyDecisions.get(String(a._id)), policyDecisions.get(String(b._id)));
    });
    const seenPhones = new Set<string>();
    for (const lead of candidates) {
        const decision = decisions.get(String(lead._id))!;
        if (!decision.callable || !decision.normalizedPhone) continue;
        if (seenPhones.has(decision.normalizedPhone)) {
            decisions.set(decision.leadId, { ...decision, callable: false, reason: "DUPLICATE_PHONE", priority: 9 });
        } else seenPhones.add(decision.normalizedPhone);
    }
    candidates.sort((a, b) => Number(decisions.get(String(b._id))!.callable) - Number(decisions.get(String(a._id))!.callable) || compareCallingLeads(a, b, now, policyDecisions.get(String(a._id)), policyDecisions.get(String(b._id))));
    const entries = candidates.map(lead => decisions.get(String(lead._id))!);
    const next = entries.find(entry => entry.callable) || null;
    const times = entries.flatMap(entry => entry.nextEligibleAt && +new Date(entry.nextEligibleAt) > +now ? [entry.nextEligibleAt] : []).sort();
    const version = crypto.createHash("sha256").update(JSON.stringify([CALLING_QUEUE_POLICY_VERSION, businessId, String(employee._id),
        candidates.map(lead => [String(lead._id), lead.status, lead.phone, lead.followUpAt, lead.createdAt, lead.updatedAt, decisions.get(String(lead._id))])])).digest("hex");
    return { policyVersion: CALLING_QUEUE_POLICY_VERSION, scope: { businessId, employeeId: String(employee._id), employeeCode: employee.employeeCode },
        version, serverTime: now.toISOString(), nextEligibilityChangeAt: times[0] || null,
        nextLeadId: next?.leadId || null, nextReason: next?.reason || null,
        waitReason: next ? null : times.length ? "WAITING_FOR_ELIGIBILITY" : "NO_ELIGIBLE_LEADS",
        callingWindow: callingWindow(now), entries };
}

export async function hydrateCallingQueue(queue: Awaited<ReturnType<typeof employeeCallingQueue>>, page = 1, limit = 50) {
    const ids = queue.entries.slice((page - 1) * limit, page * limit).map(entry => entry.leadId);
    const requested = [...new Set([...ids, ...(queue.nextLeadId ? [queue.nextLeadId] : [])])];
    const leads = await Lead.find({ _id: { $in: requested } }).slice("comments", -10).slice("activity", 20)
        .populate("assignedAgent", "name employeeCode aliases").populate("assignedTeam", "name").lean();
    const byId = new Map(leads.map(lead => [String(lead._id), lead]));
    return { ...queue, leads: ids.flatMap(id => byId.has(id) ? [byId.get(id)!] : []), nextLead: queue.nextLeadId ? byId.get(queue.nextLeadId) || null : null };
}
