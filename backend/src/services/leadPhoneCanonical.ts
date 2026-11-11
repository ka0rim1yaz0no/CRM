import { Lead } from "../models/Lead";
import { leadPhoneDedupEnabled } from "../config/rolloutFlags";
import type { CanonicalPhoneLead } from "../../../shared/leadPhonePolicy";
import type { Types } from "mongoose";
import { getCurrentBusinessId } from "../config/tenancy";
import { cachedCanonicalPhoneSelection, cachedLeadPhoneFacts } from "./leadPhoneSnapshotCache";
import { compactLeadFactsStage, compactLeadFactBatchSize, readCompactLeadFacts, type CompactLeadFact } from "./compactLeadFacts";

const factFields = ["_id", "phone", "status", "followUpAt", "assignedAgent", "assignedAgentName", "createdAt", "googlePlaceId",
    "providerPlaceId", "placeProvider", "businessName", "businessAddress", "callCount", "notes", "callLogCount", "manualCommentCount"] as const;

export async function leadPhoneCanonicalSnapshot(now = new Date(), fresh = false) {
    const load = () => readCompactLeadFacts<CanonicalPhoneLead & { _id: Types.ObjectId }>(Lead.aggregate<CompactLeadFact>([
        { $match: { status: { $ne: "Archived" } } },
        { $project: { phone: 1, status: 1, followUpAt: 1, assignedAgent: 1, assignedAgentName: 1, createdAt: 1,
            googlePlaceId: 1, providerPlaceId: 1, placeProvider: 1, businessName: 1, businessAddress: 1, callCount: 1,
            notes: { $cond: [{ $gt: [{ $strLenCP: { $ifNull: ["$notes", ""] } }, 0] }, "present", ""] },
            callLogCount: { $size: { $ifNull: ["$callLogs", []] } },
            manualCommentCount: { $size: { $filter: { input: { $ifNull: ["$comments", []] }, as: "comment", cond: { $ne: ["$$comment.authorName", "CSV Import"] } } } },
        } },
        compactLeadFactsStage(factFields),
    ]).option({ maxTimeMS: 10000 }).cursor({ batchSize: compactLeadFactBatchSize }), factFields);
    const records = fresh ? await load() : await cachedLeadPhoneFacts(getCurrentBusinessId(), load);
    return cachedCanonicalPhoneSelection(records, now);
}

export async function restrictToCanonicalPhones(filter: Record<string, unknown>, now = new Date()) {
    if (!leadPhoneDedupEnabled()) return;
    const snapshot = await leadPhoneCanonicalSnapshot(now);
    const previous = Array.isArray(filter.$and) ? filter.$and : [];
    filter.$and = [...previous, { $or: [{ status: "Archived" }, { _id: { $in: snapshot.canonical.map(lead => lead._id) } }] }];
}
