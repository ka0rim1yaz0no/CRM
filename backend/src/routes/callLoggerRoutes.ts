import { Router } from "express";
import { getLeadCallStat, getLeadCallStats, getLeadCallSummary, getMyLeadCallStats, getMyLeadCallSummary, logConnectedCall, logNotConnectedCall, logVoicemailCall } from "../controllers/leadCallStatController";


export const callRouter = Router();

callRouter.get("/call-stats/me", getMyLeadCallStats);
callRouter.get("/call-stats", getLeadCallStats);
callRouter.get("/call-summary/me", getMyLeadCallSummary);
callRouter.get("/call-summary", getLeadCallSummary);
callRouter.get("/:id/call-stat", getLeadCallStat);
callRouter.patch("/:id/log-call", logConnectedCall);
callRouter.patch("/:id/not-connected", logNotConnectedCall);
callRouter.patch("/:id/voicemail", logVoicemailCall);
