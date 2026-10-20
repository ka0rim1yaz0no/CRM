import { Schema, type Types } from "mongoose";
import { tenantModel } from "../config/tenancy";

export type CredentialRevealAuditDocument = {
  actorCode: string;
  credentialId: Types.ObjectId;
  businessId: string;
  occurredAt: Date;
};

const schema = new Schema<CredentialRevealAuditDocument>({
  actorCode: { type: String, required: true },
  credentialId: { type: Schema.Types.ObjectId, required: true },
  businessId: { type: String, required: true },
  occurredAt: { type: Date, required: true, default: Date.now },
}, { strict: "throw", versionKey: false });
schema.index({ credentialId: 1, occurredAt: -1 });
export const CredentialRevealAudit = tenantModel<CredentialRevealAuditDocument>("CredentialRevealAudit", schema);
