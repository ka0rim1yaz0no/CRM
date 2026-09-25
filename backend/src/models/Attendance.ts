import { Schema, Types } from "mongoose";
import { tenantModel } from "../config/tenancy";

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
  },
  { timestamps: true }
);

attendanceSchema.index({ employee: 1, isArchived: 1, timeIn: -1 });

export const Attendance = tenantModel<AttendanceDocument>("Attendance", attendanceSchema);
