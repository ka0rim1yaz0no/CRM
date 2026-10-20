import mongoose, { Schema } from "mongoose";

const schema = new Schema({ _id: { type: String, required: true }, version: { type: Number, default: 0 } }, { versionKey: false });

// Operational coordination only: no punches, salaries or payroll amounts are stored here.
export const PayrollAttendanceFence = mongoose.models.PayrollAttendanceFence || mongoose.model("PayrollAttendanceFence", schema);
