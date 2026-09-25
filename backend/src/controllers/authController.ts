import type { Request, Response } from "express";
import { Employee, normalizeEmployeeAvailabilityStatus } from "../models/Employee";
import { getBusinessAccessForEmployeeCode, normalizeBusinessAccessIds } from "../models/BusinessUserAccess";
import { getBusinessById, getCurrentBusinessId, getPublicBusinesses, type PublicBusinessConfig, runWithBusiness } from "../config/tenancy";
import { syncEmployeeAvailabilityAcrossBusinesses } from "../services/employeeAvailabilityService";
import { findConfiguredAdmin } from "../config/adminUsers";

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

    response.json({
      user: { id: "admin", name: configuredAdmin.name, role: "Admin", employeeCode },
      userType: "admin",
      business: responseBusiness(request, publicBusinesses),
      allowedBusinesses: publicBusinesses,
    });
    return;
  }

  if (["00000003", "00000001"].includes(employeeCode)) {
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

  response.json({
    user: employee,
    userType: "employee",
    business: responseBusiness(request, allowedBusinesses),
    allowedBusinesses,
  });
}

export async function switchEmployeeBusiness(request: Request, response: Response) {
  const employeeCode = String(request.body.employeeCode || "").trim();
  const currentBusinessId = String(request.body.currentBusinessId || getCurrentBusinessId()).trim();
  const targetBusinessId = String(request.body.targetBusinessId || "").trim();

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
  await syncEmployeeAvailabilityAcrossBusinesses(
    currentEmployee.employeeCode,
    currentAvailabilityStatus,
    currentEmployee.availabilityStatusReason
  );
  targetEmployee.availabilityStatus = currentAvailabilityStatus;

  response.json({
    user: targetEmployee,
    userType: "employee",
    business: allowedBusinesses.find((business) => business.id === targetBusiness.id) || { id: targetBusiness.id, name: targetBusiness.name },
    allowedBusinesses,
  });
}

export async function logoutEmployee(request: Request, response: Response) {
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
