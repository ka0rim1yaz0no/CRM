import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { Request, Response } from "express";
import { Types } from "mongoose";
import { getBusinessAccessForEmployeeCode } from "../models/BusinessUserAccess";
import {
  getCallBridgeDeviceModel,
  getCallBridgePairingModel,
  getCallBridgeScheduleModel,
  type CallBridgeDeviceDocument,
  type CallBridgeState,
} from "../models/CallBridge";
import { Employee, normalizeEmployeeAvailabilityStatus } from "../models/Employee";
import { Lead } from "../models/Lead";
import {
  latestDate,
  normalizeBrowserSessionStartedAt,
  shouldRejectOlderBrowserSession,
} from "../services/callBridgeSession";
import { emitCallDashboardUpdated } from "../socket";

const pairingLifetimeMs = 10 * 60 * 1000;
const heartbeatFreshnessMs = 20 * 1000;
const callLeaseMs = 90 * 1000;
const postCallDelayMs = 30 * 1000;
const dialIntentMs = 30 * 1000;
const callBridgePackageFileName = "assistly-call-bridge.zip";
const validBridgeStates = new Set<CallBridgeState>(["idle", "active", "unknown"]);

type LeadDialBlock = "LEAD_NOT_FOUND" | "LEAD_ALREADY_COMMENTED";

function cleanString(value: unknown, maxLength = 240) {
  return String(value || "").trim().slice(0, maxLength);
}

function hashSecret(value: string) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function randomToken() {
  return crypto.randomBytes(32).toString("base64url");
}

function randomPairingCode() {
  const value = crypto.randomInt(0, 100_000_000);
  return String(value).padStart(8, "0");
}

function bearerToken(request: Request) {
  const authorization = String(request.header("authorization") || "");
  return authorization.toLowerCase().startsWith("bearer ") ? authorization.slice(7).trim() : "";
}

function bridgeState(value: unknown): CallBridgeState {
  const normalizedValue = cleanString(value, 20).toLowerCase() as CallBridgeState;
  return validBridgeStates.has(normalizedValue) ? normalizedValue : "unknown";
}

async function getLeadDialBlock(leadId: string): Promise<LeadDialBlock | null> {
  if (!leadId || !Types.ObjectId.isValid(leadId)) {
    return "LEAD_NOT_FOUND";
  }

  const phOffsetMs = 8 * 60 * 60 * 1000;
  const shiftedNow = new Date(Date.now() + phOffsetMs);
  const startTime = Date.UTC(shiftedNow.getUTCFullYear(), shiftedNow.getUTCMonth(), shiftedNow.getUTCDate()) - phOffsetMs;
  const commentRange = { $gte: new Date(startTime), $lt: new Date(startTime + 24 * 60 * 60 * 1000) };
  const [leadExists, commentedLeadExists] = await Promise.all([
    Lead.exists({ _id: leadId }),
    Lead.exists({
      _id: leadId,
      comments: { $elemMatch: { authorType: "employee", createdAt: commentRange } },
    }),
  ]);

  if (!leadExists) return "LEAD_NOT_FOUND";
  return commentedLeadExists ? "LEAD_ALREADY_COMMENTED" : null;
}

function callBridgePackageCandidates() {
  return [
    path.resolve(process.cwd(), "..", "callbridge", "dist", callBridgePackageFileName),
    path.resolve(process.cwd(), "callbridge", "dist", callBridgePackageFileName),
    path.resolve(process.cwd(), "dist", callBridgePackageFileName),
  ];
}

async function devicesForEmployee(employeeCode: string) {
  return getCallBridgeDeviceModel().find({ employeeCode }).sort({ lastSeenAt: -1 }).lean();
}

