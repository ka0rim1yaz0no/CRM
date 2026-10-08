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
    const employee = await Employee.findOneAndUpdate(
      { employeeCode: normalizedEmployeeCode, status: { $ne: "Archived" } },
      { $set: { availabilityStatus, availabilityStatusReason } },
      { returnDocument: "after", runValidators: true }
    );

    if (employee) {
      updatedEmployees.push({ businessId: business.id, employeeId: String(employee._id) });
    }
  });

  return updatedEmployees;
}
