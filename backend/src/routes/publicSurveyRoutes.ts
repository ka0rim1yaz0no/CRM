import { Router } from "express";
import { submitHempIndustrySurvey } from "../controllers/publicSurveyController";

export const publicSurveyRouter = Router();

publicSurveyRouter.post("/help-save-the-hemp-industry", submitHempIndustrySurvey);
