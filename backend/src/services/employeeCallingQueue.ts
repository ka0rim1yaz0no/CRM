import crypto from "node:crypto";
import { Types } from "mongoose";
import { normalizeLeadPhone } from "../../../shared/leadPhonePolicy";
import { Lead } from "../models/Lead";
import { uniquelyOwnedLegacyNames } from "./leadAssignment";
import { leadPhoneDedupEnabled } from "../config/rolloutFlags";
import { leadPhoneCanonicalSnapshot } from "./leadPhoneCanonical";
import { busyPhonesForEmployee } from "./leadPhoneDispatch";
import { cachedLeadPhoneCommentFacts, coalesceDisplayLeadFacts, type PhoneCommentFact } from "./leadPhoneSnapshotCache";
import { autoCallPhoneCandidates, shouldBlockCommentedPhone } from "./leadAutoCallEligibility";
import { AUTO_CALL_COMMENT_COOLDOWN_MS, CALLING_QUEUE_POLICY_VERSION, callingWindow, compareCallingLeads, evaluateCallingLead, type CallingDecision, type CallingPolicyLead } from "../../../shared/leadCallingPolicy";
import { compactLeadFactsStage, compactLeadFactBatchSize, readCompactLeadFacts, type CompactLeadFact } from "./compactLeadFacts";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";

export type CallingEmployee = { _id: unknown; employeeCode: string; name?: string; aliases?: string[] };
type Candidate = CallingPolicyLead & { _id: Types.ObjectId; phone?: string; updatedAt?: Date };
export type CallingQueueEntry = CallingDecision & { leadId: string; normalizedPhone: string | null };
const candidateFields = ["_id", "phone", "status", "followUpAt", "createdAt", "updatedAt", "latest", "invalid"] as const;
let pendingReadSort: Promise<void> = Promise.resolve();

async function sortCallingCandidates(candidates: Candidate[], compare: (first: Candidate, second: Candidate) => number) {
    // Run one CPU-heavy read sort per event-loop turn so Bridge/deadline I/O
    // can progress even when many dashboards refresh together.
    const sorted = pendingReadSort.then(async () => { await yieldToEventLoop(); candidates.sort(compare); });
    pendingReadSort = sorted.catch(() => undefined);
    await sorted;
}

export function normalizeCallingPhone(phone: unknown) {
    return normalizeLeadPhone(phone);
}

const commentSummary = { $concatArrays: [{
    $map: { input: { $filter: { input: { $ifNull: ["$comments", []] }, as: "comment", cond: { $eq: ["$$comment.authorType", "employee"] } } },
        as: "comment", in: { $convert: { input: "$$comment.createdAt", to: "date", onError: null, onNull: null } } },
}, { $cond: [{ $ne: [{ $ifNull: ["$lastCallOutcomeAt", null] }, null] },
    [{ $convert: { input: "$lastCallOutcomeAt", to: "date", onError: null, onNull: null } }], []] }] };
const summarize = (latest: Date | null, invalid: boolean) => invalid
    ? [{ authorType: "employee", createdAt: null }]
    : latest ? [{ authorType: "employee", createdAt: latest }] : [];