function aggregateBridgeStatus(
  devices: Array<Pick<CallBridgeDeviceDocument, "state" | "lastSeenAt" | "nextivaProcessDetected" | "deviceName" | "bridgeVersion">>,
  schedule: { callLeaseUntil?: Date | null; nextCallAllowedAt?: Date | null; lastCallEndedAt?: Date | null } | null,
  now = new Date()
) {
  const freshAfter = new Date(now.getTime() - heartbeatFreshnessMs);
  const freshDevices = devices.filter((device) => new Date(device.lastSeenAt) >= freshAfter);
  const activeDevice = freshDevices.find((device) => device.state === "active");
  const connectedDevice = freshDevices[0];
  const nextivaProcessDetected = freshDevices.some((device) => device.nextivaProcessDetected);
  const callLeaseUntil = schedule?.callLeaseUntil ? new Date(schedule.callLeaseUntil) : null;
  const nextCallAllowedAt = schedule?.nextCallAllowedAt ? new Date(schedule.nextCallAllowedAt) : null;
  const leaseActive = Boolean(callLeaseUntil && callLeaseUntil > now);
  const delayActive = Boolean(nextCallAllowedAt && nextCallAllowedAt > now);

  let state: "offline" | "unknown" | "idle" | "calling" | "active" = "offline";
  let reason = "Call Bridge is offline.";

  if (freshDevices.length > 0 && activeDevice) {
    state = "active";
    reason = "A Nextiva call is active.";
  } else if (freshDevices.length > 0 && leaseActive) {
    state = "calling";
    reason = "A Nextiva call is starting.";
  } else if (freshDevices.length > 0 && !nextivaProcessDetected) {
    state = "unknown";
    reason = "Nextiva is not running.";
  } else if (freshDevices.length > 0 && delayActive) {
    state = "idle";
    reason = "Waiting 30 seconds after the previous call.";
  } else if (freshDevices.length > 0) {
    state = "idle";
    reason = "Call Bridge is ready.";
  }

  return {
    connected: freshDevices.length > 0,
    ready:
      freshDevices.length > 0 &&
      nextivaProcessDetected &&
      !activeDevice &&
      !leaseActive &&
      !delayActive,
    state,
    reason,
    nextivaProcessDetected,
    deviceName: connectedDevice?.deviceName || "",
    bridgeVersion: connectedDevice?.bridgeVersion || "",
    lastSeenAt: connectedDevice?.lastSeenAt || null,
    callLeaseUntil,
    nextCallAllowedAt,
    lastCallEndedAt: schedule?.lastCallEndedAt || null,
  };
}

export async function createCallBridgePairing(request: Request, response: Response) {
  const employeeId = cleanString(request.body.employeeId, 80);
  const browserDeviceKey = cleanString(request.body.browserDeviceKey, 200);
  const employee = employeeId ? await Employee.findById(employeeId) : null;

  if (!employee || !employee.employeeCode) {
    response.status(404).json({ message: "Employee not found or employee code is missing." });
    return;
  }

  const pairingCode = randomPairingCode();
  const businessAccessIds = await getBusinessAccessForEmployeeCode(employee.employeeCode);
  const businessIds = Array.from(
    new Set([request.business?.id, ...businessAccessIds].filter((value): value is string => Boolean(value)))
  );
  const expiresAt = new Date(Date.now() + pairingLifetimeMs);
  const Pairing = getCallBridgePairingModel();
  const accountSwitchingEnabled = browserDeviceKey.length >= 24;

  await Pairing.deleteMany({ employeeCode: employee.employeeCode, usedAt: null });
  await Pairing.create({
    codeHash: hashSecret(pairingCode),
    employeeCode: employee.employeeCode,
    employeeName: employee.name,
    businessIds,
    ...(accountSwitchingEnabled ? { browserDeviceKeyHash: hashSecret(browserDeviceKey) } : {}),
    accountSwitchingEnabled,
    expiresAt,
    usedAt: null,
  });

  response.status(201).json({
    pairingCode,
    employeeCode: employee.employeeCode,
    employeeName: employee.name,
    businessId: request.business?.id || "",
    accountSwitchingEnabled,
    expiresAt,
  });
}

