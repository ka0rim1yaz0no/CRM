import type { Request, Response } from "express";
import { isConfiguredAdminCode } from "../config/adminUsers";
import { autoCallDisabledReason, getCallProvider, isAutoCallDisabledForEmployee } from "../config/callProvider";
import { Attendance } from "../models/Attendance";
import { Employee } from "../models/Employee";
import { getCallBridgeDeviceModel, getCallBridgeScheduleModel } from "../models/CallBridge";
import { getSystemSettings } from "./systemSettingsController";
import { callDashboardStatus, currentAttendanceShift, offPhoneTimeInShift } from "../services/callDashboardService";

export async function getCallDashboard(request: Request, response: Response) {
  const actorCode = String(request.header("x-crm-user-code") || "").trim();
  const actorType = String(request.header("x-crm-user-type") || "").trim().toLowerCase();
  if (actorType !== "admin" || !isConfiguredAdminCode(actorCode)) {
    response.status(403).json({ message: "The call dashboard is available to administrators only." });
    return;
  }

  const now = new Date();
  const [settings, employees] = await Promise.all([
    getSystemSettings(),
    Employee.find({ status: { $ne: "Archived" }, role: /sales/i })
      .select("name employeeCode role team availabilityStatus")
      .lean(),
  ]);
  const shift = currentAttendanceShift(
    now,
    settings.attendanceTimeZone || "Asia/Manila",
    settings.officialShiftStartTime || "23:00",
    settings.officialShiftEndTime || "08:00"
  );
  const business = {
    id: String(request.business?.id || ""),
    name: String(request.business?.name || "Current business"),
  };

  if (!employees.length) {
    response.json({ generatedAt: now, business, shift, employees: [] });
    return;
  }

  const employeeCodes = employees.map((employee) => employee.employeeCode).filter(Boolean);
  const callProvider = getCallProvider();
  const providerDeviceFilter = callProvider === "ringcentral"
    ? { bridgeVersion: "ringcentral-api-v1" }
    : { bridgeVersion: { $ne: "ringcentral-api-v1" } };
  const employeeIds = employees.map((employee) => employee._id);
  const attendanceFrom = new Date(shift.start.getTime() - 24 * 60 * 60 * 1000);
  const [devices, schedules, attendance, latestTransitionRows] = await Promise.all([
    // A paired bridge belongs to the employee/device and stays valid when the
    // employee changes CRM businesses. Older pairings may not list every newer
    // business assignment, so filtering devices by businessIds creates a false
    // "Call Bridge disconnected" status despite fresh heartbeats.
    getCallBridgeDeviceModel().find({ employeeCode: { $in: employeeCodes }, ...providerDeviceFilter })
      .select("employeeCode state audioSessionActive nextivaProcessDetected lastSeenAt lastStateChangedAt")
      .lean(),
    getCallBridgeScheduleModel().find({ employeeCode: { $in: employeeCodes } })
      .select("employeeCode callLeaseUntil lastCallEndedAt nextCallAllowedAt lastDialStartedAt dialIntentUntil lastCallStartedAt")
      .lean(),
    Attendance.find({
      employee: { $in: employeeIds },
      isArchived: { $ne: true },
      timeIn: { $gte: attendanceFrom, $lte: now },
    }).select("employee source timeIn").sort({ timeIn: 1 }).lean(),
    Attendance.aggregate([
      {
        $match: {
          employee: { $in: employeeIds },
          isArchived: { $ne: true },
          timeIn: { $lte: now },
          source: { $in: ["Time In", "Login", "Break In", "Lunch Break In", "Off the Phone In", "Time Out", "Logout", "Break Out", "Lunch Break Out", "Off the Phone Out"] },
        },
      },
      { $sort: { timeIn: -1 as const } },
      { $group: { _id: "$employee", source: { $first: "$source" }, timeIn: { $first: "$timeIn" } } },
    ]),
  ]);

  const latestTransitions = new Map(
    latestTransitionRows.map((event) => [String(event._id), event])
  );

  const rows = employees.map((employee) => {
    const employeeAttendance = attendance
      .filter((event) => String(event.employee) === String(employee._id))
      .map((event) => ({ source: event.source, timeIn: event.timeIn }));
    const latest = latestTransitions.get(String(employee._id));
    const statusAttendance = latest && !employeeAttendance.some((event) => event.source === latest.source && event.timeIn.getTime() === latest.timeIn.getTime())
      ? [...employeeAttendance, { source: latest.source, timeIn: latest.timeIn }]
      : employeeAttendance;
    const employeeDevices = devices.filter((device) => device.employeeCode === employee.employeeCode);
    const schedule = schedules.find((item) => item.employeeCode === employee.employeeCode);
    const offPhone = offPhoneTimeInShift(employeeAttendance, shift.start, shift.end, now);
    const status = callDashboardStatus({
      availabilityStatus: employee.availabilityStatus,
      devices: employeeDevices,
      schedule,
      attendance: statusAttendance,
      offPhoneStartedAt: offPhone.activeStartedAt,
      now,
      shift,
      provider: callProvider,
    });
    const dashboardStatus = isAutoCallDisabledForEmployee(employee.employeeCode) &&
      status.status === "ONLINE" && status.detail === "Ready to dial"
      ? { ...status, detail: autoCallDisabledReason }
      : status;

    return {
      employeeId: String(employee._id),
      employeeCode: employee.employeeCode,
      name: employee.name || employee.employeeCode,
      businessId: business.id,
      businessName: business.name,
      role: employee.role,
      team: employee.team,
      ...dashboardStatus,
      offPhoneCompletedMs: offPhone.completedMs,
      offPhoneActiveStartedAt: offPhone.activeStartedAt,
      offPhoneTotalMs: offPhone.totalMs,
    };
  }).sort((first, second) => first.name.localeCompare(second.name));

  response.set("Cache-Control", "no-store");
  response.json({ generatedAt: now, business, shift, employees: rows });
}
