import crypto from "node:crypto";
import { SDK } from "@ringcentral/sdk";
import WebSocket, { type RawData } from "ws";
import { getRingCentralConfig } from "../config/callProvider";
import { runForEachBusiness } from "../config/tenancy";
import { Employee } from "../models/Employee";
import {
  getCallBridgeAttemptModel,
  getCallBridgeDeviceModel,
  getCallBridgeScheduleModel,
} from "../models/CallBridge";
import {
  classifyRingCentralCall,
  classifyRingCentralRecording,
  isRingCentralOutcomeShadowEnabled,
} from "./ringCentralCallClassification";
import { analyzeRingCentralRecording } from "./ringCentralRecordingAnalysis";
import { persistRingCentralCallOutcome } from "./ringCentralCallOutcomePersistence";
import { emitCallDashboardUpdated } from "../socket";

type RingCentralExtension = {
  id?: string;
  extensionNumber?: string;
  name?: string;
  contact?: {
    email?: string;
    firstName?: string;
    lastName?: string;
  };
};

type RingCentralParty = {
  extensionId?: string;
  direction?: string;
  status?: { code?: string };
  to?: { phoneNumber?: string };
  from?: { phoneNumber?: string };
};

type RingCentralTelephonyEvent = {
  body?: {
    sequence?: number;
    sessionId?: string;
    telephonySessionId?: string;
    eventTime?: string;
    parties?: RingCentralParty[];
  };
};

type RingCentralCallLogRecord = {
  id?: string;
  result?: string;
  duration?: number;
  recording?: {
    id?: string;
    type?: string;
    contentUri?: string;
  };
};

export type RingCentralSessionAction = {
  extensionId: string;
  action: "add" | "remove";
};

type EmployeeMapping = {
  employeeCode: string;
  employeeName: string;
  extensionId: string;
  extensionNumber: string;
  businessIds: string[];
};

const providerVersion = "ringcentral-api-v1";
const heartbeatIntervalMs = 10_000;
const extensionRefreshIntervalMs = 5 * 60_000;
const classificationRefreshIntervalMs = 30_000;
const reconnectDelayMs = 60_000;
const postCallDelayMs = 30_000;
// RingCentral can publish a completed call and its recording well after the
// disconnect event. Keep retrying in the background so a late recording is
// classified without blocking the agent's next call.
const callLogRetryDelaysMs = [2_000, 8_000, 15_000, 15_000, 20_000];
const activeStatusCodes = new Set([
  "SETUP",
  "PROCEEDING",
  "ANSWERED",
  "HOLD",
  "PARKED",
  "VOICEMAIL",
  "VOICEMAILSCREENING",
]);
const terminalStatusCodes = new Set(["DISCONNECTED", "GONE"]);

let monitorStarted = false;
let monitorConnected = false;
let monitorLastError = "";
let webSocketReference: WebSocket | null = null;
let lastWebSocketMessageAt = 0;
let heartbeatTimer: NodeJS.Timeout | null = null;
let refreshTimer: NodeJS.Timeout | null = null;
let classificationRefreshTimer: NodeJS.Timeout | null = null;
let retryTimer: NodeJS.Timeout | null = null;
let telephonyEventQueue: Promise<void> = Promise.resolve();

const mappingsByEmployeeCode = new Map<string, EmployeeMapping>();
const employeeCodesByExtensionId = new Map<string, Set<string>>();
const activeSessionsByExtensionId = new Map<string, Set<string>>();
const latestSequenceBySessionId = new Map<string, number>();
const finalizationJobs = new Map<string, Promise<void>>();

function normalizeText(value: unknown) {
  return String(value || "").trim().toLowerCase().replace(/\s+/g, " ");
}

function normalizePhone(value: unknown) {
  return String(value || "").replace(/\D/g, "");
}

function extensionName(extension: RingCentralExtension) {
  return String(
    extension.name ||
      [extension.contact?.firstName, extension.contact?.lastName].filter(Boolean).join(" ")
  ).trim();
}

export function parseRingCentralExtensionMap(rawValue: string) {
  const value = String(rawValue || "").trim();
  if (!value) return new Map<string, string>();

  try {
    if (value.startsWith("{")) {
      const parsed = JSON.parse(value) as Record<string, unknown>;
      return new Map(
        Object.entries(parsed)
          .map(([employeeCode, extension]) => [employeeCode.trim(), String(extension || "").trim()] as const)
          .filter(([employeeCode, extension]) => Boolean(employeeCode && extension))
      );
    }
  } catch {
    return new Map<string, string>();
  }

  return new Map(
    value
      .split(/[,;\n]+/)
      .map((entry) => entry.split("=").map((part) => part.trim()))
      .filter((parts) => parts.length >= 2 && parts[0] && parts[1])
      .map(([employeeCode, extension]) => [employeeCode, extension] as const)
  );
}

