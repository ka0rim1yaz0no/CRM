import { Router } from "express";
import { readAgentProductivityReport } from "../controllers/reportController";

export const reportRouter = Router();

reportRouter.get("/agent-productivity", readAgentProductivityReport);
