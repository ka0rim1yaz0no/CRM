import type { Request, Response } from "express";
import { attendanceIntegrityEnabled, securityDataMinimizationEnabled } from "../config/rolloutFlags";
import { canReadPrivateEmployee, employeeResponse } from "../services/employeePrivacy";
import { verifyAdminDashboardSession } from "../config/adminDashboardSession";
import { Employee, normalizeEmployeeAvailabilityStatus, type EmployeeAvailabilityStatus, type EmployeeStatus } from "../models/Employee";
import { Lead } from "../models/Lead";
import {
  deleteBusinessAccessForEmployeeCode,
  getBusinessAccessForEmployeeCode,
  normalizeBusinessAccessIds,
  setBusinessAccessForEmployeeCode,
} from "../models/BusinessUserAccess";
import { getBusinessById, getConfiguredBusinesses, getCurrentBusinessId, runWithBusiness } from "../config/tenancy";
import { reassignLeadsFromAgent } from "./leadController";
import { emitCallDashboardUpdated } from "../socket";
import { syncCallBridgeBusinessIds } from "../services/callBridgeBusinessService";
import { isTrackerOnlyAdminCode } from "../config/adminUsers";
import { syncEmployeeCurrentPayrollAcrossBusinesses } from "./payrollController";
import { syncEmployeeAttendanceAcrossBusinesses } from "../services/employeeAttendanceSyncService";

function toSalary(value: unknown) {
  const salary = Number(value);
  return Number.isFinite(salary) && salary >= 0 ? Math.round(salary * 100) / 100 : 0;
}

function toProfileImage(value: unknown) {
  const image = String(value || "").trim();
  if (!image) return "";
  const maxDataUrlLength = Math.ceil((2 * 1024 * 1024 * 4) / 3) + 128;
  return image.length <= maxDataUrlLength && /^data:image\/(?:png|jpe?g|webp|gif);base64,/i.test(image) ? image : "";
}

function profileImageIsInvalid(value: unknown) {
  return Boolean(String(value || "").trim()) && !toProfileImage(value);
}

function toText(value: unknown, fallback = "") {
  const text = String(value || "").trim();
  return text || fallback;
}

function toAliases(value: unknown) {
  const aliases = Array.isArray(value) ? value : String(value || "").split(",");
  return Array.from(
    new Set(
      aliases
        .map((alias) => String(alias || "").trim())
        .filter(Boolean)
    )
  );
}

function validBusinessAccessIds(value: unknown, fallbackBusinessId = getCurrentBusinessId()) {
  const configuredBusinessIds = new Set(
    normalizeBusinessAccessIds(value).filter((businessId) => Boolean(getBusinessById(businessId)))
  );

  if (fallbackBusinessId && getBusinessById(fallbackBusinessId)) {
    configuredBusinessIds.add(fallbackBusinessId);
  }

  return Array.from(configuredBusinessIds);
}

function sameNormalizedName(first: unknown, second: unknown) {
  return toText(first).toLowerCase().replace(/\s+/g, " ") === toText(second).toLowerCase().replace(/\s+/g, " ");
}

async function syncEmployeeNameReferences(employeeCode: string, businessAccessIds: unknown, previousName: string, nextName: string) {
  if (!previousName || !nextName || sameNormalizedName(previousName, nextName)) {
    return;
  }

  for (const businessId of validBusinessAccessIds(businessAccessIds)) {
    await runWithBusiness(businessId, async () => {
      const employee = await Employee.findOne({ employeeCode }).select("_id").lean();
      if (!employee) return;
      await Promise.all([
        Lead.updateMany(
          { $or: [{ assignedAgent: employee._id }, { assignedAgentName: previousName }] },
          { $set: { assignedAgentName: nextName } }
        ),
        Lead.updateMany(
          { "comments.authorName": previousName },
          { $set: { "comments.$[comment].authorName": nextName } },
          { arrayFilters: [{ "comment.authorName": previousName }] }
        ),
        Lead.updateMany(
          { "activity.actorName": previousName, "activity.actorType": "employee" },
          { $set: { "activity.$[activity].actorName": nextName } },
          { arrayFilters: [{ "activity.actorName": previousName, "activity.actorType": "employee" }] }
        ),
      ]);
    });
  }
}

