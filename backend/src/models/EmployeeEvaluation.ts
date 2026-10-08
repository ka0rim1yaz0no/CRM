import { Schema, Types } from "mongoose";
import { tenantModel } from "../config/tenancy";

export type EmployeeEvaluationDocument = {
  employee: Types.ObjectId;
  employeeCode: string;
  employeeName: string;
  milestoneMonth: 1 | 3 | 6;
  dueDate: Date;
  status: "Draft" | "Completed";
  rating: number | null;
  strengths: string;
  improvementAreas: string;
  managerNotes: string;
  reviewedBy: string;
  completedAt: Date | null;
};

const employeeEvaluationSchema = new Schema<EmployeeEvaluationDocument>(
  {
    employee: { type: Schema.Types.ObjectId, ref: "Employee", required: true, index: true },
    employeeCode: { type: String, required: true, trim: true, index: true },
    employeeName: { type: String, required: true, trim: true },
    milestoneMonth: { type: Number, enum: [1, 3, 6], required: true },
    dueDate: { type: Date, required: true, index: true },
    status: { type: String, enum: ["Draft", "Completed"], default: "Draft", index: true },
    rating: { type: Number, min: 1, max: 5, default: null },
    strengths: { type: String, trim: true, default: "" },
    improvementAreas: { type: String, trim: true, default: "" },
    managerNotes: { type: String, trim: true, default: "" },
    reviewedBy: { type: String, trim: true, default: "" },
    completedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

employeeEvaluationSchema.index({ employeeCode: 1, milestoneMonth: 1, dueDate: 1 }, { unique: true });

export const EmployeeEvaluation = tenantModel<EmployeeEvaluationDocument>("EmployeeEvaluation", employeeEvaluationSchema);
