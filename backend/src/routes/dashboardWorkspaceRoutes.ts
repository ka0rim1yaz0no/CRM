import { Router } from "express";
import { dashboardWorkspaceSummary, dashboardEmployeeQuickView, saveDashboardWorkspace, saveDashboardNote } from "../controllers/dashboardWorkspaceController";
export const dashboardWorkspaceRouter = Router();
dashboardWorkspaceRouter.get("/summary", dashboardWorkspaceSummary);
dashboardWorkspaceRouter.get("/employee/:code", dashboardEmployeeQuickView);
dashboardWorkspaceRouter.put("/settings", saveDashboardWorkspace);
dashboardWorkspaceRouter.post("/notes", saveDashboardNote);
dashboardWorkspaceRouter.patch("/notes/:id", saveDashboardNote);
dashboardWorkspaceRouter.delete("/notes/:id", saveDashboardNote);
