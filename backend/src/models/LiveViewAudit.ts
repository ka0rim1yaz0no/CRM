import { Schema } from "mongoose";
import { tenantModel } from "../config/tenancy";

export type LiveViewAuditDocument = {
  requestId: string;
  employeeId: string;
  employeeName: string;
  adminCode: string;
  adminName: string;
  status: "requested" | "active" | "declined" | "ended" | "failed";
  requestedAt: Date;
  startedAt: Date | null;
  endedAt: Date | null;
  reason: string;
};

const liveViewAuditSchema = new Schema<LiveViewAuditDocument>(
  {
    requestId: { type: String, required: true, unique: true, index: true },
    employeeId: { type: String, required: true, trim: true, index: true },
    employeeName: { type: String, required: true, trim: true },
    adminCode: { type: String, required: true, trim: true, index: true },
    adminName: { type: String, required: true, trim: true },
    status: { type: String, enum: ["requested", "active", "declined", "ended", "failed"], default: "requested", index: true },
    requestedAt: { type: Date, required: true, default: Date.now, index: true },
    startedAt: { type: Date, default: null },
    endedAt: { type: Date, default: null },
    reason: { type: String, trim: true, default: "" },
  },
  { timestamps: true }
);

liveViewAuditSchema.index({ employeeId: 1, requestedAt: -1 });

export const LiveViewAudit = tenantModel<LiveViewAuditDocument>("LiveViewAudit", liveViewAuditSchema);
