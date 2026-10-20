import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import { after, afterEach, before, test } from "node:test";
import mongoose from "mongoose";
import { MongoMemoryReplSet } from "mongodb-memory-server";

process.env.NODE_ENV = "test";
const prefix = "vault_test_" + crypto.randomBytes(8).toString("hex");
const businesses = ["vault-a", "vault-b", "vault-c"];
const adminCode = "test-vault-full-admin";
const signingKey = crypto.randomBytes(48).toString("base64");
const encryptionKey = crypto.randomBytes(48).toString("base64");
process.env.BUSINESS_DATABASES = JSON.stringify(businesses.map((id, index) => ({ id, name: "Synthetic vault " + index, databaseName: prefix + "_" + index })));
process.env.DEFAULT_BUSINESS_ID = businesses[0];
process.env.DEFAULT_BUSINESS_DATABASE = prefix + "_0";
process.env.SHARED_CREDENTIAL_BUSINESS_ID = businesses[0];
process.env.CONTROL_DATABASE_NAME = prefix + "_control";
process.env.CRM_ADMIN_ONE_CODE = adminCode;
process.env.CRM_ADMIN_SESSION_SECRET = signingKey;
process.env.CRM_CREDENTIAL_KEY = encryptionKey;
process.env.CRM_SECURITY_CREDENTIAL_VAULT = "true";
if (!process.env.CI) process.env.MONGOMS_RUNTIME_DOWNLOAD = "false";

const { createApp } = await import("../app");
const { Credential } = await import("../models/Credential");
const { CredentialRevealAudit } = await import("../models/CredentialRevealAudit");
const { runWithBusiness, getBusinessConnection } = await import("../config/tenancy");
const { createAdminDashboardSession } = await import("../config/adminDashboardSession");
const { createAttendanceHubSession } = await import("../config/attendanceHubSession");
const trackerCode = "synthetic-vault-tracker";
const { decryptCredentialPassword, encryptCredentialPassword, isEncryptedCredentialPassword } = await import("./credentialEncryption");
process.env.CRM_ADMIN_TWO_CODE = trackerCode;
process.env.CRM_TRACKER_ADMIN_CODES = trackerCode;
let mongo: MongoMemoryReplSet | undefined;
let server: http.Server | undefined;
let base = "";
let counter = 0;
const vault = <T>(callback: () => T) => runWithBusiness(businesses[0], callback);
const secret = () => "synthetic-password-" + crypto.randomBytes(12).toString("hex");

before(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  const uri = mongo.getUri(prefix);
  assert.equal(new URL(uri).hostname, "127.0.0.1");
  await mongoose.connect(uri);
  server = http.createServer(createApp());
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  base = "http://127.0.0.1:" + (server.address() as { port: number }).port + "/api/credentials";
});
afterEach(() => {
  process.env.CRM_CREDENTIAL_KEY = encryptionKey;
  process.env.CRM_SECURITY_CREDENTIAL_VAULT = "true";
  process.env.CRM_SECURITY_LEGACY_AUTH = "true";
});
after(async () => {
  try {
    if (server?.listening) {
      const closed = new Promise<void>((resolve, reject) => server!.close((error) => error ? reject(error) : resolve()));
      server.closeAllConnections(); await closed;
    }
  } finally { try { await mongoose.disconnect(); } finally { await mongo?.stop(); } }
});

