import { Schema } from "mongoose";
import { tenantModel } from "../config/tenancy";

export type PayrollStatus = "Paid" | "Pending" | "Failed" | "Completed" | "Review" | "Applied" | "Enabled";
export type PayrollPayType = "Monthly" | "Semi-monthly" | "Weekly" | "Hourly" | "Contract";
export type PayrollItemCategory = "Payroll Runs" | "Payouts" | "Deductions" | "Tax Settings";

export type PayrollRecordDocument = {
  employeeName: string;
  email: string;
  employeeId: string;
  department: string;
  payType: PayrollPayType;
  grossPay: number;
  basicPay: number;
  workingDays: number;
  minuteRate: number;
  lateMinutes: number;
  excessLunchMinutes: number;
  excessBreakMinutes: number;
  absenceMinutes: number;
  earlyTimeOutMinutes: number;
  deductibleMinutes: number;
  incompleteShiftDays: number;
  deductions: number;
  netPay: number;
  attendanceDays: number;
  absentDays: number;
  absentHours: number;
  lateDays: number;
  lateHours: number;
  workedHours: number;
  overtimeHours: number;
  overtimeApproved: boolean;
  scheduledHours: number;
  status: PayrollStatus;
  paidOn: string;
  payPeriod: string;
  isArchived: boolean;
};

export type PayrollListItemDocument = {
  category: PayrollItemCategory;
  name: string;
  second: string;
  third: string;
  fourth: string;
  status: PayrollStatus;
  isArchived: boolean;
};

const payrollRecordSchema = new Schema<PayrollRecordDocument>(
  {
    employeeName: { type: String, required: true, trim: true },
    email: { type: String, trim: true, default: "" },
    employeeId: { type: String, required: true, trim: true },
    department: { type: String, required: true, trim: true },
    payType: { type: String, enum: ["Monthly", "Semi-monthly", "Weekly", "Hourly", "Contract"], required: true, trim: true, default: "Semi-monthly" },
    grossPay: { type: Number, required: true, min: 0 },
    basicPay: { type: Number, min: 0, default: 0 },
    workingDays: { type: Number, min: 0, default: 0 },
    minuteRate: { type: Number, min: 0, default: 0 },
    lateMinutes: { type: Number, min: 0, default: 0 },
    excessLunchMinutes: { type: Number, min: 0, default: 0 },
    excessBreakMinutes: { type: Number, min: 0, default: 0 },
    absenceMinutes: { type: Number, min: 0, default: 0 },
    earlyTimeOutMinutes: { type: Number, min: 0, default: 0 },
    deductibleMinutes: { type: Number, min: 0, default: 0 },
    incompleteShiftDays: { type: Number, min: 0, default: 0 },
    deductions: { type: Number, required: true, min: 0 },
    netPay: { type: Number, required: true, min: 0 },
    attendanceDays: { type: Number, min: 0, default: 0 },
    absentDays: { type: Number, min: 0, default: 0 },
    absentHours: { type: Number, min: 0, default: 0 },
    lateDays: { type: Number, min: 0, default: 0 },
    lateHours: { type: Number, min: 0, default: 0 },
    workedHours: { type: Number, min: 0, default: 0 },
    overtimeHours: { type: Number, min: 0, default: 0 },
    overtimeApproved: { type: Boolean, default: false },
    scheduledHours: { type: Number, min: 0, default: 0 },
    status: { type: String, enum: ["Paid", "Pending", "Failed", "Completed", "Review", "Applied", "Enabled"], default: "Pending" },
    paidOn: { type: String, required: true, trim: true, default: "-" },
    payPeriod: { type: String, required: true, trim: true, default: "Current Month" },
    isArchived: { type: Boolean, default: false },
  },
  { timestamps: true }
);

const payrollListItemSchema = new Schema<PayrollListItemDocument>(
  {
    category: { type: String, enum: ["Payroll Runs", "Payouts", "Deductions", "Tax Settings"], required: true },
    name: { type: String, required: true, trim: true },
    second: { type: String, required: true, trim: true },
    third: { type: String, required: true, trim: true },
    fourth: { type: String, trim: true, default: "" },
    status: { type: String, enum: ["Paid", "Pending", "Failed", "Completed", "Review", "Applied", "Enabled"], default: "Pending" },
    isArchived: { type: Boolean, default: false },
  },
  { timestamps: true }
);

payrollRecordSchema.index({ employeeId: 1, payPeriod: 1, isArchived: 1 });
payrollListItemSchema.index({ category: 1, isArchived: 1 });

export const PayrollRecord = tenantModel<PayrollRecordDocument>("PayrollRecord", payrollRecordSchema);
export const PayrollListItem = tenantModel<PayrollListItemDocument>("PayrollListItem", payrollListItemSchema);
