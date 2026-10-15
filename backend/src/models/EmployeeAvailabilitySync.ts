import mongoose, { Schema } from "mongoose";
import { employeeAvailabilityStatuses, type EmployeeAvailabilityStatus } from "./Employee";

export type EmployeeAvailabilitySyncDocument = {
  employeeCode: string;
  availabilityStatus: EmployeeAvailabilityStatus;
  availabilityStatusReason: string;
  revision: number;
  pendingBusinessIds: string[];
  attempts: number;
  lastErrorAt: Date | null;
};

const schema = new Schema<EmployeeAvailabilitySyncDocument>({
  employeeCode: { type: String, required: true, unique: true, index: true, trim: true },
  availabilityStatus: { type: String, enum: employeeAvailabilityStatuses, required: true },
  availabilityStatusReason: { type: String, trim: true, default: "" },
  revision: { type: Number, required: true, default: 0 },
  pendingBusinessIds: { type: [String], default: [] },
  attempts: { type: Number, default: 0 },
  lastErrorAt: { type: Date, default: null },
}, { timestamps: true });

export function getEmployeeAvailabilitySyncModel() {
  const databaseName = process.env.CONTROL_DATABASE_NAME || "crm_control";
  const connection = mongoose.connection.useDb(databaseName, { useCache: true });
  return connection.models.EmployeeAvailabilitySync ||
    connection.model<EmployeeAvailabilitySyncDocument>("EmployeeAvailabilitySync", schema);
}
