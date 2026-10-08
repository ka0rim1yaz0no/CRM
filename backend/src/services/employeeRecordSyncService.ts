import { getConfiguredBusinesses, runWithBusiness } from "../config/tenancy";
import { Employee } from "../models/Employee";
import { LeaveRequest, type LeaveRequestType } from "../models/LeaveRequest";
import { Notice } from "../models/Notice";
import { EmployeeEvaluation } from "../models/EmployeeEvaluation";

type SharedNotice = Record<string, unknown> & { employeeCode: string; createdAt: Date; updatedAt: Date; isRead: boolean };
type SharedLeave = Record<string, unknown> & { employeeCode: string; createdAt: Date; updatedAt: Date };
type SharedEvaluation = Record<string, unknown> & { employeeCode: string; createdAt: Date; updatedAt: Date; dueDate: Date };
const activeSyncs = new Map<string, Promise<void>>();

function noticeKey(record: SharedNotice) {
  return [record.employeeCode, record.createdAt.toISOString(), record.title, record.message, record.issuedBy].join("::");
}

function leaveKey(record: SharedLeave) {
  return [record.employeeCode, record.createdAt.toISOString(), record.leaveType, new Date(record.startDate as Date).toISOString(), new Date(record.endDate as Date).toISOString(), record.reason].join("::");
}

function evaluationKey(record: SharedEvaluation) {
  return [record.employeeCode, record.milestoneMonth, record.dueDate.toISOString().slice(0, 10)].join("::");
}

async function readSharedRecords(businessId: string) {
  return runWithBusiness(businessId, async () => {
    const employees = await Employee.find({ status: { $ne: "Archived" } }).select("_id employeeCode").lean();
    const codeById = new Map(employees.map((employee) => [String(employee._id), employee.employeeCode]));
    const [noticeRows, leaveRows, evaluationRows] = await Promise.all([Notice.find().lean(), LeaveRequest.find().lean(), EmployeeEvaluation.find().lean()]);
    const notices = noticeRows.flatMap((record) => {
      const employeeCode = codeById.get(String(record.employee));
      if (!employeeCode) return [];
      return [{ ...record, employeeCode, createdAt: new Date((record as unknown as { createdAt: Date }).createdAt), updatedAt: new Date((record as unknown as { updatedAt: Date }).updatedAt), isRead: Boolean(record.isRead) } as SharedNotice];
    });
    const leaves = leaveRows.flatMap((record) => {
      const employeeCode = codeById.get(String(record.employee));
      if (!employeeCode) return [];
      return [{ ...record, employeeCode, createdAt: new Date((record as unknown as { createdAt: Date }).createdAt), updatedAt: new Date((record as unknown as { updatedAt: Date }).updatedAt) } as SharedLeave];
    });
    const evaluations = evaluationRows.flatMap((record) => {
      const employeeCode = String(record.employeeCode || codeById.get(String(record.employee)) || "").trim();
      if (!employeeCode) return [];
      return [{
        ...record,
        employeeCode,
        dueDate: new Date(record.dueDate),
        createdAt: new Date((record as unknown as { createdAt: Date }).createdAt),
        updatedAt: new Date((record as unknown as { updatedAt: Date }).updatedAt),
      } as SharedEvaluation];
    });
    return { notices, leaves, evaluations };
  });
}

function mergeRecords(groups: Array<{ notices: SharedNotice[]; leaves: SharedLeave[]; evaluations: SharedEvaluation[] }>) {
  const notices = new Map<string, SharedNotice>();
  const leaves = new Map<string, SharedLeave>();
  const evaluations = new Map<string, SharedEvaluation>();
  for (const record of groups.flatMap((group) => group.notices)) {
    const key = noticeKey(record);
    const current = notices.get(key);
    if (!current || record.updatedAt > current.updatedAt) notices.set(key, record);
    const merged = notices.get(key)!;
    merged.isRead = Boolean(merged.isRead || current?.isRead || record.isRead);
    const acknowledgements = [merged.acknowledgedAt, current?.acknowledgedAt, record.acknowledgedAt]
      .filter(Boolean).map((value) => new Date(value as Date)).sort((a, b) => b.getTime() - a.getTime());
    if (acknowledgements[0]) merged.acknowledgedAt = acknowledgements[0];
  }
  for (const record of groups.flatMap((group) => group.leaves)) {
    const key = leaveKey(record);
    const current = leaves.get(key);
    if (!current || record.updatedAt > current.updatedAt) leaves.set(key, record);
  }
  for (const record of groups.flatMap((group) => group.evaluations)) {
    const key = evaluationKey(record);
    const current = evaluations.get(key);
    if (!current || record.updatedAt > current.updatedAt) evaluations.set(key, record);
  }
  return { notices: [...notices.values()], leaves: [...leaves.values()], evaluations: [...evaluations.values()] };
}

