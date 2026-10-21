import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import mongoose, { type ClientSession } from "mongoose";
import { Attendance } from "../models/Attendance";
import { Employee } from "../models/Employee";
import { AttendanceLedger } from "../models/AttendanceLedger";
import { getBusinessById, runWithBusiness } from "../config/tenancy";
import { attendancePolicy, type AttendanceIdentity } from "./attendanceLedgerService";
import { prepareLegacyAttendanceAdoption, type LegacyAttendanceReplica } from "./legacyAttendanceAdoptionPlan";
import { payrollAccuracyEnabled } from "../config/rolloutFlags";
import { lockPayrollAttendance } from "./payrollAttendanceFence";

export type LocalAdoptionBackup = { id: string; target: "127.0.0.1:27119"; createdAt: string;
  fingerprints: Record<string, string>; databases: string[]; files: Array<{ path: string; sha256: string }> };

function requireLocalAdoption() {
  const fixture = process.env.NODE_ENV === "test" && mongoose.connection.name.startsWith("legacy_adoption_test_");
  const review = process.env.NODE_ENV === "development" && process.env.CRM_LOCAL_LEGACY_ADOPTION === "true" &&
    mongoose.connection.host === "127.0.0.1" && mongoose.connection.port === 27119;
  if (!review && !fixture) throw new Error("Legacy adoption is restricted to a backed-up isolated local review.");
}

export async function readLocalLegacyAdoptionPlan(identity: AttendanceIdentity, session?: ClientSession) {
  const replicas: LegacyAttendanceReplica[] = [];
  for (const businessId of identity.businessIds) await runWithBusiness(businessId, async () => {
    const employee = await Employee.findOne({ employeeCode: identity.code, status: { $ne: "Archived" } }).select("_id").session(session || null).lean();
    if (!employee) { replicas.push({ businessId, employeeId: null, records: [] }); return; }
    const records = await Attendance.collection.find({ employee: employee._id }, { session }).sort({ timeIn: 1, _id: 1 }).toArray();
    replicas.push({ businessId, employeeId: String(employee._id), records: records.map((record) => ({ id: String(record._id), source: String(record.source),
      at: new Date(record.timeIn).toISOString(), createdAt: new Date(record.createdAt || record.timeIn).toISOString(),
      eventId: record.eventId, archived: Boolean(record.isArchived), reversed: record.isEffective === false })) });
  });
  const policy = await attendancePolicy(identity.canonicalBusinessId);
  return { ...prepareLegacyAttendanceAdoption(identity.key, replicas, policy), replicas };
}

async function verifiedBackup(identity: AttendanceIdentity, manifestPath: string) {
  requireLocalAdoption();
  const root = path.dirname(path.resolve(manifestPath));
  const backup = JSON.parse(await fs.readFile(manifestPath, "utf8")) as LocalAdoptionBackup;
  if (backup.target !== "127.0.0.1:27119" || !backup.id || !Number.isFinite(Date.parse(backup.createdAt)) ||
      Date.now() - Date.parse(backup.createdAt) > 86_400_000 || Date.parse(backup.createdAt) > Date.now() || !backup.files?.length) throw new Error("A current local Mongo backup is required.");
  for (const business of identity.businessIds) if (!backup.databases.includes(getBusinessById(business)!.databaseName)) throw new Error("Backup does not cover every assigned business.");
  if (!backup.databases.includes(mongoose.connection.name) || !backup.databases.includes(process.env.CONTROL_DATABASE_NAME || "crm_control")) throw new Error("Backup must include canonical attendance and membership metadata.");
  const required = [mongoose.connection.name, process.env.CONTROL_DATABASE_NAME || "crm_control", ...identity.businessIds.map((id) => getBusinessById(id)!.databaseName)];
  if (required.some((database) => !backup.files.some((file) => file.path.split(/[\\/]/).includes(database)))) throw new Error("Backup artifacts do not cover every required database.");
  if (process.env.NODE_ENV !== "test" && !backup.files.some((file) => path.basename(file.path) === "oplog.bson")) throw new Error("Replica-set oplog backup required.");
  for (const file of backup.files) {
    const target = path.resolve(root, file.path); const relative = path.relative(root, target);
    if (relative.startsWith("..") || path.isAbsolute(relative) || !file.path.endsWith(".bson")) throw new Error("Invalid backup artifact path.");
    const digest = crypto.createHash("sha256").update(await fs.readFile(target)).digest("hex");
    if (digest !== file.sha256) throw new Error("Mongo backup integrity check failed.");
  }
  return backup;
}

export async function adoptLocalLegacyAttendance(identity: AttendanceIdentity, manifestPath: string) {
  const backup = await verifiedBackup(identity, manifestPath);
  return adoptReviewedLegacyAttendance(identity, backup, "local-reviewed-adoption");
}