export async function claimCallBridgePairing(request: Request, response: Response) {
  const pairingCode = cleanString(request.body.pairingCode, 20).replace(/\D/g, "");
  const deviceId = cleanString(request.body.deviceId, 120);
  const deviceName = cleanString(request.body.deviceName, 160) || "Windows computer";

  if (!pairingCode || !deviceId) {
    response.status(400).json({ message: "Pairing code and device id are required." });
    return;
  }

  const now = new Date();
  const Pairing = getCallBridgePairingModel();
  const pairing = await Pairing.findOneAndUpdate(
    {
      codeHash: hashSecret(pairingCode),
      usedAt: null,
      expiresAt: { $gt: now },
    },
    { $set: { usedAt: now } },
    { returnDocument: "after" }
  );

  if (!pairing) {
    response.status(401).json({ message: "Pairing code is invalid or expired." });
    return;
  }

  const token = randomToken();
  const Device = getCallBridgeDeviceModel();
  const accountSwitchingEnabled = Boolean(pairing.accountSwitchingEnabled && pairing.browserDeviceKeyHash);
  const deviceValues = {
    employeeCode: pairing.employeeCode,
    employeeName: pairing.employeeName,
    businessIds: pairing.businessIds,
    deviceId,
    deviceName,
    tokenHash: hashSecret(token),
    ...(accountSwitchingEnabled ? { browserDeviceKeyHash: pairing.browserDeviceKeyHash } : {}),
    accountSwitchingEnabled,
    browserSessionId: undefined,
    browserSessionStartedAt: undefined,
    browserSessionLastSeenAt: undefined,
    state: "unknown" as const,
    nextivaProcessDetected: false,
    audioSessionActive: false,
    bridgeVersion: cleanString(request.body.bridgeVersion, 40),
    lastSeenAt: now,
    lastStateChangedAt: now,
  };

  if (accountSwitchingEnabled) {
    const reusableDevice = await Device.findOne({
      $or: [{ browserDeviceKeyHash: pairing.browserDeviceKeyHash }, { deviceId }],
    }).sort({ lastSeenAt: -1 });

    if (reusableDevice) {
      await Device.deleteMany({
        _id: { $ne: reusableDevice._id },
        $or: [
          { browserDeviceKeyHash: pairing.browserDeviceKeyHash },
          { employeeCode: pairing.employeeCode, deviceId },
        ],
      });
      reusableDevice.set(deviceValues);
      await reusableDevice.save();
    } else {
      await Device.create(deviceValues);
    }
  } else {
    await Device.findOneAndUpdate(
      { employeeCode: pairing.employeeCode, deviceId },
      {
        $set: deviceValues,
        $unset: {
          browserDeviceKeyHash: 1,
          browserSessionId: 1,
          browserSessionStartedAt: 1,
          browserSessionLastSeenAt: 1,
        },
      },
      { returnDocument: "after", upsert: true, setDefaultsOnInsert: true }
    );
  }

  await getCallBridgeScheduleModel().findOneAndUpdate(
    { employeeCode: pairing.employeeCode },
    { $setOnInsert: { employeeCode: pairing.employeeCode } },
    { upsert: true, setDefaultsOnInsert: true }
  );

  response.status(201).json({
    token,
    employeeCode: pairing.employeeCode,
    employeeName: pairing.employeeName,
    businessIds: pairing.businessIds,
    accountSwitchingEnabled,
    heartbeatIntervalSeconds: 5,
  });
}