function toEmployeeStatus(value: unknown): EmployeeStatus {
  const status = toText(value, "Active");
  return ["Active", "Training", "Paused", "Archived"].includes(status) ? status as EmployeeStatus : "Active";
}

function toEmployeeAvailabilityStatus(value: unknown): EmployeeAvailabilityStatus {
  return normalizeEmployeeAvailabilityStatus(toText(value, "OFFLINE"));
}

function employeePayload(body: Record<string, unknown>, options: { includeProfileImage?: boolean } = { includeProfileImage: true }) {
  const payload = {
    name: toText(body.name),
    dateHired: toText(body.dateHired),
    terminationDate: toText(body.terminationDate),
    employeeCode: toText(body.employeeCode),
    aliases: toAliases(body.aliases),
    role: toText(body.role),
    team: toText(body.team, "Unassigned"),
    company: toText(body.company, "Assistly"),
    email: toText(body.email),
    phone: toText(body.phone),
    personalPhone: toText(body.personalPhone),
    personalEmail: toText(body.personalEmail),
    personalAddress: toText(body.personalAddress),
    emergencyContact: toText(body.emergencyContact),
    contactRelationship: toText(body.contactRelationship),
    emergencyContactNumber: toText(body.emergencyContactNumber),
    personalNotes: toText(body.personalNotes),
    bankName: toText(body.bankName),
    bankAccountName: toText(body.bankAccountName),
    bankAccountNumber: toText(body.bankAccountNumber),
    bankRoutingNumber: toText(body.bankRoutingNumber),
    salary: toSalary(body.salary),
    status: toEmployeeStatus(body.status),
    availabilityStatus: toEmployeeAvailabilityStatus(body.availabilityStatus),
    businessAccessIds: validBusinessAccessIds(body.businessAccessIds),
  };

  if (!options.includeProfileImage) {
    return payload;
  }

  return {
    ...payload,
    profileImage: toProfileImage(body.profileImage),
  };
}

function withNormalizedAvailability<T extends { availabilityStatus?: unknown }>(employee: T) {
  return {
    ...employee,
    availabilityStatus: normalizeEmployeeAvailabilityStatus(employee.availabilityStatus),
  };
}

function actorType(request: Request) {
  return String(request.header("x-crm-user-type") || "").trim().toLowerCase();
}

function actorCode(request: Request) {
  return String(request.header("x-crm-user-code") || "").trim();
}

function employeeCanAccessRecord(request: Request, employeeCode: string) {
  if (securityDataMinimizationEnabled()) return canReadPrivateEmployee(request, employeeCode);
  return actorType(request) !== "employee" || actorCode(request) === String(employeeCode || "").trim();
}

function respondIfEmployeeCannotAccess(request: Request, response: Response, employeeCode: string) {
  if (employeeCanAccessRecord(request, employeeCode)) return false;
  response.status(403).json({ message: "You can only access your own employee profile." });
  return true;
}

function respondIfNotAdmin(request: Request, response: Response) {
  if (actorType(request) === "admin" && verifyAdminDashboardSession(request.header("x-crm-admin-session"))) return false;
  response.status(403).json({ message: "Administrator access is required." });
  return true;
}

const employeeSummaryFields = [
  "name",
  "dateHired",
  "terminationDate",
  "employeeCode",
  "aliases",
  "role",
  "team",
  "company",
  "email",
  "phone",
    "salary",
    "status",
    "availabilityStatus",
  "businessAccessIds",
].join(" ");

