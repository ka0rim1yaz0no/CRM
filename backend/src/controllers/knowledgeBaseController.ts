import type { Request, Response } from "express";
import { mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { KnowledgeBaseEntry, type KnowledgeBaseEntryType } from "../models/KnowledgeBaseEntry";
import { KnowledgeBaseSuggestion } from "../models/KnowledgeBaseSuggestion";
import { Employee } from "../models/Employee";
import { Notice } from "../models/Notice";
import { configuredUploadRoot, uploadRoot } from "../config/uploadPaths";
import { securityUploadsEnabled } from "../config/rolloutFlags";
import { knowledgeBaseUploads } from "../models/KnowledgeBaseUpload";
import { randomUUID } from "node:crypto";

const controllerDirectory = path.dirname(fileURLToPath(import.meta.url));
const backendRootDirectory = path.resolve(controllerDirectory, "..", "..");
const knowledgeBaseUploadRoot = configuredUploadRoot ? path.join(uploadRoot, "knowledge-base") : path.resolve(process.cwd(), "public", "uploads", "knowledge-base");

type AnnouncementNoticeEntry = {
  _id: { toString(): string };
  entryType: KnowledgeBaseEntryType;
  status: string;
  title: string;
  description: string;
};

function knowledgeBasePhotoUrl(fileName: string) {
  return securityUploadsEnabled() ? `/api/knowledge-base/photos/file/${fileName}` : `/uploads/knowledge-base/${fileName}`;
}

function knowledgeBaseDocumentUrl(fileName: string) {
  return `/api/knowledge-base/documents/file/${fileName}`;
}

function isSafeKnowledgeBaseFileName(value: string) {
  return /^[a-z0-9_.-]+$/i.test(value) && !value.includes("..");
}

function knowledgeBaseUploadCandidates(subdirectory = "") {
  if (configuredUploadRoot) return [path.resolve(knowledgeBaseUploadRoot, subdirectory)];
  const segments = subdirectory ? ["knowledge-base", subdirectory] : ["knowledge-base"];

  return Array.from(
    new Set([
      path.resolve(backendRootDirectory, "public", "uploads", ...segments),
      path.resolve(process.cwd(), "uploads", ...segments),
      path.resolve(process.cwd(), "public", "uploads", ...segments),
      path.resolve(process.cwd(), "backend", "uploads", ...segments),
      path.resolve(process.cwd(), "backend", "public", "uploads", ...segments),
      path.resolve(process.cwd(), "..", "uploads", ...segments),
    ])
  );
}

async function serveKnowledgeBaseFile(request: Request, response: Response, subdirectory = "") {
  const fileName = String(request.params.fileName || "").trim().slice(0, 260);

  if (!isSafeKnowledgeBaseFileName(fileName)) {
    response.status(400).json({ message: "Invalid knowledge base file path" });
    return;
  }

  if (securityUploadsEnabled()) {
    const owner = await knowledgeBaseUploads().findOne({ fileName, directory: subdirectory || "photos" }).lean();
    const escapedName = fileName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const location = subdirectory ? "(?:api/knowledge-base/documents/file|uploads/knowledge-base/documents)" : "(?:api/knowledge-base/photos/file|uploads/knowledge-base)";
    const reference = new RegExp(`/${location}/${escapedName}(?=[?\\s"'<>#]|$)`);
    const legacyReference = !owner && await KnowledgeBaseEntry.exists({ $or: [
      { photoUrls: reference }, { "documents.url": reference }, { description: reference }, { answer: reference },
    ] });
    if (owner ? owner.businessId !== request.business?.id : !legacyReference) {
      response.status(404).json({ message: "Knowledge base file not found" });
      return;
    }
  }

  for (const uploadDirectory of knowledgeBaseUploadCandidates(subdirectory)) {
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

      response.setHeader("Cache-Control", securityUploadsEnabled() ? "private, no-store" : "private, max-age=3600");
      if (securityUploadsEnabled() && subdirectory === "documents") {
        response.attachment(fileName);
        response.setHeader("Content-Type", "application/octet-stream");
      }
      response.sendFile(filePath);
      return;
    } catch {
      // Try the next deployment layout.
    }
  }

  response.status(404).json({ message: "Knowledge base file not found" });
}

