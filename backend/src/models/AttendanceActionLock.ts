import mongoose, { Schema } from "mongoose";
import { attendanceV2Enabled } from "../config/rolloutFlags";

export type AttendanceActionLockDocument = {
  employeeCode: string;
  ownerToken: string;
  leaseUntil: Date;
};

const schema = new Schema<AttendanceActionLockDocument>({
  employeeCode: { type: String, required: true },
  ownerToken: { type: String, default: "" },
  leaseUntil: { type: Date, default: () => new Date(0) },
});
if (attendanceV2Enabled()) schema.index({ employeeCode: 1 }, { unique: true });
export const AttendanceActionLock = mongoose.models.AttendanceActionLock ||
  mongoose.model<AttendanceActionLockDocument>("AttendanceActionLock", schema);
