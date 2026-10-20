import type { Request } from "express";
import { verifyAdminDashboardSession } from "../config/adminDashboardSession";
import { verifyAttendanceHubSession } from "../config/attendanceHubSession";
import { normalizeEmployeeAvailabilityStatus } from "../models/Employee";

const publicFields = ["_id", "name", "employeeCode", "aliases", "role", "team", "company", "email", "phone", "status", "availabilityStatus", "availabilityStatusReason", "availabilityRevision", "attendanceRevision", "activeAttendanceSessionId", "businessAccessIds", "createdAt", "updatedAt"] as const;
const privateFields = ["dateHired", "terminationDate", "salary", "profileImage", "personalPhone", "personalEmail", "personalAddress", "emergencyContact", "contactRelationship", "emergencyContactNumber", "personalNotes", "bankName", "bankAccountName", "bankAccountNumber", "bankRoutingNumber"] as const;

export function signedEmployeeOwner(request: Request, employeeCode: string) {
  return verifyAttendanceHubSession(request.header("x-crm-attendance-session")) === employeeCode;
}

export function canReadPrivateEmployee(request: Request, employeeCode: string) {
  return Boolean(verifyAdminDashboardSession(request.header("x-crm-admin-session"))) || signedEmployeeOwner(request, employeeCode);
}

export function employeeResponse(employee: Record<string, unknown>, options: { private?: boolean; adminSummary?: boolean } = {}) {
  const fields: readonly string[] = options.private ? [...publicFields, ...privateFields]
    : options.adminSummary ? [...publicFields, "dateHired", "terminationDate", "salary"] : publicFields;
  const result: Record<string, unknown> = {};
  for (const field of fields) if (Object.hasOwn(employee, field)) result[field] = employee[field];
  result.availabilityStatus = normalizeEmployeeAvailabilityStatus(employee.availabilityStatus);
  return result;
}
