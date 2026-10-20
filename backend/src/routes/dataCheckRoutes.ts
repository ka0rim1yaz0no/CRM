import { Router } from "express";
import { rateLimit } from "express-rate-limit";
import { verifiedAdminOnly } from "../middleware/businessAccess";
import { dataCheckConfig, getDataCheck } from "../controllers/dataCheckController";
import { verifyAdminDashboardSession } from "../config/adminDashboardSession";

export const dataCheckRouter = Router();
dataCheckRouter.use(verifiedAdminOnly);
dataCheckRouter.get("/config", dataCheckConfig);
export const dataCheckRateLimit = rateLimit({ windowMs: 60_000, limit: 10, standardHeaders: "draft-8", legacyHeaders: false,
  keyGenerator: request => verifyAdminDashboardSession(request.header("x-crm-admin-session"))!.name,
  message: { message: "Please wait before running another Data Check." } });
dataCheckRouter.get("/", dataCheckRateLimit, getDataCheck);
