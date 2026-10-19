import { Router } from "express";
import { archiveMediaAsset, listMediaAssets, serveMediaAssetFile, uploadMediaAsset } from "../controllers/mediaController";
import { verifiedAdminOnly } from "../middleware/businessAccess";

export const mediaRouter = Router();

mediaRouter.get("/", listMediaAssets);
mediaRouter.post("/", verifiedAdminOnly, uploadMediaAsset);
mediaRouter.get("/file/:fileName", serveMediaAssetFile);
mediaRouter.patch("/:id/archive", verifiedAdminOnly, archiveMediaAsset);
