import { Router } from "express";
import {
  activateCallBridgeForEmployee,
  claimCallBridgePairing,
  createCallBridgePairing,
  downloadCallBridgePackage,
  getCallBridgeStatus,
  markCallBridgeDialStarted,
  releaseCallBridgeCall,
  reserveCallBridgeCall,
  revokeCallBridgeDevices,
  updateCallBridgeHeartbeat,
} from "../controllers/callBridgeController";

export const callBridgeRouter = Router();

callBridgeRouter.post("/pairings", createCallBridgePairing);
callBridgeRouter.post("/claim", claimCallBridgePairing);
callBridgeRouter.post("/activate", activateCallBridgeForEmployee);
callBridgeRouter.post("/heartbeat", updateCallBridgeHeartbeat);
callBridgeRouter.get("/status", getCallBridgeStatus);
callBridgeRouter.post("/reserve", reserveCallBridgeCall);
callBridgeRouter.post("/dial-start", markCallBridgeDialStarted);
callBridgeRouter.post("/release", releaseCallBridgeCall);
callBridgeRouter.delete("/devices", revokeCallBridgeDevices);
callBridgeRouter.get("/package", downloadCallBridgePackage);