function normalizePhotoUrls(value: unknown) {
  if (Array.isArray(value)) {
    return value.map((url) => String(url).trim()).filter(Boolean);
  }

  return String(value || "")
    .split("\n")
    .map((url) => url.trim())
    .filter(Boolean);
}

function normalizeDocuments(value: unknown) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((document) => ({
      name: String(document?.name || "").trim(),
      url: String(document?.url || "").trim(),
      mimeType: String(document?.mimeType || "application/octet-stream").trim(),
    }))
    .filter((document) => document.name && document.url);
}

function getEntryInput(request: Request) {
  const entryType: KnowledgeBaseEntryType = request.body.entryType === "FAQ" ? "FAQ" : request.body.entryType === "Article" ? "Article" : "Product";

  return {
    entryType,
    title: request.body.title || "",
    category: request.body.category || "",
    description: request.body.description || "",
    scope: request.body.scope || "",
    photoUrls: normalizePhotoUrls(request.body.photoUrls),
    documents: normalizeDocuments(request.body.documents),
    question: request.body.question || "",
    answer: request.body.answer || "",
    comments: Array.isArray(request.body.comments) ? request.body.comments : [],
    status: request.body.status || "Active",
  };
}

function getSuggestionInput(request: Request) {
  const entryType: KnowledgeBaseEntryType = request.body.entryType === "FAQ" ? "FAQ" : request.body.entryType === "Article" ? "Article" : "Product";

  return {
    entry: request.body.entry,
    entryType,
    comment: request.body.comment || "",
    title: request.body.title || "",
    category: request.body.category || "",
    description: request.body.description || "",
    scope: request.body.scope || "",
    question: request.body.question || "",
    answer: request.body.answer || "",
    submittedById: request.body.submittedById || "",
    submittedByName: request.body.submittedByName || "Employee",
    status: "Pending" as const,
  };
}

function normalizeMultilineText(value: unknown) {
  return String(value || "")
    .replace(/\\r\\n/g, "\n")
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "\n")
    .trim();
}

const allowedKnowledgeBaseImageTypes = new Map([
  ["image/png", "png"],
  ["image/jpeg", "jpg"],
  ["image/jpg", "jpg"],
  ["image/webp", "webp"],
  ["image/gif", "gif"],
  ["image/avif", "avif"],
  ["image/bmp", "bmp"],
]);

function getUploadHeader(request: Request, headerName: string) {
  const header = request.headers[headerName.toLowerCase()];
  return Array.isArray(header) ? header[0] : header || "";
}

function normalizeUploadFileName(value: unknown, fallback = "image") {
  let decodedName = String(value || fallback);

  try {
    decodedName = decodeURIComponent(decodedName);
  } catch {
    // Keep the raw header value if it is not URI encoded.
  }

  return decodedName.replace(/[^a-zA-Z0-9._-]/g, "-") || fallback;
}

function getImageUploadPayload(request: Request) {
  if (Buffer.isBuffer(request.body) && request.body.length > 0) {
    const mimeType = String(getUploadHeader(request, "content-type") || "")
      .split(";")[0]
      .trim()
      .toLowerCase();

    return {
      bytes: request.body,
      mimeType,
      originalName: normalizeUploadFileName(getUploadHeader(request, "x-file-name")),
    };
  }

  const dataUrl = String(request.body?.dataUrl || "");
  const match = dataUrl.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,([a-zA-Z0-9+/=\s]+)$/);

  if (!match) {
    return null;
  }

  return {
    bytes: Buffer.from(match[2].replace(/\s/g, ""), "base64"),
    mimeType: match[1].toLowerCase(),
    originalName: normalizeUploadFileName(request.body?.fileName),
  };
}

async function createAnnouncementNotices(entry: AnnouncementNoticeEntry) {
  if (entry.entryType !== "Article" || entry.status !== "Active") {
    return;
  }

  const employees = await Employee.find({ status: { $ne: "Archived" } }).select("_id").lean();

  if (!employees.length) {
    return;
  }

  const sourceId = entry._id.toString();
  const title = String(entry.title || "New announcement").trim();
  const message = normalizeMultilineText(entry.description).slice(0, 1500) || "A new announcement is available.";
  const href = `/announcements/${sourceId}`;

  await Notice.bulkWrite(
    employees.map((employee) => ({
      updateOne: {
        filter: {
          employee: employee._id,
          source: "KnowledgeBaseAnnouncement",
          sourceId,
        },
        update: {
          $setOnInsert: {
            employee: employee._id,
            title,
            message,
            severity: "Info",
            issuedBy: "Admin",
            isRead: false,
            href,
            source: "KnowledgeBaseAnnouncement",
            sourceId,
          },
        },
        upsert: true,
      },
    }))
  );
}

