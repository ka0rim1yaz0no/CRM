import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { spawn } from "node:child_process";
import mongoose from "mongoose";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import { isReviewBlockedPath, localReviewBusinesses, localReviewRestoreUri, reviewCollections, reviewControlCollections } from "./localReviewConfig";

const privateRoot = path.join(process.env.LOCALAPPDATA || "", "AssistlyLocalReview");
if (!path.isAbsolute(privateRoot)) throw new Error("A private local review directory is required.");
const tools = path.join(privateRoot, "tools", "mongodb-database-tools-windows-x86_64-100.19.1", "bin");
await fs.access(path.join(tools, "mongodump.exe"));
await fs.access(path.join(tools, "mongorestore.exe"));
const snapshot = path.join(privateRoot, "snapshots", crypto.randomUUID());
const dump = path.join(snapshot, "dump");
await fs.mkdir(dump, { recursive: true });
async function tool(name: string, args: string[]) {
  const child = spawn(path.join(tools, `${name}.exe`), args, { windowsHide: true, stdio: "ignore" });
  const code = await new Promise<number | null>((resolve, reject) => { child.once("exit", resolve); child.once("error", reject); });
  if (code !== 0) throw new Error(`${name} failed. Original local databases were not modified.`);
}
const source = new mongoose.mongo.MongoClient("mongodb://127.0.0.1:27017/?directConnection=true", { serverSelectionTimeoutMS: 3000 });
let mongo: MongoMemoryReplSet | undefined;
let server: http.Server | undefined;
try {
  await source.connect();
  const available = (await source.db("admin").admin().listDatabases({ nameOnly: true })).databases.map((item) => item.name);
  const profiles = await source.db("crm_control").collection<{ businessId: string; name: string; databaseName?: string }>("businessprofiles")
    .find({}, { projection: { _id: 0, businessId: 1, name: 1, databaseName: 1 } }).toArray();
  const businesses = localReviewBusinesses(profiles, available);
  if (!businesses.length) throw new Error("No verified local CRM businesses were found.");
  const counts: Array<{ database: string; collection: string; count: number }> = [];
  const sources = [...new Set(businesses.map((business) => business.databaseName)), "crm_control"];
  for (const database of sources) {
    const allowlist = database === "crm_control" ? reviewControlCollections : reviewCollections;
    const collections = new Set((await source.db(database).listCollections({}, { nameOnly: true }).toArray()).map((item) => item.name));
    for (const collection of allowlist) {
      if (!collections.has(collection)) continue;
      const count = await source.db(database).collection(collection).countDocuments();
      await tool("mongodump", ["--uri=mongodb://127.0.0.1:27017/?directConnection=true", `--db=${database}`, `--collection=${collection}`, `--out=${dump}`, "--quiet"]);
      counts.push({ database, collection, count });
    }
  }
  // The real BSON dump is complete before any restoration or review-database writes.
  const snapshotAt = new Date().toISOString();
  await fs.writeFile(path.join(snapshot, "manifest.json"), JSON.stringify({ createdAt: snapshotAt, source: "127.0.0.1:27017", businesses, counts, excludedSensitiveCollections: true }, null, 2));
  process.stdout.write("Local CRM backup complete. Restoring isolated review copy.\n");
  mongo = await MongoMemoryReplSet.create({ binary: { downloadDir: path.resolve("node_modules/.cache/mongodb-memory-server") }, replSet: { count: 1 }, instanceOpts: [{ port: 27119 }] });
  const reviewUri = mongo.getUri("crm");
  await tool("mongorestore", [`--uri=${localReviewRestoreUri(reviewUri)}`, `--dir=${dump}`, "--quiet"]);
  const destination = new mongoose.mongo.MongoClient(reviewUri);
  await destination.connect();
  try {
    for (const item of counts) {
      const actualCount = await destination.db(item.database).collection(item.collection).countDocuments();
      if (actualCount !== item.count) throw new Error(`Review copy count verification failed for ${item.database}.${item.collection}: expected ${item.count}, received ${actualCount}.`);
      if (await source.db(item.database).collection(item.collection).countDocuments() !== item.count) throw new Error("Local source changed during backup. Restart the review after local writes stop.");
    }
  } finally { await destination.close(); }
  await source.close();
  for (const name of Object.keys(process.env)) if (/^(CRM_|MONGO|RINGCENTRAL_|NEXTIVA_|GOOGLE_|TOMTOM_|CLIENT_ORIGIN|CALL_PROVIDER)/i.test(name)) delete process.env[name];
  Object.assign(process.env, {
    NODE_ENV: "development", MONGODB_URI: reviewUri, DEFAULT_BUSINESS_ID: businesses[0].id,
    DEFAULT_BUSINESS_DATABASE: businesses[0].databaseName, CONTROL_DATABASE_NAME: "crm_control",
    BUSINESS_DATABASES: JSON.stringify(businesses), CRM_ADMIN_ONE_CODE: "90000001",
    CRM_ADMIN_SESSION_SECRET: crypto.randomBytes(48).toString("hex"), CRM_ATTENDANCE_INTEGRITY: "true",
    CRM_ATTENDANCE_ACTIVE_SESSION: "true", CRM_ATTENDANCE_HUB: "true", CRM_ATTENDANCE_RECOVERY_CUTOFF: "false",
    CRM_AUTO_CALL_DISABLED: "true", CLIENT_ORIGIN: "http://localhost:5173,http://127.0.0.1:5173",
    CRM_UPLOAD_ROOT: path.join(snapshot, "review-uploads"),
  });
  await mongoose.connect(reviewUri);
  if (process.argv.includes("--adopt-legacy")) {
    process.env.CRM_LOCAL_LEGACY_ADOPTION = "true";
    const { runLocalLegacyAttendanceRollout } = await import("./services/localLegacyAttendanceRollout");
    const result = await runLocalLegacyAttendanceRollout(snapshot, tools);
    process.stdout.write(`Local legacy adoption verified: ${JSON.stringify(result)}\n`);
    delete process.env.CRM_LOCAL_LEGACY_ADOPTION;
  }
  const { createApp } = await import("./app");
  const app = createApp();
  server = http.createServer((request, response) => {
    const origin = request.headers.origin;
    if (origin && !["http://localhost:5173", "http://127.0.0.1:5173"].includes(origin)) {
      response.writeHead(403); response.end("Local review origin only."); return;
    }
    const pathname = new URL(request.url || "/", "http://127.0.0.1").pathname;
    if (pathname === "/__local/review-info") {
      response.setHeader("Content-Type", "application/json"); response.setHeader("Cache-Control", "no-store");
      response.end(JSON.stringify({ isolatedCopy: true, businesses: businesses.length, snapshotAt, adminCode: "90000001" })); return;
    }
    if (isReviewBlockedPath(pathname, true)) {
      response.writeHead(403, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ message: "External integrations are disabled in this isolated local review." })); return;
    }
    app(request, response);
  });
  server.on("upgrade", (request, socket) => {
    const origin = request.headers.origin;
    if (origin && !["http://localhost:5173", "http://127.0.0.1:5173"].includes(origin)) socket.destroy();
  });
  const { createSocketServer } = await import("./socket");
  createSocketServer(server);
  const { startAttendanceIntegrityWorker } = await import("./services/attendanceRecoveryWorker");
  startAttendanceIntegrityWorker();
  server.listen(4101, "127.0.0.1", () => process.stdout.write(`Isolated attendance backend ready on http://127.0.0.1:4101. Local CRM review copy: ${businesses.length} businesses. Local-only admin 90000001.\n`));
  const stop = async () => { server?.close(); await mongoose.disconnect(); await mongo?.stop(); process.exit(0); };
  process.on("SIGINT", () => { void stop(); }); process.on("SIGTERM", () => { void stop(); });
} catch (error) {
  await source.close(); server?.close(); await mongoose.disconnect(); await mongo?.stop();
  throw error;
}
