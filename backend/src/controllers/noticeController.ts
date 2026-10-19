import type { Request, Response } from "express";
import mongoose from "mongoose";
import { verifyAdminDashboardSession } from "../config/adminDashboardSession";
import { verifyAttendanceHubSession } from "../config/attendanceHubSession";
import { getBusinessById, runWithBusiness } from "../config/tenancy";
import { getBusinessAccessForEmployeeCode } from "../models/BusinessUserAccess";
import { Employee } from "../models/Employee";
import { Notice } from "../models/Notice";
import { recordEmployeeTransaction } from "./employeeTransactionController";
import { syncSharedEmployeeRecords } from "../services/employeeRecordSyncService";

export async function listRecentNotices(request: Request, response: Response) {
  if (request.business?.id) await syncSharedEmployeeRecords(request.business.id);
  const notices = await Notice.find()
    .populate({ path: "employee", select: "name employeeCode team role" })
    .sort({ createdAt: -1 })
    .limit(20);
  response.json(notices);
}

export async function listEmployeeNotices(request: Request, response: Response) {
  if (request.business?.id) await syncSharedEmployeeRecords(request.business.id);
  const employeeId = String(request.params.employeeId);
  const notices = await Notice.find({ employee: employeeId }).sort({ createdAt: -1 });
  response.json(notices);
}

export async function createEmployeeNotice(request: Request, response: Response) {
  const employeeId = String(request.params.employeeId);
  const notice = await Notice.create({
    employee: employeeId,
    title: request.body.title,
    message: request.body.message,
    severity: request.body.severity || "Info",
    issuedBy: request.body.issuedBy || "Admin",
    href: request.body.href || "",
    source: request.body.source || "AdminNotice",
    sourceId: request.body.sourceId || "",
  });
  await recordEmployeeTransaction({
    employee: employeeId,
    category: "Notice",
    title: "Notice issued",
    description: `${notice.issuedBy} issued "${notice.title}".`,
    metadata: { noticeId: notice._id.toString(), severity: notice.severity },
  });

  response.status(201).json(notice);
}

export async function updateEmployeeNotice(request: Request, response: Response) {
  const employeeId = String(request.params.employeeId);
  const title = String(request.body.title || "").trim();
  const message = String(request.body.message || "").trim();

  if (!title || !message) {
    response.status(400).json({ message: "Notice title and message are required" });
    return;
  }

  const notice = await Notice.findOneAndUpdate(
    { _id: request.params.noticeId, employee: employeeId },
    {
      title,
      message,
      severity: request.body.severity || "Info",
      issuedBy: request.body.issuedBy || "Admin",
      href: request.body.href || "",
      source: request.body.source || "AdminNotice",
      sourceId: request.body.sourceId || "",
    },
    { returnDocument: "after", runValidators: true }
  );

  if (!notice) {
    response.status(404).json({ message: "Notice not found" });
    return;
  }

  await recordEmployeeTransaction({
    employee: employeeId,
    category: "Notice",
    title: "Notice updated",
    description: `${notice.issuedBy} updated "${notice.title}".`,
    metadata: { noticeId: notice._id.toString(), severity: notice.severity },
  });

  response.json(notice);
}

export async function deleteEmployeeNotice(request: Request, response: Response) {
  const employeeId = String(request.params.employeeId);
  const notice = await Notice.findOneAndDelete({
    _id: request.params.noticeId,
    employee: employeeId,
  });

  if (!notice) {
    response.status(404).json({ message: "Notice not found" });
    return;
  }

  response.json({ deletedCount: 1 });
}

export async function markEmployeeNoticeRead(request: Request, response: Response) {
  const employeeId = String(request.params.employeeId);
  const notice = await Notice.findOneAndUpdate(
    { _id: request.params.noticeId, employee: employeeId },
    { isRead: true },
    { returnDocument: "after", runValidators: true }
  );

  if (!notice) {
    response.status(404).json({ message: "Notice not found" });
    return;
  }

  response.json(notice);
}

export async function acknowledgeEmployeeNotice(request: Request, response: Response) {
  const employeeId = String(request.params.employeeId);
  const notice = await Notice.findOneAndUpdate(
    { _id: request.params.noticeId, employee: employeeId },
    { isRead: true, acknowledgedAt: new Date() },
    { returnDocument: "after", runValidators: true }
  );

  if (!notice) {
    response.status(404).json({ message: "Notice not found" });
    return;
  }

  await recordEmployeeTransaction({
    employee: employeeId,
    category: "Notice",
    title: "Notice acknowledged",
    description: `Employee acknowledged "${notice.title}".`,
    metadata: { noticeId: notice._id.toString() },
  });

  response.json(notice);
}

export async function replyToEmployeeNotice(request: Request, response: Response) {
  const employeeId = String(request.params.employeeId);
  const message = String(request.body.message || "").trim();

  if (!message) {
    response.status(400).json({ message: "Reply message is required" });
    return;
  }

  const notice = await Notice.findOneAndUpdate(
    { _id: request.params.noticeId, employee: employeeId },
    {
      isRead: true,
      $push: { replies: { message, createdAt: new Date() } },
    },
    { returnDocument: "after", runValidators: true }
  );

  if (!notice) {
    response.status(404).json({ message: "Notice not found" });
    return;
  }

  await recordEmployeeTransaction({
    employee: employeeId,
    category: "Notice",
    title: "Notice reply",
    description: `Employee replied to "${notice.title}".`,
    metadata: { noticeId: notice._id.toString() },
  });

  response.json(notice);
}

export async function markEmployeeNoticesRead(request: Request, response: Response) {
  const employeeId = String(request.params.employeeId);
  const admin = verifyAdminDashboardSession(request.header("x-crm-admin-session"));
  const code = verifyAttendanceHubSession(request.header("x-crm-attendance-session"));
  if (!admin && !code) {
    response.status(401).json({ message: "Sign in again to mark notices read." });
    return;
  }
  if (!mongoose.isValidObjectId(employeeId)) {
    response.status(400).json({ message: "Invalid employee." });
    return;
  }
  const employee = await Employee.findById(employeeId).select("employeeCode status").lean();
  if (!employee || employee.status === "Archived") {
    response.status(404).json({ message: "Employee not found." });
    return;
  }
  if (!admin && employee.employeeCode !== code) {
    response.status(403).json({ message: "You can only mark your own notices read." });
    return;
  }
  const businessIds = await getBusinessAccessForEmployeeCode(employee.employeeCode);
  const activeBusinessId = request.business?.id || "";
  if (!businessIds.includes(activeBusinessId) || businessIds.some((id) => !getBusinessById(id))) {
    response.status(409).json({ message: "Employee business membership needs review before marking all notices read." });
    return;
  }
  const session = await mongoose.startSession();
  try {
    // One transaction prevents a partial tenant failure from reporting a false success.
    const notices = await session.withTransaction(async () => {
      for (const businessId of businessIds) {
        await runWithBusiness(businessId, async () => {
          const identity = await Employee.findOne({ employeeCode: employee.employeeCode, status: { $ne: "Archived" } }).session(session).select("_id").lean();
          if (!identity) throw new Error("Missing employee business identity");
          await Notice.updateMany({ employee: identity._id, isRead: false }, { $set: { isRead: true } }, { session });
        });
      }
      return Notice.find({ employee: employeeId }).session(session).sort({ createdAt: -1 }).lean();
    });
    response.json(notices);
  } catch {
    response.status(503).json({ message: "Could not confirm the update in every assigned business. Please retry; marking read again is safe." });
  } finally {
    await session.endSession();
  }
}
