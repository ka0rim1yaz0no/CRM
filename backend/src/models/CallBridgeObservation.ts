import mongoose, { Schema } from "mongoose";
import { callTimingV2Enabled } from "../config/rolloutFlags";

export type CallBridgeObservationDocument = {
  employeeCode: string;
  startedAt: Date;
  endedAt: Date;
  durationMs: number;
  businessIds: string[];
};

const schema = new Schema<CallBridgeObservationDocument>({
  employeeCode: { type: String, required: true },
  startedAt: { type: Date, required: true },
  endedAt: { type: Date, required: true },
  durationMs: { type: Number, required: true },
  businessIds: { type: [String], default: [] },
}, { timestamps: true });
schema.index({ businessIds: 1, startedAt: 1 });
schema.index({ businessIds: 1, endedAt: 1 });
if (callTimingV2Enabled()) {
  schema.index({ employeeCode: 1, startedAt: 1 }, { unique: true });
  schema.index({ employeeCode: 1, endedAt: -1 });
}

export const CallBridgeObservation = mongoose.models.CallBridgeObservation ||
  mongoose.model<CallBridgeObservationDocument>("CallBridgeObservation", schema);
