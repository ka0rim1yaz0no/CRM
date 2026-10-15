import "dotenv/config";
import mongoose from "mongoose";
import { connectDatabase } from "../config/db";
import { getConfiguredBusinesses, refreshConfiguredBusinessesFromStore, runWithBusiness } from "../config/tenancy";
import { Attendance } from "../models/Attendance";
import { Employee } from "../models/Employee";

await connectDatabase(process.env.MONGODB_URI || "");
await refreshConfiguredBusinessesFromStore();

// Dry-run only. This command never rewrites or archives attendance history.
const eventCounts = new Map<string, Map<string, number>>();
const memberBusinesses = new Map<string, Set<string>>();
const eventEmployees = new Map<string, string>();
for (const business of getConfiguredBusinesses()) {
  await runWithBusiness(business.id, async () => {
    const employees = await Employee.find({ status: { $ne: "Archived" } }).select("_id employeeCode").lean();
    const employeeCodes = new Map(employees.map((employee) => [String(employee._id), employee.employeeCode]));
    for (const employee of employees) {
      const memberships = memberBusinesses.get(employee.employeeCode) || new Set<string>();
      memberships.add(business.id);
      memberBusinesses.set(employee.employeeCode, memberships);
    }
    const records = await Attendance.find({ employee: { $in: employees.map((employee) => employee._id) },
      isArchived: { $ne: true } }).select("employee eventId source timeIn").lean();
    for (const record of records) {
      const code = employeeCodes.get(String(record.employee));
      if (!code) continue;
      const key = record.eventId || `${record.source}|${record.timeIn.toISOString()}`;
      const eventKey = JSON.stringify([code, key]);
      const perBusiness = eventCounts.get(eventKey) || new Map<string, number>();
      perBusiness.set(business.id, (perBusiness.get(business.id) || 0) + 1);
      eventCounts.set(eventKey, perBusiness);
      eventEmployees.set(eventKey, code);
    }
  });
}
const differences = Array.from(eventCounts.entries()).filter(([eventKey, counts]) =>
  counts.size !== memberBusinesses.get(eventEmployees.get(eventKey) || "")?.size ||
  Array.from(counts.values()).some((count) => count !== 1)).length;
console.log(JSON.stringify({ dryRun: true, businesses: getConfiguredBusinesses().length,
  eventsChecked: eventCounts.size, differingEvents: differences }));
await mongoose.disconnect();
