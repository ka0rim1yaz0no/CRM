import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { securityCredentialVaultEnabled } from "../config/rolloutFlags";

const reservedPrefix = "crmcred:";
const versionPrefix = `${reservedPrefix}v1:`;

export class CredentialEncryptionError extends Error {
  readonly status = 503;
  readonly code = "CREDENTIAL_ENCRYPTION_UNAVAILABLE";

  constructor() {
    super("Credential encryption is unavailable.");
    this.name = "CredentialEncryptionError";
  }
}

function encryptionKey() {
  const configured = process.env.CRM_CREDENTIAL_KEY;
  if (!configured) throw new CredentialEncryptionError();
  let material: Buffer;
  if (configured.startsWith("base64:")) {
    const encoded = configured.slice("base64:".length);
    material = Buffer.from(encoded, "base64");
    if (material.toString("base64") !== encoded) throw new CredentialEncryptionError();
  } else {
    material = Buffer.from(configured, "utf8");
  }
  try {
    if (material.length < 32) throw new CredentialEncryptionError();
    return createHash("sha256").update(material).digest();
  } finally {
    material.fill(0);
  }
}

function authenticatedContext(credentialId: string) {
  if (typeof credentialId !== "string" || !credentialId.trim()) throw new CredentialEncryptionError();
  return Buffer.from(`${versionPrefix}\0${credentialId}`, "utf8");
}

function decodeComponent(value: string, size?: number) {
  if (!/^[A-Za-z0-9_-]*$/.test(value)) throw new CredentialEncryptionError();
  const decoded = Buffer.from(value, "base64url");
  if (decoded.toString("base64url") !== value || (size !== undefined && decoded.length !== size)) {
    throw new CredentialEncryptionError();
  }
  return decoded;
}

// Reserve malformed and future envelopes too: they must never become legacy plaintext.
export function isEncryptedCredentialPassword(stored: unknown): boolean {
  return typeof stored === "string" && stored.trimStart().toLowerCase().startsWith(reservedPrefix);
}

export function encryptCredentialPassword(plaintext: string, credentialId: string): string {
  let key: Buffer | undefined;
  try {
    if (typeof plaintext !== "string") throw new CredentialEncryptionError();
    key = encryptionKey();
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv, { authTagLength: 16 });
    cipher.setAAD(authenticatedContext(credentialId));
    const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    return `${versionPrefix}${iv.toString("base64url")}:${cipher.getAuthTag().toString("base64url")}:${ciphertext.toString("base64url")}`;
  } catch {
    throw new CredentialEncryptionError();
  } finally {
    key?.fill(0);
  }
}

export function decryptCredentialPassword(stored: string, credentialId: string): string {
  let key: Buffer | undefined;
  try {
    if (typeof stored !== "string") throw new CredentialEncryptionError();
    if (!isEncryptedCredentialPassword(stored)) return stored;
    const parts = stored.split(":");
    if (parts.length !== 5 || !stored.startsWith(versionPrefix)) throw new CredentialEncryptionError();
    const iv = decodeComponent(parts[2], 12);
    const tag = decodeComponent(parts[3], 16);
    const ciphertext = decodeComponent(parts[4]);
    key = encryptionKey();
    const decipher = createDecipheriv("aes-256-gcm", key, iv, { authTagLength: 16 });
    decipher.setAAD(authenticatedContext(credentialId));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  } catch {
    throw new CredentialEncryptionError();
  } finally {
    key?.fill(0);
  }
}

export function assertCredentialEncryptionConfiguration(): void {
  if (process.env.NODE_ENV !== "production" || !securityCredentialVaultEnabled()) return;
  let key: Buffer | undefined;
  try {
    key = encryptionKey();
  } catch {
    throw new CredentialEncryptionError();
  } finally {
    key?.fill(0);
  }
}
