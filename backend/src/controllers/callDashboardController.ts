import type { Request, Response } from "express";
import { isConfiguredAdminCode } from "../config/adminUsers";
import { autoCallDisabledReason, getCallProvider, isAutoCallDisabledForEmployee } from "../config/callProvider";
import { Attendance } from "../models/Attendance";
import { Employee } from "../models/Employee";
import { getCallBridgeDeviceModel, getCallBridgeScheduleModel } from "../models/CallBridge";
import { getSystemSettings } from "./systemSettingsController";
import { callDashboardStatus, currentAttendanceShift, offPhoneDashboardClock, offPhoneTimeInShift } from "../services/callDashboardService";
import { callDashboardV2Enabled, timeAccountingV2Enabled } from "../config/rolloutFlags";
import { accountTime, bucketForAttendanceSource } from "../services/timeAccounting";
import { verifyAdminDashboardSession } from "../config/adminDashboardSession";
import { CallBridgeObservation } from "../models/CallBridgeObservation";
import { groupDashboardSnapshots, type DashboardSnapshot } from "../services/callDashboardAggregation";
import { offPhoneNonBillableAt, offPhoneShiftBilling } from "../../../shared/attendanceOffPhone";
import { offPhoneLimitPolicy } from "../config/payrollEarnings";

async function getCallDashboardForBusiness(request: Request, response: Response) {
  const admin = verifyAdminDashboardSession(request.header("x-crm-admin-session"));
  if (!admin) {
    response.status(403).json({ message: "A valid administrator session is required." });
    return;
  }
  const selectedBusiness = request.business;
  if (!selectedBusiness) {
    response.status(400).json({ message: "Select a business to view its call dashboard." });
    return;
  }
  const now = new Date();
  const settings = await getSystemSettings();
  const shift = currentAttendanceShift(now, settings.attendanceTimeZone || "Asia/Manila",
    settings.officialShiftStartTime || "23:00", settings.officialShiftEndTime || "08:00");
  const employees = await Employee.find({ status: { $ne: "Archived" }, role: /sales/i })
    .select("name employeeCode role team").lean();
  const ids = employees.map((employee) => employee._id);
  const attendance = ids.length ? await Attendance.find({ employee: { $in: ids }, isArchived: { $ne: true },
    timeIn: { $gte: new Date(shift.start.getTime() - 24 * 60 * 60_000), $lte: now } })
    .select("employee source timeIn eventId").sort({ timeIn: 1 }).lean() : [];
  const recordsById = new Map<string, typeof attendance>();
  for (const event of attendance) {
    const key = String(event.employee);
    const list = recordsById.get(key) || [];
    list.push(event);
    recordsById.set(key, list);
  }
  const snapshots: DashboardSnapshot[] = employees.filter((employee) => employee.employeeCode).map((employee) => ({
    employee: { _id: String(employee._id), name: employee.name, employeeCode: employee.employeeCode,
      role: employee.role, team: employee.team },
    business: { id: selectedBusiness.id, name: selectedBusiness.name },
    events: (recordsById.get(String(employee._id)) || []).map((event) => ({
      source: event.source, timeIn: event.timeIn, eventId: event.eventId,
    })),
  }));
  const grouped = groupDashboardSnapshots(snapshots, selectedBusiness.id);
  const codes = [...grouped.keys()];
  const [devices, schedules, observations] = await Promise.all([
    getCallBridgeDeviceModel().find({ employeeCode: { $in: codes }, bridgeVersion: { $ne: "ringcentral-api-v1" } })
      .select("employeeCode bridgeVersion state audioSessionActive nextivaProcessDetected lastSeenAt lastStateChangedAt lastBridgeAvailabilityChangedAt lastIdleAt").lean(),
    getCallBridgeScheduleModel().find({ employeeCode: { $in: codes } })
      .select("employeeCode callLeaseUntil lastCallEndedAt nextCallAllowedAt lastDialStartedAt dialIntentUntil lastCallStartedAt").lean(),
    CallBridgeObservation.find({ employeeCode: { $in: codes }, endedAt: { $gte: shift.start, $lte: now } })
      .select("employeeCode durationMs").lean(),
  ]);
  const rows = [...grouped.values()].map((group) => {
    const code = group.employee.employeeCode;
    const events = group.events.sort((a, b) => a.timeIn.getTime() - b.timeIn.getTime());
    const accounted = accountTime(events.flatMap((event) => {
      const bucket = bucketForAttendanceSource(event.source);
      return bucket ? [{ at: event.timeIn, bucket }] : [];
    }), shift.start, shift.end, now);
    const businessBreakdown = group.businesses.map((business) => ({ ...business,
      timeBucketsMs: accountTime((group.eventsByBusiness.get(business.id) || []).flatMap((event) => {
        const bucket = bucketForAttendanceSource(event.source);
        return bucket ? [{ at: event.timeIn, bucket }] : [];
      }), shift.start, shift.end, now).milliseconds }));
    const availabilityStatus = accounted.state === "break" ? "BREAK" : accounted.state === "lunch" ? "LUNCH"
      : accounted.state === "offPhone" ? "OFF THE PHONE" : accounted.state === "online" ? "ONLINE" : "OFFLINE";
    const employeeDevices = devices.filter((device) => device.employeeCode === code);
    const schedule = schedules.find((item) => item.employeeCode === code);
    const status = callDashboardStatus({ availabilityStatus, devices: employeeDevices, schedule,
      attendance: events, offPhoneStartedAt: accounted.state === "offPhone" ? accounted.stateSince : null,
      now, shift, provider: "nextiva" });
    const offPhone = offPhoneDashboardClock({ totalMs: accounted.milliseconds.offPhone,
      state: accounted.state, stateSince: accounted.stateSince, shiftEnd: shift.end, now });
    const latestDevice = [...employeeDevices].sort((a, b) => b.lastSeenAt.getTime() - a.lastSeenAt.getTime())[0];
    const heartbeatAgeMs = latestDevice ? Math.max(0, now.getTime() - latestDevice.lastSeenAt.getTime()) : null;
    const employeeCalls = observations.filter((observation) => observation.employeeCode === code);
    const billing = offPhoneShiftBilling(events, shift.start, shift.end, now, offPhoneLimitPolicy());
    return {
      employeeId: String(group.employee._id), employeeCode: code, name: group.employee.name || code,
      businessId: group.businesses[0]?.id || "", businessName: group.businesses[0]?.name || "",
      businesses: group.businesses, businessBreakdown, role: group.employee.role, team: group.employee.team,
      ...status, timeBucketsMs: accounted.milliseconds,
      offPhoneNonBillable: status.status === "OFF THE PHONE" && offPhoneNonBillableAt(billing, +now),
      offPhoneNonBillableFrom: status.status === "OFF THE PHONE" ? billing.active?.nonBillableFrom ?? null : null,
      offPhoneCompletedMs: offPhone.completedMs, offPhoneActiveStartedAt: offPhone.activeStartedAt,
      offPhoneTotalMs: accounted.milliseconds.offPhone,
      breakRemainingMs: accounted.remainingBreakMs, lunchRemainingMs: accounted.remainingLunchMs,
      allowanceOverdue: accounted.overdue, heartbeatAgeMs,
      callsCount: employeeCalls.length,
      talkTimeMs: employeeCalls.reduce((sum, observation) => sum + observation.durationMs, 0),
      bridgeHealth: !latestDevice ? "offline" : heartbeatAgeMs !== null && heartbeatAgeMs <= 20_000
        ? latestDevice.nextivaProcessDetected ? "fresh" : "nextiva-closed" : "stale",
    };
  }).sort((a, b) => a.name.localeCompare(b.name));
  response.set("Cache-Control", "no-store");
  response.json({ generatedAt: now, serverTime: new Date(),
    business: { id: selectedBusiness.id, name: selectedBusiness.name }, shift, employees: rows,
    totals: { employees: rows.length, onlineMs: rows.reduce((sum, row) => sum + row.timeBucketsMs.online, 0),
      breakMs: rows.reduce((sum, row) => sum + row.timeBucketsMs.break, 0),
      lunchMs: rows.reduce((sum, row) => sum + row.timeBucketsMs.lunch, 0),
      offPhoneMs: rows.reduce((sum, row) => sum + row.timeBucketsMs.offPhone, 0) } });
}

