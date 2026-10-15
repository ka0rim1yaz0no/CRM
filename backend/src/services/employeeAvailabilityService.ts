import { getConfiguredBusinesses, runForEachBusiness, runWithBusiness } from "../config/tenancy";
import { attendanceV2Enabled } from "../config/rolloutFlags";
import { Employee, type EmployeeAvailabilityStatus } from "../models/Employee";
import { getEmployeeAvailabilitySyncModel, type EmployeeAvailabilitySyncDocument } from "../models/EmployeeAvailabilitySync";

type AvailabilityChange = Pick<EmployeeAvailabilitySyncDocument,
  "employeeCode" | "availabilityStatus" | "availabilityStatusReason" | "revision" | "pendingBusinessIds">;

async function deliverAvailabilityChange(change: AvailabilityChange) {
  const results = await Promise.allSettled(change.pendingBusinessIds.map((businessId) =>
    runWithBusiness(businessId, async () => {
      const filter = { employeeCode: change.employeeCode, status: { $ne: "Archived" as const },
        $or: [{ availabilityRevision: { $exists: false } }, { availabilityRevision: { $lt: change.revision } }] };
      const updated = await Employee.findOneAndUpdate(filter, { $set: {
        availabilityStatus: change.availabilityStatus,
        availabilityStatusReason: change.availabilityStatusReason,
        availabilityRevision: change.revision,
      } }, { returnDocument: "after", runValidators: true }).select("_id").lean();
      const employee = updated || await Employee.findOne({ employeeCode: change.employeeCode,
        status: { $ne: "Archived" } }).select("_id").lean();
      return employee ? { businessId, employeeId: String(employee._id) } : null;
    })
  ));
  const pendingBusinessIds = change.pendingBusinessIds.filter((_, index) => results[index].status === "rejected");
  const Outbox = getEmployeeAvailabilitySyncModel();
  await Outbox.updateOne({ employeeCode: change.employeeCode, revision: change.revision }, {
    $set: { pendingBusinessIds, lastErrorAt: pendingBusinessIds.length ? new Date() : null },
    $inc: { attempts: 1 },
  });
  return results.flatMap((result) => result.status === "fulfilled" && result.value ? [result.value] : []);
}

async function queueAvailabilityChange(employeeCode: string, availabilityStatus: EmployeeAvailabilityStatus,
  availabilityStatusReason: string) {
  const Outbox = getEmployeeAvailabilitySyncModel();
  await Outbox.init();
  const update = { $set: { availabilityStatus, availabilityStatusReason,
    pendingBusinessIds: getConfiguredBusinesses().map((business) => business.id) }, $inc: { revision: 1 } };
  try {
    return await Outbox.findOneAndUpdate({ employeeCode }, update,
      { upsert: true, returnDocument: "after", setDefaultsOnInsert: true }).lean();
  } catch (error) {
    if ((error as { code?: number })?.code !== 11000) throw error;
    return Outbox.findOneAndUpdate({ employeeCode }, update, { returnDocument: "after" }).lean();
  }
}

export async function retryPendingEmployeeAvailability(limit = 100) {
  if (!attendanceV2Enabled()) return 0;
  const Outbox = getEmployeeAvailabilitySyncModel();
  const pending = await Outbox.find({ pendingBusinessIds: { $ne: [] } })
    .sort({ lastErrorAt: 1, updatedAt: 1 }).limit(limit).lean();
  for (const change of pending) await deliverAvailabilityChange(change);
  return pending.length;
}

export async function syncEmployeeAvailabilityAcrossBusinesses(
  employeeCode: string,
  availabilityStatus: EmployeeAvailabilityStatus,
  availabilityStatusReason = ""
) {
  const normalizedEmployeeCode = String(employeeCode || "").trim();
  const updatedEmployees: Array<{ businessId: string; employeeId: string }> = [];

  if (!normalizedEmployeeCode) return updatedEmployees;

  if (attendanceV2Enabled()) {
    const change = await queueAvailabilityChange(normalizedEmployeeCode, availabilityStatus, availabilityStatusReason);
    if (!change) throw new Error("Could not queue employee availability change");
    return deliverAvailabilityChange(change);
  }

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
