import { Schema } from "mongoose";
import { tenantModel } from "../config/tenancy";
import { attendanceV2Enabled } from "../config/rolloutFlags";
import type { AttendanceSource, AttendanceStatus } from "./Attendance";

export type AttendanceSyncOutboxDocument = {
  eventId: string;
  employeeCode: string;
  source: AttendanceSource;
  timeIn: Date;
  attendanceStatus: AttendanceStatus;
  isArchived: boolean;
  pendingBusinessIds: string[];
  attempts: number;
  lastErrorAt?: Date;
};

const schema = new Schema<AttendanceSyncOutboxDocument>({
  eventId: { type: String, required: true },
  employeeCode: { type: String, required: true },
  source: { type: String, required: true },
  timeIn: { type: Date, required: true },
  attendanceStatus: { type: String, default: "" },
  isArchived: { type: Boolean, default: false },
  pendingBusinessIds: { type: [String], default: [] },
  attempts: { type: Number, default: 0 },
  lastErrorAt: Date,
}, { timestamps: true });
if (attendanceV2Enabled()) schema.index({ employeeCode: 1, eventId: 1 }, { unique: true });

export const AttendanceSyncOutbox = tenantModel<AttendanceSyncOutboxDocument>("AttendanceSyncOutbox", schema);
