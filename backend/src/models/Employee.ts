import { Schema } from "mongoose";
import { runForEachBusiness, tenantModel } from "../config/tenancy";
import { isMongoNamespaceNotFoundError, toBusinessDatabaseAccessError } from "../utils/mongoErrors";

export type EmployeeStatus = "Active" | "Training" | "Paused" | "Archived";
export type EmployeeAvailabilityStatus = "ONLINE" | "OFFLINE" | "BREAK" | "LUNCH" | "OFF THE PHONE";
export const employeeAvailabilityStatuses: EmployeeAvailabilityStatus[] = ["ONLINE", "OFFLINE", "BREAK", "LUNCH", "OFF THE PHONE"];

export function normalizeEmployeeAvailabilityStatus(value: unknown): EmployeeAvailabilityStatus {
  const status = String(value || "").trim().toUpperCase().replace(/\s+/g, " ");

  if (status === "ONLINE") return "ONLINE";
  if (status === "OFFLINE") return "OFFLINE";
  if (status === "BREAK" || status === "ON BREAK") return "BREAK";
  if (status === "LUNCH" || status === "LUNCH BREAK") return "LUNCH";
  if (status === "OFF THE PHONE" || status === "IDLE" || status === "COACHING") return "OFF THE PHONE";

  return "OFFLINE";
}

export type EmployeeDocument = {
  name: string;
  dateHired: string;
  terminationDate: string;
  employeeCode: string;
  aliases: string[];
  role: string;
  team: string;
  company: string;
  email: string;
  phone: string;
  profileImage: string;
  personalPhone: string;
  personalEmail: string;
  personalAddress: string;
  emergencyContact: string;
  contactRelationship: string;
  emergencyContactNumber: string;
  personalNotes: string;
  bankName: string;
  bankAccountName: string;
  bankAccountNumber: string;
  bankRoutingNumber: string;
  salary: number;
  status: EmployeeStatus;
  availabilityStatus: EmployeeAvailabilityStatus;
  availabilityStatusReason: string;
  businessAccessIds: string[];
};

const employeeSchema = new Schema<EmployeeDocument>(
  {
    name: { type: String, trim: true, default: "" },
    dateHired: { type: String, trim: true, default: "" },
    terminationDate: { type: String, trim: true, default: "" },
    employeeCode: { type: String, trim: true, default: "" },
    aliases: { type: [String], default: [] },
    role: { type: String, trim: true, default: "" },
    team: { type: String, default: "Unassigned", trim: true },
    company: { type: String, trim: true, default: "Assistly" },
    email: { type: String, lowercase: true, trim: true, default: "" },
    phone: { type: String, trim: true, default: "" },
    profileImage: { type: String, default: "" },
    personalPhone: { type: String, trim: true, default: "" },
    personalEmail: { type: String, lowercase: true, trim: true, default: "" },
    personalAddress: { type: String, trim: true, default: "" },
    emergencyContact: { type: String, trim: true, default: "" },
    contactRelationship: { type: String, trim: true, default: "" },
    emergencyContactNumber: { type: String, trim: true, default: "" },
    personalNotes: { type: String, trim: true, default: "" },
    bankName: { type: String, trim: true, default: "" },
    bankAccountName: { type: String, trim: true, default: "" },
    bankAccountNumber: { type: String, trim: true, default: "" },
    bankRoutingNumber: { type: String, trim: true, default: "" },
    salary: { type: Number, min: 0, default: 0 },
    businessAccessIds: { type: [String], default: [] },
    status: {
      type: String,
      enum: ["Active", "Training", "Paused", "Archived"],
      default: "Active",
    },
    availabilityStatus: {
      type: String,
      enum: employeeAvailabilityStatuses,
      default: "OFFLINE",
      set: normalizeEmployeeAvailabilityStatus,
    },
    availabilityStatusReason: { type: String, trim: true, default: "" },
  },
  { timestamps: true }
);

employeeSchema.index(
  { employeeCode: 1 },
  { unique: true, partialFilterExpression: { employeeCode: { $type: "string", $gt: "" } } }
);
employeeSchema.index(
  { email: 1 },
  { unique: true, partialFilterExpression: { email: { $type: "string", $gt: "" } } }
);

export const Employee = tenantModel<EmployeeDocument>("Employee", employeeSchema);

function hasExpectedOptionalUniqueIndex(index: Record<string, unknown>, field: "employeeCode" | "email") {
  return JSON.stringify(index.partialFilterExpression) === JSON.stringify({ [field]: { $type: "string", $gt: "" } });
}

export async function ensureEmployeeIndexes() {
  await runForEachBusiness(async (business) => {
    try {
      try {
        const indexes = await Employee.collection.indexes();
        const staleOptionalIndexes = indexes.filter((index) => {
          const field = index.name === "employeeCode_1" ? "employeeCode" : index.name === "email_1" ? "email" : null;
          return field && !hasExpectedOptionalUniqueIndex(index as Record<string, unknown>, field);
        });

        for (const index of staleOptionalIndexes) {
          if (index.name) {
            await Employee.collection.dropIndex(index.name);
          }
        }
      } catch (error) {
        if (!isMongoNamespaceNotFoundError(error)) {
          throw error;
        }
      }

      await Employee.createIndexes();
    } catch (error) {
      const accessError = toBusinessDatabaseAccessError(error, business.databaseName);

      if (!accessError) {
        throw error;
      }

      console.warn(accessError.message);
    }
  });
}