export async function listKnowledgeBaseEntries(request: Request, response: Response) {
  const entryType = String(request.query.entryType || "").trim();
  const filter: Record<string, unknown> = { status: { $ne: "Archived" } };

  if (entryType === "Product" || entryType === "FAQ" || entryType === "Article") {
    filter.entryType = entryType;
  }

  const entries = await KnowledgeBaseEntry.find(filter).sort({ updatedAt: -1 });
  response.json(entries);
}

export async function createKnowledgeBaseEntry(request: Request, response: Response) {
  const input = getEntryInput(request);

  if (input.entryType === "FAQ" && !input.question.trim()) {
    response.status(400).json({ message: "question is required" });
    return;
  }

  if (input.entryType === "Product" && !input.title.trim()) {
    response.status(400).json({ message: "title is required" });
    return;
  }

  if (input.entryType === "Article" && (!input.title.trim() || !input.description.trim())) {
    response.status(400).json({ message: "title and description are required" });
    return;
  }

  const entry = await KnowledgeBaseEntry.create(input);
  await createAnnouncementNotices(entry);
  response.status(201).json(entry);
}

export async function updateKnowledgeBaseEntry(request: Request, response: Response) {
  const entry = await KnowledgeBaseEntry.findByIdAndUpdate(request.params.id, getEntryInput(request), {
    returnDocument: "after",
    runValidators: true,
  });

  if (!entry) {
    response.status(404).json({ message: "Knowledge base entry not found" });
    return;
  }

  if (entry.entryType === "Article" && entry.status === "Active") {
    await createAnnouncementNotices(entry);
  }

  response.json(entry);
}

export async function archiveKnowledgeBaseEntry(request: Request, response: Response) {
  const entry = await KnowledgeBaseEntry.findByIdAndUpdate(
    request.params.id,
    { status: "Archived" },
    { returnDocument: "after", runValidators: true }
  );

  if (!entry) {
    response.status(404).json({ message: "Knowledge base entry not found" });
    return;
  }

  response.json(entry);
}

export async function uploadKnowledgeBasePhoto(request: Request, response: Response) {
  const payload = getImageUploadPayload(request);

  if (!payload) {
    response.status(400).json({ message: "Valid image file is required" });
    return;
  }

  const extension = allowedKnowledgeBaseImageTypes.get(payload.mimeType);

  if (!extension) {
    response.status(400).json({ message: "Unsupported image type" });
    return;
  }

  const uploadDir = knowledgeBaseUploadRoot;
  const baseName = path.basename(payload.originalName, path.extname(payload.originalName)) || "image";
  const fileName = `${Date.now()}-${randomUUID()}-${baseName}.${extension}`;

  if (securityUploadsEnabled()) await knowledgeBaseUploads().create({ fileName, directory: "photos", businessId: request.business!.id });

  await mkdir(uploadDir, { recursive: true });
  await writeFile(path.join(uploadDir, fileName), payload.bytes);

  response.status(201).json({ url: knowledgeBasePhotoUrl(fileName) });
}

export async function uploadKnowledgeBaseDocument(request: Request, response: Response) {
  const dataUrl = String(request.body.dataUrl || "");
  const originalName = String(request.body.fileName || "document").replace(/[^a-zA-Z0-9._-]/g, "-");
  const match = dataUrl.match(/^data:([a-zA-Z0-9/+.-]+);base64,(.+)$/);

  if (!match) {
    response.status(400).json({ message: "Valid document dataUrl is required" });
    return;
  }

  const mimeType = match[1];
  const base64 = match[2];
  const allowedMimeTypes = new Set([
    "application/pdf",
    "application/msword",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/vnd.ms-excel",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "application/vnd.ms-powerpoint",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    "text/plain",
    "text/csv",
    "image/png",
    "image/jpeg",
    "image/webp",
    "image/gif",
  ]);

  if (!allowedMimeTypes.has(mimeType)) {
    response.status(400).json({ message: "Unsupported document type" });
    return;
  }

  const uploadDir = path.resolve(knowledgeBaseUploadRoot, "documents");
  const fileName = `${Date.now()}-${randomUUID()}-${originalName}`;

  if (securityUploadsEnabled()) await knowledgeBaseUploads().create({ fileName, directory: "documents", businessId: request.business!.id });

  await mkdir(uploadDir, { recursive: true });
  await writeFile(path.join(uploadDir, fileName), Buffer.from(base64, "base64"));

  response.status(201).json({
    name: originalName,
    url: knowledgeBaseDocumentUrl(fileName),
    mimeType,
  });
}

