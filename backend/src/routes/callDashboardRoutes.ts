import { Router } from "express";
import { getCallDashboard } from "../controllers/callDashboardController";

export const callDashboardRouter = Router();
callDashboardRouter.get("/", getCallDashboard);
