import type { Request, Response } from "express";
import { Credential, type CredentialStatus } from "../models/Credential";

function toText(value: unknown, fallback = "") {
  const text = String(value || "").trim();
  return text || fallback;
}

function toCredentialStatus(value: unknown): CredentialStatus {
  const status = toText(value, "Active");
  return ["Active", "Review", "Archived"].includes(status) ? status as CredentialStatus : "Active";
}

function getCredentialInput(request: Request) {
  return {
    accountName: toText(request.body.accountName),
    username: toText(request.body.username),
    password: toText(request.body.password),
    platform: toText(request.body.platform),
    company: toText(request.body.company, "General"),
    team: toText(request.body.team, "All teams"),
    status: toCredentialStatus(request.body.status),
  };
}

export async function listCredentials(_request: Request, response: Response) {
  const credentials = await Credential.find({ status: { $ne: "Archived" } }).sort({ updatedAt: -1 }).lean();
  response.json(
    credentials.map((credential) => ({
      ...credential,
      accountName: toText(credential.accountName),
      username: toText(credential.username),
      password: toText(credential.password),
      platform: toText(credential.platform),
      company: toText(credential.company, "General"),
      team: toText(credential.team, "All teams"),
      status: toCredentialStatus(credential.status),
    }))
  );
}

export async function createCredential(request: Request, response: Response) {
  const input = getCredentialInput(request);

  if (!input.username?.trim() || !input.password?.trim() || !input.platform?.trim()) {
    response.status(400).json({ message: "username, password, and platform are required" });
    return;
  }

  const credential = await Credential.create(input);
  response.status(201).json(credential);
}

export async function updateCredential(request: Request, response: Response) {
  const credential = await Credential.findByIdAndUpdate(request.params.id, getCredentialInput(request), {
    returnDocument: "after",
    runValidators: true,
  });

  if (!credential) {
    response.status(404).json({ message: "Credential not found" });
    return;
  }

  response.json(credential);
}

export async function archiveCredential(request: Request, response: Response) {
  const credential = await Credential.findByIdAndUpdate(
    request.params.id,
    { status: "Archived" },
    { returnDocument: "after", runValidators: true }
  );

  if (!credential) {
    response.status(404).json({ message: "Credential not found" });
    return;
  }

  response.json(credential);
}