function signed(code: string, exp = Date.now() + 3_600_000) {
  const payload = Buffer.from(JSON.stringify({ code, exp })).toString("base64url");
  return payload + "." + crypto.createHmac("sha256", signingKey).update(payload).digest("base64url");
}
async function request(method = "GET", path = "", body?: unknown, options: {
  token?: string | null; business?: number; headers?: Record<string, string>;
} = {}) {
  const token = options.token === undefined ? createAdminDashboardSession(adminCode)! : options.token;
  const response = await fetch(base + path, { method, headers: { "Content-Type": "application/json",
    "X-Business-Id": businesses[options.business ?? 0], ...(token ? { "X-CRM-Admin-Session": token } : {}), ...options.headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, body: await response.json(), headers: response.headers };
}
function metadataOnly(body: Record<string, unknown>, forbidden: string[] = []) {
  assert.equal(body.hasPassword, true);
  assert.equal(Object.hasOwn(body, "password"), false);
  assert.ok(Object.keys(body).every((key) => ["_id", "accountName", "username", "platform", "company", "team", "status", "createdAt", "updatedAt", "hasPassword"].includes(key)));
  for (const value of forbidden) assert.ok(!JSON.stringify(body).includes(value), "metadata must not disclose secret material");
}
function sanitized(result: Awaited<ReturnType<typeof request>>, forbidden: string[] = []) {
  assert.equal(result.status, 503);
  assert.deepEqual(result.body, { message: "Credentials are temporarily unavailable. Please try again." });
  for (const value of forbidden) assert.ok(!JSON.stringify(result.body).includes(value), "errors must not disclose secret material");
}
async function seed(encrypted = false) {
  const id = new mongoose.Types.ObjectId();
  const plaintext = secret();
  const password = encrypted ? encryptCredentialPassword(plaintext, String(id)) : plaintext;
  const now = new Date();
  await vault(() => Credential.collection.insertOne({ _id: id, accountName: "Synthetic vault account", username: "user-" + counter++,
    password, platform: "Fixture platform", company: "All branches", team: "All teams", status: "Active", createdAt: now, updatedAt: now }));
  return { id: String(id), plaintext, password };
}
const raw = (id: string) => vault(() => Credential.collection.findOne({ _id: new mongoose.Types.ObjectId(id) }));
const snapshot = () => vault(async () => JSON.stringify({ credentials: await Credential.collection.find({}).sort({ _id: 1 }).toArray(),
  audits: await CredentialRevealAudit.collection.find({}).sort({ _id: 1 }).toArray() }));

test("vault ON: all five HTTP routes reject anonymous, forged, wrong-role, tracker-only, expired and tampered sessions without writes", async () => {
  const record = await seed();
  const valid = createAdminDashboardSession(adminCode)!;
  const [payload, signature] = valid.split(".");
  const invalid = [
    { token: null },
    { token: null, headers: { "X-CRM-User-Type": "admin", "X-CRM-User-Code": adminCode } },
    { token: createAttendanceHubSession("synthetic-employee")! },
    { token: signed(trackerCode) },
    { token: signed(adminCode, Date.now() - 1) },
    { token: payload + "." + (signature[0] === "A" ? "B" : "A") + signature.slice(1) },
  ];
  const before = await snapshot();
  for (const identity of invalid) for (const [method, path] of [["GET", ""], ["POST", ""], ["PUT", "/" + record.id],
    ["PATCH", "/" + record.id + "/archive"], ["POST", "/" + record.id + "/reveal"]]) {
    const response = await request(method, path, method === "GET" ? undefined : { username: "forged", platform: "Forged", password: secret() }, identity);
    assert.ok(response.status === 401 || response.status === 403, "credential routes must require a signed full-admin session");
    assert.ok(!JSON.stringify(response.body).includes(record.plaintext));
  }
  assert.equal(await snapshot(), before);
});

test("vault ON: full admin CRUD returns metadata, stores encrypted passwords, and audits explicit reveal before returning plaintext", async () => {
  const plaintext = secret();
  const created = await request("POST", "", { username: "created-" + counter++, platform: "Vault CRUD", password: plaintext });
  assert.equal(created.status, 201); metadataOnly(created.body, [plaintext]);
  const id = created.body._id as string;
  const stored = (await raw(id))!;
  assert.ok(isEncryptedCredentialPassword(stored.password));
  assert.equal(decryptCredentialPassword(stored.password, id), plaintext);
  const list = await request();
  assert.equal(list.status, 200); metadataOnly(list.body.find((item: { _id: string }) => item._id === id), [plaintext, stored.password]);
  const updated = await request("PUT", "/" + id, { accountName: "Updated metadata", password: "   " });
  assert.equal(updated.status, 200); metadataOnly(updated.body, [plaintext, stored.password]);
  assert.equal((await raw(id))!.password, stored.password, "blank password must preserve the exact ciphertext");
  const revealed = await request("POST", "/" + id + "/reveal", {}, { headers: { "X-CRM-User-Code": "forged-audit-actor" } });
  assert.equal(revealed.status, 200); assert.equal(revealed.headers.get("cache-control"), "no-store");
  assert.deepEqual(revealed.body, { password: plaintext });
  const audits = await vault(() => CredentialRevealAudit.find({ credentialId: id }).lean());
  assert.equal(audits.length, 1); assert.equal(audits[0].actorCode, adminCode);
  assert.equal(audits[0].businessId, businesses[0]); assert.ok(audits[0].occurredAt instanceof Date);
  assert.ok(!JSON.stringify(audits).includes(plaintext)); assert.ok(!JSON.stringify(audits).includes(stored.password));
  const archived = await request("PATCH", "/" + id + "/archive", {});
  assert.equal(archived.status, 200); metadataOnly(archived.body, [plaintext, stored.password]);
  assert.equal(archived.body.status, "Archived");
});

test("vault ON: legacy list and reveal do not migrate passwords; a missing-password metadata write upgrades only its target", async () => {
  const record = await seed(); const untouched = await seed();
  const before = await raw(record.id);
  const list = await request();
  assert.equal(list.status, 200); metadataOnly(list.body.find((item: { _id: string }) => item._id === record.id), [record.plaintext]);
  assert.deepEqual(await raw(record.id), before, "list must remain read-only");
  assert.equal((await request("POST", "/" + record.id + "/reveal", {})).body.password, record.plaintext);
  assert.deepEqual(await raw(record.id), before, "reveal audits access but must not lazily rewrite the credential");
  const update = await request("PUT", "/" + record.id, { accountName: "Upgrade on intentional metadata write" });
  assert.equal(update.status, 200); metadataOnly(update.body, [record.plaintext]);
  assert.ok(isEncryptedCredentialPassword((await raw(record.id))!.password));
  assert.equal(decryptCredentialPassword((await raw(record.id))!.password, record.id), record.plaintext);
  assert.equal((await raw(untouched.id))!.password, untouched.plaintext);
});

test("vault ON: reject empty creates, invalid IDs, and client envelopes without mutation", async () => {
  const record = await seed(true); const before = await snapshot();
  for (const password of ["", "   "]) assert.equal((await request("POST", "", { username: "empty", platform: "Empty", password })).status, 400);
  for (const password of [record.password, "crmcred:v1:malformed", " crmcred:v99:unknown"]) {
    assert.equal((await request("POST", "", { username: "envelope", platform: "Envelope", password })).status, 400);
    assert.equal((await request("PUT", "/" + record.id, { password })).status, 400);
  }
  for (const [method, suffix] of [["PUT", ""], ["PATCH", "/archive"], ["POST", "/reveal"]]) {
    assert.equal((await request(method, "/not-an-id" + suffix, {})).status, 400);
  }
  assert.equal((await request("POST", "/" + new mongoose.Types.ObjectId() + "/reveal", {})).status, 404);
  assert.equal(await snapshot(), before);
});

test("vault ON: model save, query and insertMany writes encrypt at rest and reject transplanted ciphertext", async () => {
  const plaintext = secret();
  const record = await vault(() => Credential.create({ username: "model-" + counter++, platform: "Model", password: plaintext }));
  const id = String(record._id);
  assert.ok(isEncryptedCredentialPassword((await raw(id))!.password));
  await vault(() => Credential.updateOne({ _id: id }, { $set: { password: plaintext + "-changed" } }));
  assert.equal(decryptCredentialPassword((await raw(id))!.password, id), plaintext + "-changed");
  const inserted = await vault(() => Credential.insertMany([{ username: "inserted-" + counter++, platform: "Model insert", password: plaintext }]));
  assert.ok(isEncryptedCredentialPassword((await raw(String(inserted[0]._id)))!.password));
  const other = await seed(true); const before = await raw(id);
  await assert.rejects(vault(() => Credential.updateOne({ _id: id }, { $set: { password: other.password } })));
  assert.deepEqual(await raw(id), before);
});

test("vault ON: alternate update operators cannot write plaintext or rename password paths", async () => {
  const record = await seed(true);
  const before = await raw(record.id);
  for (const update of [
    { $min: { password: "aaa-synthetic-plaintext" } },
    { $max: { password: "zzz-synthetic-plaintext" } },
    { $rename: { password: "previousPassword" } },
    { $unset: { password: "" } },
  ]) {
    await assert.rejects(vault(() => Credential.updateOne({ _id: record.id }, update)));
    assert.deepEqual(await raw(record.id), before);
  }
});

test("vault ON: blank/missing password updates preserve concurrent password changes, including during legacy upgrade", async (context) => {
  for (const encrypted of [true, false]) {
    const record = await seed(encrypted); const newer = secret();
    const model = vault(() => getBusinessConnection().model("Credential")) as typeof Credential;
    const original = model.findOneAndUpdate.bind(model);
    let injected = false;
    const mocked = context.mock.method(model, "findOneAndUpdate", (...args: Parameters<typeof Credential.findOneAndUpdate>) => {
      const query = original(...args);
      const execute = query.exec.bind(query);
      query.exec = async () => {
        if (!injected && String(query.getFilter()._id) === record.id) {
          injected = true;
          await Credential.updateOne({ _id: record.id }, { $set: { password: newer } });
        }
        return execute();
      };
      return query;
    });
    try {
      const update = await request("PUT", "/" + record.id, { accountName: "Concurrent metadata", ...(encrypted ? { password: "" } : {}) });
      assert.equal(update.status, 200); assert.equal(injected, true); metadataOnly(update.body, [newer]);
      assert.equal(decryptCredentialPassword((await raw(record.id))!.password, record.id), newer);
      assert.equal((await raw(record.id))!.accountName, "Concurrent metadata");
    } finally { mocked.mock.restore(); }
  }
});

test("vault ON: missing/wrong keys and tampered or wrong-context records fail closed with sanitized errors", async () => {
  const record = await seed(true); const legacy = await seed();
  const before = await snapshot();
  delete process.env.CRM_CREDENTIAL_KEY;
  sanitized(await request("POST", "/" + record.id + "/reveal", {}), [record.plaintext, record.password]);
  sanitized(await request("POST", "", { username: "missing-key", platform: "Missing key", password: secret() }));
  sanitized(await request("PUT", "/" + legacy.id, { accountName: "No key upgrade" }));
  assert.equal((await request()).status, 200, "metadata remains readable without decryption");
  assert.equal(await snapshot(), before);
  process.env.CRM_CREDENTIAL_KEY = crypto.randomBytes(48).toString("base64");
  sanitized(await request("POST", "/" + record.id + "/reveal", {}), [record.password]);
  process.env.CRM_CREDENTIAL_KEY = encryptionKey;
  const other = await seed(true);
  await vault(() => Credential.collection.updateOne({ _id: new mongoose.Types.ObjectId(record.id) }, { $set: { password: other.password } }));
  sanitized(await request("POST", "/" + record.id + "/reveal", {}), [other.password]);
  await vault(() => Credential.collection.updateOne({ _id: new mongoose.Types.ObjectId(record.id) }, { $set: { password: "crmcred:v1:tampered" } }));
  sanitized(await request("POST", "/" + record.id + "/reveal", {}));
  await vault(() => Credential.collection.updateOne({ _id: new mongoose.Types.ObjectId(record.id) }, { $set: { password: record.password } }));
});

test("vault ON: audit and database failures never return or log plaintext/ciphertext", async (context) => {
  const record = await seed(true);
  const errors = context.mock.method(console, "error", () => {});
  const warnings = context.mock.method(console, "warn", () => {});
  const auditModel = vault(() => getBusinessConnection().model("CredentialRevealAudit"));
  const failure = context.mock.method(auditModel, "create", async () => { throw new Error(record.plaintext + record.password); });
  const before = await snapshot();
  sanitized(await request("POST", "/" + record.id + "/reveal", {}), [record.plaintext, record.password]);
  assert.equal(await snapshot(), before);
  failure.mock.restore();
  const model = vault(() => getBusinessConnection().model("Credential"));
  context.mock.method(model, "find", () => { throw new Error(record.plaintext + record.password); });
  sanitized(await request(), [record.plaintext, record.password]);
  assert.equal(errors.mock.callCount(), 0); assert.equal(warnings.mock.callCount(), 0);
});

test("all three businesses share the same vault and audit storage, with requesting business and signed actor recorded", async () => {
  const record = await seed(true);
  for (let business = 0; business < businesses.length; business++) {
    const list = await request("GET", "", undefined, { business });
    assert.equal(list.status, 200); metadataOnly(list.body.find((item: { _id: string }) => item._id === record.id), [record.password]);
    const revealed = await request("POST", "/" + record.id + "/reveal", {}, { business });
    assert.equal(revealed.status, 200); assert.equal(revealed.body.password, record.plaintext);
  }
  const audits = await vault(() => CredentialRevealAudit.find({ credentialId: record.id }).lean());
  assert.deepEqual(audits.map((audit) => audit.businessId).sort(), [...businesses].sort());
  assert.ok(audits.every((audit) => audit.actorCode === adminCode));
  for (const business of businesses.slice(1)) await runWithBusiness(business, async () => {
    assert.equal(await Credential.countDocuments(), 0); assert.equal(await CredentialRevealAudit.countDocuments(), 0);
  });
});

test("vault OFF: legacy plaintext behavior remains, encrypted rows decrypt with retained key or fail closed, and reveal is disabled", async () => {
  const record = await seed(true); const legacy = await seed();
  process.env.CRM_SECURITY_CREDENTIAL_VAULT = "false";
  process.env.CRM_SECURITY_LEGACY_AUTH = "false";
  const list = await request("GET", "", undefined, { token: null });
  assert.equal(list.status, 200);
  assert.equal(list.body.find((item: { _id: string }) => item._id === record.id).password, record.plaintext);
  assert.equal(list.body.find((item: { _id: string }) => item._id === legacy.id).password, legacy.plaintext);
  for (const original of [record, legacy]) for (const password of [undefined, "", "   "]) {
    const updated = await request("PUT", "/" + original.id, { username: "rollback-" + counter++, platform: "Rollback metadata",
      ...(password === undefined ? {} : { password }) }, { token: null });
    assert.equal(updated.status, 200); assert.equal(updated.body.password, original.plaintext);
    assert.equal((await raw(original.id))!.password, original.password, "rollback metadata writes must preserve plaintext and ciphertext exactly");
  }
  assert.equal((await request("POST", "/" + record.id + "/reveal", {}, { token: null })).status, 404);
  const plaintext = secret();
  const created = await request("POST", "", { username: "legacy-off-" + counter++, platform: "Legacy off", password: plaintext }, { token: null });
  assert.equal(created.status, 201); assert.equal(created.body.password, plaintext);
  assert.equal((await raw(created.body._id))!.password, plaintext);
  delete process.env.CRM_CREDENTIAL_KEY;
  sanitized(await request("GET", "", undefined, { token: null }), [record.password]);
});
