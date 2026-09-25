import { Router } from "express";
import { countAdminLeads, listAdminLeads } from "../controllers/leadController";

export const adminLeadRouter = Router();

adminLeadRouter.get("/counts", countAdminLeads);
adminLeadRouter.get("/", listAdminLeads);
adminLeadRouter.get("/:tab", listAdminLeads);
