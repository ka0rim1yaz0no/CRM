import { Schema, Types } from "mongoose";
import { tenantModel } from "../config/tenancy";
import { attendanceIntegrityEnabled, attendanceV2Enabled } from "../config/rolloutFlags";

export type AttendanceSource =
  | "Login"
  | "Logout"
  | "Time In"
  | "Time Out"
  | "Break Out"
  | "Break In"
  | "Lunch Break Out"
  | "Lunch Break In"
  | "Off the Phone Out"
  | "Off the Phone In";
export type AttendanceStatus = "On time" | "Late" | "Undertime" | "";

export type AttendanceDocument = {
  employee: Types.ObjectId;
  timeIn: Date;
  source: AttendanceSource;
  attendanceStatus: AttendanceStatus;
  isArchived: boolean;
  eventId?: string;
  syncPending?: boolean;
  isEffective?: boolean;
  ledgerIdentity?: string;
  ledgerRevision?: number;
};

const attendanceSchema = new Schema<AttendanceDocument>(
  {
    employee: { type: Schema.Types.ObjectId, ref: "Employee", required: true },
    timeIn: { type: Date, required: true, default: Date.now },
    source: {
      type: String,
      enum: [
        "Login",
        "Logout",
        "Time In",
        "Time Out",
        "Break Out",
        "Break In",
        "Lunch Break Out",
        "Lunch Break In",
        "Off the Phone Out",
        "Off the Phone In",
      ],
      default: "Time In",
    },
    attendanceStatus: { type: String, enum: ["On time", "Late", "Undertime", ""], default: "" },
    isArchived: { type: Boolean, default: false },
    eventId: { type: String, default: undefined },
    syncPending: { type: Boolean, default: undefined },
    isEffective: { type: Boolean, default: undefined },
    ledgerIdentity: String,
    ledgerRevision: Number,
  },
  { timestamps: true }
);

attendanceSchema.index({ employee: 1, isArchived: 1, timeIn: -1 });
attendanceSchema.index({ ledgerIdentity: 1, ledgerRevision: 1 });
attendanceSchema.pre("find", function () { this.where({ isEffective: { $ne: false } }); });
attendanceSchema.pre("findOne", function () { this.where({ isEffective: { $ne: false } }); });
if (attendanceV2Enabled() || attendanceIntegrityEnabled()) {
  attendanceSchema.index({ employee: 1, eventId: 1 }, { unique: true, partialFilterExpression: { eventId: { $type: "string" } } });
}
export const Attendance = tenantModel<AttendanceDocument>("Attendance", attendanceSchema);
