import assert from "node:assert/strict";
import { createCipheriv, createHash } from "node:crypto";
import test from "node:test";
import { MongoClient } from "mongodb";
import { assertCredentialEncryptionConfiguration, CredentialEncryptionError, decryptCredentialPassword, encryptCredentialPassword, isEncryptedCredentialPassword } from "./credentialEncryption";
import { auditCredentialEncryption, classifyCredentialPasswordStorage, parseCredentialEncryptionAuditArgs } from "../scripts/auditCredentialEncryption";

const fakeKey = "fixture-only-credential-key-32-bytes-minimum";
const fakeId = "fake-credential-id";
const fakePassword = "fake-password-only";

function withEnvironment(values: Record<string, string | undefined>, run: () => void) {
  const previous = Object.fromEntries(Object.keys(values).map((name) => [name, process.env[name]]));
  try {
    for (const [name, value] of Object.entries(values)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    run();
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

function unavailable(run: () => unknown) {
  assert.throws(run, (error: unknown) => {
    assert.ok(error instanceof CredentialEncryptionError);
    assert.equal(error.status, 503);
    assert.equal(error.code, "CREDENTIAL_ENCRYPTION_UNAVAILABLE");
    assert.equal(error.message, "Credential encryption is unavailable.");
    assert.equal(error.cause, undefined);
    return true;
  });
}

test("vault round trips exact plaintext, Unicode and empty values with random 12-byte IVs and 16-byte tags", () => {
  withEnvironment({ CRM_CREDENTIAL_KEY: fakeKey }, () => {
    for (const plaintext of [fakePassword, "", "  fake password  ", "fake-\u00e9-\ud83d\udd12"]) {
      const stored = encryptCredentialPassword(plaintext, fakeId);
      assert.match(stored, /^crmcred:v1:/);
      assert.notEqual(stored, encryptCredentialPassword(plaintext, fakeId));
      const parts = stored.split(":");
      assert.equal(Buffer.from(parts[2], "base64url").length, 12);
      assert.equal(Buffer.from(parts[3], "base64url").length, 16);
      assert.equal(decryptCredentialPassword(stored, fakeId), plaintext);
      assert.equal(classifyCredentialPasswordStorage(stored), "encrypted");
    }
  });
});

test("legacy plaintext reads are unchanged without a key or writes", () => {
  withEnvironment({ CRM_CREDENTIAL_KEY: undefined }, () => {
    for (const plaintext of [fakePassword, "", "  fake password  "]) {
      assert.equal(decryptCredentialPassword(plaintext, fakeId), plaintext);
      assert.equal(isEncryptedCredentialPassword(plaintext), false);
      assert.equal(classifyCredentialPasswordStorage(plaintext), "plaintext");
    }
    assert.equal(isEncryptedCredentialPassword(null), false);
    unavailable(() => encryptCredentialPassword(fakePassword, fakeId));
  });
});

test("version one interoperates with AES-256-GCM, SHA-256 key derivation and the exact context", () => {
  withEnvironment({ CRM_CREDENTIAL_KEY: fakeKey }, () => {
    const iv = Buffer.alloc(12, 7);
    const cipher = createCipheriv("aes-256-gcm", createHash("sha256").update(fakeKey, "utf8").digest(), iv, { authTagLength: 16 });
    cipher.setAAD(Buffer.from(`crmcred:v1:\0${fakeId}`, "utf8"));
    const ciphertext = Buffer.concat([cipher.update(fakePassword, "utf8"), cipher.final()]);
    const stored = `crmcred:v1:${iv.toString("base64url")}:${cipher.getAuthTag().toString("base64url")}:${ciphertext.toString("base64url")}`;
    assert.equal(decryptCredentialPassword(stored, fakeId), fakePassword);
    unavailable(() => decryptCredentialPassword(stored, `${fakeId} `));
  });
});

test("configuration has no missing or short key fallback in any environment", () => {
  for (const mode of ["development", "test", "production"]) {
    for (const key of [undefined, "", "f".repeat(31), `base64:${Buffer.alloc(31, 7).toString("base64")}`]) {
      withEnvironment({ NODE_ENV: mode, CRM_CREDENTIAL_KEY: key }, () => unavailable(() => encryptCredentialPassword(fakePassword, fakeId)));
    }
  }
});

test("keys use UTF-8 byte length and support only canonical standard base64", () => {
  withEnvironment({ CRM_CREDENTIAL_KEY: "f".repeat(32) }, () => assert.ok(encryptCredentialPassword(fakePassword, fakeId)));
  withEnvironment({ CRM_CREDENTIAL_KEY: "\u00e9".repeat(16) }, () => assert.ok(encryptCredentialPassword(fakePassword, fakeId)));
  withEnvironment({ CRM_CREDENTIAL_KEY: "\u00e9".repeat(15) }, () => unavailable(() => encryptCredentialPassword(fakePassword, fakeId)));
  let stored = "";
  withEnvironment({ CRM_CREDENTIAL_KEY: fakeKey }, () => { stored = encryptCredentialPassword(fakePassword, fakeId); });
  const encoded = Buffer.from(fakeKey).toString("base64");
  withEnvironment({ CRM_CREDENTIAL_KEY: `base64:${encoded}` }, () => assert.equal(decryptCredentialPassword(stored, fakeId), fakePassword));
  for (const invalid of [`${encoded}\n`, `${encoded}!`, "not*base64", Buffer.alloc(32, 255).toString("base64url")]) {
    withEnvironment({ CRM_CREDENTIAL_KEY: `base64:${invalid}` }, () => unavailable(() => encryptCredentialPassword(fakePassword, fakeId)));
  }
});

test("startup validates only production with vault enabled", () => {
  for (const mode of ["development", "test"]) {
    withEnvironment({ NODE_ENV: mode, CRM_SECURITY_CREDENTIAL_VAULT: "true", CRM_CREDENTIAL_KEY: undefined }, () => assert.doesNotThrow(assertCredentialEncryptionConfiguration));
  }
  for (const flag of [undefined, "false", "0"]) {
    withEnvironment({ NODE_ENV: "production", CRM_SECURITY_CREDENTIAL_VAULT: flag, CRM_CREDENTIAL_KEY: undefined }, () => assert.doesNotThrow(assertCredentialEncryptionConfiguration));
  }
  for (const flag of ["true", "1"]) {
    withEnvironment({ NODE_ENV: "production", CRM_SECURITY_CREDENTIAL_VAULT: flag, CRM_CREDENTIAL_KEY: undefined }, () => unavailable(assertCredentialEncryptionConfiguration));
    withEnvironment({ NODE_ENV: "production", CRM_SECURITY_CREDENTIAL_VAULT: flag, CRM_CREDENTIAL_KEY: fakeKey }, () => assert.doesNotThrow(assertCredentialEncryptionConfiguration));
  }
});

test("crypto remains active with the rollout flag off and encrypted reads still require a key", () => {
  let stored = "";
  withEnvironment({ CRM_SECURITY_CREDENTIAL_VAULT: "false", CRM_CREDENTIAL_KEY: fakeKey }, () => {
    stored = encryptCredentialPassword(fakePassword, fakeId);
    assert.equal(decryptCredentialPassword(stored, fakeId), fakePassword);
  });
  withEnvironment({ CRM_SECURITY_CREDENTIAL_VAULT: "false", CRM_CREDENTIAL_KEY: undefined }, () => unavailable(() => decryptCredentialPassword(stored, fakeId)));
});

test("wrong keys, credential IDs and tampered IV/tag/ciphertext fail closed with the same error", () => {
  withEnvironment({ CRM_CREDENTIAL_KEY: fakeKey }, () => {
    const stored = encryptCredentialPassword(fakePassword, fakeId);
    unavailable(() => decryptCredentialPassword(stored, "different-fake-id"));
    unavailable(() => decryptCredentialPassword(stored, ""));
    for (const part of [2, 3, 4]) {
      const parts = stored.split(":");
      const bytes = Buffer.from(parts[part], "base64url");
      bytes[0] ^= 1;
      parts[part] = bytes.toString("base64url");
      unavailable(() => decryptCredentialPassword(parts.join(":"), fakeId));
    }
    withEnvironment({ CRM_CREDENTIAL_KEY: "different-fixture-key-at-least-32-bytes" }, () => unavailable(() => decryptCredentialPassword(stored, fakeId)));
  });
});

test("malformed, noncanonical and unknown envelopes never fall back to plaintext", () => {
  withEnvironment({ CRM_CREDENTIAL_KEY: fakeKey }, () => {
    const stored = encryptCredentialPassword(fakePassword, fakeId);
    const parts = stored.split(":");
    for (const invalid of ["crmcred:", "crmcred:v2:fake", stored + ":extra", ` ${stored}`, stored.replace("crmcred", "CRMCRED"), stored.replace(parts[2], "AA"), stored.replace(parts[3], "AA"), stored.replace(parts[2], parts[2] + "="), stored.replace(parts[4], "!"), `crmcred:v1:${parts[2]}:${parts[3].slice(0, -1)}B:${parts[4]}`]) {
      assert.equal(isEncryptedCredentialPassword(invalid), true);
      assert.equal(classifyCredentialPasswordStorage(invalid), "malformed");
      unavailable(() => decryptCredentialPassword(invalid, fakeId));
    }
    unavailable(() => decryptCredentialPassword(null as unknown as string, fakeId));
    unavailable(() => encryptCredentialPassword(fakePassword, " "));
    unavailable(() => encryptCredentialPassword(null as unknown as string, fakeId));
    assert.equal(classifyCredentialPasswordStorage(undefined), "malformed");
    assert.equal(classifyCredentialPasswordStorage(42), "malformed");
  });
});

test("audit requires explicit URI and business databases and rejects every apply/unknown mode", () => {
  const uri = "mongodb://127.0.0.1:27017";
  assert.deepEqual(parseCredentialEncryptionAuditArgs(["--dry-run", "--uri", uri, "--business-db", "fake_business_a", "--business-db", "fake_business_b", "--business-db", "fake_business_a"]), { uri, businessDbs: ["fake_business_a", "fake_business_b"] });
  for (const args of [[], ["--uri", uri], ["--business-db", "fake_business_a"], ["--uri", uri, "--business-db"], ["--uri", uri, "--business-db", "--dry-run"], ["--uri", uri, "--business-db", "fake_business_a", "--apply"], ["--apply=true"], ["--uri", uri, "--uri", uri, "--business-db", "fake_business_a"], ["--uri", "https://fake.invalid", "--business-db", "fake_business_a"], ["--uri", uri, "--business-db", "../fake"]]) {
    assert.throws(() => parseCredentialEncryptionAuditArgs(args), { message: "Invalid audit arguments." });
  }
});

test("audit uses raw read-only projected cursors and returns counts without identities or values", async (context) => {
  const encrypted = `crmcred:v1:${Buffer.alloc(12).toString("base64url")}:${Buffer.alloc(16).toString("base64url")}:Zg`;
  const rows: Record<string, { password?: unknown }[]> = {
    fake_business_a: [{ password: fakePassword }, { password: encrypted }],
    fake_business_b: [{ password: "crmcred:v2:invalid" }, {}, { password: 42 }, { password: "" }],
  };
  const closed: string[] = [];
  let clientClosed = false;
  context.mock.method(MongoClient.prototype, "connect", async function (this: MongoClient) { return this; });
  context.mock.method(MongoClient.prototype, "close", async () => { clientClosed = true; });
  context.mock.method(MongoClient.prototype, "db", (name: string) => ({
    collection(collection: string) {
      assert.equal(collection, "credentials");
      return {
        find(filter: unknown, options: unknown) {
          assert.deepEqual(filter, {});
          assert.deepEqual(options, { projection: { _id: 0, password: 1 }, batchSize: 100 });
          return {
            async *[Symbol.asyncIterator]() { yield* rows[name]; },
            async close() { closed.push(name); },
          };
        },
      };
    },
  }) as unknown as ReturnType<MongoClient["db"]>);
  const result = await auditCredentialEncryption({ uri: "mongodb://127.0.0.1:27017", businessDbs: Object.keys(rows) });
  assert.deepEqual(result, { businessDatabases: 2, total: 6, plaintext: 2, encrypted: 1, malformed: 3 });
  assert.deepEqual(closed, Object.keys(rows));
  assert.equal(clientClosed, true);
  assert.equal(JSON.stringify(result).includes(fakePassword), false);
  assert.equal(JSON.stringify(result).includes("fake_business"), false);
});

test("audit closes the raw cursor and connection when a fake read fails", async (context) => {
  let cursorClosed = false;
  let clientClosed = false;
  context.mock.method(MongoClient.prototype, "connect", async function (this: MongoClient) { return this; });
  context.mock.method(MongoClient.prototype, "close", async () => { clientClosed = true; });
  context.mock.method(MongoClient.prototype, "db", () => ({
    collection() {
      return {
        find() {
          return {
            [Symbol.asyncIterator]() {
              return { async next() { throw new Error("Fake read failure."); } };
            },
            async close() { cursorClosed = true; },
          };
        },
      };
    },
  }) as unknown as ReturnType<MongoClient["db"]>);
  await assert.rejects(auditCredentialEncryption({ uri: "mongodb://127.0.0.1:27017", businessDbs: ["fake_business_a"] }), { message: "Fake read failure." });
  assert.equal(cursorClosed, true);
  assert.equal(clientClosed, true);
});
