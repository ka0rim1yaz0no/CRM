import type { ClientSession, Model, Schema, Types } from "mongoose";
import type { LeadDocument } from "../models/Lead";
import { leadPhoneDedupEnabled } from "../config/rolloutFlags";
import { normalizeLeadPhone } from "../../../shared/leadPhonePolicy";
import { invalidateLeadPhoneSnapshot } from "./leadPhoneSnapshotCache";
import { getCurrentBusinessId } from "../config/tenancy";

type PhoneRecord = { _id?: unknown; phone?: unknown; status?: unknown; duplicateOf?: unknown };
type Update = { $set?: Record<string, unknown>; $setOnInsert?: Record<string, unknown>; $unset?: Record<string, unknown> };
type Operation = { insertOne?: { document: PhoneRecord & Record<string, unknown> }; updateOne?: {
    filter: Record<string, unknown>; update: Update; upsert?: boolean;
}; updateMany?: { update: Update }; replaceOne?: unknown };

export class LeadPhoneConflict extends Error {
    statusCode = 409;
    constructor(message = "An active lead already uses this telephone number in this business.") { super(message); }
}

async function phoneOwners(model: Model<LeadDocument>, session?: ClientSession | null) {
    const records = await model.find({ $or: [{ status: { $ne: "Archived" } }, { duplicateOf: { $exists: true } }] }).select("phone duplicateOf").session(session || null).maxTimeMS(10000).lean();
    const owners = new Map<string, Map<string, string>>();
    for (const record of records) {
        const phone = normalizeLeadPhone(record.phone);
        if (!phone) continue;
        const ids = owners.get(phone) || new Map<string, string>(); ids.set(String(record._id), String(record.duplicateOf || "")); owners.set(phone, ids);
    }
    return owners;
}

function protectedPhoneFields(next: PhoneRecord, owners: Map<string, Map<string, string>>) {
    if (next.status !== "Archived" && next.duplicateOf) throw new LeadPhoneConflict("This archived duplicate requires administrator review before restoration.");
    const phone = normalizeLeadPhone(next.phone);
    if (phone && next.status !== "Archived") {
        const ids = owners.get(phone) || new Map<string, string>();
        if ([...ids].some(([id, canonical]) => id !== String(next._id) && canonical !== String(next._id))) throw new LeadPhoneConflict();
        ids.set(String(next._id), ""); owners.set(phone, ids);
    }
    return { normalizedPhone: phone || undefined, activePhoneKey: next.status !== "Archived" ? phone || undefined : undefined };
}

const touchesIdentity = (update: Update) => Object.hasOwn(update.$set || {}, "phone") ||
    Object.hasOwn(update.$set || {}, "status") || Boolean(update.$setOnInsert);
const needsClaim = (previous: PhoneRecord | null, next: PhoneRecord) => !previous ||
    String(previous.phone || "") !== String(next.phone || "") || (previous.status === "Archived" && next.status !== "Archived");

function setFields(update: Update, values: ReturnType<typeof protectedPhoneFields>) {
    for (const [key, value] of Object.entries(values)) {
        if (value === undefined) { update.$unset = { ...update.$unset, [key]: 1 }; if (update.$set) delete update.$set[key]; }
        else { update.$set = { ...update.$set, [key]: value }; if (update.$unset) delete update.$unset[key]; }
    }
}