async function syncEmployeeBusinessAccess(
  employeeCode: string,
  businessAccessIds: string[],
  employeePayloadForTargets: ReturnType<typeof employeePayload>,
  previousEmployeeCode = "",
  sourceProfileImage = ""
) {
  const normalizedEmployeeCode = toText(employeeCode);
  const normalizedPreviousEmployeeCode = toText(previousEmployeeCode);
  const allowedBusinessIds = validBusinessAccessIds(businessAccessIds);

  if (!normalizedEmployeeCode) {
    return;
  }

  const configuredBusinessIds = getConfiguredBusinesses().map((business) => business.id);
  const safeTargetPayload = {
    ...employeePayloadForTargets,
    profileImage: Object.prototype.hasOwnProperty.call(employeePayloadForTargets, "profileImage")
      ? toProfileImage((employeePayloadForTargets as Record<string, unknown>).profileImage)
      : toProfileImage(sourceProfileImage),
  } as Record<string, unknown>;
  if (attendanceIntegrityEnabled()) delete safeTargetPayload.availabilityStatus;

  if (normalizedPreviousEmployeeCode && normalizedPreviousEmployeeCode !== normalizedEmployeeCode) {
    await deleteBusinessAccessForEmployeeCode(normalizedPreviousEmployeeCode);

    for (const businessId of configuredBusinessIds) {
      await runWithBusiness(businessId, async () => {
        await Employee.updateMany(
          { employeeCode: normalizedPreviousEmployeeCode },
          { $set: { businessAccessIds: [], status: "Archived" } }
        );
      });
    }
  }

  await setBusinessAccessForEmployeeCode(normalizedEmployeeCode, allowedBusinessIds);
  await syncCallBridgeBusinessIds(normalizedEmployeeCode, allowedBusinessIds);

  const allowedBusinessIdSet = new Set(allowedBusinessIds);

  for (const businessId of configuredBusinessIds) {
    await runWithBusiness(businessId, async () => {
      const existingEmployee = await Employee.findOne({ employeeCode: normalizedEmployeeCode });

      if (!allowedBusinessIdSet.has(businessId)) {
        if (existingEmployee) {
          existingEmployee.businessAccessIds = allowedBusinessIds;
          existingEmployee.status = "Archived";
          await existingEmployee.save();
        }
        return;
      }

      if (existingEmployee) {
        existingEmployee.set({
          ...safeTargetPayload,
          businessAccessIds: allowedBusinessIds,
        });
        existingEmployee.businessAccessIds = allowedBusinessIds;
        await existingEmployee.save();
        return;
      }

      await Employee.create({
        ...safeTargetPayload,
        businessAccessIds: allowedBusinessIds,
      });
    });
  }
}

async function verifyEmployeeBusinessAccess(employeeCode: string, businessAccessIds: unknown) {
  const allowedBusinessIds = validBusinessAccessIds(businessAccessIds);
  const allowedBusinessIdSet = new Set(allowedBusinessIds);
  const failures: string[] = [];

  for (const business of getConfiguredBusinesses()) {
    await runWithBusiness(business.id, async () => {
      const employee = await Employee.findOne({ employeeCode }).select("status businessAccessIds").lean();
      if (allowedBusinessIdSet.has(business.id)) {
        const storedAccessIds = normalizeBusinessAccessIds(employee?.businessAccessIds);
        if (!employee || employee.status === "Archived" || allowedBusinessIds.some((id) => !storedAccessIds.includes(id))) {
          failures.push(business.id);
        }
        return;
      }
      if (employee && employee.status !== "Archived") failures.push(business.id);
    });
  }

  if (failures.length) {
    throw new Error(`Employee synchronization verification failed for: ${failures.join(", ")}`);
  }
}

async function hasCurrentBusinessAccess(employee: { employeeCode?: unknown; businessAccessIds?: unknown }) {
  const controlBusinessIds = await getBusinessAccessForEmployeeCode(toText(employee.employeeCode));
  const accessBusinessIds = controlBusinessIds.length > 0
    ? controlBusinessIds
    : normalizeBusinessAccessIds(employee.businessAccessIds);

  if (accessBusinessIds.length === 0) {
    return true;
  }

  return accessBusinessIds.includes(getCurrentBusinessId());
}