export async function serveKnowledgeBasePhotoFile(request: Request, response: Response) {
  await serveKnowledgeBaseFile(request, response, "");
}

export async function serveKnowledgeBaseDocumentFile(request: Request, response: Response) {
  await serveKnowledgeBaseFile(request, response, "documents");
}

export async function listKnowledgeBaseSuggestions(request: Request, response: Response) {
  const entryId = String(request.query.entry || "").trim();
  const status = String(request.query.status || "").trim();
  const filter: Record<string, unknown> = {};

  if (entryId) {
    filter.entry = entryId;
  }

  if (["Pending", "Approved", "Rejected"].includes(status)) {
    filter.status = status;
  }

  const suggestions = await KnowledgeBaseSuggestion.find(filter)
    .populate({ path: "entry", select: "entryType title question status" })
    .sort({ createdAt: -1 });

  response.json(suggestions);
}

export async function createKnowledgeBaseSuggestion(request: Request, response: Response) {
  const input = getSuggestionInput(request);

  if (!input.entry) {
    response.status(400).json({ message: "entry is required" });
    return;
  }

  const hasSuggestedChange = [
    input.title,
    input.category,
    input.description,
    input.scope,
    input.question,
    input.answer,
  ].some((value) => value.trim());

  if (!input.comment.trim() && !hasSuggestedChange) {
    response.status(400).json({ message: "comment or suggested change is required" });
    return;
  }

  const entry = await KnowledgeBaseEntry.findById(input.entry);

  if (!entry) {
    response.status(404).json({ message: "Knowledge base entry not found" });
    return;
  }

  const suggestion = await KnowledgeBaseSuggestion.create({ ...input, entryType: entry.entryType });
  response.status(201).json(suggestion);
}

export async function approveKnowledgeBaseSuggestion(request: Request, response: Response) {
  const suggestion = await KnowledgeBaseSuggestion.findById(request.params.id);

  if (!suggestion) {
    response.status(404).json({ message: "Suggestion not found" });
    return;
  }

  const entry = await KnowledgeBaseEntry.findById(suggestion.entry);

  if (!entry) {
    response.status(404).json({ message: "Knowledge base entry not found" });
    return;
  }

  if (entry.entryType === "Product" || entry.entryType === "Article") {
    if (suggestion.title.trim()) entry.title = suggestion.title;
    if (suggestion.category.trim()) entry.category = suggestion.category;
    if (suggestion.description.trim()) entry.description = suggestion.description;
    if (suggestion.scope.trim()) entry.scope = suggestion.scope;
  } else {
    if (suggestion.question.trim()) entry.question = suggestion.question;
    if (suggestion.answer.trim()) entry.answer = suggestion.answer;
  }

  if (suggestion.comment.trim()) {
    entry.comments.push({
      comment: suggestion.comment,
      submittedById: suggestion.submittedById,
      submittedByName: suggestion.submittedByName,
      createdAt: new Date(),
    });
  }

  suggestion.status = "Approved";
  suggestion.reviewedAt = new Date();

  await entry.save();
  await suggestion.save();

  response.json({ suggestion, entry });
}

export async function rejectKnowledgeBaseSuggestion(request: Request, response: Response) {
  const suggestion = await KnowledgeBaseSuggestion.findByIdAndUpdate(
    request.params.id,
    { status: "Rejected", reviewedAt: new Date() },
    { returnDocument: "after", runValidators: true }
  );

  if (!suggestion) {
    response.status(404).json({ message: "Suggestion not found" });
    return;
  }

  response.json(suggestion);
}