export function isRingCentralActiveStatus(value: unknown) {
  return activeStatusCodes.has(String(value || "").trim().toUpperCase());
}

export function isRingCentralTerminalStatus(value: unknown) {
  return terminalStatusCodes.has(String(value || "").trim().toUpperCase());
}

export function isRingCentralSubscriptionAck(
  metadata: { type?: string; messageId?: string; status?: number },
  expectedMessageId: string
) {
  return (
    (metadata.type === "ClientResponse" || metadata.type === "ClientRequest")
    && metadata.messageId === expectedMessageId
  );
}

export function resolveRingCentralSessionActions(
  parties: RingCentralParty[],
  mappedExtensionIds: ReadonlySet<string>,
  trackedExtensionIds: ReadonlySet<string>
) {
  const actions = new Map<string, RingCentralSessionAction["action"]>();
  let recognizedMappedStatus = false;

  for (const party of parties) {
    const extensionId = String(party.extensionId || "").trim();
    if (!extensionId || !mappedExtensionIds.has(extensionId)) continue;

    const statusCode = party.status?.code;
    if (isRingCentralTerminalStatus(statusCode)) {
      actions.set(extensionId, "remove");
      recognizedMappedStatus = true;
    } else if (isRingCentralActiveStatus(statusCode)) {
      actions.set(extensionId, "add");
      recognizedMappedStatus = true;
    }
  }

  const reportedStatuses = parties
    .map((party) => String(party.status?.code || "").trim())
    .filter(Boolean);
  const isPartialTerminalEvent =
    !recognizedMappedStatus
    && reportedStatuses.length > 0
    && reportedStatuses.every(isRingCentralTerminalStatus);

  if (isPartialTerminalEvent) {
    for (const extensionId of trackedExtensionIds) {
      actions.set(extensionId, "remove");
    }
  }

  return [...actions].map(([extensionId, action]) => ({ extensionId, action }));
}

function tokenHash(employeeCode: string, extensionId: string) {
  return crypto.createHash("sha256").update(`ringcentral:${employeeCode}:${extensionId}`).digest("hex");
}

function deviceId(extensionId: string) {
  return `ringcentral:${extensionId}`;
}

async function employeeSnapshots() {
  const employees = new Map<string, {
    employeeCode: string;
    employeeName: string;
    email: string;
    personalEmail: string;
    phone: string;
    businessIds: Set<string>;
  }>();

  await runForEachBusiness(async (business) => {
    const businessEmployees = await Employee.find({ status: { $ne: "Archived" }, role: /sales/i })
      .select("name employeeCode email personalEmail phone")
      .lean();

    for (const employee of businessEmployees) {
      const employeeCode = String(employee.employeeCode || "").trim();
      if (!employeeCode) continue;

      const existing = employees.get(employeeCode);
      if (existing) {
        existing.businessIds.add(business.id);
        continue;
      }

      employees.set(employeeCode, {
        employeeCode,
        employeeName: String(employee.name || employeeCode).trim(),
        email: normalizeText(employee.email),
        personalEmail: normalizeText(employee.personalEmail),
        phone: normalizePhone(employee.phone),
        businessIds: new Set([business.id]),
      });
    }
  });

  return [...employees.values()];
}

export function findRingCentralExtension(
  employee: Awaited<ReturnType<typeof employeeSnapshots>>[number],
  extensions: RingCentralExtension[],
  explicitTarget: string
) {
  if (explicitTarget) {
    const explicitExtension = extensions.find((extension) =>
      String(extension.id || "") === explicitTarget ||
      String(extension.extensionNumber || "") === explicitTarget
    );

    if (explicitExtension) return explicitExtension;
  }

  const emailMatches = extensions.filter((extension) => {
    const email = normalizeText(extension.contact?.email);
    return Boolean(email && (email === employee.email || email === employee.personalEmail));
  });
  if (emailMatches.length === 1) return emailMatches[0];

  const employeeName = normalizeText(employee.employeeName);
  const nameMatches = extensions.filter((extension) => normalizeText(extensionName(extension)) === employeeName);
  if (nameMatches.length === 1) return nameMatches[0];

  if (employee.phone) {
    const phoneMatches = extensions.filter((extension) => normalizePhone(extension.extensionNumber) === employee.phone);
    if (phoneMatches.length === 1) return phoneMatches[0];
  }

  return null;
}

