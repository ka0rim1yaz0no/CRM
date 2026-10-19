import type { NextFunction, Request, Response } from "express";
import { findConfiguredAdmin } from "../config/adminUsers";
import { getBusinessAccessForEmployeeCode } from "../models/BusinessUserAccess";
import { Employee } from "../models/Employee";
import { verifyAdminDashboardSession } from "../config/adminDashboardSession";

export function verifiedAdminOnly(request: Request, response: Response, next: NextFunction) {
  if (!verifyAdminDashboardSession(request.header("x-crm-admin-session"))) {
    response.status(403).json({ message: "A verified administrator session is required." });
    return;
  }
  next();
}

export async function businessAccessMiddleware(request: Request, response: Response, next: NextFunction) {
  const userType = String(request.header("x-crm-user-type") || "").trim().toLowerCase();
  const userCode = String(request.header("x-crm-user-code") || "").trim();
  const businessId = request.business?.id || "";

  response.setHeader("X-Business-Id", businessId);

  // Integrations and desktop agents use their own endpoint-specific credentials.
  // Only validate requests that claim to be an interactive CRM user.
  if (!userType) {
    next();
    return;
  }

  if (userType === "admin") {
    if (!findConfiguredAdmin(userCode)) {
      response.status(401).json({ message: "Invalid administrator session." });
      return;
    }
    next();
    return;
  }

  if (userType !== "employee" || !userCode) {
    response.status(401).json({ message: "Invalid CRM user session." });
    return;
  }

  const controlledBusinessIds = await getBusinessAccessForEmployeeCode(userCode);
  if (controlledBusinessIds.length > 0) {
    if (!controlledBusinessIds.includes(businessId)) {
      response.status(403).json({ message: "You do not have access to this business." });
      return;
    }
    next();
    return;
  }

  const employeeExists = await Employee.exists({ employeeCode: userCode, status: { $ne: "Archived" } });
  if (!employeeExists) {
    response.status(403).json({ message: "You do not have access to this business." });
    return;
  }

  next();
}

export function configuredAdminOnly(request: Request, response: Response, next: NextFunction) {
  const userType = String(request.header("x-crm-user-type") || "").trim().toLowerCase();
  const userCode = String(request.header("x-crm-user-code") || "").trim();

  if (userType !== "admin" || !findConfiguredAdmin(userCode)) {
    response.status(403).json({ message: "Administrator access is required." });
    return;
  }

  next();
}
