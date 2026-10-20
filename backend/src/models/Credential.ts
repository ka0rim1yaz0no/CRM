import { Schema, Types } from "mongoose";
import { tenantModel } from "../config/tenancy";
import { securityCredentialVaultEnabled } from "../config/rolloutFlags";
import { decryptCredentialPassword, encryptCredentialPassword, isEncryptedCredentialPassword } from "../services/credentialEncryption";

export type CredentialStatus = "Active" | "Review" | "Archived";

export type CredentialDocument = {
  accountName: string;
  username: string;
  password: string;
  platform: string;
  company: string;
  team: string;
  status: CredentialStatus;
};

const credentialSchema = new Schema<CredentialDocument>(
  {
    accountName: { type: String, trim: true, default: "" },
    username: { type: String, required: true, trim: true },
    password: { type: String, required: true, select: false },
    platform: { type: String, required: true, trim: true },
    company: { type: String, required: true, trim: true, default: "General" },
    team: { type: String, trim: true, default: "All teams" },
    status: { type: String, enum: ["Active", "Review", "Archived"], default: "Active" },
  },
  { timestamps: true }
);

async function encryptedPassword(value: unknown, id: unknown) {
  if (typeof value !== "string" || !value.trim() || !Types.ObjectId.isValid(String(id))) {
    throw new Error("Invalid credential password write.");
  }
  if (isEncryptedCredentialPassword(value)) {
    await decryptCredentialPassword(value, String(id));
    return value;
  }
  return encryptCredentialPassword(value, String(id));
}

credentialSchema.pre("save", async function () {
  if (securityCredentialVaultEnabled() && this.password !== undefined) {
    this.password = await encryptedPassword(this.password, this._id);
  }
});
credentialSchema.pre(["findOneAndUpdate", "updateOne", "updateMany", "replaceOne", "findOneAndReplace"], async function () {
  if (!securityCredentialVaultEnabled()) return;
  const update = this.getUpdate();
  if (!update || Array.isArray(update)) throw new Error("Unsupported credential update.");
  const values = update as Record<string, unknown>;
  const passwordPath = (key: string) => key === "password" || key.startsWith("password.");
  for (const [operator, fields] of Object.entries(values)) {
    if (!operator.startsWith("$") || !fields || typeof fields !== "object") continue;
    for (const [key, target] of Object.entries(fields)) {
      if ((passwordPath(key) && (!["$set", "$setOnInsert"].includes(operator) || key !== "password")) ||
          (operator === "$rename" && typeof target === "string" && passwordPath(target))) {
        throw new Error("Invalid credential password write.");
      }
    }
  }
  for (const segment of [values, values.$set, values.$setOnInsert]) {
    if (!segment || typeof segment !== "object" || !("password" in segment)) continue;
    const fields = segment as Record<string, unknown>;
    fields.password = await encryptedPassword(fields.password, this.getFilter()._id);
  }
  this.setUpdate(update);
});
// No current vault caller needs bulk writes; fail closed rather than bypass save/update hooks.
credentialSchema.pre("bulkWrite", async function () {
  if (securityCredentialVaultEnabled()) throw new Error("Bulk credential writes are not supported.");
});
credentialSchema.pre("insertMany", async function (documents) {
  if (!securityCredentialVaultEnabled()) return;
  for (const document of documents) {
    document._id ??= new Types.ObjectId();
    document.password = await encryptedPassword(document.password, document._id);
  }
});

export const Credential = tenantModel<CredentialDocument>("Credential", credentialSchema);
