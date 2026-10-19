import { Schema } from "mongoose";
import { tenantModel } from "../config/tenancy";

type Target = { metric: "calls" | "talkMinutes" | "qualified"; period: "daily" | "monthly"; team: string; amount: number };
type Settings = { key: string; revision: number; targets: Target[]; newLeadHours: number; followUpHours: number; audit: Array<{ actor: string; at: Date; before: unknown; after: unknown }> };
const settingsSchema = new Schema<Settings>({ key: { type: String, unique: true, default: "workspace" }, revision: { type: Number, default: 1 },
  targets: [{ metric: String, period: String, team: String, amount: Number }], newLeadHours: { type: Number, default: 24 }, followUpHours: { type: Number, default: 0 },
  audit: [{ actor: String, at: Date, before: Schema.Types.Mixed, after: Schema.Types.Mixed }] }, { timestamps: true });
export const DashboardWorkspace = tenantModel<Settings>("DashboardWorkspace", settingsSchema);
type Note = { text: string; author: string; authorName: string; pinned: boolean; deletedAt: Date | null; edits: Array<{ text: string; at: Date; actor: string }> };
const noteSchema = new Schema<Note>({ text: { type: String, required: true, maxlength: 2000 }, author: { type: String, required: true }, authorName: String,
  pinned: { type: Boolean, default: false }, deletedAt: { type: Date, default: null }, edits: [{ text: String, at: Date, actor: String }] }, { timestamps: true });
noteSchema.index({ deletedAt: 1, pinned: -1, createdAt: -1 });
export const DashboardHandover = tenantModel<Note>("DashboardHandover", noteSchema);