// Legacy records are inspected, never backfilled by reads. A sparse, unique
// claim on new/changed phone identities closes concurrent insertion races.
export function installLeadPhoneWriteGuard(schema: Schema<LeadDocument>) {
    const invalidate = () => invalidateLeadPhoneSnapshot(getCurrentBusinessId());
    schema.post("save", invalidate);
    schema.post("insertMany", invalidate);
    schema.post("bulkWrite", invalidate);
    schema.post(["deleteMany", "deleteOne"], invalidate);
    schema.post(["findOneAndUpdate", "updateOne", "updateMany"], function () {
        const update = this.getUpdate();
        if (!update || Array.isArray(update)) { invalidate(); return; }
        const fields = Object.values(update).flatMap(value => value && typeof value === "object" ? Object.keys(value) : []);
        if (fields.some(field => /^(phone|status|followUpAt|assignedAgent|assignedAgentName|createdAt|googlePlaceId|providerPlaceId|businessName|businessAddress|callCount|callLogs|comments|notes)(\.|$)/.test(field))) invalidate();
    });
    schema.pre("save", async function () {
        if (!leadPhoneDedupEnabled() || (!this.isNew && !this.isModified("phone") && !this.isModified("status"))) return;
        const model = this.constructor as Model<LeadDocument>;
        const previous = this.isNew ? null : await model.findById(this._id).select("phone status duplicateOf").session(this.$session()).lean();
        if (this.status === "Archived") { this.activePhoneKey = undefined; return; }
        if (!needsClaim(previous, this)) return;
        const values = protectedPhoneFields({ ...this.toObject(), duplicateOf: previous?.duplicateOf || this.duplicateOf }, await phoneOwners(model, this.$session()));
        this.normalizedPhone = values.normalizedPhone; this.activePhoneKey = values.activePhoneKey;
    });
    schema.pre("insertMany", async function (documents: Array<PhoneRecord & Record<string, unknown>>) {
        if (!leadPhoneDedupEnabled()) return;
        const owners = await phoneOwners(this);
        for (const document of documents) {
            document._id ||= new (this.base.Types.ObjectId)();
            Object.assign(document, protectedPhoneFields(document, owners));
        }
    });
    schema.pre(["findOneAndUpdate", "updateOne", "updateMany"], async function () {
        if (!leadPhoneDedupEnabled()) return;
        const update = this.getUpdate() as Update | null;
        if (!update || !touchesIdentity(update)) return;
        if (update.$set?.status === "Archived" && !Object.hasOwn(update.$set, "phone")) {
            update.$unset = { ...update.$unset, activePhoneKey: 1 }; return;
        }
        if ((this as typeof this & { op: string }).op === "updateMany") throw new LeadPhoneConflict("Restore or change telephone numbers per lead so duplicate protection can be verified.");
        const previous = await this.model.findOne(this.getFilter()).select("phone status duplicateOf").session(this.getOptions().session || null).lean() as (PhoneRecord & { _id: Types.ObjectId }) | null;
        if (!previous && !this.getOptions().upsert) return;
        const next = { ...previous, ...(!previous ? update.$setOnInsert : {}), ...update.$set, _id: previous?._id || this.getFilter()._id };
        if (next.status === "Archived") { update.$unset = { ...update.$unset, activePhoneKey: 1 }; return; }
        if (!needsClaim(previous, next)) return;
        setFields(update, protectedPhoneFields(next, await phoneOwners(this.model, this.getOptions().session)));
    });
    schema.pre("bulkWrite", async function (rawOperations, options) {
        if (!leadPhoneDedupEnabled()) return;
        const operations = rawOperations as Operation[];
        let owners: Awaited<ReturnType<typeof phoneOwners>> | undefined;
        for (const operation of operations) {
            if (operation.replaceOne) throw new LeadPhoneConflict("Whole-record replacement is not permitted for protected leads.");
            if (operation.insertOne) {
                const document = operation.insertOne.document;
                document._id ||= new (this.base.Types.ObjectId)();
                owners ||= await phoneOwners(this, options?.session);
                Object.assign(document, protectedPhoneFields(document, owners));
            }
            const command = operation.updateOne || operation.updateMany;
            if (!command || !touchesIdentity(command.update)) continue;
            const update = command.update;
            if (update.$set?.status === "Archived" && !Object.hasOwn(update.$set, "phone")) { update.$unset = { ...update.$unset, activePhoneKey: 1 }; continue; }
            if (!operation.updateOne) throw new LeadPhoneConflict("Use reviewed per-lead restoration for protected leads.");
            const previous = await this.findOne(operation.updateOne.filter).select("phone status duplicateOf").session(options?.session || null).lean();
            if (!previous && !operation.updateOne.upsert) continue;
            const next = { ...previous, ...(!previous ? update.$setOnInsert : {}), ...update.$set, _id: previous?._id || operation.updateOne.filter._id || new this.base.Types.ObjectId() };
            if (!needsClaim(previous, next)) continue;
            owners ||= await phoneOwners(this, options?.session);
            setFields(update, protectedPhoneFields(next, owners));
        }
    });
}