async function performSync(targetBusinessId: string) {
  const merged = mergeRecords(await Promise.all(getConfiguredBusinesses().map((business) => readSharedRecords(business.id))));
  await runWithBusiness(targetBusinessId, async () => {
    const employees = await Employee.find({ status: { $ne: "Archived" } }).select("_id employeeCode").lean();
    const employeeByCode = new Map(employees.map((employee) => [employee.employeeCode, employee]));

    for (const record of merged.notices) {
      const employee = employeeByCode.get(record.employeeCode);
      if (!employee) continue;
      const filter = { employee: employee._id, createdAt: record.createdAt, title: String(record.title || ""), message: String(record.message || "") };
      const existing = await Notice.findOne(filter) as InstanceType<typeof Notice> | null;
      const payload = {
        employee: employee._id,
        title: String(record.title || ""),
        message: String(record.message || ""),
        severity: record.severity,
        issuedBy: record.issuedBy,
        isRead: Boolean(record.isRead),
        href: record.href,
        source: record.source,
        sourceId: record.sourceId,
        acknowledgedAt: record.acknowledgedAt,
        replies: record.replies,
      };
      if (existing) {
        existing.set({ ...payload, isRead: Boolean(existing.isRead || record.isRead) });
        await existing.save();
      } else {
        await Notice.collection.insertOne({ ...payload, createdAt: record.createdAt, updatedAt: record.updatedAt, __v: 0 });
      }
    }

    for (const record of merged.leaves) {
      const employee = employeeByCode.get(record.employeeCode);
      if (!employee) continue;
      const filter = {
        employee: employee._id,
        createdAt: record.createdAt,
        leaveType: String(record.leaveType || "Vacation") as LeaveRequestType,
        startDate: new Date(record.startDate as Date),
        endDate: new Date(record.endDate as Date),
      };
      const existing = await LeaveRequest.findOne(filter);
      const payload = {
        employee: employee._id,
        leaveType: record.leaveType,
        startDate: record.startDate,
        endDate: record.endDate,
        selectedDates: record.selectedDates,
        reason: record.reason,
        status: record.status,
        adminNote: record.adminNote,
        comments: record.comments,
        reviewedBy: record.reviewedBy,
        reviewedAt: record.reviewedAt,
      };
      if (existing) {
        if (record.updatedAt > new Date((existing as unknown as { updatedAt: Date }).updatedAt)) {
          existing.set(payload);
          await existing.save();
        }
      } else {
        await LeaveRequest.collection.insertOne({ ...payload, createdAt: record.createdAt, updatedAt: record.updatedAt, __v: 0 });
      }
    }

    for (const record of merged.evaluations) {
      const employee = employeeByCode.get(record.employeeCode);
      if (!employee) continue;
      const milestoneMonth = Number(record.milestoneMonth) as 1 | 3 | 6;
      if (![1, 3, 6].includes(milestoneMonth)) continue;
      const filter = {
        employeeCode: record.employeeCode,
        milestoneMonth,
        dueDate: record.dueDate,
      };
      const existing = await EmployeeEvaluation.findOne(filter);
      const payload = {
        employee: employee._id,
        employeeCode: record.employeeCode,
        employeeName: String(record.employeeName || "Employee"),
        milestoneMonth,
        dueDate: record.dueDate,
        status: record.status,
        rating: record.rating,
        strengths: record.strengths,
        improvementAreas: record.improvementAreas,
        managerNotes: record.managerNotes,
        reviewedBy: record.reviewedBy,
        completedAt: record.completedAt,
      };
      if (existing) {
        if (record.updatedAt > new Date((existing as unknown as { updatedAt: Date }).updatedAt)) {
          existing.set(payload);
          await existing.save();
        }
      } else {
        await EmployeeEvaluation.collection.insertOne({ ...payload, createdAt: record.createdAt, updatedAt: record.updatedAt, __v: 0 });
      }
    }
  });
}

export async function syncSharedEmployeeRecords(targetBusinessId: string) {
  const existing = activeSyncs.get(targetBusinessId);
  if (existing) return existing;
  const sync = performSync(targetBusinessId).finally(() => activeSyncs.delete(targetBusinessId));
  activeSyncs.set(targetBusinessId, sync);
  return sync;
}

export async function syncSharedEmployeeRecordsToAllBusinesses() {
  for (const business of getConfiguredBusinesses()) {
    await syncSharedEmployeeRecords(business.id);
  }
}