export async function activateCallBridgeForEmployee(request: Request, response: Response) {
  const employeeCode = cleanString(request.body.employeeCode, 80);
  const browserDeviceKey = cleanString(request.body.browserDeviceKey, 200);
  const browserSessionId = cleanString(request.body.browserSessionId, 120);
  const headerEmployeeCode = cleanString(request.header("x-crm-user-code"), 80);
  const headerUserType = cleanString(request.header("x-crm-user-type"), 30).toLowerCase();
  const now = new Date();
  const browserSessionStartedAt = normalizeBrowserSessionStartedAt(request.body.browserSessionStartedAt, now);

  if (
    !employeeCode ||
    employeeCode !== headerEmployeeCode ||
    headerUserType !== "employee" ||
    browserDeviceKey.length < 24 ||
    browserSessionId.length < 16 ||
    !browserSessionStartedAt
  ) {
    response.status(403).json({ message: "A valid employee device session is required." });
    return;
  }

  const employee = await Employee.findOne({ employeeCode, status: { $ne: "Archived" } })
    .select("employeeCode name role status")
    .lean();

  if (!employee || !cleanString(employee.role).toLowerCase().includes("sales")) {
    response.status(403).json({ message: "Only active sales employees can use this Call Bridge computer." });
    return;
  }

  const businessId = request.business?.id || "";
  const businessAccessIds = await getBusinessAccessForEmployeeCode(employeeCode);

  if (businessAccessIds.length > 0 && !businessAccessIds.includes(businessId)) {
    response.status(403).json({ message: "This employee cannot use Call Bridge for the selected business." });
    return;
  }

  const Device = getCallBridgeDeviceModel();
  const device = await Device.findOne({
    browserDeviceKeyHash: hashSecret(browserDeviceKey),
    accountSwitchingEnabled: true,
    businessIds: businessId,
  }).sort({ lastSeenAt: -1 });

  if (!device) {
    response.json({
      activated: false,
      switchable: false,
      employeeCode,
      reason: "This browser has not been paired for automatic account switching.",
    });
    return;
  }

  if (shouldRejectOlderBrowserSession(device, browserSessionId, browserSessionStartedAt, now)) {
    response.status(409).json({
      code: "NEWER_BROWSER_SESSION_ACTIVE",
      message: "A newer sales login is already using Call Bridge on this computer.",
    });
    return;
  }

  const previousEmployeeCode = device.employeeCode;
  const employeeChanged = previousEmployeeCode !== employeeCode;

  if (employeeChanged) {
    const Schedule = getCallBridgeScheduleModel();
    const freshAfter = new Date(now.getTime() - heartbeatFreshnessMs);
    const [previousSchedule, targetSchedule, activeTargetDevice] = await Promise.all([
      Schedule.findOne({ employeeCode: previousEmployeeCode }).lean(),
      Schedule.findOne({ employeeCode }).lean(),
      Device.findOne({
        _id: { $ne: device._id },
        employeeCode,
        state: "active",
        lastSeenAt: { $gte: freshAfter },
      }).lean(),
    ]);
    const previousCallBusy =
      (device.state === "active" && device.lastSeenAt >= freshAfter) ||
      Boolean(previousSchedule?.callLeaseUntil && previousSchedule.callLeaseUntil > now) ||
      Boolean(previousSchedule?.dialIntentUntil && previousSchedule.dialIntentUntil > now);
    const targetCallBusy =
      Boolean(activeTargetDevice) ||
      Boolean(targetSchedule?.callLeaseUntil && targetSchedule.callLeaseUntil > now) ||
      Boolean(targetSchedule?.dialIntentUntil && targetSchedule.dialIntentUntil > now);

    if (previousCallBusy || targetCallBusy) {
      response.status(409).json({
        code: "CALL_BRIDGE_BUSY",
        message: "Call Bridge will switch accounts after the active or starting call finishes.",
      });
      return;
    }

    const latestCallEndedAt = latestDate(previousSchedule?.lastCallEndedAt, targetSchedule?.lastCallEndedAt);
    const latestNextCallAllowedAt = latestDate(
      previousSchedule?.nextCallAllowedAt,
      targetSchedule?.nextCallAllowedAt
    );
    const nextCallAllowedAt = latestNextCallAllowedAt && latestNextCallAllowedAt > now
      ? latestNextCallAllowedAt
      : null;

    await Device.deleteMany({
      _id: { $ne: device._id },
      employeeCode,
      deviceId: device.deviceId,
    });

    device.employeeCode = employeeCode;
    device.employeeName = employee.name;

    await Promise.all([
      Schedule.findOneAndUpdate(
        { employeeCode: previousEmployeeCode },
        {
          $set: {
            callLeaseUntil: null,
            lastDialStartedAt: null,
            dialIntentUntil: null,
            lastCallStartedAt: null,
          },
        }
      ),
      Schedule.findOneAndUpdate(
        { employeeCode },
        {
          $set: {
            callLeaseUntil: null,
            nextCallAllowedAt,
            lastCallEndedAt: latestCallEndedAt,
            lastDialStartedAt: null,
            dialIntentUntil: null,
            lastCallStartedAt: null,
          },
          $setOnInsert: { employeeCode },
        },
        { upsert: true, setDefaultsOnInsert: true }
      ),
    ]);
  }

  device.browserSessionId = browserSessionId;
  device.browserSessionStartedAt = browserSessionStartedAt;
  device.browserSessionLastSeenAt = now;
  await device.save();

  if (employeeChanged) {
    emitCallDashboardUpdated(device.businessIds);
  }

  response.json({
    activated: true,
    switchable: true,
    employeeChanged,
    employeeCode,
    deviceName: device.deviceName,
  });
}