async function syncSharedEmployeeFields(
  employeeCode: string,
  fallbackBusinessAccessIds: unknown,
  fields: Record<string, unknown>
) {
  const controlledBusinessIds = await getBusinessAccessForEmployeeCode(employeeCode);
  const businessIds = validBusinessAccessIds(
    controlledBusinessIds.length ? controlledBusinessIds : fallbackBusinessAccessIds
  );

  for (const businessId of businessIds) {
    await runWithBusiness(businessId, async () => {
      await Employee.updateOne({ employeeCode }, { $set: fields }, { runValidators: true });
    });
  }
}

export async function listEmployees(request: Request, response: Response) {
  const secure = securityDataMinimizationEnabled();
  const admin = Boolean(verifyAdminDashboardSession(request.header("x-crm-admin-session")));
  const isSummary = secure ? !(admin && String(request.query.summary).toLowerCase() === "false")
    : actorType(request) === "employee" || String(request.query.summary || "").toLowerCase() === "true";
  const includeArchived = String(request.query.includeArchived || "").toLowerCase() === "true";
  const actorCode = String(request.header("x-crm-user-code") || "").trim();
  const employeeFilter: Record<string, unknown> = includeArchived ? {} : { status: { $ne: "Archived" as EmployeeStatus } };

  if (isTrackerOnlyAdminCode(actorCode)) {
    employeeFilter.team = /^internal$/i;
  }

  const employeeQuery = Employee.find(employeeFilter).sort({ createdAt: -1 });

  if (isSummary) {
    employeeQuery.select(employeeSummaryFields);
  }

  const employees = await employeeQuery.lean();
  const employeesWithAccess = await Promise.all(
    employees.map(async (employee) => ({
      employee,
      hasAccess: await hasCurrentBusinessAccess(employee),
    }))
  );

  response.set("Cache-Control", "no-store");
  response.json(employeesWithAccess.filter(({ hasAccess }) => hasAccess).map(({ employee }) => secure
    ? employeeResponse(employee, { private: !isSummary && admin, adminSummary: admin }) : withNormalizedAvailability(employee)));
}

export async function getEmployee(request: Request, response: Response) {
  const isSummary = String(request.query.summary || "").toLowerCase() === "true";
  const employeeQuery = Employee.findById(request.params.id);

  if (isSummary) {
    employeeQuery.select(employeeSummaryFields);
  }

  const employee = await employeeQuery;

  if (!employee) {
    response.status(404).json({ message: "Employee not found" });
    return;
  }

  if (!(await hasCurrentBusinessAccess(employee))) {
    response.status(404).json({ message: "Employee not found" });
    return;
  }

  if (securityDataMinimizationEnabled()) {
    if (!isSummary && !canReadPrivateEmployee(request, employee.employeeCode)) {
      response.status(403).json({ message: "A signed owner or administrator session is required." });
      return;
    }
    response.set("Cache-Control", "no-store");
    response.json(employeeResponse(employee.toObject(), { private: !isSummary, adminSummary: Boolean(verifyAdminDashboardSession(request.header("x-crm-admin-session"))) }));
    return;
  }
  if (!isSummary && respondIfEmployeeCannotAccess(request, response, employee.employeeCode)) return;

  response.json(withNormalizedAvailability(employee.toObject()));
}

