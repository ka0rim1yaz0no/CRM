import { Schema } from "mongoose";
import { tenantModel } from "../config/tenancy";

export type AttendanceNoteValues = { reason: string; excused: boolean };
export type NoteRevision = AttendanceNoteValues & { by: string; at: Date; revision?: number; commandId?: string; contentHash?: string;
  before?: AttendanceNoteValues; after?: AttendanceNoteValues; attendanceRevision?: number; policyRevision?: number };
export type AttendanceDayNoteDocument = {
  employeeCode: string;
  dayKey: string;
  reason: string;
  excused: boolean;
  noteRevision?: number;
  revisions: NoteRevision[];
};

const noteSchema = new Schema<AttendanceDayNoteDocument>({
  employeeCode: { type: String, required: true, trim: true },
  dayKey: { type: String, required: true },
  reason: { type: String, trim: true, default: "" },
  excused: { type: Boolean, default: false },
  noteRevision: { type: Number, min: 0, default: undefined },
  revisions: { type: [{ reason: String, excused: Boolean, by: String, at: Date, revision: Number, commandId: String, contentHash: String,
    before: { reason: String, excused: Boolean }, after: { reason: String, excused: Boolean }, attendanceRevision: Number, policyRevision: Number }], default: [] },
}, { timestamps: true });
noteSchema.index({ employeeCode: 1, dayKey: 1 }, { unique: true });

export const AttendanceDayNote = tenantModel<AttendanceDayNoteDocument>("AttendanceDayNote", noteSchema);
