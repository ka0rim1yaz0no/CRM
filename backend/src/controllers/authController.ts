import type { Request, Response } from "express";
import { Employee, normalizeEmployeeAvailabilityStatus } from "../models/Employee";
import { getBusinessAccessForEmployeeCode, normalizeBusinessAccessIds } from "../models/BusinessUserAccess";
import { getBusinessById, getCurrentBusinessId, getPublicBusinesses, type PublicBusinessConfig, runWithBusiness } from "../config/tenancy";
import { syncEmployeeAvailabilityAcrossBusinesses } from "../services/employeeAvailabilityService";
import { syncActiveAttendanceForBusinessSwitch } from "../services/employeeAttendanceSyncService";
import { findConfiguredAdmin, isDeniedEmployeeCode } from "../config/adminUsers";
import { verifyAttendanceHubSession } from "../config/attendanceHubSession";
import { attendanceIntegrityEnabled, attendanceV2Enabled, securityDataMinimizationEnabled, securityHardeningEnabled } from "../config/rolloutFlags";
import { employeeResponse } from "../services/employeePrivacy";
import { setFileSession, clearFileSession } from "../middleware/securityFileSession";
import { createAdminDashboardSession } from "../config/adminDashboardSession";
import { createAttendanceHubSession } from "../config/attendanceHubSession";
import { syncRecentAttendanceEventsForBusinessSwitch } from "../services/attendanceEventSyncService";

function responseBusiness(request: Request, publicBusinesses: PublicBusinessConfig[]) {
  if (!request.business) {
    return undefined;
  }

  const publicBusiness = publicBusinesses.find((business) => business.id === request.business?.id);
  return publicBusiness || { id: request.business.id, name: request.business.name, isDefault: request.business.isDefault };
}

async function allowedBusinessesForEmployee(employeeCode: string, employeeBusinessAccessIds: unknown, fallbackBusinessId = getCurrentBusinessId()) {
  const controlBusinessIds = await getBusinessAccessForEmployeeCode(employeeCode);
  const hasControlBusinessAccess = controlBusinessIds.length > 0;
  const rawBusinessIds = hasControlBusinessAccess ? controlBusinessIds : normalizeBusinessAccessIds(employeeBusinessAccessIds);
  const allowedBusinessIds = new Set(rawBusinessIds);

  if (!hasControlBusinessAccess && fallbackBusinessId) {
    allowedBusinessIds.add(fallbackBusinessId);
  }

  const publicBusinesses = await getPublicBusinesses();
  return publicBusinesses.filter((business) => allowedBusinessIds.has(business.id));
}

export async function loginWithEmployeeCode(request: Request, response: Response) {
  const employeeCode = String(request.body.employeeCode || "").trim();

  if (!employeeCode) {
    response.status(400).json({ message: "Employee code is required" });
    return;
  }

  const configuredAdmin = findConfiguredAdmin(employeeCode);

  if (configuredAdmin) {
    const publicBusinesses = await getPublicBusinesses();
    const sessionToken = createAdminDashboardSession(employeeCode);
    const fileToken = sessionToken || createAttendanceHubSession(employeeCode);
    if (fileToken) setFileSession(response, { type: configuredAdmin.access === "full" ? "admin" : "tracker", token: fileToken });

    response.json({
      user: { id: "admin", name: configuredAdmin.name, role: "Admin", employeeCode },
      userType: "admin",
      access: configuredAdmin.access,
      sessionToken,
      ...(configuredAdmin.access === "tracker" ? { attendanceHubSession: fileToken } : {}),
      business: responseBusiness(request, publicBusinesses),
      allowedBusinesses: publicBusinesses,
    });
    return;
  }

  if (isDeniedEmployeeCode(employeeCode)) {
    response.status(401).json({ message: "Invalid employee code" });
    return;
  }

  const employee = await Employee.findOne({ employeeCode, status: { $ne: "Archived" } }).select("-profileImage");

  if (!employee) {
    response.status(401).json({ message: "Invalid employee code" });
    return;
  }

  const allowedBusinesses = await allowedBusinessesForEmployee(employee.employeeCode, employee.businessAccessIds);
  const selectedBusinessId = request.business?.id || getCurrentBusinessId();

  if (!allowedBusinesses.some((business) => business.id === selectedBusinessId)) {
    response.status(403).json({ message: "You do not have access to this business." });
    return;
  }

  const attendanceHubSession = createAttendanceHubSession(employee.employeeCode);
  if (attendanceHubSession) setFileSession(response, { type: "employee", token: attendanceHubSession });
  response.json({
    user: securityDataMinimizationEnabled() ? employeeResponse(employee.toObject()) : employee,
    userType: "employee",
    attendanceHubSession,
    business: responseBusiness(request, allowedBusinesses),
    allowedBusinesses,
  });
}

