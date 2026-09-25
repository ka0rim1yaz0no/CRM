import { Router } from "express";
import { createCustomerRegistrationLead } from "../controllers/integrationController";

export const integrationRouter = Router();

integrationRouter.post("/customer-registration-leads", createCustomerRegistrationLead);
