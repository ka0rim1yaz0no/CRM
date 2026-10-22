import { Router } from "express";
import { employeeBulkArchive } from "../controllers/employeeLeadArchiveController";
import { leadPhoneDedupEnabled } from "../config/rolloutFlags";
import {
  assignLead,
  archiveLead,
  archiveAllActiveLeads,
  addLeadComment,
  autoSearchTomTomPlacesForProduct,
  autoAssignLead,
  bulkAssignLeads,
  bulkArchiveLeads,
  bulkPermanentlyDeleteArchivedLeads,
  bulkPermanentlyDeleteActiveLeads,
  bulkRestoreLeads,
  countLeads,
  createLead,
  importLeads,
  readAgentLeadDashboard,
  readTomTomPlacesUsage,
  readLead,
  listEmployeeLeadLogs,
  listMyLeads,
  listLeads,
  permanentlyDeleteArchivedLeads,
  permanentlyDeleteLead,
  recordLeadCall,
  reassignNewLeadsBatch,
  restoreAllArchivedLeads,
  restoreLead,
  scoreLeadsByHighestPotential,
  scheduleLeadFollowUp,
  searchAndImportTomTomPlacesAsLeads,
  updateLead,
  updateLeadComment,
  updateLeadStatus,
  toggleLeadFavorite,
} from "../controllers/leadController";
import { getLeadCallStat, getLeadCallStats, getMyLeadCallStats, logConnectedCall, logNotConnectedCall, logVoicemailCall } from "../controllers/leadCallStatController";

export const leadRouter = Router();

leadRouter.get("/", listLeads);
leadRouter.get("/call-stats/me", getMyLeadCallStats);
leadRouter.get("/call-stats", getLeadCallStats);
leadRouter.get("/counts", countLeads);
leadRouter.get("/workspace-capabilities", (_request, response) => {
  response.set("Cache-Control", "no-store").json({ phoneDeduplication: leadPhoneDedupEnabled(), employeeBulkArchive: leadPhoneDedupEnabled() });
});
leadRouter.get("/my", listMyLeads);
leadRouter.get("/agent-dashboard", readAgentLeadDashboard);
leadRouter.get("/employee-logs", listEmployeeLeadLogs);
leadRouter.get("/:id", readLead);
leadRouter.post("/", createLead);
leadRouter.post("/ai-score", scoreLeadsByHighestPotential);
leadRouter.post("/import", importLeads);
leadRouter.patch("/reassign-new", reassignNewLeadsBatch);
leadRouter.patch("/bulk/archive", bulkArchiveLeads);
leadRouter.patch("/employee/bulk/archive", employeeBulkArchive);
leadRouter.patch("/bulk/archive-all", archiveAllActiveLeads);
leadRouter.patch("/bulk/restore", bulkRestoreLeads);
leadRouter.patch("/bulk/assign", bulkAssignLeads);
leadRouter.delete("/bulk/permanent", bulkPermanentlyDeleteArchivedLeads);
leadRouter.delete("/bulk/active/permanent", bulkPermanentlyDeleteActiveLeads);
leadRouter.patch("/archived/restore", restoreAllArchivedLeads);
leadRouter.delete("/archived/permanent", permanentlyDeleteArchivedLeads);
leadRouter.put("/:id", updateLead);
leadRouter.patch("/:id/assign", assignLead);
leadRouter.patch("/:id/archive", archiveLead);
leadRouter.patch("/:id/restore", restoreLead);
leadRouter.delete("/:id/permanent", permanentlyDeleteLead);
leadRouter.post("/:id/comments", addLeadComment);
leadRouter.post("/:id/calls", recordLeadCall);
leadRouter.patch("/:id/comments/:commentId", updateLeadComment);
leadRouter.patch("/:id/status", updateLeadStatus);
leadRouter.patch("/:id/favorite", toggleLeadFavorite);
leadRouter.patch("/:id/follow-up", scheduleLeadFollowUp);
leadRouter.patch("/:id/auto-assign", autoAssignLead);
leadRouter.get("/tomtom/usage", readTomTomPlacesUsage);
leadRouter.post("/tomtom/search-import", searchAndImportTomTomPlacesAsLeads);
leadRouter.post("/tomtom/auto-search", autoSearchTomTomPlacesForProduct);


leadRouter.get("/:id/call-stat", getLeadCallStat);

leadRouter.patch("/:id/log-call", logConnectedCall);
leadRouter.patch("/:id/not-connected", logNotConnectedCall);
leadRouter.patch("/:id/voicemail", logVoicemailCall);