export async function listEmployeeBusinesses(request: Request, response: Response) {
  const employeeCode = String(request.query.employeeCode || "").trim();

  if (!employeeCode) {
    response.status(400).json({ message: "Employee code is required" });
    return;
  }

  const allowedBusinesses = await allowedBusinessesForEmployee(
    employeeCode,
    [],
    request.business?.id || getCurrentBusinessId()
  );

  response.set("Cache-Control", "no-store");
  response.json(allowedBusinesses);
}

export async function switchEmployeeBusiness(request: Request, response: Response) {
  const employeeCode = String(request.body.employeeCode || "").trim();
  const currentBusinessId = String(request.body.currentBusinessId || getCurrentBusinessId()).trim();
  const targetBusinessId = String(request.body.targetBusinessId || "").trim();
  if (securityHardeningEnabled() && verifyAttendanceHubSession(request.header("x-crm-attendance-session")) !== employeeCode) {
    response.status(403).json({ message: "A signed employee session is required to switch businesses." });
    return;
  }

  if (!employeeCode || !targetBusinessId) {
    response.status(400).json({ message: "Employee code and target business are required" });
    return;
  }

  const currentBusiness = getBusinessById(currentBusinessId);
  const targetBusiness = getBusinessById(targetBusinessId);

  if (!currentBusiness || !targetBusiness) {
    response.status(400).json({ message: "Unknown business selected." });
    return;
  }

  const currentEmployee = await runWithBusiness(currentBusiness.id, () =>
    Employee.findOne({ employeeCode, status: { $ne: "Archived" } }).select(
      "employeeCode businessAccessIds availabilityStatus availabilityStatusReason"
    )
  );

  if (!currentEmployee) {
    response.status(401).json({ message: "Employee not found in current business" });
    return;
  }

  const allowedBusinesses = await allowedBusinessesForEmployee(
    currentEmployee.employeeCode,
    currentEmployee.businessAccessIds,
    currentBusiness.id
  );

  if (!allowedBusinesses.some((business) => business.id === targetBusiness.id)) {
    response.status(403).json({ message: "You do not have access to this business." });
    return;
  }

  const targetEmployee = await runWithBusiness(targetBusiness.id, () =>
    Employee.findOne({ employeeCode, status: { $ne: "Archived" } }).select("-profileImage")
  );

  if (!targetEmployee) {
    response.status(404).json({ message: "Employee account is not available in the selected business." });
    return;
  }

  const currentAvailabilityStatus = normalizeEmployeeAvailabilityStatus(currentEmployee.availabilityStatus);
  if (!attendanceIntegrityEnabled()) await syncEmployeeAvailabilityAcrossBusinesses(
    currentEmployee.employeeCode,
    currentAvailabilityStatus,
    currentEmployee.availabilityStatusReason
  );
  try {
    if (attendanceIntegrityEnabled()) {
      // Business selection never changes attendance. Commands maintain the shared projection.
    } else if (attendanceV2Enabled()) {
      await syncRecentAttendanceEventsForBusinessSwitch(currentEmployee.employeeCode, currentBusiness.id);
    } else {
      await syncActiveAttendanceForBusinessSwitch(
        currentEmployee.employeeCode,
        currentBusiness.id,
        targetBusiness.id
      );
    }
  } catch (error) {
    console.error(`Unable to carry attendance while switching ${currentEmployee.employeeCode} from ${currentBusiness.id} to ${targetBusiness.id}:`, error);
  }
  targetEmployee.availabilityStatus = currentAvailabilityStatus;

  const attendanceHubSession = createAttendanceHubSession(targetEmployee.employeeCode);
  if (attendanceHubSession) setFileSession(response, { type: "employee", token: attendanceHubSession });
  response.json({
    user: securityDataMinimizationEnabled() ? employeeResponse(targetEmployee.toObject()) : targetEmployee,
    userType: "employee",
    attendanceHubSession,
    business: allowedBusinesses.find((business) => business.id === targetBusiness.id) || { id: targetBusiness.id, name: targetBusiness.name },
    allowedBusinesses,
  });
}

export async function logoutEmployee(request: Request, response: Response) {
  clearFileSession(response);
  const employeeId = String(request.body.employeeId || "").trim();

  if (!employeeId) {
    response.status(400).json({ message: "Employee id is required" });
    return;
  }

  const employee = await Employee.findOne({ _id: employeeId, status: { $ne: "Archived" } });

  if (!employee) {
    response.status(404).json({ message: "Employee not found" });
    return;
  }

  response.json({ success: true });
}
