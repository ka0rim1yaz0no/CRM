import { Schema } from "mongoose";
import { tenantModel } from "../config/tenancy";

export type EmployeePaymentHistoryPolicyDocument = {
    _id: string;
    fromDate: string;
    initialPayPeriod: string;
    activatedAt: Date;
};

const schema = new Schema<EmployeePaymentHistoryPolicyDocument>({
    _id: { type: String, required: true },
    fromDate: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
    initialPayPeriod: { type: String, required: true },
    activatedAt: { type: Date, required: true },
});

export const EmployeePaymentHistoryPolicy = tenantModel<EmployeePaymentHistoryPolicyDocument>("EmployeePaymentHistoryPolicy", schema);
