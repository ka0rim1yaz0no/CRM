import type { Request, Response } from "express";
import { Types } from "mongoose";
import { getBusinessById, getDefaultBusiness, runWithBusiness } from "../config/tenancy";
import { securityCredentialVaultEnabled } from "../config/rolloutFlags";
import { verifyAdminDashboardSession } from "../config/adminDashboardSession";
import { Credential, type CredentialDocument, type CredentialStatus } from "../models/Credential";
import { CredentialRevealAudit } from "../models/CredentialRevealAudit";
import { decryptCredentialPassword, isEncryptedCredentialPassword } from "../services/credentialEncryption";

function sharedCredentialBusinessId() {
  const configuredId = String(process.env.SHARED_CREDENTIAL_BUSINESS_ID || "business-a").trim();
  return getBusinessById(configuredId)?.id || getDefaultBusiness().id;
}
function withSharedCredentials<T>(callback: () => Promise<T>) {
  return runWithBusiness(sharedCredentialBusinessId(), callback);
}
function unavailable(response: Response) {
  response.status(503).json({ message: "Credentials are temporarily unavailable. Please try again." });
}
function toText(value: unknown, fallback = "") {
  const text = String(value || "").trim();
  return text || fallback;
}
function toCredentialStatus(value: unknown): CredentialStatus {
  const status = toText(value, "Active");
  return ["Active", "Review", "Archived"].includes(status) ? status as CredentialStatus : "Active";
}
function getCredentialInput(request: Request) {
  const company = toText(request.body.company);
  return { accountName: toText(request.body.accountName), username: toText(request.body.username),
    password: toText(request.body.password), platform: toText(request.body.platform),
    company: company && company !== "All companies" ? company : "All branches",
    team: toText(request.body.team, "All teams"), status: toCredentialStatus(request.body.status) };
}
type StoredCredential = CredentialDocument & { _id: unknown; createdAt?: unknown; updatedAt?: unknown; __v?: unknown };
function metadata(credential: StoredCredential) {
  return { _id: credential._id, accountName: toText(credential.accountName), username: toText(credential.username),
    platform: toText(credential.platform), company: toText(credential.company, "General"), team: toText(credential.team, "All teams"),
    status: toCredentialStatus(credential.status), createdAt: credential.createdAt, updatedAt: credential.updatedAt,
    hasPassword: typeof credential.password === "string" && credential.password.length > 0 };
}
async function present(credential: StoredCredential, secure: boolean) {
  if (secure) return metadata(credential);
  const legacy: Record<string, unknown> = { ...metadata(credential) };
  delete legacy.hasPassword;
  return { ...legacy, __v: credential.__v,
    password: await decryptCredentialPassword(credential.password, String(credential._id)) };
}
function validId(request: Request, response: Response) {
  if (Types.ObjectId.isValid(String(request.params.id))) return true;
  response.status(400).json({ message: "A valid credential ID is required." });
  return false;
}
function validPasswordInput(request: Request, response: Response) {
  const value = request.body?.password;
  if (value !== undefined && (typeof value !== "string" || isEncryptedCredentialPassword(value))) {
    response.status(400).json({ message: "Provide a plaintext password, not an encrypted value." });
    return false;
  }
  return true;
}
function duplicateFilter(input: { username: string; platform: string }, id?: string) {
  const exact = (value: string) => ({ $regex: "^" + value.replace(/[.*+?^$(){}|[\]\\]/g, "\\$&") + "$", $options: "i" });
  return { ...(id ? { _id: { $ne: id } } : {}), platform: exact(input.platform), username: exact(input.username), status: { $ne: "Archived" as const } };
}
async function secureUpdate(id: string, changes: Partial<CredentialDocument>, password?: string) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const original = await Credential.findById(id).select("+password").lean();
    if (!original) return null;
    const next = { ...changes };
    let upgrade = false;
    if (password?.trim()) next.password = password;
    else if (isEncryptedCredentialPassword(original.password)) {
      await decryptCredentialPassword(original.password, id);
    } else {
      next.password = original.password;
      upgrade = true;
    }
    // Compare the old plaintext during upgrade so a concurrent password change wins.
    const saved = await Credential.findOneAndUpdate({ _id: id, ...(upgrade ? { password: original.password } : {}) },
      { $set: next }, { returnDocument: "after", runValidators: true }).select("+password");
    if (saved) return saved;
  }
  throw new Error("Credential changed during update.");
}
export async function listCredentials(_request: Request, response: Response) {
  try {
    const secure = securityCredentialVaultEnabled();
    const credentials = await withSharedCredentials(async () => {
      const source = await Credential.find({ status: { $ne: "Archived" } }).select("+password").sort({ updatedAt: -1 }).lean();
      const unique = new Map<string, (typeof source)[number]>();
      for (const credential of source) {
        const identity = toText(credential.platform).toLowerCase() + "|" + toText(credential.username).toLowerCase();
        if (!unique.has(identity)) unique.set(identity, credential);
      }
      return Promise.all([...unique.values()].map((credential) => present(credential, secure)));
    });
    response.json(credentials);
  } catch { unavailable(response); }
}
export async function createCredential(request: Request, response: Response) {
  try {
    const secure = securityCredentialVaultEnabled();
    if (secure && !validPasswordInput(request, response)) return;
    const input = getCredentialInput(request);
    if (secure && typeof request.body.password === "string") input.password = request.body.password;
    if (!input.username || !input.password.trim() || !input.platform) {
      response.status(400).json({ message: "username, password, and platform are required" }); return;
    }
    const credential = await withSharedCredentials(async () => {
      if (await Credential.exists(duplicateFilter(input))) return null;
      return Credential.create(input);
    });
    if (!credential) { response.status(409).json({ message: "This tool and username already exist in Credentials." }); return; }
    response.status(201).json(await present(credential.toObject(), secure));
  } catch { unavailable(response); }
}
export async function updateCredential(request: Request, response: Response) {
  try {
    const secure = securityCredentialVaultEnabled();
    if (secure && (!validId(request, response) || !validPasswordInput(request, response))) return;
    const input = getCredentialInput(request);
    const credential = await withSharedCredentials(async () => {
      const original = await Credential.findById(request.params.id).select("+password").lean();
      if (!original) return null;
      const changes: Partial<CredentialDocument> = secure
        ? Object.fromEntries(Object.entries(input).filter(([key]) => key !== "password" && Object.hasOwn(request.body, key))) : input;
      if (await Credential.exists(duplicateFilter({ username: changes.username ?? original.username,
        platform: changes.platform ?? original.platform }, String(original._id)))) return "duplicate" as const;
      if (secure) return secureUpdate(String(original._id), changes, request.body.password);
      if (isEncryptedCredentialPassword(original.password)) {
        await decryptCredentialPassword(original.password, String(original._id));
      }
      if (!input.password.trim()) delete changes.password;
      return Credential.findByIdAndUpdate(request.params.id, changes, { returnDocument: "after", runValidators: true }).select("+password");
    });
    if (credential === "duplicate") { response.status(409).json({ message: "This tool and username already exist in Credentials." }); return; }
    if (!credential) { response.status(404).json({ message: "Credential not found" }); return; }
    response.json(await present(credential.toObject(), secure));
  } catch { unavailable(response); }
}
export async function archiveCredential(request: Request, response: Response) {
  try {
    const secure = securityCredentialVaultEnabled();
    if (secure && !validId(request, response)) return;
    const credential = await withSharedCredentials(async () => {
      if (secure) return secureUpdate(String(request.params.id), { status: "Archived" });
      const original = await Credential.findById(request.params.id).select("+password").lean();
      if (!original) return null;
      await decryptCredentialPassword(original.password, String(original._id));
      return Credential.findByIdAndUpdate(request.params.id, { status: "Archived" }, { returnDocument: "after", runValidators: true }).select("+password");
    });
    if (!credential) { response.status(404).json({ message: "Credential not found" }); return; }
    response.json(await present(credential.toObject(), secure));
  } catch { unavailable(response); }
}
export async function revealCredential(request: Request, response: Response) {
  response.set("Cache-Control", "no-store");
  if (!securityCredentialVaultEnabled()) { response.status(404).json({ message: "Credential reveal is disabled." }); return; }
  const actor = verifyAdminDashboardSession(request.header("x-crm-admin-session"));
  if (!actor) { response.status(403).json({ message: "A verified administrator session is required." }); return; }
  if (!validId(request, response)) return;
  try {
    const password = await withSharedCredentials(async () => {
      const credential = await Credential.findById(request.params.id).select("+password").lean();
      if (!credential) return null;
      const plaintext = await decryptCredentialPassword(credential.password, String(credential._id));
      await CredentialRevealAudit.create({ actorCode: actor.employeeCode, credentialId: credential._id,
        businessId: request.business?.id || sharedCredentialBusinessId(), occurredAt: new Date() });
      return plaintext;
    });
    if (password === null) { response.status(404).json({ message: "Credential not found" }); return; }
    response.json({ password });
  } catch { unavailable(response); }
}
