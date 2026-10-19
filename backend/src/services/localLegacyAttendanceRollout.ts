import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import mongoose from "mongoose";
import { getConfiguredBusinesses, runWithBusiness } from "../config/tenancy";
import { Employee } from "../models/Employee";
import { Attendance } from "../models/Attendance";
import { AttendanceLedger } from "../models/AttendanceLedger";
import { attendanceSnapshot, readAttendanceLedger, resolveAttendanceIdentity, type AttendanceIdentity } from "./attendanceLedgerService";
import { adoptLocalLegacyAttendance, readLocalLegacyAdoptionPlan, type LocalAdoptionBackup } from "./localLegacyAttendanceAdoption";
import { deliverAttendanceLedger } from "./attendanceLedgerOutbox";

export async function runLocalLegacyAttendanceRollout(backupParent: string, mongoTools: string) {
  if (mongoose.connection.host !== "127.0.0.1" || mongoose.connection.port !== 27119 || process.env.CRM_LOCAL_LEGACY_ADOPTION !== "true") throw new Error("Isolated local review required.");
  const businesses = getConfiguredBusinesses(); const identities = new Map<string, AttendanceIdentity>();
  for (const business of businesses) await runWithBusiness(business.id, async () => {
    const employees = await Employee.find({ status: { $ne: "Archived" } }).select("_id employeeCode").lean();
    for (const employee of employees) {
      const identity = await resolveAttendanceIdentity(String(employee._id), { role: "admin", code: "local-reviewed-adoption" });
      identities.set(identity.key, identity);
    }
  });
  const plans = new Map(await Promise.all([...identities.values()].map(async (identity) => [identity.key, await readLocalLegacyAdoptionPlan(identity)] as const)));
  const root = path.join(backupParent, "legacy-before-adoption"); const dump = path.join(root, "dump");
  await fs.mkdir(dump, { recursive: true });
  const child = spawn(path.join(mongoTools, "mongodump.exe"), ["--uri=mongodb://127.0.0.1:27119/?directConnection=true", "--oplog", `--out=${dump}`, "--quiet"], { windowsHide: true, stdio: "ignore" });
  const exitCode = await new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); });
  if (exitCode !== 0) throw new Error("Local Mongo backup failed. No legacy adoption was attempted.");
  const files: LocalAdoptionBackup["files"] = [];
  const scan = async (directory: string) => {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) await scan(file);
      else if (entry.isFile() && entry.name.endsWith(".bson")) files.push({ path: path.relative(root, file), sha256: crypto.createHash("sha256").update(await fs.readFile(file)).digest("hex") });
    }
  };
  await scan(dump);
  if (!files.length || !files.some((file) => path.basename(file.path) === "oplog.bson")) throw new Error("A complete local replica-set dump is required.");
  const backup: LocalAdoptionBackup = { id: crypto.randomUUID(), target: "127.0.0.1:27119", createdAt: new Date().toISOString(),
    databases: [...new Set([mongoose.connection.name, process.env.CONTROL_DATABASE_NAME || "crm_control", ...businesses.map((business) => business.databaseName)])],
    fingerprints: Object.fromEntries([...plans].map(([key, plan]) => [key, plan.fingerprint])), files };
  const manifestPath = path.join(root, "manifest.json");
  await fs.writeFile(manifestPath, JSON.stringify(backup, null, 2));
  const report = { businesses: businesses.length, identities: identities.size, adopted: 0, alreadyAdopted: 0, blocked: 0,
    historicalReview: 0, originalsPreserved: true, verifiedBusinessReplicas: 0, syncPending: 0, manualControlsVerified: 0 };
  for (const identity of identities.values()) {
    const result = await adoptLocalLegacyAttendance(identity, manifestPath);
    if (result.status === "blocked") { report.blocked++; continue; }
    if (result.status === "adopted") report.adopted++; else report.alreadyAdopted++;
    await deliverAttendanceLedger(identity.key);
    const ledger = await readAttendanceLedger(identity); const snapshot = attendanceSnapshot(ledger);
    if (snapshot.reviewState === "verified") report.manualControlsVerified++;
    if (snapshot.historyReviewRequired) report.historicalReview++;
    if (snapshot.syncPending) report.syncPending++;
    for (const replica of plans.get(identity.key)!.replicas) await runWithBusiness(replica.businessId, async () => {
      const originalIds = replica.records.map((record) => new mongoose.Types.ObjectId(record.id));
      const originals = await Attendance.collection.find({ _id: { $in: originalIds } }, { projection: { source: 1, timeIn: 1 } }).toArray();
      const originalMap = new Map(originals.map((record) => [String(record._id), record]));
      if (originals.length !== originalIds.length || replica.records.some((record) => {
        const actual = originalMap.get(record.id); return actual?.source !== record.source || new Date(actual.timeIn).toISOString() !== record.at;
      })) throw new Error("Original-punch preservation check failed; use the local backup for review.");
      const employee = await Employee.findById(replica.employeeId).select("availabilityStatus").lean();
      const delivered = await Attendance.find({ ledgerIdentity: identity.key }).select("eventId").lean();
      const ids = delivered.map((record) => record.eventId).sort();
      const expected = snapshot.records.map((event) => event.id).sort();
      if (JSON.stringify(ids) !== JSON.stringify(expected) || employee?.availabilityStatus !== snapshot.state) throw new Error("Business projection verification failed; adoption remains auditable and delivery retryable.");
      report.verifiedBusinessReplicas++;
    });
  }
  if (await AttendanceLedger.countDocuments({ "jobs.done": false })) report.syncPending = Math.max(report.syncPending, 1);
  await fs.writeFile(path.join(root, "result.json"), JSON.stringify({ ...report, backupId: backup.id, verifiedAt: new Date().toISOString() }, null, 2));
  return report;
}
