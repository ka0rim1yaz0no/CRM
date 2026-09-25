import { Schema, Types } from "mongoose";
import { tenantModel } from "../config/tenancy";

export type BrowserActivityClassification = "work" | "non-work" | "unknown";

export type BrowserActivityEventDocument = {
  employee: Types.ObjectId;
  employeeName: string;
  eventType:
    | "site_visit"
    | "tab_created"
    | "tab_updated"
    | "tab_activated"
    | "tab_closed"
    | "window_focus"
    | "idle_state"
    | "link_clicked"
    | "form_submitted"
    | "copy"
    | "paste"
    | "keyboard_activity"
    | "mouse_activity"
    | "scroll"
    | "screenshot_captured"
    | "manual_sync";
  url: string;
  normalizedUrl: string;
  title: string;
  domain: string;
  classification: BrowserActivityClassification;
  category: string;
  tabId: number | null;
  windowId: number | null;
  source: "extension";
  occurredAt: Date;
  metadata: Record<string, unknown>;
};

export type BrowserActivityScreenshotDocument = {
  employee: Types.ObjectId;
  employeeName: string;
  url: string;
  normalizedUrl: string;
  title: string;
  domain: string;
  classification: BrowserActivityClassification;
  category: string;
  fileUrl: string;
  mimeType: string;
  data?: Buffer;
  width: number;
  height: number;
  capturedAt: Date;
  metadata: Record<string, unknown>;
};

const classificationValues: BrowserActivityClassification[] = ["work", "non-work", "unknown"];

const browserActivityEventSchema = new Schema<BrowserActivityEventDocument>(
  {
    employee: { type: Schema.Types.ObjectId, ref: "Employee", required: true, index: true },
    employeeName: { type: String, required: true, trim: true },
    eventType: {
      type: String,
      required: true,
      enum: [
        "site_visit",
        "tab_created",
        "tab_updated",
        "tab_activated",
        "tab_closed",
        "window_focus",
        "idle_state",
        "link_clicked",
        "form_submitted",
        "copy",
        "paste",
        "keyboard_activity",
        "mouse_activity",
        "scroll",
        "screenshot_captured",
        "manual_sync",
      ],
      index: true,
    },
    url: { type: String, trim: true, default: "" },
    normalizedUrl: { type: String, trim: true, default: "" },
    title: { type: String, trim: true, default: "" },
    domain: { type: String, trim: true, lowercase: true, default: "", index: true },
    classification: { type: String, enum: classificationValues, default: "unknown", index: true },
    category: { type: String, trim: true, default: "Unknown", index: true },
    tabId: { type: Number, default: null },
    windowId: { type: Number, default: null },
    source: { type: String, enum: ["extension"], default: "extension" },
    occurredAt: { type: Date, required: true, default: Date.now, index: true },
    metadata: { type: Schema.Types.Mixed, default: {} },
  },
  { timestamps: true }
);

const browserActivityScreenshotSchema = new Schema<BrowserActivityScreenshotDocument>(
  {
    employee: { type: Schema.Types.ObjectId, ref: "Employee", required: true, index: true },
    employeeName: { type: String, required: true, trim: true },
    url: { type: String, trim: true, default: "" },
    normalizedUrl: { type: String, trim: true, default: "" },
    title: { type: String, trim: true, default: "" },
    domain: { type: String, trim: true, lowercase: true, default: "", index: true },
    classification: { type: String, enum: classificationValues, default: "unknown", index: true },
    category: { type: String, trim: true, default: "Unknown", index: true },
    fileUrl: { type: String, required: true, trim: true },
    mimeType: { type: String, trim: true, default: "image/jpeg" },
    data: { type: Buffer, select: false },
    width: { type: Number, min: 0, default: 0 },
    height: { type: Number, min: 0, default: 0 },
    capturedAt: { type: Date, required: true, default: Date.now, index: true },
    metadata: { type: Schema.Types.Mixed, default: {} },
  },
  { timestamps: true }
);

browserActivityEventSchema.index({ employee: 1, occurredAt: -1 });
browserActivityScreenshotSchema.index({ employee: 1, capturedAt: -1 });

export const BrowserActivityEvent = tenantModel<BrowserActivityEventDocument>("BrowserActivityEvent", browserActivityEventSchema);
export const BrowserActivityScreenshot = tenantModel<BrowserActivityScreenshotDocument>("BrowserActivityScreenshot", browserActivityScreenshotSchema);