// Operational callers must verify their own backup and isolated target before invoking this transaction.
export async function adoptReviewedLegacyAttendance(identity: AttendanceIdentity,
  backup: Pick<LocalAdoptionBackup, "id" | "createdAt" | "fingerprints">,
  actor: "local-reviewed-adoption" | "production-reviewed-adoption") {
  if (!["local-reviewed-adoption", "production-reviewed-adoption"].includes(actor) || !backup.id ||
      !Number.isFinite(Date.parse(backup.createdAt)) || Date.parse(backup.createdAt) > Date.now() ||
      Date.now() - Date.parse(backup.createdAt) > 86_400_000 || !/^[a-f0-9]{64}$/.test(backup.fingerprints?.[identity.key] || "")) {
    throw new Error("A current verified review fingerprint is required.");
  }
  const session = await mongoose.startSession();
  try {
    return await session.withTransaction(async () => {
      if (payrollAccuracyEnabled()) await lockPayrollAttendance(identity.businessIds.map(businessId => ({ businessId, employeeCode: identity.code })), session);
      const existing = await AttendanceLedger.findById(identity.key).session(session).lean();
      if (existing) return { status: "already-adopted" as const, historyReviewRequired: Boolean(existing.legacyAdoption?.historicalIssues) };
      const plan = await readLocalLegacyAdoptionPlan(identity, session);
      if (!backup.fingerprints[identity.key] || backup.fingerprints[identity.key] !== plan.fingerprint) throw new Error("Legacy data changed after review/backup. Nothing was adopted.");
      if (plan.events.length >= 10_000) throw new Error("Legacy history exceeds canonical attendance capacity.");
      if (!plan.ready) return { status: "blocked" as const, historyReviewRequired: true };
      if (identity.key.startsWith("access:")) {
        const access = mongoose.connection.getClient().db(process.env.CONTROL_DATABASE_NAME || "crm_control").collection("businessuseraccesses");
        const mapping = await access.findOne({ _id: new mongoose.Types.ObjectId(identity.key.slice(7)), employeeCode: identity.code }, { session });
        const assigned = (mapping?.businessIds || []).filter((id: string) => Boolean(getBusinessById(id)));
        if (JSON.stringify(assigned) !== JSON.stringify(identity.businessIds)) throw new Error("Business membership changed. Review adoption again.");
        await access.updateOne({ _id: mapping!._id }, { $inc: { legacyAdoptionFence: 1 } }, { session });
      }
      for (const replica of plan.replicas) await runWithBusiness(replica.businessId, async () => {
        const sourceRows = new Map(replica.records.map((record) => [record.id, record]));
        for (const event of plan.events) {
          const origin = event.replicaOrigins?.find((item) => item.businessId === replica.businessId);
          if (!origin) continue;
          const source = sourceRows.get(origin.recordId)!;
          const result = await Attendance.collection.updateOne({ _id: new mongoose.Types.ObjectId(origin.recordId), employee: new mongoose.Types.ObjectId(replica.employeeId!),
            source: source.source, timeIn: new Date(source.at), isArchived: { $ne: true }, isEffective: { $ne: false } },
          { $set: { eventId: event.id, ledgerIdentity: identity.key, ledgerRevision: 1, isEffective: true,
            ...(source.eventId ? { legacyOriginalEventId: source.eventId } : {}) } }, { session });
          if (result.matchedCount !== 1) throw new Error("Legacy evidence changed during adoption.");
        }
        for (const duplicate of plan.duplicates.filter((item) => item.businessId === replica.businessId)) {
          await Attendance.collection.updateOne({ _id: new mongoose.Types.ObjectId(duplicate.recordId), employee: new mongoose.Types.ObjectId(replica.employeeId!) },
            { $set: { isEffective: false, ledgerIdentity: identity.key, ledgerRevision: 1, legacyDuplicateOf: duplicate.primaryRecordId } }, { session });
        }
      });
      const commandId = crypto.randomUUID(); const at = new Date().toISOString();
      await AttendanceLedger.create([{ _id: identity.key, employeeCode: identity.code, businessIds: identity.businessIds,
        canonicalBusinessId: identity.canonicalBusinessId, revision: 1, fence: 0, events: plan.events, corrections: [], closures: [], commands: [],
        audit: [{ commandId, actor: { role: "admin", code: actor }, operation: "legacy-adopt",
          reason: `Reviewed legacy adoption (${actor}); backup ${backup.id}. Original punches retained; no inferred checkout.`, at,
          beforeRevision: 0, afterRevision: 1, targetIds: plan.events.map((event) => event.id), beforeState: "legacy-review", afterState: "adopted" }],
        legacyAdoption: { backupId: backup.id, fingerprint: plan.fingerprint, sourceCount: plan.sourceCount, duplicateCount: plan.duplicates.length,
          businessStreamsDiffer: plan.businessStreamsDiffer, historicalIssues: plan.timelineIssues.length, adoptedAt: at },
        jobs: identity.businessIds.map((businessId) => ({ businessId, revision: 1, done: false })) }], { session });
      return { status: "adopted" as const, historyReviewRequired: plan.timelineIssues.length > 0 || plan.businessStreamsDiffer };
    });
  } finally { await session.endSession(); }
}