export async function getCallDashboard(request: Request, response: Response) {
  if (callDashboardV2Enabled()) return getCallDashboardForBusiness(request, response);
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
      .select("employeeCode bridgeVersion state audioSessionActive nextivaProcessDetected lastSeenAt lastStateChangedAt lastIdleAt")
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
          source: { $in: ["Time In", "Login", "Break In", "Lunch Break In", "Off the Phone In", "Time Out", "Logout", "Break Out", "Lunch Break Out", "Off the Phone Out", "Non-Billable Off the Phone Out"] },
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
    const accounted = timeAccountingV2Enabled() ? accountTime(
      employeeAttendance.flatMap((event) => {
        const bucket = bucketForAttendanceSource(event.source);
        return bucket ? [{ at: event.timeIn, bucket }] : [];
      }), shift.start, shift.end, now
    ) : null;
    const accountedAvailability = accounted?.state === "break" ? "BREAK"
      : accounted?.state === "lunch" ? "LUNCH"
      : accounted?.state === "offPhone" ? "OFF THE PHONE"
      : accounted?.state === "online" ? "ONLINE" : "OFFLINE";
    const status = callDashboardStatus({
      availabilityStatus: callDashboardV2Enabled() && accounted ? accountedAvailability : employee.availabilityStatus,
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
    const billing = offPhoneShiftBilling(employeeAttendance, shift.start, shift.end, now, offPhoneLimitPolicy());

    return {
      employeeId: String(employee._id),
      employeeCode: employee.employeeCode,
      name: employee.name || employee.employeeCode,
      businessId: business.id,
      businessName: business.name,
      role: employee.role,
      team: employee.team,
      ...dashboardStatus,
      offPhoneNonBillable: dashboardStatus.status === "OFF THE PHONE" && offPhoneNonBillableAt(billing, +now),
      offPhoneNonBillableFrom: dashboardStatus.status === "OFF THE PHONE" ? billing.active?.nonBillableFrom ?? null : null,
      offPhoneCompletedMs: offPhone.completedMs,
      offPhoneActiveStartedAt: offPhone.activeStartedAt,
      offPhoneTotalMs: offPhone.totalMs,
      ...(accounted ? { timeBucketsMs: accounted.milliseconds, accountingState: accounted.state,
        breakRemainingMs: accounted.remainingBreakMs, lunchRemainingMs: accounted.remainingLunchMs,
        allowanceOverdue: accounted.overdue } : {}),
    };
  }).sort((first, second) => first.name.localeCompare(second.name));

  response.set("Cache-Control", "no-store");
  response.json({ generatedAt: now, business, shift, employees: rows });
}
