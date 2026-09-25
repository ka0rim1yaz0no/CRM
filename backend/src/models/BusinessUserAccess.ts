import mongoose, { Schema } from "mongoose";

export type BusinessUserAccessDocument = {
  employeeCode: string;
  businessIds: string[];
};

const businessUserAccessSchema = new Schema<BusinessUserAccessDocument>(
  {
    employeeCode: { type: String, required: true, trim: true, unique: true, index: true },
    businessIds: { type: [String], default: [] },
  },
  { timestamps: true }
);

function getBusinessUserAccessModel() {
  const databaseName = process.env.CONTROL_DATABASE_NAME || "crm_control";
  const connection = mongoose.connection.useDb(databaseName, { useCache: true });

  return (
    connection.models.BusinessUserAccess ||
    connection.model<BusinessUserAccessDocument>("BusinessUserAccess", businessUserAccessSchema)
  );
}

export function normalizeBusinessAccessIds(value: unknown) {
  const values = Array.isArray(value) ? value : String(value || "").split(",");

  return Array.from(
    new Set(
      values
        .map((businessId) => String(businessId || "").trim())
        .filter(Boolean)
    )
  );
}

export async function getBusinessAccessForEmployeeCode(employeeCode: string) {
  const normalizedEmployeeCode = String(employeeCode || "").trim();

  if (!normalizedEmployeeCode) {
    return [];
  }

  const access = await getBusinessUserAccessModel().findOne({ employeeCode: normalizedEmployeeCode }).lean();
  return normalizeBusinessAccessIds(access?.businessIds);
}

export async function setBusinessAccessForEmployeeCode(employeeCode: string, businessIds: string[]) {
  const normalizedEmployeeCode = String(employeeCode || "").trim();

  if (!normalizedEmployeeCode) {
    return null;
  }

  const normalizedBusinessIds = normalizeBusinessAccessIds(businessIds);

  return getBusinessUserAccessModel().findOneAndUpdate(
    { employeeCode: normalizedEmployeeCode },
    { employeeCode: normalizedEmployeeCode, businessIds: normalizedBusinessIds },
    { returnDocument: "after", upsert: true, setDefaultsOnInsert: true }
  );
}

export async function deleteBusinessAccessForEmployeeCode(employeeCode: string) {
  const normalizedEmployeeCode = String(employeeCode || "").trim();

  if (!normalizedEmployeeCode) {
    return;
  }

  await getBusinessUserAccessModel().deleteOne({ employeeCode: normalizedEmployeeCode });
}