export async function updateCallBridgeHeartbeat(request: Request, response: Response) {
  const token = bearerToken(request);

  if (!token) {
    response.status(401).json({ message: "Bridge token is required." });
    return;
  }

  const Device = getCallBridgeDeviceModel();
  const device = await Device.findOne({ tokenHash: hashSecret(token) });

  if (!device) {
    response.status(401).json({ message: "Bridge token is invalid." });
    return;
  }

  const now = new Date();
  const previousState = device.state;
  const previousNextivaProcessDetected = device.nextivaProcessDetected;
  const previousAudioSessionActive = device.audioSessionActive;
  const nextState = bridgeState(request.body.state);

  device.state = nextState;
  device.nextivaProcessDetected = Boolean(request.body.nextivaProcessDetected);
  device.audioSessionActive = Boolean(request.body.audioSessionActive);
  device.bridgeVersion = cleanString(request.body.bridgeVersion, 40);
  device.deviceName = cleanString(request.body.deviceName, 160) || device.deviceName;
  device.lastSeenAt = now;

  if (previousState !== nextState || previousNextivaProcessDetected !== device.nextivaProcessDetected) {
    device.lastStateChangedAt = now;
  }

  await device.save();

  if (nextState === "active") {
    await getCallBridgeScheduleModel().findOneAndUpdate(
      { employeeCode: device.employeeCode },
      {
        $set: {
          callLeaseUntil: null,
          dialIntentUntil: null,
          ...(previousState !== "active" ? { lastCallStartedAt: now } : {}),
        },
        $setOnInsert: { employeeCode: device.employeeCode },
      },
      { upsert: true, setDefaultsOnInsert: true }
    );
  } else if (previousState === "active") {
    await getCallBridgeScheduleModel().findOneAndUpdate(
      { employeeCode: device.employeeCode },
      {
        $set: {
          callLeaseUntil: null,
          lastCallEndedAt: now,
          nextCallAllowedAt: new Date(now.getTime() + postCallDelayMs),
          lastCallStartedAt: null,
          lastDialStartedAt: null,
          dialIntentUntil: null,
        },
        $setOnInsert: { employeeCode: device.employeeCode },
      },
      { upsert: true, setDefaultsOnInsert: true }
    );
  }

  if (previousState !== nextState || previousNextivaProcessDetected !== device.nextivaProcessDetected || previousAudioSessionActive !== device.audioSessionActive) {
    emitCallDashboardUpdated(device.businessIds);
  }

  response.json({ ok: true, serverTime: now });
}

export async function getCallBridgeStatus(request: Request, response: Response) {
  const employeeCode = cleanString(request.query.employeeCode, 80);

  if (!employeeCode) {
    response.status(400).json({ message: "Employee code is required." });
    return;
  }

  const [devices, schedule] = await Promise.all([
    devicesForEmployee(employeeCode),
    getCallBridgeScheduleModel().findOne({ employeeCode }).lean(),
  ]);

  response.json({
    employeeCode,
    ...aggregateBridgeStatus(devices, schedule),
  });
}

