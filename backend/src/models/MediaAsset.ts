import { Schema } from "mongoose";
import { tenantModel } from "../config/tenancy";

export type MediaAssetType = "Image" | "Video";

export type MediaAssetDocument = {
  name: string;
  url: string;
  mimeType: string;
  assetType: MediaAssetType;
  role: string;
  branch?: string;
  size: number;
  data?: Buffer;
  isArchived: boolean;
};

const mediaAssetSchema = new Schema<MediaAssetDocument>(
  {
    name: { type: String, required: true, trim: true },
    url: { type: String, required: true, trim: true },
    mimeType: { type: String, required: true, trim: true },
    assetType: { type: String, enum: ["Image", "Video"], required: true },
    role: { type: String, trim: true, default: "All roles" },
    branch: { type: String, trim: true, default: "" },
    size: { type: Number, default: 0 },
    data: { type: Buffer, select: false },
    isArchived: { type: Boolean, default: false },
  },
  { timestamps: true }
);

export const MediaAsset = tenantModel<MediaAssetDocument>("MediaAsset", mediaAssetSchema);
