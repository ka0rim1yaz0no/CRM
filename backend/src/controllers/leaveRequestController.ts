import type { Request, Response } from "express";
import { LeaveRequest, type LeaveRequestStatus, type LeaveRequestType } from "../models/LeaveRequest";
import { recordEmployeeTransaction } from "./employeeTransactionController";
import { syncSharedEmployeeRecords } from "../services/employeeRecordSyncService";

const leaveRequestTypes: LeaveRequestType[] = ["Vacation", "Sick", "Emergency", "Personal", "Other"];
const leaveRequestStatuses: LeaveRequestStatus[] = ["Pending", "Approved", "Rejected"];

type LeaveRequestInput = {
  leaveType: LeaveRequestType;
  startDate: Date | null;
  endDate: Date | null;
  selectedDates: Date[];
  reason: string;
};

type ValidLeaveRequestInput = {
  leaveType: LeaveRequestType;
  startDate: Date;
  endDate: Date;
  selectedDates: Date[];
  reason: string;
};

function parsePhDateInput(value: unknown, boundary: "start" | "end") {
  const normalizedValue = String(value || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalizedValue)) {
    return null;
  }

  const time = boundary === "end" ? "23:59:59.999" : "00:00:00.000";
  const date = new Date(`${normalizedValue}T${time}+08:00`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function normalizeLeaveType(value: unknown): LeaveRequestType {
  const leaveType = String(value || "").trim() as LeaveRequestType;
  return leaveRequestTypes.includes(leaveType) ? leaveType : "Vacation";
}

function normalizeStatus(value: unknown) {
  const status = String(value || "").trim() as LeaveRequestStatus;
  return leaveRequestStatuses.includes(status) ? status : undefined;
}

function uniqueSortedDateKeys(dates: unknown[]) {
  const dateKeys = dates
    .map((dateValue) => String(dateValue || "").trim())
    .filter((dateValue) => /^\d{4}-\d{2}-\d{2}$/.test(dateValue) && Boolean(parsePhDateInput(dateValue, "start")));

  return Array.from(new Set(dateKeys)).sort((firstKey, secondKey) => firstKey.localeCompare(secondKey));
}

function parseSelectedDateKeys(value: unknown) {
  if (!Array.isArray(value)) {
    return [];
  }

  return uniqueSortedDateKeys(value);
}

function populateLeaveRequest(query: ReturnType<typeof LeaveRequest.find>) {
  return query.populate({ path: "employee", select: "name employeeCode team role email" });
}

function populateSingleLeaveRequest(query: ReturnType<typeof LeaveRequest.findById>) {
  return query.populate({ path: "employee", select: "name employeeCode team role email" });
}

function getLeaveRequestInput(request: Request) {
  const selectedDateKeys = parseSelectedDateKeys(request.body.selectedDates);
  const selectedDates = selectedDateKeys
    .map((dateValue) => parsePhDateInput(dateValue, "start"))
    .filter((date): date is Date => Boolean(date));
  const startDate = selectedDates[0] || parsePhDateInput(request.body.startDate, "start");
  const endDate = selectedDates.length > 0
    ? parsePhDateInput(selectedDateKeys[selectedDateKeys.length - 1], "end")
    : parsePhDateInput(request.body.endDate, "end");
  const reason = String(request.body.reason || "").trim();

  return {
    leaveType: normalizeLeaveType(request.body.leaveType),
    startDate,
    endDate,
    selectedDates,
    reason,
  };
}

function validateLeaveRequestInput(
  response: Response,
  input: LeaveRequestInput
): input is ValidLeaveRequestInput {
  if (!input.startDate || !input.endDate) {
    response.status(400).json({ message: "Start and end dates are required" });
    return false;
  }

  if (input.endDate.getTime() < input.startDate.getTime()) {
    response.status(400).json({ message: "End date cannot be before start date" });
    return false;
  }

  if (!input.reason) {
    response.status(400).json({ message: "Reason is required" });
    return false;
  }

  return true;
}

export async function listEmployeeLeaveRequests(request: Request, response: Response) {
  if (request.business?.id) await syncSharedEmployeeRecords(request.business.id);
  const employeeId = String(request.params.employeeId);
  const leaveRequests = await LeaveRequest.find({ employee: employeeId }).sort({ createdAt: -1 });
  response.json(leaveRequests);
}

export async function listLeaveRequests(request: Request, response: Response) {
  if (request.business?.id) await syncSharedEmployeeRecords(request.business.id);
  const filter: Record<string, unknown> = {};
  const employeeId = String(request.query.employee || "").trim();
  const status = normalizeStatus(request.query.status);

  if (employeeId) {
    filter.employee = employeeId;
  }

  if (status) {
    filter.status = status;
  }

  const leaveRequests = await populateLeaveRequest(LeaveRequest.find(filter).sort({ createdAt: -1 }));
  response.json(leaveRequests);
}

export async function createEmployeeLeaveRequest(request: Request, response: Response) {
  const employeeId = String(request.params.employeeId);
  const input = getLeaveRequestInput(request);

  if (!validateLeaveRequestInput(response, input)) {
    return;
  }

  const leaveRequest = await LeaveRequest.create({
    employee: employeeId,
    leaveType: input.leaveType,
    startDate: input.startDate,
    endDate: input.endDate,
    selectedDates: input.selectedDates.length > 0 ? input.selectedDates : [input.startDate],
    reason: input.reason,
  });

  await recordEmployeeTransaction({
    employee: employeeId,
    category: "System",
    title: "Leave request submitted",
    description: `Employee submitted ${leaveRequest.leaveType.toLowerCase()} leave.`,
    metadata: { leaveRequestId: leaveRequest._id.toString(), status: leaveRequest.status },
  });

  response.status(201).json(leaveRequest);
}

export async function updateEmployeeLeaveRequest(request: Request, response: Response) {
  const employeeId = String(request.params.employeeId);
  const input = getLeaveRequestInput(request);

  if (!validateLeaveRequestInput(response, input)) {
    return;
  }

  const leaveRequest = await LeaveRequest.findOneAndUpdate(
    { _id: request.params.requestId, employee: employeeId, status: "Pending" },
    {
      leaveType: input.leaveType,
      startDate: input.startDate,
      endDate: input.endDate,
      selectedDates: input.selectedDates.length > 0 ? input.selectedDates : [input.startDate],
      reason: input.reason,
    },
    { returnDocument: "after", runValidators: true }
  );

  if (!leaveRequest) {
    response.status(404).json({ message: "Pending leave request not found" });
    return;
  }

  await recordEmployeeTransaction({
    employee: employeeId,
    category: "System",
    title: "Leave request updated",
    description: `Employee updated ${leaveRequest.leaveType.toLowerCase()} leave request.`,
    metadata: { leaveRequestId: leaveRequest._id.toString(), status: leaveRequest.status },
  });

  response.json(leaveRequest);
}

export async function commentLeaveRequest(request: Request, response: Response) {
  const adminNote = String(request.body.adminNote || "").trim();
  const reviewedBy = String(request.body.reviewedBy || "Admin").trim() || "Admin";

  if (!adminNote) {
    response.status(400).json({ message: "Comment is required" });
    return;
  }

  const leaveRequest = await LeaveRequest.findOneAndUpdate(
    { _id: request.params.requestId, status: "Pending" },
    {
      $push: {
        comments: {
          authorType: "Admin",
          authorName: reviewedBy,
          message: adminNote,
          createdAt: new Date(),
        },
      },
    },
    { returnDocument: "after", runValidators: true }
  );

  if (!leaveRequest) {
    response.status(404).json({ message: "Pending leave request not found" });
    return;
  }

  await recordEmployeeTransaction({
    employee: leaveRequest.employee,
    category: "System",
    title: "Leave request comment",
    description: `${reviewedBy} commented on ${leaveRequest.leaveType.toLowerCase()} leave.`,
    metadata: { leaveRequestId: leaveRequest._id.toString(), status: leaveRequest.status },
  });

  const populatedLeaveRequest = await populateSingleLeaveRequest(LeaveRequest.findById(leaveRequest._id));
  response.json(populatedLeaveRequest || leaveRequest);
}

export async function replyToLeaveRequest(request: Request, response: Response) {
  const employeeId = String(request.params.employeeId);
  const message = String(request.body.message || "").trim();
  const authorName = String(request.body.authorName || "Employee").trim() || "Employee";

  if (!message) {
    response.status(400).json({ message: "Reply is required" });
    return;
  }

  const leaveRequest = await LeaveRequest.findOneAndUpdate(
    { _id: request.params.requestId, employee: employeeId, status: "Pending" },
    {
      $push: {
        comments: {
          authorType: "Employee",
          authorName,
          message,
          createdAt: new Date(),
        },
      },
    },
    { returnDocument: "after", runValidators: true }
  );

  if (!leaveRequest) {
    response.status(404).json({ message: "Pending leave request not found" });
    return;
  }

  await recordEmployeeTransaction({
    employee: employeeId,
    category: "System",
    title: "Leave request reply",
    description: `${authorName} replied to ${leaveRequest.leaveType.toLowerCase()} leave.`,
    metadata: { leaveRequestId: leaveRequest._id.toString(), status: leaveRequest.status },
  });

  response.json(leaveRequest);
}

async function reviewLeaveRequest(request: Request, response: Response, status: Exclude<LeaveRequestStatus, "Pending">) {
  const adminNote = String(request.body.adminNote || "").trim();
  const reviewedBy = String(request.body.reviewedBy || "Admin").trim() || "Admin";
  const reviewUpdate: Record<string, unknown> = {
    status,
    reviewedBy,
    reviewedAt: new Date(),
  };

  if (adminNote) {
    reviewUpdate.adminNote = adminNote;
  }

  const leaveRequest = await LeaveRequest.findOneAndUpdate(
    { _id: request.params.requestId, status: "Pending" },
    reviewUpdate,
    { returnDocument: "after", runValidators: true }
  );

  if (!leaveRequest) {
    response.status(404).json({ message: "Pending leave request not found" });
    return;
  }

  await recordEmployeeTransaction({
    employee: leaveRequest.employee,
    category: "System",
    title: `Leave request ${status.toLowerCase()}`,
    description: `${reviewedBy} ${status.toLowerCase()} ${leaveRequest.leaveType.toLowerCase()} leave.`,
    metadata: { leaveRequestId: leaveRequest._id.toString(), status },
  });

  const populatedLeaveRequest = await populateSingleLeaveRequest(LeaveRequest.findById(leaveRequest._id));
  response.json(populatedLeaveRequest || leaveRequest);
}

export async function approveLeaveRequest(request: Request, response: Response) {
  await reviewLeaveRequest(request, response, "Approved");
}

export async function rejectLeaveRequest(request: Request, response: Response) {
  await reviewLeaveRequest(request, response, "Rejected");
}
