import mongoose, { Schema } from "mongoose";
import type { SessionCorrection, SessionEvent, SystemClosure } from "../services/attendanceSessionState";
import type { AttendanceDerivedDay } from "../services/attendanceDerived";
import type { AttendanceDerivedBaseline, AttendanceDerivedMetadata } from "../services/attendanceDerivedAudit";

export type AttendanceActor = { code: string; role: "admin" | "employee" | "system" };
export type AttendanceAudit = { commandId: string; actor: AttendanceActor; reason: string; operation: string; at: string;
  beforeRevision: number; afterRevision: number; targetIds: string[]; beforeState: string; afterState: string;
  beforeDerived?: AttendanceDerivedDay[]; afterDerived?: AttendanceDerivedDay[];
  noteReference?: { businessId: string; dayKey: string; noteRevision: number; contentHash: string };
  derivedAuditVersion?: 1; removedDerivedDays?: string[]; derivedMetadata?: AttendanceDerivedMetadata[] };
export type AttendanceLedgerDocument = {
  _id: string; employeeCode: string; businessIds: string[]; canonicalBusinessId: string; revision: number; fence: number;
  lockToken?: string; lockUntil?: Date; events: SessionEvent[]; corrections: SessionCorrection[]; closures: SystemClosure[];
  audit: AttendanceAudit[]; commands: Array<{ id: string; actor: string; hash: string; revision: number; result: Record<string, unknown> }>;
  jobs: Array<{ revision: number; businessId: string; done: boolean; createdAt?: string; lastErrorCode?: string; lastErrorAt?: string }>; migrationRequired?: boolean;
  derived?: AttendanceDerivedDay[];
  maintenance?: { active: boolean; derivedRefreshAt?: Date };
  derivedBaseline?: AttendanceDerivedBaseline;
  legacyAdoption?: { backupId: string; fingerprint: string; sourceCount: number; duplicateCount: number;
    businessStreamsDiffer: boolean; historicalIssues: number; adoptedAt: string };
};
const schema = new Schema({
  _id: String, employeeCode: { type: String, required: true }, businessIds: [String], canonicalBusinessId: String,
  revision: { type: Number, default: 0 }, fence: { type: Number, default: 0 }, lockToken: String, lockUntil: Date,
  events: { type: [Schema.Types.Mixed], default: [] }, corrections: { type: [Schema.Types.Mixed], default: [] },
  closures: { type: [Schema.Types.Mixed], default: [] }, audit: { type: [Schema.Types.Mixed], default: [] },
  commands: { type: [Schema.Types.Mixed], default: [] }, jobs: { type: [Schema.Types.Mixed], default: [] },
  derived: { type: [Schema.Types.Mixed], default: undefined },
  maintenance: { type: Schema.Types.Mixed, default: undefined },
  derivedBaseline: { type: Schema.Types.Mixed, default: undefined },
  legacyAdoption: { type: Schema.Types.Mixed, default: undefined },
}, { timestamps: true, minimize: false });
schema.index({ employeeCode: 1, businessIds: 1 });
schema.index({ "maintenance.active": 1, _id: 1 });
schema.index({ "maintenance.derivedRefreshAt": 1, _id: 1 });
schema.index({ "jobs.done": 1, _id: 1 });
schema.index({ "derived.policyRevision": 1, _id: 1 });
export const AttendanceLedger = mongoose.models.AttendanceLedger as mongoose.Model<AttendanceLedgerDocument> ||
  mongoose.model<AttendanceLedgerDocument>("AttendanceLedger", schema);

export type AttendancePolicyDocument = { _id: string; graceMinutes: number; breakMinutes: number; lunchMinutes: number;
  shiftStart: string; shiftEnd: string; recoveryEnabled: boolean; recoveryTime: string; autoTimeOutTime?: string; revision: number;
  audit: Array<{ actor: string; at: string; before: Record<string, unknown>; after: Record<string, unknown> }> };
const policySchema = new Schema({ _id: String, graceMinutes: { type: Number, default: 0 },
  breakMinutes: { type: Number, default: 15 }, lunchMinutes: { type: Number, default: 60 },
  shiftStart: { type: String, default: "23:00" }, shiftEnd: { type: String, default: "08:00" },
  recoveryEnabled: { type: Boolean, default: false }, recoveryTime: { type: String, default: "22:59" },
  autoTimeOutTime: { type: String, default: "08:05", match: /^([01]\d|2[0-3]):[0-5]\d$/ },
  revision: { type: Number, default: 0 }, audit: { type: [Schema.Types.Mixed], default: [] } }, { timestamps: true });
export const AttendancePolicy = mongoose.models.AttendancePolicy as mongoose.Model<AttendancePolicyDocument> ||
  mongoose.model<AttendancePolicyDocument>("AttendancePolicy", policySchema);