function extensionParty(parties: RingCentralParty[], extensionId: string) {
  return parties.find((party) => String(party.extensionId || "").trim() === extensionId);
}

function delay(milliseconds: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

async function findFinalCallLogRecord(
  platform: ReturnType<SDK["platform"]>,
  sessionId: string
) {
  let latestRecord: RingCentralCallLogRecord | null = null;

  for (const retryDelay of callLogRetryDelaysMs) {
    await delay(retryDelay);
    const response = await platform.get("/restapi/v1.0/account/~/call-log", {
      view: "Detailed",
      telephonySessionId: sessionId,
      recordingType: "All",
    });
    const payload = await response.json() as { records?: RingCentralCallLogRecord[] };
    latestRecord = payload.records?.[0] || null;
    if (!latestRecord) continue;

    const providerClassification = classifyRingCentralCall({ providerResult: latestRecord.result });
    if (providerClassification.outcome !== "unclassified" || latestRecord.recording?.contentUri) {
      return latestRecord;
    }
  }

  return latestRecord;
}

async function finalizeCallAttemptFromProvider(
  platform: ReturnType<SDK["platform"]>,
  attemptId: string,
  sessionId: string
) {
  const Attempt = getCallBridgeAttemptModel();
  const attempt = await Attempt.findById(attemptId).lean();
  if (!attempt || attempt.callStatLogId) return;
  const automaticCallStatLogId = String(attempt._id);

  await Attempt.updateOne(
    { _id: attempt._id, callStatLogId: "" },
    { $set: { phase: "classifying", lastError: "" } }
  );

  try {
    const record = await findFinalCallLogRecord(platform, sessionId);
    if (!record) {
      await Attempt.updateOne(
        { _id: attempt._id, callStatLogId: "" },
        {
          $set: {
            phase: "classifying",
            outcome: "pending",
            outcomeReason: "RingCentral is preparing the final call recording. Automatic detection is still processing.",
            classificationConfidence: "",
            classificationSource: "",
            classifiedAt: null,
            lastError: "",
          },
        }
      );
      return;
    }

    let classification = classifyRingCentralCall({
      statusCodes: attempt.statusCodes,
      providerResult: record.result,
      answeredAt: attempt.answeredAt,
    });
    let classificationSource: "ringcentral_call_log" | "ringcentral_recording" = "ringcentral_call_log";
    let recordingId = String(record.recording?.id || "").trim();

    if (classification.outcome === "unclassified" && record.recording?.contentUri) {
      const recordingResponse = await platform.get(record.recording.contentUri);
      const recordingBytes = await recordingResponse.arrayBuffer();
      const analysis = await analyzeRingCentralRecording(recordingBytes);
      classification = classifyRingCentralRecording(analysis);
      classificationSource = "ringcentral_recording";
    }

    if (classification.outcome === "unclassified") {
      await Attempt.updateOne(
        { _id: attempt._id, callStatLogId: "" },
        {
          $set: {
            phase: "classifying",
            outcome: "pending",
            outcomeReason: "Automatic detection is continuing to analyze the RingCentral recording.",
            classificationConfidence: "",
            classificationSource: "",
            classifiedAt: null,
            lastError: "",
          },
        }
      );
      return;
    }

    const claimedAttempt = await Attempt.updateOne(
      { _id: attempt._id, callStatLogId: "" },
      {
        $set: {
          phase: "classified",
          outcome: classification.outcome,
          outcomeReason: classification.reason,
          classificationConfidence: classification.confidence,
          classificationSource,
          classifiedAt: new Date(),
          recordingId,
          providerResult: `RingCentral call log: ${String(record.result || "Unknown")}`,
          ...(Number.isFinite(record.duration)
            ? { durationSeconds: Math.max(0, Number(record.duration)) }
            : {}),
          callStatLogId: automaticCallStatLogId,
          lastError: "",
        },
      }
    );
    if (claimedAttempt.modifiedCount === 0) return;

    await persistRingCentralCallOutcome({
      attemptId: automaticCallStatLogId,
      businessId: attempt.businessId,
      leadId: attempt.leadId,
      employeeCode: attempt.employeeCode,
      outcome: classification.outcome,
      providerSessionId: sessionId,
      providerResult: `RingCentral call log: ${String(record.result || "Unknown")}`,
      durationSeconds: Number.isFinite(record.duration)
        ? Math.max(0, Number(record.duration))
        : attempt.durationSeconds || 0,
      calledAt: attempt.endedAt || new Date(),
    });
  } catch (error) {
    await Attempt.updateOne(
      {
        _id: attempt._id,
        callStatLogId: { $in: ["", automaticCallStatLogId] },
      },
      {
        $set: {
          phase: "classifying",
          outcome: "pending",
          outcomeReason: "Automatic detection is retrying the RingCentral recording analysis.",
          classificationConfidence: "",
          classificationSource: "",
          classifiedAt: null,
          callStatLogId: "",
          lastError: error instanceof Error ? error.message : String(error),
        },
      }
    );
  }
}

function queueCallAttemptFinalization(
  platform: ReturnType<SDK["platform"]>,
  attemptId: string,
  sessionId: string
) {
  if (finalizationJobs.has(attemptId)) return;

  const job = finalizeCallAttemptFromProvider(platform, attemptId, sessionId)
    .catch((error: unknown) => {
      console.warn(
        "RingCentral call finalization failed:",
        error instanceof Error ? error.message : error
      );
    })
    .finally(() => finalizationJobs.delete(attemptId));
  finalizationJobs.set(attemptId, job);
}

async function retryPendingCallClassifications(platform: ReturnType<SDK["platform"]>) {
  const attempts = await getCallBridgeAttemptModel().find({
    callStatLogId: "",
    providerSessionId: { $exists: true, $ne: "" },
    endedAt: { $gte: new Date(Date.now() - 24 * 60 * 60_000) },
    $or: [
      { phase: "classifying" },
      { outcome: "unclassified", classificationSource: "ringcentral_call_log" },
    ],
  })
    .sort({ endedAt: 1 })
    .limit(20)
    .select("providerSessionId")
    .lean();

  for (const attempt of attempts) {
    const sessionId = String(attempt.providerSessionId || "").trim();
    if (sessionId) {
      queueCallAttemptFinalization(platform, String(attempt._id), sessionId);
    }
  }
}

async function updateCallAttemptFromProvider(
  platform: ReturnType<SDK["platform"]>,
  mapping: EmployeeMapping,
  sessionId: string,
  parties: RingCentralParty[],
  action: RingCentralSessionAction["action"],
  eventTime: Date
) {
  const Attempt = getCallBridgeAttemptModel();
  const party = extensionParty(parties, mapping.extensionId);
  const direction = String(party?.direction || "").trim().toLowerCase();
  const statusCodes = parties
    .map((item) => String(item.status?.code || "").trim())
    .filter(Boolean);
  const normalizedStatusCodes = new Set(statusCodes.map((status) => status.toUpperCase()));

  if (action === "add") {
    if (direction && direction !== "outbound") return;

    const recentDialThreshold = new Date(eventTime.getTime() - 2 * 60_000);
    const voicemailDetected = normalizedStatusCodes.has("VOICEMAIL")
      || normalizedStatusCodes.has("VOICEMAILSCREENING");
    const answeredDetected = normalizedStatusCodes.has("ANSWERED");
    const updatedAttempt = await Attempt.findOneAndUpdate(
      {
        employeeCode: mapping.employeeCode,
        outcome: "pending",
        $or: [
          { providerSessionId: sessionId },
          {
            providerSessionId: { $exists: false },
            phase: { $in: ["reserved", "dialing", "ringing"] },
            dialStartedAt: { $gte: recentDialThreshold, $lte: new Date(eventTime.getTime() + 10_000) },
          },
        ],
      },
      {
        $set: {
          providerSessionId: sessionId,
          extensionId: mapping.extensionId,
          extensionNumber: mapping.extensionNumber,
          phase: voicemailDetected ? "voicemail" : answeredDetected ? "answered" : "ringing",
          providerResult: voicemailDetected
            ? "RingCentral reported voicemail"
            : answeredDetected
              ? "RingCentral reported answered"
              : "RingCentral session confirmed",
        },
        ...(statusCodes.length > 0 ? { $addToSet: { statusCodes: { $each: statusCodes } } } : {}),
      },
      { sort: { reservedAt: -1 }, returnDocument: "after" }
    );
    if (updatedAttempt && (answeredDetected || voicemailDetected)) {
      await Attempt.updateOne(
        {
          _id: updatedAttempt._id,
          $or: [{ answeredAt: null }, { answeredAt: { $exists: false } }],
        },
        { $set: { answeredAt: eventTime } }
      );
    } else if (updatedAttempt) {
      await Attempt.updateOne(
        {
          _id: updatedAttempt._id,
          $or: [{ ringingAt: null }, { ringingAt: { $exists: false } }],
        },
        { $set: { ringingAt: eventTime } }
      );
    }
    return;
  }

  const attempt = await Attempt.findOne({
    employeeCode: mapping.employeeCode,
    providerSessionId: sessionId,
    phase: { $ne: "failed" },
  }).sort({ reservedAt: -1 }).lean();
  if (!attempt) return;

  const startedAt = attempt.dialStartedAt || attempt.ringingAt || attempt.reservedAt;
  const combinedStatusCodes = Array.from(new Set([...(attempt.statusCodes || []), ...statusCodes]));
  const shouldClassify = isRingCentralOutcomeShadowEnabled() && !attempt.callStatLogId;
  const classification = shouldClassify
    ? classifyRingCentralCall({
        statusCodes: combinedStatusCodes,
        providerResult: attempt.providerResult,
        answeredAt: attempt.answeredAt,
      })
    : null;
  const updatedAttempt = await Attempt.findOneAndUpdate(
    { _id: attempt._id, phase: { $ne: "failed" } },
    {
      $set: {
        ...(classification
          ? {
              phase: "classified",
              outcome: classification.outcome,
              outcomeReason: classification.reason,
              classificationConfidence: classification.confidence,
              classificationSource: "ringcentral_events",
              classifiedAt: eventTime,
            }
          : attempt.phase !== "classified"
            ? { phase: "ended" }
            : {}),
        endedAt: eventTime,
        durationSeconds: Math.max(0, Math.round((eventTime.getTime() - startedAt.getTime()) / 1000)),
        providerResult: classification
          ? `RingCentral event classification: ${classification.outcome}`
          : "RingCentral session ended",
      },
      ...(statusCodes.length > 0 ? { $addToSet: { statusCodes: { $each: statusCodes } } } : {}),
    },
    { returnDocument: "after" }
  );
  if (shouldClassify && updatedAttempt) {
    queueCallAttemptFinalization(platform, String(updatedAttempt._id), sessionId);
  }
}

async function loadExtensions(platform: ReturnType<SDK["platform"]>) {
  const response = await platform.get("/restapi/v1.0/account/~/extension", {
    type: "User",
    status: "Enabled",
    perPage: 1000,
  });
  const payload = await response.json() as { records?: RingCentralExtension[] };
  return payload.records || [];
}

async function refreshMappings(platform: ReturnType<SDK["platform"]>) {
  const [extensions, employees] = await Promise.all([loadExtensions(platform), employeeSnapshots()]);
  const explicitMap = parseRingCentralExtensionMap(process.env.RINGCENTRAL_EXTENSION_MAP || "");
  const nextMappings = new Map<string, EmployeeMapping>();
  const nextCodesByExtension = new Map<string, Set<string>>();

  for (const employee of employees) {
    const extension = findRingCentralExtension(employee, extensions, explicitMap.get(employee.employeeCode) || "");
    const extensionId = String(extension?.id || "").trim();
    if (!extensionId) continue;

    const mapping: EmployeeMapping = {
      employeeCode: employee.employeeCode,
      employeeName: employee.employeeName,
      extensionId,
      extensionNumber: String(extension?.extensionNumber || "").trim(),
      businessIds: [...employee.businessIds],
    };
    nextMappings.set(mapping.employeeCode, mapping);

    const employeeCodes = nextCodesByExtension.get(extensionId) || new Set<string>();
    employeeCodes.add(mapping.employeeCode);
    nextCodesByExtension.set(extensionId, employeeCodes);
  }

  mappingsByEmployeeCode.clear();
  employeeCodesByExtensionId.clear();
  nextMappings.forEach((mapping, employeeCode) => mappingsByEmployeeCode.set(employeeCode, mapping));
  nextCodesByExtension.forEach((employeeCodes, extensionId) => employeeCodesByExtensionId.set(extensionId, employeeCodes));
  await touchMappedDevices();
}

async function touchMappedDevices() {
  if (!monitorConnected) return;

  const now = new Date();
  const Device = getCallBridgeDeviceModel();

  await Promise.all([...mappingsByEmployeeCode.values()].map(async (mapping) => {
    const active = (activeSessionsByExtensionId.get(mapping.extensionId)?.size || 0) > 0;
    const nextState = active ? "active" : "idle";
    const existing = await Device.findOne({
      employeeCode: mapping.employeeCode,
      deviceId: deviceId(mapping.extensionId),
    }).select("state lastStateChangedAt").lean();
    await Device.findOneAndUpdate(
      { employeeCode: mapping.employeeCode, deviceId: deviceId(mapping.extensionId) },
      {
        $set: {
          employeeName: mapping.employeeName,
          businessIds: mapping.businessIds,
          deviceName: mapping.extensionNumber
            ? `RingCentral extension ${mapping.extensionNumber}`
            : "RingCentral extension",
          nextivaProcessDetected: true,
          audioSessionActive: active,
          state: nextState,
          bridgeVersion: providerVersion,
          lastSeenAt: now,
          ...(existing && existing.state !== nextState ? { lastStateChangedAt: now } : {}),
        },
        $setOnInsert: {
          tokenHash: tokenHash(mapping.employeeCode, mapping.extensionId),
          accountSwitchingEnabled: true,
        },
      },
      { upsert: true, setDefaultsOnInsert: true }
    );
  }));
}

async function updateEmployeeCallState(mapping: EmployeeMapping, active: boolean, eventTime: Date) {
  const Device = getCallBridgeDeviceModel();
  const existing = await Device.findOne({
    employeeCode: mapping.employeeCode,
    deviceId: deviceId(mapping.extensionId),
  });
  const previousState = existing?.state || "idle";
  const nextState = active ? "active" : "idle";
  const now = new Date();

  await Device.findOneAndUpdate(
    { employeeCode: mapping.employeeCode, deviceId: deviceId(mapping.extensionId) },
    {
      $set: {
        employeeName: mapping.employeeName,
        businessIds: mapping.businessIds,
        deviceName: mapping.extensionNumber
          ? `RingCentral extension ${mapping.extensionNumber}`
          : "RingCentral extension",
        tokenHash: tokenHash(mapping.employeeCode, mapping.extensionId),
        accountSwitchingEnabled: true,
        state: nextState,
        nextivaProcessDetected: true,
        audioSessionActive: active,
        bridgeVersion: providerVersion,
        lastSeenAt: now,
        ...(previousState !== nextState ? { lastStateChangedAt: eventTime } : {}),
      },
    },
    { upsert: true, setDefaultsOnInsert: true }
  );

  if (active && previousState !== "active") {
    await getCallBridgeScheduleModel().findOneAndUpdate(
      { employeeCode: mapping.employeeCode },
      {
        $set: {
          callLeaseUntil: null,
          reservedBusinessId: "",
          reservedLeadId: "",
          reservationTokenHash: "",
          dialIntentUntil: null,
          lastCallStartedAt: eventTime,
        },
        $setOnInsert: { employeeCode: mapping.employeeCode },
      },
      { upsert: true, setDefaultsOnInsert: true }
    );
  } else if (!active && previousState === "active") {
    await getCallBridgeScheduleModel().findOneAndUpdate(
      { employeeCode: mapping.employeeCode },
      {
        $set: {
          callLeaseUntil: null,
          reservedBusinessId: "",
          reservedLeadId: "",
          reservationTokenHash: "",
          lastCallEndedAt: eventTime,
          nextCallAllowedAt: new Date(eventTime.getTime() + postCallDelayMs),
          lastCallStartedAt: null,
          lastDialStartedAt: null,
          dialIntentUntil: null,
        },
        $setOnInsert: { employeeCode: mapping.employeeCode },
      },
      { upsert: true, setDefaultsOnInsert: true }
    );
  }

  if (previousState !== nextState) {
    emitCallDashboardUpdated(mapping.businessIds);
  }
}

async function handleTelephonyEvent(
  rawEvent: unknown,
  platform: ReturnType<SDK["platform"]>
) {
  const event = rawEvent as RingCentralTelephonyEvent;
  const body = event.body;
  const sessionId = String(body?.telephonySessionId || body?.sessionId || "").trim();
  if (!sessionId || !Array.isArray(body?.parties)) return;

  const sequence = body.sequence;
  if (typeof sequence === "number" && Number.isFinite(sequence)) {
    const previousSequence = latestSequenceBySessionId.get(sessionId) ?? -1;
    if (sequence <= previousSequence) return;
    latestSequenceBySessionId.set(sessionId, sequence);
  }

  const parsedEventTime = new Date(String(body.eventTime || ""));
  const eventTime = Number.isNaN(parsedEventTime.getTime()) ? new Date() : parsedEventTime;
  const trackedExtensionIds = new Set(
    [...activeSessionsByExtensionId]
      .filter(([, sessions]) => sessions.has(sessionId))
      .map(([extensionId]) => extensionId)
  );
  const actions = resolveRingCentralSessionActions(
    body.parties,
    new Set(employeeCodesByExtensionId.keys()),
    trackedExtensionIds
  );
  const affectedExtensionIds = new Set<string>();

  for (const { extensionId, action } of actions) {
    const sessions = activeSessionsByExtensionId.get(extensionId) || new Set<string>();

    if (action === "remove") {
      sessions.delete(sessionId);
    } else {
      sessions.add(sessionId);
    }

    if (sessions.size > 0) {
      activeSessionsByExtensionId.set(extensionId, sessions);
    } else {
      activeSessionsByExtensionId.delete(extensionId);
    }
    affectedExtensionIds.add(extensionId);
  }

  await Promise.all([...affectedExtensionIds].flatMap((extensionId) => {
    const active = (activeSessionsByExtensionId.get(extensionId)?.size || 0) > 0;
    const action = actions.find((item) => item.extensionId === extensionId)?.action || "remove";
    return [...(employeeCodesByExtensionId.get(extensionId) || [])]
      .map((employeeCode) => mappingsByEmployeeCode.get(employeeCode))
      .filter((mapping): mapping is EmployeeMapping => Boolean(mapping))
      .flatMap((mapping) => [
        updateEmployeeCallState(mapping, active, eventTime),
        updateCallAttemptFromProvider(platform, mapping, sessionId, body.parties || [], action, eventTime),
      ]);
  }));
}

function clearMonitorTimers() {
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  if (refreshTimer) clearInterval(refreshTimer);
  if (classificationRefreshTimer) clearInterval(classificationRefreshTimer);
  heartbeatTimer = null;
  refreshTimer = null;
  classificationRefreshTimer = null;
}

function scheduleRetry() {
  if (retryTimer) return;
  retryTimer = setTimeout(() => {
    retryTimer = null;
    void connectMonitor();
  }, reconnectDelayMs);
}

function handleWebSocketDisconnect(socket: WebSocket, reason: string) {
  if (webSocketReference !== socket) return;

  monitorConnected = false;
  monitorLastError = reason;
  webSocketReference = null;
  activeSessionsByExtensionId.clear();
  latestSequenceBySessionId.clear();
  clearMonitorTimers();
  scheduleRetry();
}

function parseWebSocketMessage(data: RawData) {
  try {
    const parsed = JSON.parse(data.toString()) as unknown;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function createWebSocketConnection(platform: ReturnType<SDK["platform"]>) {
  const tokenResponse = await platform.post("/restapi/oauth/wstoken");
  const tokenPayload = await tokenResponse.json() as { ws_access_token?: string; uri?: string };
  const accessToken = String(tokenPayload.ws_access_token || "").trim();
  const uri = String(tokenPayload.uri || "").trim();
  if (!accessToken || !uri) {
    throw new Error("RingCentral did not return WebSocket connection credentials.");
  }

  const socketUrl = new URL(uri);
  socketUrl.searchParams.set("access_token", accessToken);
  const socket = new WebSocket(socketUrl);
  const subscribeMessageId = crypto.randomUUID();

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    let subscriptionSent = false;
    const setupMessages: string[] = [];
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      socket.close();
      const trace = setupMessages.length > 0 ? ` Received: ${setupMessages.join(", ")}.` : "";
      reject(new Error(`RingCentral WebSocket subscription timed out.${trace}`));
    }, 30_000);

    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      callback();
    };

    socket.on("message", (data) => {
      lastWebSocketMessageAt = Date.now();
      const messages = parseWebSocketMessage(data);
      const metadata = (messages[0] || {}) as { type?: string; messageId?: string; status?: number; message?: string };
      if (!settled && metadata.type) {
        const body = (messages[1] || {}) as { errorCode?: string; message?: string };
        setupMessages.push([
          metadata.type,
          metadata.status ? `status=${metadata.status}` : "",
          metadata.messageId === subscribeMessageId ? "matching-id" : "",
          body.errorCode ? `error=${body.errorCode}` : "",
          body.message ? `message=${body.message}` : "",
        ].filter(Boolean).join(" "));
      }

      if (metadata.type === "ConnectionDetails" && !subscriptionSent) {
        subscriptionSent = true;
        socket.send(JSON.stringify([
          {
            type: "ClientRequest",
            messageId: subscribeMessageId,
            method: "POST",
            path: "/restapi/v1.0/subscription/",
          },
          {
            eventFilters: ["/restapi/v1.0/account/~/telephony/sessions"],
            deliveryMode: { transportType: "WebSocket" },
          },
        ]));
        return;
      }

      if (isRingCentralSubscriptionAck(metadata, subscribeMessageId)) {
        if (Number(metadata.status || 0) >= 200 && Number(metadata.status || 0) < 300) {
          finish(resolve);
        } else {
          finish(() => reject(new Error(metadata.message || `RingCentral subscription failed with status ${metadata.status || "unknown"}.`)));
        }
        return;
      }

      if (metadata.type === "ServerNotification" && messages[1]) {
        telephonyEventQueue = telephonyEventQueue
          .then(() => handleTelephonyEvent(messages[1], platform))
          .catch((error: unknown) => {
            console.warn("RingCentral telephony event could not be processed:", error instanceof Error ? error.message : error);
          });
      }
    });

    socket.on("error", (error) => {
      if (!settled) {
        finish(() => reject(error));
      }
    });

    socket.on("close", (code, reason) => {
      const detail = reason.toString().trim();
      if (!settled) {
        finish(() => reject(new Error(`RingCentral WebSocket closed during setup (${code}${detail ? `: ${detail}` : ""}).`)));
        return;
      }
      handleWebSocketDisconnect(socket, `RingCentral WebSocket disconnected (${code}${detail ? `: ${detail}` : ""}).`);
    });
  });

  return socket;
}