export async function createEmployee(request: Request, response: Response) {
  if (respondIfNotAdmin(request, response)) return;
  if (profileImageIsInvalid(request.body.profileImage)) {
    response.status(400).json({ message: "Profile picture must be a JPG, PNG, WebP, or GIF no larger than 2 MB." });
    return;
  }
  const payload = employeePayload(request.body);
  const existingByCode = await Employee.findOne({ employeeCode: payload.employeeCode });
  if (existingByCode && (!sameNormalizedName(existingByCode.name, payload.name) || toText(existingByCode.email).toLowerCase() !== toText(payload.email).toLowerCase())) {
    response.status(409).json({ message: "That employee code already belongs to another employee." });
    return;
  }
  const existingByEmail = payload.email
    ? await Employee.findOne({ email: payload.email, employeeCode: { $ne: payload.employeeCode } }).select("_id").lean()
    : null;
  if (existingByEmail) {
    response.status(409).json({ message: "That email address already belongs to another employee." });
    return;
  }

  await syncEmployeeBusinessAccess(
    payload.employeeCode,
    payload.businessAccessIds,
    payload,
    "",
    toProfileImage((payload as Record<string, unknown>).profileImage)
  );
  await verifyEmployeeBusinessAccess(payload.employeeCode, payload.businessAccessIds);
  await syncEmployeeAttendanceAcrossBusinesses(payload.employeeCode);
  await syncEmployeeCurrentPayrollAcrossBusinesses(payload.employeeCode, payload.businessAccessIds);
  const employee = await Employee.findOne({ employeeCode: payload.employeeCode });
  if (!employee) {
    response.status(500).json({ message: "Employee synchronization completed without creating the active-business record." });
    return;
  }
  emitCallDashboardUpdated(validBusinessAccessIds(employee.businessAccessIds));

  response.status(existingByCode ? 200 : 201).json(withNormalizedAvailability(employee.toObject()));
}

export async function updateEmployee(request: Request, response: Response) {
  if (respondIfNotAdmin(request, response)) return;
  const shouldUpdateProfileImage = Object.prototype.hasOwnProperty.call(request.body, "profileImage");
  if (shouldUpdateProfileImage && profileImageIsInvalid(request.body.profileImage)) {
    response.status(400).json({ message: "Profile picture must be a JPG, PNG, WebP, or GIF no larger than 2 MB." });
    return;
  }
  const existingEmployee = await Employee.findById(request.params.id);

  if (!existingEmployee) {
    response.status(404).json({ message: "Employee not found" });
    return;
  }

  const previousName = toText(existingEmployee.name);
  const previousEmployeeCode = toText(existingEmployee.employeeCode);
  const previousBusinessAccessIds = validBusinessAccessIds(existingEmployee.businessAccessIds);
  const payload = employeePayload(request.body, { includeProfileImage: shouldUpdateProfileImage });
  if (attendanceIntegrityEnabled()) delete (payload as Record<string, unknown>).availabilityStatus;

  if (previousName && !sameNormalizedName(previousName, payload.name)) {
    payload.aliases = toAliases([...payload.aliases, previousName]);
  }

  const employee = await Employee.findByIdAndUpdate(
    request.params.id,
    payload,
    { returnDocument: "after", runValidators: true }
  );

  if (!employee) {
    response.status(404).json({ message: "Employee not found" });
    return;
  }

  if (employee.status === "Archived") {
    await reassignLeadsFromAgent(String(employee._id));
  }

  await syncEmployeeBusinessAccess(employee.employeeCode, employee.businessAccessIds, payload, previousEmployeeCode, employee.profileImage);
  await verifyEmployeeBusinessAccess(employee.employeeCode, employee.businessAccessIds);
  await syncEmployeeAttendanceAcrossBusinesses(employee.employeeCode);
  await syncEmployeeCurrentPayrollAcrossBusinesses(employee.employeeCode, employee.businessAccessIds);
  await syncEmployeeNameReferences(employee.employeeCode, employee.businessAccessIds, previousName, employee.name);
  emitCallDashboardUpdated([
    ...previousBusinessAccessIds,
    ...validBusinessAccessIds(employee.businessAccessIds),
  ]);

  response.json(withNormalizedAvailability(employee.toObject()));
}

