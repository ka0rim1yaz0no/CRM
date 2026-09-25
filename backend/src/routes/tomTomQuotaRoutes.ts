import { Router } from "express";
import { readSharedTomTomUsage, reserveSharedTomTomRequest } from "../controllers/tomTomQuotaController";

export const tomTomQuotaRouter = Router();

tomTomQuotaRouter.get("/usage", readSharedTomTomUsage);
tomTomQuotaRouter.post("/reserve", reserveSharedTomTomRequest);