async function connectMonitor() {
  const config = getRingCentralConfig();
  if (!config.configured) {
    monitorConnected = false;
    monitorLastError = "RingCentral API credentials are not configured.";
    return;
  }

  try {
    const sdk = new SDK({
      server: config.server,
      clientId: config.clientId,
      clientSecret: config.clientSecret,
    });
    const platform = sdk.platform();
    await platform.login({ jwt: config.jwt });
    await refreshMappings(platform);
    const socket = await createWebSocketConnection(platform);

    webSocketReference = socket;
    monitorConnected = true;
    monitorLastError = "";
    await touchMappedDevices();

    heartbeatTimer = setInterval(() => {
      if (webSocketReference?.readyState !== WebSocket.OPEN) {
        if (webSocketReference) {
          handleWebSocketDisconnect(webSocketReference, "RingCentral WebSocket is not open.");
        }
        return;
      }

      if (Date.now() - lastWebSocketMessageAt >= 30_000) {
        webSocketReference.send(JSON.stringify([{ type: "Heartbeat", messageId: crypto.randomUUID() }]));
      }

      void touchMappedDevices().catch((error: unknown) => {
        monitorLastError = error instanceof Error ? error.message : String(error);
      });
    }, heartbeatIntervalMs);
    refreshTimer = setInterval(() => {
      void refreshMappings(platform).catch((error: unknown) => {
        monitorLastError = error instanceof Error ? error.message : String(error);
      });
    }, extensionRefreshIntervalMs);
    void retryPendingCallClassifications(platform).catch((error: unknown) => {
      monitorLastError = error instanceof Error ? error.message : String(error);
    });
    classificationRefreshTimer = setInterval(() => {
      void retryPendingCallClassifications(platform).catch((error: unknown) => {
        monitorLastError = error instanceof Error ? error.message : String(error);
      });
    }, classificationRefreshIntervalMs);

    console.log(`RingCentral call monitor connected with ${mappingsByEmployeeCode.size} mapped sales employee(s).`);
  } catch (error) {
    monitorConnected = false;
    monitorLastError = error instanceof Error ? error.message : String(error);
    if (webSocketReference) webSocketReference.close();
    webSocketReference = null;
    clearMonitorTimers();
    console.warn(`RingCentral call monitor is unavailable: ${monitorLastError}`);
    scheduleRetry();
  }
}

export function startRingCentralCallMonitor() {
  if (monitorStarted) return;
  monitorStarted = true;
  void connectMonitor();
}

export function getRingCentralMonitorStatus(employeeCode = "") {
  const config = getRingCentralConfig();
  const mapping = mappingsByEmployeeCode.get(String(employeeCode || "").trim());
  return {
    configured: config.configured,
    connected: monitorConnected,
    mapped: Boolean(mapping),
    extensionId: mapping?.extensionId || "",
    extensionNumber: mapping?.extensionNumber || "",
    deviceName: mapping
      ? mapping.extensionNumber
        ? `RingCentral extension ${mapping.extensionNumber}`
        : "RingCentral extension"
      : "",
    lastError: monitorLastError,
  };
}
