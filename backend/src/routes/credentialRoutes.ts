import { Router } from "express";
import { archiveCredential, createCredential, listCredentials, revealCredential, updateCredential } from "../controllers/credentialController";
import { securityCredentialVaultEnabled } from "../config/rolloutFlags";
import { verifiedAdminOnly } from "../middleware/businessAccess";

export const credentialRouter = Router();

credentialRouter.use((request, response, next) => {
  if (!securityCredentialVaultEnabled()) return next();
  response.set("Cache-Control", "no-store");
  return verifiedAdminOnly(request, response, next);
});

credentialRouter.get("/", listCredentials);
credentialRouter.post("/", createCredential);
credentialRouter.put("/:id", updateCredential);
credentialRouter.patch("/:id/archive", archiveCredential);
credentialRouter.post("/:id/reveal", revealCredential);
