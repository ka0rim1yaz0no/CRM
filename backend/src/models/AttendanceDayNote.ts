import { Schema } from "mongoose";
import { tenantModel } from "../config/tenancy";

type NoteRevision = { reason: string; excused: boolean; by: string; at: Date };
export type AttendanceDayNoteDocument = {
  employeeCode: string;
  dayKey: string;
  reason: string;
  excused: boolean;
  revisions: NoteRevision[];
};

const noteSchema = new Schema<AttendanceDayNoteDocument>({
  employeeCode: { type: String, required: true, trim: true },
  dayKey: { type: String, required: true },
  reason: { type: String, trim: true, default: "" },
  excused: { type: Boolean, default: false },
  revisions: { type: [{ reason: String, excused: Boolean, by: String, at: Date }], default: [] },
}, { timestamps: true });
noteSchema.index({ employeeCode: 1, dayKey: 1 }, { unique: true });

export const AttendanceDayNote = tenantModel<AttendanceDayNoteDocument>("AttendanceDayNote", noteSchema);
