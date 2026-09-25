import mongoose, { Schema } from "mongoose";

export type PlaceSearchUsageDocument = {
  provider: "tomtom";
  dayKey: string;
  requestCount: number;
};

export type PlaceSearchAuditDocument = {
  provider: "tomtom";
  businessId: string;
  actorCode: string;
  actorName: string;
  actorType: "admin" | "poc";
  ipAddress: string;
  mode: "manual" | "auto";
  query: string;
  location: string;
  radiusMiles: number;
  requestCount: number;
  returnedCount: number;
  importedCount: number;
  duplicateCount: number;
  skippedNoPhoneCount: number;
  status: "completed" | "partial" | "failed";
  errorMessage: string;
};

const placeSearchUsageSchema = new Schema<PlaceSearchUsageDocument>(
  {
    provider: { type: String, enum: ["tomtom"], required: true },
    dayKey: { type: String, required: true },
    requestCount: { type: Number, min: 0, default: 0 },
  },
  { timestamps: true }
);

placeSearchUsageSchema.index({ provider: 1, dayKey: 1 }, { unique: true });

const placeSearchAuditSchema = new Schema<PlaceSearchAuditDocument>(
  {
    provider: { type: String, enum: ["tomtom"], required: true, index: true },
    businessId: { type: String, required: true, trim: true, index: true },
    actorCode: { type: String, required: true, trim: true, index: true },
    actorName: { type: String, required: true, trim: true },
    actorType: { type: String, enum: ["admin", "poc"], required: true },
    ipAddress: { type: String, trim: true, default: "" },
    mode: { type: String, enum: ["manual", "auto"], required: true },
    query: { type: String, required: true, trim: true },
    location: { type: String, trim: true, default: "" },
    radiusMiles: { type: Number, min: 0, default: 0 },
    requestCount: { type: Number, min: 0, default: 0 },
    returnedCount: { type: Number, min: 0, default: 0 },
    importedCount: { type: Number, min: 0, default: 0 },
    duplicateCount: { type: Number, min: 0, default: 0 },
    skippedNoPhoneCount: { type: Number, min: 0, default: 0 },
    status: { type: String, enum: ["completed", "partial", "failed"], required: true },
    errorMessage: { type: String, trim: true, default: "" },
  },
  { timestamps: true }
);

placeSearchAuditSchema.index({ provider: 1, createdAt: -1 });
placeSearchAuditSchema.index({ businessId: 1, createdAt: -1 });

function getControlConnection() {
  const databaseName = process.env.CONTROL_DATABASE_NAME || "crm_control";
  return mongoose.connection.useDb(databaseName, { useCache: true });
}

export function getPlaceSearchUsageModel() {
  const connection = getControlConnection();
  return (
    connection.models.PlaceSearchUsage ||
    connection.model<PlaceSearchUsageDocument>("PlaceSearchUsage", placeSearchUsageSchema)
  );
}

export function getPlaceSearchAuditModel() {
  const connection = getControlConnection();
  return (
    connection.models.PlaceSearchAudit ||
    connection.model<PlaceSearchAuditDocument>("PlaceSearchAudit", placeSearchAuditSchema)
  );
}
