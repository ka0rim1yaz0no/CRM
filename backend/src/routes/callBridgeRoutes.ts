import { Router, type Request, type Response, type NextFunction } from "express";
import {
  activateCallBridgeForEmployee,
  claimCallBridgePairing,
  createCallBridgePairing,
  downloadCallBridgePackage,
  getLatestCallBridgeAttempt,
  getCallBridgeStatus,
  markCallBridgeDialStarted,
  releaseCallBridgeCall,
  reserveCallBridgeCall,
  revokeCallBridgeDevices,
  updateCallBridgeHeartbeat,
} from "../controllers/callBridgeController";

export const callBridgeRouter = Router();

function logReserveConflict(request: Request, response: Response, next: NextFunction) {
  const sendJson = response.json.bind(response);

  response.json = ((body: unknown) => {
    if (response.statusCode === 409) {
      const result = (body || {}) as { code?: unknown; reason?: unknown; message?: unknown };
      console.warn("Call Bridge reservation rejected", {
        employeeCode: String(request.body?.employeeCode || request.header("x-crm-user-code") || ""),
        businessId: request.business?.id || "",
        code: String(result.code || ""),
        reason: String(result.reason || result.message || "Conflict"),
      });
    }

    return sendJson(body);
  }) as Response["json"];

  next();
}

function logDialStartFailure(request: Request, response: Response, next: NextFunction) {
  const sendJson = response.json.bind(response);

  response.json = ((body: unknown) => {
    if (response.statusCode >= 400) {
      const result = (body || {}) as { code?: unknown; message?: unknown };
      console.warn("Call Bridge dial-start rejected", {
        status: response.statusCode,
        employeeCode: String(request.body?.employeeCode || request.header("x-crm-user-code") || ""),
        businessId: request.business?.id || "",
        leadId: String(request.body?.leadId || ""),
        hasReservationToken: Boolean(request.body?.reservationToken),
        clientVersion: String(request.header("x-crm-auto-call-version") || ""),
        code: String(result.code || ""),
        message: String(result.message || ""),
      });
    }

    return sendJson(body);
  }) as Response["json"];

  next();
}

callBridgeRouter.post("/pairings", createCallBridgePairing);
callBridgeRouter.post("/claim", claimCallBridgePairing);
callBridgeRouter.post("/activate", activateCallBridgeForEmployee);
callBridgeRouter.post("/heartbeat", updateCallBridgeHeartbeat);
callBridgeRouter.get("/status", getCallBridgeStatus);
callBridgeRouter.get("/attempts/latest", getLatestCallBridgeAttempt);
callBridgeRouter.post("/reserve", logReserveConflict, reserveCallBridgeCall);
callBridgeRouter.post("/dial-start", logDialStartFailure, markCallBridgeDialStarted);
callBridgeRouter.post("/release", releaseCallBridgeCall);
callBridgeRouter.delete("/devices", revokeCallBridgeDevices);
callBridgeRouter.get("/package", downloadCallBridgePackage);
