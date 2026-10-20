import type { Request, Response } from "express";
import { mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { Employee } from "../models/Employee";
import { MediaAsset, type MediaAssetType } from "../models/MediaAsset";
import { configuredUploadRoot, uploadRoot } from "../config/uploadPaths";
import { securityUploadsEnabled } from "../config/rolloutFlags";

const mediaUploadRoot = path.join(uploadRoot, "media");
const maxStoredMediaBytes = 12 * 1024 * 1024;
const maxMediaBytes = 50 * 1024 * 1024;

function toText(value: unknown, fallback = "") {
  const text = String(value || "").trim();
  return text || fallback;
}

function toAssetType(value: unknown, mimeType = ""): MediaAssetType {
  const type = toText(value);

  if (type === "Image" || type === "Video") {
    return type;
  }

  return mimeType.startsWith("video/") ? "Video" : "Image";
}

function toSize(value: unknown) {
  const size = Number(value);
  return Number.isFinite(size) && size > 0 ? Math.round(size) : 0;
}

function mediaFileUrl(fileName: string) {
  return `/api/media/file/${fileName}`;
}

function isSafeMediaFileName(value: string) {
  return /^[a-z0-9_.-]+$/i.test(value) && !value.includes("..");
}

function mediaUploadCandidates() {
  if (configuredUploadRoot) return [mediaUploadRoot];
  return Array.from(
    new Set([
      mediaUploadRoot,
      path.resolve(process.cwd(), "backend", "uploads", "media"),
      path.resolve(process.cwd(), "..", "uploads", "media"),
    ])
  ).filter((candidate) => path.basename(candidate) === "media");
}

export async function listMediaAssets(_request: Request, response: Response) {
  const assets = await MediaAsset.find({ isArchived: false }).sort({ createdAt: -1 }).lean();
  response.json(
    assets.map((asset) => {
      const mimeType = toText(asset.mimeType, "application/octet-stream");

      return {
        ...asset,
        name: toText(asset.name, "Media asset"),
        url: toText(asset.url),
        mimeType,
        assetType: toAssetType(asset.assetType, mimeType),
        role: toText(asset.role, "All roles"),
        size: toSize(asset.size),
        isArchived: Boolean(asset.isArchived),
      };
    })
  );
}

export async function uploadMediaAsset(request: Request, response: Response) {
  const dataUrl = String(request.body.dataUrl || "");
  const originalName = String(request.body.fileName || "media").replace(/[^a-zA-Z0-9._-]/g, "-");
  const role = toText(request.body.role);
  const match = dataUrl.match(/^data:(image\/(?:png|jpe?g|webp|gif)|video\/(?:mp4|webm|ogg|quicktime));base64,([a-zA-Z0-9+/=]+)$/);

  if (!role) {
    response.status(400).json({ message: "role is required" });
    return;
  }

  if (role !== "All roles") {
    const roleExists = await Employee.exists({ role, status: { $ne: "Archived" } });
    if (!roleExists) {
      response.status(400).json({ message: "Select a role used by an active employee in this business." });
      return;
    }
  }

  if (!match) {
    response.status(400).json({ message: "Valid image or video dataUrl is required" });
    return;
  }

  const mimeType = match[1];
  const base64 = match[2];
  const assetType = mimeType.startsWith("image/") ? "Image" : "Video";
  const extensionByMime: Record<string, string> = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/jpg": "jpg",
    "image/webp": "webp",
    "image/gif": "gif",
    "video/mp4": "mp4",
    "video/webm": "webm",
    "video/ogg": "ogg",
    "video/quicktime": "mov",
  };
  const uploadDir = mediaUploadRoot;
  const fileName = `${Date.now()}-${Math.random().toString(16).slice(2)}-${originalName}.${extensionByMime[mimeType] || "bin"}`;
  const bytes = Buffer.from(base64, "base64");
  if (!bytes.length || bytes.toString("base64").replace(/=+$/, "") !== base64.replace(/=+$/, "")) {
    response.status(400).json({ message: "Media data is invalid or empty." });
    return;
  }
  if (bytes.length > maxMediaBytes) {
    response.status(413).json({ message: "Media files must be 50 MB or smaller." });
    return;
  }

  await mkdir(uploadDir, { recursive: true });
  await writeFile(path.join(uploadDir, fileName), bytes);

  const asset = await MediaAsset.create({
    name: originalName,
    url: mediaFileUrl(fileName),
    mimeType,
    assetType,
    role,
    size: bytes.length,
    ...(bytes.length <= maxStoredMediaBytes ? { data: bytes } : {}),
  });

  const assetResponse = asset.toObject() as Record<string, unknown>;
  delete assetResponse.data;

  response.status(201).json(assetResponse);
}

export async function serveMediaAssetFile(request: Request, response: Response) {
  const fileName = toText(request.params.fileName).slice(0, 260);

  if (!isSafeMediaFileName(fileName)) {
    response.status(400).json({ message: "Invalid media file path" });
    return;
  }

  const apiUrl = mediaFileUrl(fileName);
  const legacyUrl = `/uploads/media/${fileName}`;
  const asset = await MediaAsset.findOne({ url: { $in: [apiUrl, legacyUrl] }, isArchived: false }).select("_id mimeType").lean();
  if (!asset) {
    response.status(404).json({ message: "Media file not found in this business" });
    return;
  }

  for (const uploadDirectory of mediaUploadCandidates()) {
    const root = path.resolve(uploadDirectory);
    const filePath = path.resolve(root, fileName);

    if (!filePath.startsWith(`${root}${path.sep}`)) {
      continue;
    }

    try {
      const fileStat = await stat(filePath);
      if (!fileStat.isFile()) {
        continue;
      }

      response.sendFile(filePath);
      return;
    } catch {
      // Try the next deployment layout.
    }
  }

  const stored = await MediaAsset.findById(asset._id).select("+data");

  if (stored?.data && Buffer.isBuffer(stored.data)) {
    response.type(stored.mimeType || "application/octet-stream");
    response.setHeader("Cache-Control", securityUploadsEnabled() ? "private, no-store" : "private, max-age=3600");
    response.send(stored.data);
    return;
  }

  response.status(404).json({ message: "Media file not found" });
}

export async function archiveMediaAsset(request: Request, response: Response) {
  const asset = await MediaAsset.findByIdAndUpdate(
    request.params.id,
    { isArchived: true },
    { returnDocument: "after", runValidators: true }
  );

  if (!asset) {
    response.status(404).json({ message: "Media asset not found" });
    return;
  }

  response.json(asset);
}
