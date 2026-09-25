import { Router } from "express";
import { countMyLeads, listMyLeads } from "../controllers/leadController";

export const myLeadRouter = Router();

myLeadRouter.get("/counts", countMyLeads);
myLeadRouter.get("/", listMyLeads);
myLeadRouter.get("/:tab", listMyLeads);