export async function reserveCallBridgeCall(request: Request, response: Response) {
  const employeeCode = cleanString(request.body.employeeCode, 80);
  const leadId = cleanString(request.body.leadId, 80);

  if (!employeeCode) {
    response.status(400).json({ message: "Employee code is required." });
    return;
  }

  const now = new Date();
  const Device = getCallBridgeDeviceModel();
  const freshAfter = new Date(now.getTime() - heartbeatFreshnessMs);
  const [freshDevices, employee] = await Promise.all([
    Device.find({ employeeCode, lastSeenAt: { $gte: freshAfter } }).lean(),
    Employee.findOne({ employeeCode, status: { $ne: "Archived" } })
      .select("employeeCode role availabilityStatus")
      .lean(),
  ]);

  const employeeIsOnline = employee && normalizeEmployeeAvailabilityStatus(employee.availabilityStatus) === "ONLINE";
  const employeeHasSalesRole = employee && cleanString(employee.role).toLowerCase().includes("sales");

  if (!employeeIsOnline || !employeeHasSalesRole) {
    const schedule = await getCallBridgeScheduleModel().findOne({ employeeCode }).lean();
    response.status(409).json({
      allowed: false,
      employeeCode,
      ...aggregateBridgeStatus(freshDevices, schedule, now),
      ready: false,
      reason: !employee
        ? "Employee was not found."
        : !employeeHasSalesRole
          ? "Employee does not have a sales role."
          : "Employee is not online.",
    });
    return;
  }

  if (leadId) {
    const leadDialBlock = await getLeadDialBlock(leadId);

    if (leadDialBlock) {
      const schedule = await getCallBridgeScheduleModel().findOne({ employeeCode }).lean();
      response.status(409).json({
        allowed: false,
        code: leadDialBlock,
        employeeCode,
        ...aggregateBridgeStatus(freshDevices, schedule, now),
        ready: false,
        reason: leadDialBlock === "LEAD_ALREADY_COMMENTED"
          ? "This lead already has an employee comment today."
          : "The selected lead was not found.",
      });
      return;
    }
  }

  if (
    freshDevices.length === 0 ||
    !freshDevices.some((device) => device.nextivaProcessDetected) ||
    freshDevices.some((device) => device.state === "active")
  ) {
    const schedule = await getCallBridgeScheduleModel().findOne({ employeeCode }).lean();
    response.status(409).json({
      allowed: false,
      employeeCode,
      ...aggregateBridgeStatus(freshDevices, schedule, now),
    });
    return;
  }

  const Schedule = getCallBridgeScheduleModel();
  await Schedule.findOneAndUpdate(
    { employeeCode },
    { $setOnInsert: { employeeCode } },
    { upsert: true, setDefaultsOnInsert: true }
  );

  const leaseUntil = new Date(now.getTime() + callLeaseMs);
  const schedule = await Schedule.findOneAndUpdate(
    {
      employeeCode,
      $and: [
        { $or: [{ callLeaseUntil: null }, { callLeaseUntil: { $lte: now } }] },
        { $or: [{ nextCallAllowedAt: null }, { nextCallAllowedAt: { $lte: now } }] },
      ],
    },
    {
      $set: {
        callLeaseUntil: leaseUntil,
        lastReservedAt: now,
        lastDialStartedAt: null,
        dialIntentUntil: null,
        lastCallStartedAt: null,
      },
    },
    { returnDocument: "after" }
  );

  if (!schedule) {
    const currentSchedule = await Schedule.findOne({ employeeCode }).lean();
    response.status(409).json({
      allowed: false,
      employeeCode,
      ...aggregateBridgeStatus(freshDevices, currentSchedule, now),
    });
    return;
  }

  response.json({
    allowed: true,
    employeeCode,
    state: "calling",
    callLeaseUntil: leaseUntil,
  });
  emitCallDashboardUpdated(freshDevices.flatMap((device) => device.businessIds));
}

