import crypto from "node:crypto";
import type { Request, Response } from "express";
import { Types } from "mongoose";
import { attendanceV2Enabled } from "../config/rolloutFlags";
import { AttendanceActionLock } from "../models/AttendanceActionLock";
import { Employee } from "../models/Employee";

const leaseMs = 120_000;

export function withAttendanceActionLock(handler: (request: Request, response: Response) => Promise<void>) {
  return async (request: Request, response: Response) => {
    if (!attendanceV2Enabled()) return handler(request, response);
    if (!Types.ObjectId.isValid(String(request.params.employeeId || ""))) {
      response.status(400).json({ message: "A valid employee ID is required." });
      return;
    }
    const employee = await Employee.findById(request.params.employeeId).select("employeeCode").lean();
    if (!employee?.employeeCode) {
      response.status(404).json({ message: "Employee not found." });
      return;
    }
    const employeeCode = employee.employeeCode;
    const ownerToken = crypto.randomUUID();
    const now = new Date();
    let acquired = false;
    try {
      const lock = await AttendanceActionLock.findOneAndUpdate(
        { employeeCode, $or: [{ leaseUntil: { $lte: now } }, { leaseUntil: null }] },
        { $set: { ownerToken, leaseUntil: new Date(now.getTime() + leaseMs) }, $setOnInsert: { employeeCode } },
        { upsert: true, returnDocument: "after" }
      );
      acquired = lock?.ownerToken === ownerToken;
    } catch (error) {
      if ((error as { code?: number })?.code !== 11000) throw error;
    }
    if (!acquired) {
      response.status(409).json({ code: "ATTENDANCE_ACTION_IN_PROGRESS",
        message: "Another attendance action is being saved. Please try again." });
      return;
    }
    const renewal = setInterval(() => {
      void AttendanceActionLock.updateOne({ employeeCode, ownerToken },
        { $set: { leaseUntil: new Date(Date.now() + leaseMs) } }).catch(() => {
          console.error("Attendance action lock renewal failed");
        });
    }, 20_000);
    renewal.unref();
    try {
      await handler(request, response);
    } finally {
      clearInterval(renewal);
      await AttendanceActionLock.updateOne({ employeeCode, ownerToken },
        { $set: { ownerToken: "", leaseUntil: new Date(0) } });
    }
  };
}