export async function employeeCallingQueue(employee: CallingEmployee, businessId: string, now = new Date(), freshPhoneFacts = false,
    read: { cacheComments?: boolean } = {}) {
    const backgroundRead = read.cacheComments === true && !freshPhoneFacts;
    const names = [...new Set([employee.name, employee.employeeCode, ...(employee.aliases || [])].filter((name): name is string => Boolean(name)))];
    const legacyNames = await uniquelyOwnedLegacyNames(String(employee._id), names);
    const escaped = legacyNames.map(name => new RegExp(`^${name.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i"));
    const loadComments = () => Lead.aggregate<PhoneCommentFact>([
        { $match: { $or: [{ "comments.authorType": "employee" }, { lastCallOutcomeAt: { $ne: null } }] } },
        { $project: { _id: 0, phone: 1, commentTimes: commentSummary } },
        { $project: { phone: 1, latest: { $max: "$commentTimes" }, invalid: { $in: [null, "$commentTimes"] } } },
    ]).option({ maxTimeMS: 5000 }).exec();
    const employeeId = new Types.ObjectId(String(employee._id));
    const loadCandidates = () => readCompactLeadFacts<Candidate & { latest: Date | null; invalid: boolean }>(Lead.aggregate<CompactLeadFact>([
            { $match: { status: { $in: ["NEW", "Follow up"] }, $or: [
                { assignedAgent: new Types.ObjectId(String(employee._id)) }, { assignedAgent: null, assignedAgentName: { $in: escaped } },
            ] } },
            { $project: { phone: 1, status: 1, followUpAt: 1, createdAt: 1, updatedAt: 1, commentTimes: commentSummary } },
            { $project: { phone: 1, status: 1, followUpAt: 1, createdAt: 1, updatedAt: 1,
                latest: { $max: "$commentTimes" }, invalid: { $in: [null, "$commentTimes"] } } },
            compactLeadFactsStage(candidateFields),
        ]).option({ maxTimeMS: 5000 }).cursor({ batchSize: compactLeadFactBatchSize }), candidateFields);
    const candidateScope = JSON.stringify([String(employee._id), escaped.map(pattern => [pattern.source, pattern.flags])]);
    const [facts, phoneFacts, recentCalls] = await Promise.all([
        read.cacheComments && !freshPhoneFacts ? coalesceDisplayLeadFacts(businessId, candidateScope, loadCandidates) : loadCandidates(),
        read.cacheComments && !freshPhoneFacts ? cachedLeadPhoneCommentFacts(businessId, loadComments) : loadComments(),
        // Search all previously called leads, including closed/reassigned ones, so
        // releasing the latest target cannot resurrect an older unnoted call.
        Lead.aggregate<{ _id: Types.ObjectId; calledAt: Date | null }>([
            { $match: { "callsByEmployee.employee": employeeId } },
            { $project: { calledAt: { $max: { $map: {
                input: { $filter: { input: { $ifNull: ["$callsByEmployee", []] }, as: "call", cond: { $eq: ["$$call.employee", employeeId] } } },
                as: "call", in: { $convert: { input: "$$call.lastCallAt", to: "date", onError: null, onNull: null } },
            } } } } },
            { $sort: { calledAt: -1, _id: 1 } }, { $limit: 2 },
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
    const keys = new Map<Candidate, string>();
    for (const [index, lead] of candidates.entries()) {
        if (backgroundRead && index && index % 128 === 0) await yieldToEventLoop();
        const key = String(lead._id); keys.set(lead, key);
        const normalizedPhone = normalizeCallingPhone(lead.phone);
        let decision = evaluateCallingLead(lead, now);
        policyDecisions.set(key, decision);
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
        decisions.set(key, { ...decision, leadId: key, normalizedPhone });
    }
    const latestCall = recentCalls[0];
    const repeatCandidate = latestCall?.calledAt && +latestCall.calledAt <= +now &&
        (!recentCalls[1]?.calledAt || +recentCalls[1].calledAt !== +latestCall.calledAt)
        ? candidates.find(lead => String(lead._id) === String(latestCall._id) &&
            !(lead.comments || []).some(comment => !comment.createdAt || +new Date(comment.createdAt) >= +latestCall.calledAt!)) : undefined;
    const repeatDecision = repeatCandidate && decisions.get(String(repeatCandidate._id));
    const repeatLeadId = repeatDecision && (repeatDecision.callable || repeatDecision.reason === "PHONE_IN_USE") ? repeatDecision.leadId : null;
    const compare = (a: Candidate, b: Candidate) => {
        const firstKey = keys.get(a)!, secondKey = keys.get(b)!;
        const first = decisions.get(firstKey)!, second = decisions.get(secondKey)!;
        return Number(second.callable) - Number(first.callable) ||
            Number(secondKey === repeatLeadId) - Number(firstKey === repeatLeadId) ||
            compareCallingLeads(a, b, now, policyDecisions.get(firstKey), policyDecisions.get(secondKey));
    };
    if (backgroundRead) await sortCallingCandidates(candidates, compare);
    else candidates.sort(compare);
    const seenPhones = new Set<string>();
    for (const lead of candidates) {
        const decision = decisions.get(String(lead._id))!;
        if (!decision.callable || !decision.normalizedPhone) continue;
        if (seenPhones.has(decision.normalizedPhone)) {
            decisions.set(decision.leadId, { ...decision, callable: false, reason: "DUPLICATE_PHONE", priority: 9 });
        } else seenPhones.add(decision.normalizedPhone);
    }
    if (backgroundRead) await sortCallingCandidates(candidates, compare);
    else candidates.sort(compare);
    const entries = candidates.map(lead => decisions.get(String(lead._id))!);
    const repeatBlocked = repeatLeadId !== null && !decisions.get(repeatLeadId)?.callable;
    const next = repeatBlocked ? null : entries.find(entry => entry.callable) || null;
    const times = entries.flatMap(entry => entry.nextEligibleAt && +new Date(entry.nextEligibleAt) > +now ? [entry.nextEligibleAt] : []).sort();
    const version = crypto.createHash("sha256").update(JSON.stringify([CALLING_QUEUE_POLICY_VERSION, businessId, String(employee._id), repeatLeadId,
        candidates.map(lead => [String(lead._id), lead.status, lead.phone, lead.followUpAt, lead.createdAt, lead.updatedAt, decisions.get(String(lead._id))])])).digest("hex");
    const refreshDependencies = { version: 1 as const, leadIds: [...new Set([...facts.map(lead => String(lead._id)), ...recentCalls.map(lead => String(lead._id))])],
        phones: [...new Set(facts.flatMap(lead => normalizeCallingPhone(lead.phone) || []))] };
    return { policyVersion: CALLING_QUEUE_POLICY_VERSION, scope: { businessId, employeeId: String(employee._id), employeeCode: employee.employeeCode }, refreshDependencies,
        version, serverTime: now.toISOString(), nextEligibilityChangeAt: times[0] || null,
        nextLeadId: next?.leadId || null, nextReason: next?.reason || null, repeatLeadId,
        waitReason: repeatBlocked ? "WAITING_FOR_REPEAT_LEAD" : next ? null : times.length ? "WAITING_FOR_ELIGIBILITY" : "NO_ELIGIBLE_LEADS",
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
