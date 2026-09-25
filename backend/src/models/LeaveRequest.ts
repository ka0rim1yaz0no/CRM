import { Schema, Types } from "mongoose";
import { tenantModel } from "../config/tenancy";

export type LeaveRequestStatus = "Pending" | "Approved" | "Rejected";
export type LeaveRequestType = "Vacation" | "Sick" | "Emergency" | "Personal" | "Other";

export type LeaveRequestDocument = {
  employee: Types.ObjectId;
  leaveType: LeaveRequestType;
  startDate: Date;
  endDate: Date;
  selectedDates: Date[];
  reason: string;
  status: LeaveRequestStatus;
  adminNote?: string;
  comments: {
    authorType: "Admin" | "Employee";
    authorName: string;
    message: string;
    createdAt: Date;
  }[];
  reviewedBy?: string;
  reviewedAt?: Date;
};

const leaveRequestSchema = new Schema<LeaveRequestDocument>(
  {
    employee: { type: Schema.Types.ObjectId, ref: "Employee", required: true },
    leaveType: {
      type: String,
      enum: ["Vacation", "Sick", "Emergency", "Personal", "Other"],
      required: true,
      default: "Vacation",
    },
    startDate: { type: Date, required: true },
    endDate: { type: Date, required: true },
    selectedDates: { type: [Date], default: [] },
    reason: { type: String, required: true, trim: true },
    status: {
      type: String,
      enum: ["Pending", "Approved", "Rejected"],
      default: "Pending",
    },
    adminNote: { type: String, trim: true },
    comments: {
      type: [
        {
          authorType: { type: String, enum: ["Admin", "Employee"], required: true },
          authorName: { type: String, trim: true, default: "" },
          message: { type: String, trim: true, required: true },
          createdAt: { type: Date, default: Date.now },
        },
      ],
      default: [],
    },
    reviewedBy: { type: String, trim: true },
    reviewedAt: { type: Date },
  },
  { timestamps: true }
);

leaveRequestSchema.index({ employee: 1, createdAt: -1 });
leaveRequestSchema.index({ status: 1, createdAt: -1 });

export const LeaveRequest = tenantModel<LeaveRequestDocument>("LeaveRequest", leaveRequestSchema);