export async function markCallBridgeDialStarted(request: Request, response: Response) {
  const employeeCode = cleanString(request.body.employeeCode, 80);
  const leadId = cleanString(request.body.leadId, 80);
  if (!employeeCode || cleanString(request.header("x-crm-user-code"), 80) !== employeeCode ||
    cleanString(request.header("x-crm-user-type"), 30).toLowerCase() !== "employee") {
    response.status(403).json({ message: "Only the calling employee can mark a dial start." });
    return;
  }

  const now = new Date();
  const Schedule = getCallBridgeScheduleModel();

  if (leadId) {
    const leadDialBlock = await getLeadDialBlock(leadId);

    if (leadDialBlock) {
      await Schedule.findOneAndUpdate(
        { employeeCode },
        { $set: { callLeaseUntil: null, lastDialStartedAt: null, dialIntentUntil: null } }
      );
      response.status(409).json({
        code: leadDialBlock,
        message: leadDialBlock === "LEAD_ALREADY_COMMENTED"
          ? "This lead already has an employee comment today."
          : "The selected lead was not found.",
      });
      return;
    }
  }

  const schedule = await Schedule.findOneAndUpdate(
    { employeeCode, callLeaseUntil: { $gt: now }, lastDialStartedAt: null },
    { $set: { lastDialStartedAt: now, dialIntentUntil: new Date(now.getTime() + dialIntentMs) } },
    { returnDocument: "after" }
  );

  if (!schedule) {
    response.status(409).json({ message: "A current call reservation is required before dialing." });
    return;
  }

  const devices = await devicesForEmployee(employeeCode);
  response.json({ startedAt: now, dialIntentUntil: schedule.dialIntentUntil });
  emitCallDashboardUpdated(devices.flatMap((device) => device.businessIds));
}

export async function releaseCallBridgeCall(request: Request, response: Response) {
  const employeeCode = cleanString(request.body.employeeCode, 80);

  if (!employeeCode) {
    response.status(400).json({ message: "Employee code is required." });
    return;
  }

  const now = new Date();
  const Device = getCallBridgeDeviceModel();
  const freshAfter = new Date(now.getTime() - heartbeatFreshnessMs);
  const freshDevices = await Device.find({ employeeCode, lastSeenAt: { $gte: freshAfter } }).lean();
  const schedule = await getCallBridgeScheduleModel().findOne({ employeeCode }).lean();

  if (freshDevices.some((device) => device.state === "active")) {
    response.status(409).json({
      employeeCode,
      ...aggregateBridgeStatus(freshDevices, schedule, now),
      reason: "The reservation cannot be released while a Nextiva call is active.",
    });
    return;
  }

  const releasedSchedule = await getCallBridgeScheduleModel().findOneAndUpdate(
    { employeeCode },
    {
      $set: { callLeaseUntil: null, lastDialStartedAt: null, dialIntentUntil: null },
      $setOnInsert: { employeeCode },
    },
    { returnDocument: "after", upsert: true, setDefaultsOnInsert: true }
  );

  response.json({
    employeeCode,
    ...aggregateBridgeStatus(freshDevices, releasedSchedule, now),
  });
  emitCallDashboardUpdated(freshDevices.flatMap((device) => device.businessIds));
}

export async function revokeCallBridgeDevices(request: Request, response: Response) {
  const employeeCode = cleanString(request.body.employeeCode, 80);

  if (!employeeCode) {
    response.status(400).json({ message: "Employee code is required." });
    return;
  }

  const [result] = await Promise.all([
    getCallBridgeDeviceModel().deleteMany({ employeeCode }),
    getCallBridgePairingModel().deleteMany({ employeeCode }),
    getCallBridgeScheduleModel().deleteOne({ employeeCode }),
  ]);

  response.json({ message: "Call Bridge devices disconnected.", devicesRemoved: result.deletedCount || 0 });
  if (request.business?.id) emitCallDashboardUpdated([request.business.id]);
}

export async function downloadCallBridgePackage(_request: Request, response: Response) {
  for (const packagePath of callBridgePackageCandidates()) {
    try {
      await fs.access(packagePath);
      response.download(packagePath, callBridgePackageFileName);
      return;
    } catch {
      // Try the next local or deployed layout.
    }
  }

  response.status(404).json({
    message: "Call Bridge package is not built yet. Run npm run call-bridge:package, then try again.",
  });
}
