import type { Request, Response } from "express";
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

function toSalary(value: unknown) {
  const salary = Number(value);
  return Number.isFinite(salary) && salary >= 0 ? Math.round(salary * 100) / 100 : 0;
}

function toProfileImage(value: unknown) {
  const image = String(value || "").trim();
  if (!image) return "";
  return /^data:image\/(?:png|jpe?g|webp|gif);base64,/i.test(image) ? image : "";
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

async function syncEmployeeNameReferences(employeeId: string, previousName: string, nextName: string) {
  if (!previousName || !nextName || sameNormalizedName(previousName, nextName)) {
    return;
  }

  await Promise.all([
    Lead.updateMany(
      { $or: [{ assignedAgent: employeeId }, { assignedAgentName: previousName }] },
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
  previousEmployeeCode = ""
) {
  const normalizedEmployeeCode = toText(employeeCode);
  const normalizedPreviousEmployeeCode = toText(previousEmployeeCode);
  const allowedBusinessIds = validBusinessAccessIds(businessAccessIds);

  if (!normalizedEmployeeCode) {
    return;
  }

  const configuredBusinessIds = getConfiguredBusinesses().map((business) => business.id);
  const safeTargetPayload = { ...employeePayloadForTargets } as Record<string, unknown>;
  delete safeTargetPayload.profileImage;

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
          profileImage: existingEmployee.profileImage || "",
          businessAccessIds: allowedBusinessIds,
        });
        existingEmployee.businessAccessIds = allowedBusinessIds;
        await existingEmployee.save();
        return;
      }

      await Employee.create({
        ...safeTargetPayload,
        profileImage: "",
        businessAccessIds: allowedBusinessIds,
      });
    });
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

export async function listEmployees(request: Request, response: Response) {
  const isSummary = String(request.query.summary || "").toLowerCase() === "true";
  const includeArchived = String(request.query.includeArchived || "").toLowerCase() === "true";
  const employeeQuery = (includeArchived ? Employee.find() : Employee.find({ status: { $ne: "Archived" as EmployeeStatus } })).sort({ createdAt: -1 });

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

  response.json(employeesWithAccess.filter(({ hasAccess }) => hasAccess).map(({ employee }) => withNormalizedAvailability(employee)));
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

  response.json(withNormalizedAvailability(employee.toObject()));
}

export async function createEmployee(request: Request, response: Response) {
  const payload = employeePayload(request.body);
  const employee = await Employee.create(payload);
  await syncEmployeeBusinessAccess(employee.employeeCode, employee.businessAccessIds, payload);
  emitCallDashboardUpdated(validBusinessAccessIds(employee.businessAccessIds));

  response.status(201).json(withNormalizedAvailability(employee.toObject()));
}

export async function updateEmployee(request: Request, response: Response) {
  const shouldUpdateProfileImage = Object.prototype.hasOwnProperty.call(request.body, "profileImage");
  const existingEmployee = await Employee.findById(request.params.id);

  if (!existingEmployee) {
    response.status(404).json({ message: "Employee not found" });
    return;
  }

  const previousName = toText(existingEmployee.name);
  const previousEmployeeCode = toText(existingEmployee.employeeCode);
  const previousBusinessAccessIds = validBusinessAccessIds(existingEmployee.businessAccessIds);
  const payload = employeePayload(request.body, { includeProfileImage: shouldUpdateProfileImage });

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

  await syncEmployeeNameReferences(String(employee._id), previousName, employee.name);
  await syncEmployeeBusinessAccess(employee.employeeCode, employee.businessAccessIds, payload, previousEmployeeCode);
  emitCallDashboardUpdated([
    ...previousBusinessAccessIds,
    ...validBusinessAccessIds(employee.businessAccessIds),
  ]);

  response.json(withNormalizedAvailability(employee.toObject()));
}

export async function updateEmployeeProfile(request: Request, response: Response) {
  const profilePayload = {
    personalPhone: toText(request.body.personalPhone),
    personalEmail: toText(request.body.personalEmail),
    personalAddress: toText(request.body.personalAddress),
    emergencyContact: toText(request.body.emergencyContact),
    contactRelationship: toText(request.body.contactRelationship),
    emergencyContactNumber: toText(request.body.emergencyContactNumber),
    personalNotes: toText(request.body.personalNotes),
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

  response.json({
    message: "Personal details saved successfully.",
    employee: withNormalizedAvailability(employee.toObject()),
  });
}

export async function updateEmployeeBankDetails(request: Request, response: Response) {
  const bankPayload = {
    bankName: toText(request.body.bankName),
    bankAccountName: toText(request.body.bankAccountName),
    bankAccountNumber: toText(request.body.bankAccountNumber),
    bankRoutingNumber: toText(request.body.bankRoutingNumber),
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

  response.json(withNormalizedAvailability(employee.toObject()));
}

export async function archiveEmployee(request: Request, response: Response) {
  const employee = await Employee.findByIdAndUpdate(
    request.params.id,
    { status: "Archived" },
    { returnDocument: "after", runValidators: true }
  );

  if (!employee) {
    response.status(404).json({ message: "Employee not found" });
    return;
  }

  await reassignLeadsFromAgent(String(employee._id));
  emitCallDashboardUpdated(validBusinessAccessIds(employee.businessAccessIds));

  response.json(withNormalizedAvailability(employee.toObject()));
}

export async function deleteEmployee(request: Request, response: Response) {
  const employee = await Employee.findByIdAndDelete(request.params.id);

  if (!employee) {
    response.status(404).json({ message: "Employee not found" });
    return;
  }

  await reassignLeadsFromAgent(String(employee._id));
  emitCallDashboardUpdated(validBusinessAccessIds(employee.businessAccessIds));

  response.json(withNormalizedAvailability(employee.toObject()));
}