export async function updateEmployeeProfile(request: Request, response: Response) {
  const existingEmployee = await Employee.findById(request.params.id).select("employeeCode").lean();
  if (!existingEmployee) {
    response.status(404).json({ message: "Employee not found" });
    return;
  }
  if (respondIfEmployeeCannotAccess(request, response, existingEmployee.employeeCode)) return;

  const profileImageWasProvided = Object.prototype.hasOwnProperty.call(request.body, "profileImage");
  if (profileImageWasProvided && profileImageIsInvalid(request.body.profileImage)) {
    response.status(400).json({ message: "Profile picture must be a JPG, PNG, WebP, or GIF no larger than 2 MB." });
    return;
  }
  const profilePayload = {
    personalPhone: toText(request.body.personalPhone),
    personalEmail: toText(request.body.personalEmail),
    personalAddress: toText(request.body.personalAddress),
    emergencyContact: toText(request.body.emergencyContact),
    contactRelationship: toText(request.body.contactRelationship),
    emergencyContactNumber: toText(request.body.emergencyContactNumber),
    personalNotes: toText(request.body.personalNotes),
    bankName: toText(request.body.bankName),
    bankAccountName: toText(request.body.bankAccountName),
    bankAccountNumber: toText(request.body.bankAccountNumber),
    ...(profileImageWasProvided ? { profileImage: toProfileImage(request.body.profileImage) } : {}),
  };

  const employee = await Employee.findByIdAndUpdate(
    request.params.id,
    profilePayload,
    { returnDocument: "after", runValidators: true }
  );

  if (!employee) {
    response.status(404).json({ message: "Employee not found" });
    return;
  }

  await syncSharedEmployeeFields(employee.employeeCode, employee.businessAccessIds, profilePayload);

  response.json({
    message: "Personal details saved successfully.",
    employee: withNormalizedAvailability(employee.toObject()),
  });
}

export async function updateEmployeeBankDetails(request: Request, response: Response) {
  const existingEmployee = await Employee.findById(request.params.id).select("employeeCode").lean();
  if (!existingEmployee) {
    response.status(404).json({ message: "Employee not found" });
    return;
  }
  if (respondIfEmployeeCannotAccess(request, response, existingEmployee.employeeCode)) return;

  const bankPayload = {
    bankName: toText(request.body.bankName),
    bankAccountName: toText(request.body.bankAccountName),
    bankAccountNumber: toText(request.body.bankAccountNumber),
  };

  const employee = await Employee.findByIdAndUpdate(
    request.params.id,
    bankPayload,
    { returnDocument: "after", runValidators: true }
  );

  if (!employee) {
    response.status(404).json({ message: "Employee not found" });
    return;
  }

  await syncSharedEmployeeFields(employee.employeeCode, employee.businessAccessIds, bankPayload);

  response.json(withNormalizedAvailability(employee.toObject()));
}

export async function archiveEmployee(request: Request, response: Response) {
  if (respondIfNotAdmin(request, response)) return;
  const employee = await Employee.findByIdAndUpdate(
    request.params.id,
    { status: "Archived" },
    { returnDocument: "after", runValidators: true }
  );

  if (!employee) {
    response.status(404).json({ message: "Employee not found" });
    return;
  }

  const businessIds = validBusinessAccessIds(employee.businessAccessIds);
  for (const businessId of businessIds) {
    await runWithBusiness(businessId, async () => {
      const businessEmployee = await Employee.findOne({ employeeCode: employee.employeeCode });
      if (!businessEmployee) return;
      await reassignLeadsFromAgent(String(businessEmployee._id));
      businessEmployee.status = "Archived";
      await businessEmployee.save();
    });
  }
  emitCallDashboardUpdated(businessIds);

  response.json(withNormalizedAvailability(employee.toObject()));
}

export async function deleteEmployee(request: Request, response: Response) {
  if (respondIfNotAdmin(request, response)) return;
  const employee = await Employee.findByIdAndDelete(request.params.id);

  if (!employee) {
    response.status(404).json({ message: "Employee not found" });
    return;
  }

  const businessIds = validBusinessAccessIds(employee.businessAccessIds);
  for (const businessId of getConfiguredBusinesses().map((business) => business.id)) {
    await runWithBusiness(businessId, async () => {
      const businessEmployee = await Employee.findOne({ employeeCode: employee.employeeCode });
      if (!businessEmployee) return;
      await reassignLeadsFromAgent(String(businessEmployee._id));
      await businessEmployee.deleteOne();
    });
  }
  await deleteBusinessAccessForEmployeeCode(employee.employeeCode);
  emitCallDashboardUpdated(businessIds);

  response.json(withNormalizedAvailability(employee.toObject()));
}
