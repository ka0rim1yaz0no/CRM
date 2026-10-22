import { Lead } from "../models/Lead";
import { leadPhoneDedupEnabled } from "../config/rolloutFlags";
import { canonicalPhoneLeads, logicalLeadKey, type CanonicalPhoneLead } from "../../../shared/leadPhonePolicy";
import type { Types } from "mongoose";
import { getCurrentBusinessId } from "../config/tenancy";
import { cachedLeadPhoneFacts } from "./leadPhoneSnapshotCache";

export async function leadPhoneCanonicalSnapshot(now = new Date()) {
    const records = await cachedLeadPhoneFacts(getCurrentBusinessId(), () => Lead.aggregate<CanonicalPhoneLead & { _id: Types.ObjectId }>([
        { $match: { status: { $ne: "Archived" } } },
        { $project: { phone: 1, status: 1, followUpAt: 1, assignedAgent: 1, assignedAgentName: 1, createdAt: 1,
            googlePlaceId: 1, providerPlaceId: 1, placeProvider: 1, businessName: 1, businessAddress: 1, callCount: 1,
            notes: { $cond: [{ $gt: [{ $strLenCP: { $ifNull: ["$notes", ""] } }, 0] }, "present", ""] },
            callLogCount: { $size: { $ifNull: ["$callLogs", []] } },
            manualCommentCount: { $size: { $filter: { input: { $ifNull: ["$comments", []] }, as: "comment", cond: { $ne: ["$$comment.authorName", "CSV Import"] } } } },
        } },
    ]).option({ maxTimeMS: 10000 }).exec());
    const canonical = canonicalPhoneLeads(records, now);
    const canonicalByKey = new Map(canonical.map(lead => [logicalLeadKey(lead), lead]));
    return { records, canonical, canonicalByKey, ids: new Set(canonical.map(lead => String(lead._id))) };
}

export async function restrictToCanonicalPhones(filter: Record<string, unknown>, now = new Date()) {
    if (!leadPhoneDedupEnabled()) return;
    const snapshot = await leadPhoneCanonicalSnapshot(now);
    const previous = Array.isArray(filter.$and) ? filter.$and : [];
    filter.$and = [...previous, { $or: [{ status: "Archived" }, { _id: { $in: snapshot.canonical.map(lead => lead._id) } }] }];
}
