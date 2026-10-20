import mongoose, { Schema } from "mongoose";

type KnowledgeBaseUploadDocument = { fileName: string; directory: string; businessId: string };
const schema = new Schema<KnowledgeBaseUploadDocument>({
  fileName: { type: String, required: true },
  directory: { type: String, enum: ["photos", "documents"], required: true },
  businessId: { type: String, required: true },
}, { timestamps: true });
schema.index({ directory: 1, fileName: 1 }, { unique: true });

// File bytes share a disk root, so ownership must not depend on the selected tenant.
export function knowledgeBaseUploads() {
  const connection = mongoose.connection.useDb(process.env.CONTROL_DATABASE_NAME || "crm_control", { useCache: true });
  return connection.models.KnowledgeBaseUpload as mongoose.Model<KnowledgeBaseUploadDocument> ||
    connection.model<KnowledgeBaseUploadDocument>("KnowledgeBaseUpload", schema);
}
