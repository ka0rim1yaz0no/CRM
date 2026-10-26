import { Schema } from "mongoose";
import { tenantModel } from "../config/tenancy";

export type PayrollGenerationPolicyDocument = { _id: string; enabled: boolean; startsAfter: string; actor: string; enabledAt: Date };
const schema = new Schema<PayrollGenerationPolicyDocument>({
    _id: { type: String, required: true }, enabled: { type: Boolean, required: true },
    startsAfter: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
    actor: { type: String, required: true }, enabledAt: { type: Date, required: true },
});
export const PayrollGenerationPolicy = tenantModel<PayrollGenerationPolicyDocument>("PayrollGenerationPolicy", schema);
