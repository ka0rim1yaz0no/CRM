import { pathToFileURL } from "node:url";
import { MongoClient } from "mongodb";
import { isEncryptedCredentialPassword } from "../services/credentialEncryption";

export type CredentialEncryptionAuditOptions = { uri: string; businessDbs: string[] };
export type CredentialStorageKind = "plaintext" | "encrypted" | "malformed";

export function parseCredentialEncryptionAuditArgs(args: string[]): CredentialEncryptionAuditOptions {
  let uri = "";
  const businessDbs: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--dry-run") continue;
    if (arg !== "--uri" && arg !== "--business-db") throw new Error("Invalid audit arguments.");
    const value = args[++i];
    if (!value || value.startsWith("--")) throw new Error("Invalid audit arguments.");
    if (arg === "--uri") {
      if (uri) throw new Error("Invalid audit arguments.");
      uri = value;
    } else {
      if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("Invalid audit arguments.");
      businessDbs.push(value);
    }
  }
  if (!/^mongodb(?:\+srv)?:\/\//.test(uri) || !businessDbs.length) throw new Error("Invalid audit arguments.");
  return { uri, businessDbs: [...new Set(businessDbs)] };
}

// Structural counts only; authenticating ciphertext would require the vault key and record identity.
export function classifyCredentialPasswordStorage(stored: unknown): CredentialStorageKind {
  if (typeof stored !== "string") return "malformed";
  if (!isEncryptedCredentialPassword(stored)) return "plaintext";
  const match = /^crmcred:v1:([A-Za-z0-9_-]+):([A-Za-z0-9_-]+):([A-Za-z0-9_-]*)$/.exec(stored);
  if (!match) return "malformed";
  for (let i = 1; i <= 3; i++) {
    const decoded = Buffer.from(match[i], "base64url");
    if (decoded.toString("base64url") !== match[i]) return "malformed";
    if (i === 1 && decoded.length !== 12) return "malformed";
    if (i === 2 && decoded.length !== 16) return "malformed";
  }
  return "encrypted";
}

export async function auditCredentialEncryption(options: CredentialEncryptionAuditOptions) {
  const counts = { businessDatabases: options.businessDbs.length, total: 0, plaintext: 0, encrypted: 0, malformed: 0 };
  const client = new MongoClient(options.uri, { serverSelectionTimeoutMS: 5000, monitorCommands: false });
  try {
    await client.connect();
    for (const database of options.businessDbs) {
      const cursor = client.db(database).collection("credentials").find({}, { projection: { _id: 0, password: 1 }, batchSize: 100 });
      try {
        for await (const document of cursor) {
          counts[classifyCredentialPasswordStorage(document.password)]++;
          counts.total++;
        }
      } finally {
        await cursor.close();
      }
    }
    return counts;
  } finally {
    await client.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const options = parseCredentialEncryptionAuditArgs(process.argv.slice(2));
    process.stdout.write(`${JSON.stringify(await auditCredentialEncryption(options))}\n`);
  } catch {
    process.stderr.write("Credential encryption audit failed. Dry-run only; explicit --uri and --business-db arguments are required.\n");
    process.exitCode = 1;
  }
}
