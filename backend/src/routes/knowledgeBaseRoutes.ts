import { Router, raw } from "express";
import { securityHardeningEnabled } from "../config/rolloutFlags";
import {
  archiveKnowledgeBaseEntry,
  approveKnowledgeBaseSuggestion,
  createKnowledgeBaseEntry,
  createKnowledgeBaseSuggestion,
  listKnowledgeBaseEntries,
  listKnowledgeBaseSuggestions,
  rejectKnowledgeBaseSuggestion,
  serveKnowledgeBaseDocumentFile,
  serveKnowledgeBasePhotoFile,
  uploadKnowledgeBaseDocument,
  uploadKnowledgeBasePhoto,
  updateKnowledgeBaseEntry,
} from "../controllers/knowledgeBaseController";

export const knowledgeBaseRouter = Router();
const imageUploadLimit = process.env.FILE_UPLOAD_LIMIT || process.env.REQUEST_BODY_LIMIT || "500mb";

knowledgeBaseRouter.get("/", listKnowledgeBaseEntries);
knowledgeBaseRouter.get("/suggestions", listKnowledgeBaseSuggestions);
knowledgeBaseRouter.get("/photos/file/:fileName", serveKnowledgeBasePhotoFile);
knowledgeBaseRouter.get("/documents/file/:fileName", serveKnowledgeBaseDocumentFile);
knowledgeBaseRouter.post("/", createKnowledgeBaseEntry);
knowledgeBaseRouter.post("/documents", uploadKnowledgeBaseDocument);
knowledgeBaseRouter.post(
  "/photos",
  (request, response, next) => raw({ type: ["image/*", "application/octet-stream"], limit: securityHardeningEnabled() ? "20mb" : imageUploadLimit })(request, response, next),
  uploadKnowledgeBasePhoto
);
knowledgeBaseRouter.post("/suggestions", createKnowledgeBaseSuggestion);
knowledgeBaseRouter.patch("/suggestions/:id/approve", approveKnowledgeBaseSuggestion);
knowledgeBaseRouter.patch("/suggestions/:id/reject", rejectKnowledgeBaseSuggestion);
knowledgeBaseRouter.put("/:id", updateKnowledgeBaseEntry);
knowledgeBaseRouter.patch("/:id/archive", archiveKnowledgeBaseEntry);
