import crypto from "node:crypto";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import mongoose from "mongoose";
import { isReviewBlockedPath, localReviewBusinesses } from "./localReviewConfig";

if (!process.argv.includes("--existing-local-review")) throw new Error("Explicit existing local review mode is required.");
const owner = await fetch("http://127.0.0.1:4101/__local/review-info").then((response) => response.json());
if (owner.isolatedCopy !== true) throw new Error("The original isolated review owner must remain running.");

// Reuse only the disposable copy. Restarting this app never restores or resets its data.
await mongoose.connect("mongodb://127.0.0.1:27119/crm", { autoIndex: false, autoCreate: false });
if (mongoose.connection.host !== "127.0.0.1" || mongoose.connection.port !== 27119) throw new Error("Unexpected review database.");
const client = mongoose.connection.getClient();
const profiles = await client.db("crm_control").collection<{ businessId: string; name: string; databaseName?: string }>("businessprofiles")
  .find({}, { projection: { _id: 0, businessId: 1, name: 1, databaseName: 1 } }).toArray();
const databases = (await client.db("admin").admin().listDatabases({ nameOnly: true })).databases.map((item) => item.name);
const businesses = localReviewBusinesses(profiles, databases);
if (!businesses.length || businesses.length !== owner.businesses) throw new Error("Review business mappings could not be verified.");
for (const name of Object.keys(process.env)) if (/^(CRM_|MONGO|RINGCENTRAL_|NEXTIVA_|GOOGLE_|TOMTOM_|CLIENT_ORIGIN|CALL_PROVIDER)/i.test(name)) delete process.env[name];
Object.assign(process.env, {
  NODE_ENV: "development", DEFAULT_BUSINESS_ID: businesses[0].id,
  DEFAULT_BUSINESS_DATABASE: businesses[0].databaseName, CONTROL_DATABASE_NAME: "crm_control",
  BUSINESS_DATABASES: JSON.stringify(businesses), CRM_ADMIN_ONE_CODE: "90000001",
  CRM_ADMIN_SESSION_SECRET: crypto.randomBytes(48).toString("hex"), CRM_ATTENDANCE_INTEGRITY: "true",
  CRM_ATTENDANCE_ACTIVE_SESSION: "true", CRM_ATTENDANCE_HUB: "true", CRM_ATTENDANCE_RECOVERY_CUTOFF: "false",
  CRM_AUTO_CALL_DISABLED: "true", CLIENT_ORIGIN: "http://localhost:5173,http://127.0.0.1:5173",
  CRM_UPLOAD_ROOT: await mkdtemp(path.join(os.tmpdir(), "assistly-review-reuse-uploads-")),
});
const { createApp } = await import("./app");
const app = createApp();
const allowedOrigins = new Set(["http://localhost:5173", "http://127.0.0.1:5173"]);
const server = http.createServer((request, response) => {
  if (request.headers.origin && !allowedOrigins.has(request.headers.origin)) {
    response.writeHead(403); response.end("Local review origin only."); return;
  }
  const pathname = new URL(request.url || "/", "http://127.0.0.1").pathname;
  if (pathname === "/__local/review-info") {
    response.setHeader("Content-Type", "application/json"); response.setHeader("Cache-Control", "no-store");
    response.end(JSON.stringify({ isolatedCopy: true, businesses: businesses.length, snapshotAt: owner.snapshotAt,
      adminCode: "90000001", existingReview: true, attendanceToday: "server-shift-day" })); return;
  }
  if (isReviewBlockedPath(pathname, true)) {
    response.writeHead(403, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ message: "External integrations are disabled in this isolated local review." })); return;
  }
  app(request, response);
});
server.on("upgrade", (request, socket) => {
  if (request.headers.origin && !allowedOrigins.has(request.headers.origin)) socket.destroy();
});
const { createSocketServer } = await import("./socket");
createSocketServer(server);
// The owner keeps Mongo and its durable retry worker alive; do not start a second worker.
server.listen(4103, "127.0.0.1", () => process.stdout.write("Updated app reusing the isolated review copy on 127.0.0.1:4103.\n"));
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => {
  server.close(); void mongoose.disconnect().finally(() => process.exit(0));
});
