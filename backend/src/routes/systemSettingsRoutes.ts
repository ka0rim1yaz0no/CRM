import { Router } from "express";
import { readSystemSettings, updateSystemSettings } from "../controllers/systemSettingsController";
import { verifyAdminDashboardSession } from "../config/adminDashboardSession";

export const systemSettingsRouter = Router();

systemSettingsRouter.get("/", readSystemSettings);
systemSettingsRouter.put("/", (request, response, next) => {
  if (!verifyAdminDashboardSession(request.header("x-crm-admin-session"))) { response.status(403).json({ message: "A verified administrator session is required to change configuration." }); return; }
  next();
}, updateSystemSettings);
