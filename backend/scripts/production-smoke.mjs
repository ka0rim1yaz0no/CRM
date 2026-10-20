import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import { once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import { MongoClient } from "mongodb";

const root = path.resolve(import.meta.dirname, "..");
const database = `compiled_smoke_${crypto.randomBytes(8).toString("hex")}`;
const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "assistly-compiled-smoke-"));
const mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
const client = new MongoClient(mongo.getUri());
let child;
let exited;
try {
  await client.connect();
  const allowed = ["native-a", "native-b"];
  const mappings = allowed.map((id, index) => ({ id, name: `Synthetic Native ${index}`, databaseName: `${database}_${index}` }));
  await fs.writeFile(path.join(scratch, "empty-fixture-before-seed.json"), JSON.stringify({ database, collections: [] }));
  const ids = [];
  for (const business of mappings) {
    const inserted = await client.db(business.databaseName).collection("employees").insertOne({ name: "Synthetic compiled employee", employeeCode: "native-owner", role: "Sales", team: "Fixture", status: "Active", businessAccessIds: allowed, bankAccountNumber: "fake-native-bank" });
    ids.push(inserted.insertedId.toString());
  }
  const probe = http.createServer(); await new Promise(resolve => probe.listen(0, "127.0.0.1", resolve));
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
  const environment = Object.fromEntries(Object.entries(process.env).filter(([name]) => /^(PATH|PATHEXT|SystemRoot|WINDIR|TEMP|TMP|LOCALAPPDATA|APPDATA|USERPROFILE|ComSpec)$/i.test(name)));
  const env = { ...environment, NODE_ENV: "production", HOST: "127.0.0.1", PORT: String(port), MONGODB_URI: mongo.getUri(database),
    DOTENV_CONFIG_PATH: path.join(scratch, "intentionally-nonexistent-config"), CRM_UPLOAD_ROOT: path.join(scratch, "synthetic-uploads"),
    DEFAULT_BUSINESS_ID: allowed[0], DEFAULT_BUSINESS_DATABASE: mappings[0].databaseName, BUSINESS_DATABASES: JSON.stringify(mappings), CONTROL_DATABASE_NAME: `${database}_control`,
    CRM_ADMIN_ONE_CODE: "native-admin", CRM_ADMIN_ONE_ACCESS: "full", CRM_ADMIN_SESSION_SECRET: crypto.randomBytes(48).toString("hex"), CRM_CREDENTIAL_KEY: crypto.randomBytes(48).toString("hex"),
    CRM_SECURITY_LEGACY_AUTH: "true", CRM_DATA_CHECK: "true", CRM_SECURITY_CREDENTIAL_VAULT: "true", CRM_SECURITY_DATA_MINIMIZATION: "true", CRM_SECURITY_HARDENING: "true", CRM_SECURITY_UPLOAD_AUTH: "true", CRM_SECURITY_ENV_CODES: "true", CRM_ATTENDANCE_INTEGRITY: "true", CRM_ATTENDANCE_HUB: "true", CRM_CALL_DASHBOARD_V2: "true", CRM_DASHBOARD_V2: "true" };
  child = spawn(process.execPath, ["dist/server.js"], { cwd: root, env, windowsHide: true, stdio: "ignore" });
  exited = once(child, "exit");
  const base = `http://127.0.0.1:${port}/api`;
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null) break;
    try { if ((await fetch(`${base}/health`, { signal: AbortSignal.timeout(500) })).ok) { ready = true; break; } } catch { /* Wait for this isolated child only. */ }
    await delay(100);
  }
  assert.equal(ready, true, "Compiled native backend must start without tsx or real configuration files");
  async function login(code) {
    const response = await fetch(`${base}/auth/login`, { method: "POST", headers: { "Content-Type": "application/json", "X-Business-Id": allowed[0] }, body: JSON.stringify({ employeeCode: code }) });
    assert.equal(response.status, 200); return response.json();
  }
  const admin = await login("native-admin"), owner = await login("native-owner");
  assert.equal(Object.hasOwn(owner.user, "bankAccountNumber"), false);
  assert.ok(admin.sessionToken); assert.ok(owner.attendanceHubSession);
  for (let index = 0; index < mappings.length; index++) {
    const headers = { "X-Business-Id": mappings[index].id, "X-CRM-Admin-Session": admin.sessionToken, "X-CRM-User-Type": "admin", "X-CRM-User-Code": "native-admin" };
    assert.equal((await fetch(`${base}/call-dashboard`, { headers })).status, 200);
    assert.equal((await fetch(`${base}/dashboard-workspace/summary?preset=today`, { headers })).status, 200);
    assert.equal((await fetch(`${base}/admin/data-check/config`, { headers })).status, 200);
    const profile = await fetch(`${base}/employees/${ids[index]}`, { headers: { "X-Business-Id": mappings[index].id, "X-CRM-Attendance-Session": owner.attendanceHubSession } });
    assert.equal(profile.status, 200); assert.equal((await profile.json()).bankAccountNumber, "fake-native-bank");
    assert.equal((await fetch(`${base}/employees/${ids[index]}/attendance/session`, { headers: { "X-Business-Id": mappings[index].id, "X-CRM-Attendance-Session": owner.attendanceHubSession } })).status, 200);
  }
  process.stdout.write("Compiled native Node production-entry smoke passed: login, privacy, dashboards and attendance in two synthetic businesses.\n");
} finally {
  if (child && child.exitCode === null) child.kill();
  if (exited) await exited;
  await client.close(); await mongo.stop();
  if (path.dirname(scratch) !== path.resolve(os.tmpdir()) || !path.basename(scratch).startsWith("assistly-compiled-smoke-")) throw new Error("Unexpected temporary fixture path.");
  await fs.rm(scratch, { recursive: true, force: true });
}
