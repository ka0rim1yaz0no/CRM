import { runForEachBusiness } from "../config/tenancy";
import { Employee, type EmployeeAvailabilityStatus } from "../models/Employee";

export async function syncEmployeeAvailabilityAcrossBusinesses(
  employeeCode: string,
  availabilityStatus: EmployeeAvailabilityStatus,
  availabilityStatusReason = ""
) {
  const normalizedEmployeeCode = String(employeeCode || "").trim();
  const updatedEmployees: Array<{ businessId: string; employeeId: string }> = [];

  if (!normalizedEmployeeCode) return updatedEmployees;

  await runForEachBusiness(async (business) => {
    await Employee.updateMany(
      { employeeCode: normalizedEmployeeCode, status: { $ne: "Archived" } },
      { $set: { availabilityStatus, availabilityStatusReason } },
      { runValidators: true }
    );

    const employees = await Employee.find(
      { employeeCode: normalizedEmployeeCode, status: { $ne: "Archived" } },
      { _id: 1 }
    );

    employees.forEach((employee) => {
      updatedEmployees.push({ businessId: business.id, employeeId: String(employee._id) });
    });
  });

  return updatedEmployees;
}
