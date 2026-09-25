import mongoose, { Schema } from "mongoose";

export type BusinessProfileDocument = {
  businessId: string;
  name: string;
  databaseName?: string;
};

const businessProfileSchema = new Schema<BusinessProfileDocument>(
  {
    businessId: { type: String, required: true, trim: true, unique: true, index: true },
    name: { type: String, required: true, trim: true },
    databaseName: { type: String, trim: true, index: true },
  },
  { timestamps: true }
);

function getBusinessProfileModel() {
  const databaseName = process.env.CONTROL_DATABASE_NAME || "crm_control";
  const connection = mongoose.connection.useDb(databaseName, { useCache: true });

  return (
    connection.models.BusinessProfile ||
    connection.model<BusinessProfileDocument>("BusinessProfile", businessProfileSchema)
  );
}

export async function getBusinessDisplayNameMap() {
  const profiles = await getBusinessProfileModel().find().lean();

  return new Map(
    profiles
      .map((profile) => [String(profile.businessId || "").trim(), String(profile.name || "").trim()] as const)
      .filter(([businessId, name]) => businessId && name)
  );
}

export async function getCreatedBusinessProfiles() {
  const profiles = await getBusinessProfileModel()
    .find({ databaseName: { $type: "string", $ne: "" } })
    .lean();

  return profiles
    .map((profile) => ({
      id: String(profile.businessId || "").trim(),
      name: String(profile.name || "").trim(),
      databaseName: String(profile.databaseName || "").trim(),
    }))
    .filter((profile) => profile.id && profile.name && profile.databaseName);
}

export async function createBusinessProfile(input: { businessId: string; name: string; databaseName: string }) {
  const businessId = String(input.businessId || "").trim();
  const name = String(input.name || "").trim();
  const databaseName = String(input.databaseName || "").trim();

  if (!businessId || !name || !databaseName) {
    return null;
  }

  const Model = getBusinessProfileModel();
  const databaseOwner = await Model.findOne({ databaseName });

  if (databaseOwner && databaseOwner.businessId !== businessId) {
    return null;
  }

  const existingProfile = await Model.findOne({ businessId });

  if (existingProfile) {
    const existingDatabaseName = String(existingProfile.databaseName || "").trim();

    if (existingDatabaseName && existingDatabaseName !== databaseName) {
      return null;
    }

    existingProfile.name = name;
    existingProfile.databaseName = databaseName;
    return existingProfile.save();
  }

  return Model.create({ businessId, name, databaseName });
}

export async function setBusinessDisplayName(businessId: string, name: string) {
  const normalizedBusinessId = String(businessId || "").trim();
  const normalizedName = String(name || "").trim();

  if (!normalizedBusinessId || !normalizedName) {
    return null;
  }

  return getBusinessProfileModel().findOneAndUpdate(
    { businessId: normalizedBusinessId },
    { $set: { businessId: normalizedBusinessId, name: normalizedName } },
    { returnDocument: "after", upsert: true, setDefaultsOnInsert: true }
  );
}
