import mongoose, { Schema } from "mongoose";

export type CallBridgeState = "idle" | "active" | "unknown";

export type CallBridgePairingDocument = {
  codeHash: string;
  employeeCode: string;
  employeeName: string;
  businessIds: string[];
  browserDeviceKeyHash?: string;
  accountSwitchingEnabled: boolean;
  expiresAt: Date;
  usedAt: Date | null;
};

export type CallBridgeDeviceDocument = {
  employeeCode: string;
  employeeName: string;
  businessIds: string[];
  deviceId: string;
  deviceName: string;
  tokenHash: string;
  browserDeviceKeyHash?: string;
  accountSwitchingEnabled: boolean;
  browserSessionId?: string;
  browserSessionStartedAt?: Date;
  browserSessionLastSeenAt?: Date;
  state: CallBridgeState;
  nextivaProcessDetected: boolean;
  audioSessionActive: boolean;
  bridgeVersion: string;
  lastSeenAt: Date;
  lastStateChangedAt: Date;
  inactiveSince?: Date | null;
};

export type CallBridgeScheduleDocument = {
  employeeCode: string;
  callLeaseUntil: Date | null;
  reservedBusinessId: string;
  reservedLeadId: string;
  reservationTokenHash: string;
  nextCallAllowedAt: Date | null;
  lastReservedAt: Date | null;
  lastCallEndedAt: Date | null;
  lastDialStartedAt: Date | null;
  dialIntentUntil: Date | null;
  lastCallStartedAt: Date | null;
};

export type CallBridgeAttemptPhase =
  | "reserved"
  | "dialing"
  | "ringing"
  | "answered"
  | "voicemail"
  | "ended"
  | "classifying"
  | "classified"
  | "failed";

export type CallBridgeAttemptOutcome =
  | "pending"
  | "connected"
  | "not_connected"
  | "voicemail"
  | "unclassified";

export type CallBridgeClassificationConfidence = "" | "high" | "probable" | "needs_review";
export type CallBridgeClassificationSource =
  | ""
  | "manual"
  | "ringcentral_events"
  | "ringcentral_call_log"
  | "ringcentral_recording";

export type CallBridgeAttemptDocument = {
  employeeCode: string;
  employeeName: string;
  businessId: string;
  leadId: string;
  phone: string;
  provider: "ringcentral";
  extensionId: string;
  extensionNumber: string;
  providerSessionId?: string;
  phase: CallBridgeAttemptPhase;
  outcome: CallBridgeAttemptOutcome;
  outcomeReason: string;
  classificationConfidence: CallBridgeClassificationConfidence;
  classificationSource: CallBridgeClassificationSource;
  providerResult: string;
  statusCodes: string[];
  reservedAt: Date;
  dialStartedAt: Date | null;
  ringingAt: Date | null;
  answeredAt: Date | null;
  endedAt: Date | null;
  classifiedAt: Date | null;
  durationSeconds: number;
  recordingId: string;
  callStatLogId: string;
  lastError: string;
  createdAt?: Date;
  updatedAt?: Date;
};

const pairingSchema = new Schema<CallBridgePairingDocument>(
  {
    codeHash: { type: String, required: true, unique: true, index: true },
    employeeCode: { type: String, required: true, trim: true, index: true },
    employeeName: { type: String, required: true, trim: true },
    businessIds: { type: [String], default: [] },
    browserDeviceKeyHash: { type: String, trim: true },
    accountSwitchingEnabled: { type: Boolean, default: false },
    expiresAt: { type: Date, required: true, expires: 0 },
    usedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

const deviceSchema = new Schema<CallBridgeDeviceDocument>(
  {
    employeeCode: { type: String, required: true, trim: true, index: true },
    employeeName: { type: String, required: true, trim: true },
    businessIds: { type: [String], default: [] },
    deviceId: { type: String, required: true, trim: true },
    deviceName: { type: String, required: true, trim: true },
    tokenHash: { type: String, required: true, unique: true, index: true },
    browserDeviceKeyHash: { type: String, trim: true },
    accountSwitchingEnabled: { type: Boolean, default: false, index: true },
    browserSessionId: { type: String, trim: true },
    browserSessionStartedAt: { type: Date },
    browserSessionLastSeenAt: { type: Date },
    state: { type: String, enum: ["idle", "active", "unknown"], default: "unknown", index: true },
    nextivaProcessDetected: { type: Boolean, default: false },
    audioSessionActive: { type: Boolean, default: false },
    bridgeVersion: { type: String, trim: true, default: "" },
    lastSeenAt: { type: Date, required: true, default: Date.now, index: true },
    lastStateChangedAt: { type: Date, required: true, default: Date.now },
    inactiveSince: { type: Date, default: null },
  },
  { timestamps: true }
);

deviceSchema.index({ employeeCode: 1, deviceId: 1 }, { unique: true });
deviceSchema.index({ employeeCode: 1, lastSeenAt: -1 });
deviceSchema.index({ browserDeviceKeyHash: 1 }, { unique: true, sparse: true });

const scheduleSchema = new Schema<CallBridgeScheduleDocument>(
  {
    employeeCode: { type: String, required: true, trim: true, unique: true, index: true },
    callLeaseUntil: { type: Date, default: null },
    reservedBusinessId: { type: String, trim: true, default: "" },
    reservedLeadId: { type: String, trim: true, default: "" },
    reservationTokenHash: { type: String, trim: true, default: "" },
    nextCallAllowedAt: { type: Date, default: null },
    lastReservedAt: { type: Date, default: null },
    lastCallEndedAt: { type: Date, default: null },
    lastDialStartedAt: { type: Date, default: null },
    dialIntentUntil: { type: Date, default: null },
    lastCallStartedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

const attemptSchema = new Schema<CallBridgeAttemptDocument>(
  {
    employeeCode: { type: String, required: true, trim: true, index: true },
    employeeName: { type: String, required: true, trim: true },
    businessId: { type: String, required: true, trim: true, index: true },
    leadId: { type: String, required: true, trim: true, index: true },
    phone: { type: String, trim: true, default: "" },
    provider: { type: String, enum: ["ringcentral"], default: "ringcentral" },
    extensionId: { type: String, trim: true, default: "" },
    extensionNumber: { type: String, trim: true, default: "" },
    providerSessionId: { type: String, trim: true },
    phase: {
      type: String,
      enum: ["reserved", "dialing", "ringing", "answered", "voicemail", "ended", "classifying", "classified", "failed"],
      default: "reserved",
      index: true,
    },
    outcome: {
      type: String,
      enum: ["pending", "connected", "not_connected", "voicemail", "unclassified"],
      default: "pending",
      index: true,
    },
    outcomeReason: { type: String, trim: true, default: "" },
    classificationConfidence: {
      type: String,
      enum: ["", "high", "probable", "needs_review"],
      default: "",
    },
    classificationSource: {
      type: String,
      enum: ["", "manual", "ringcentral_events", "ringcentral_call_log", "ringcentral_recording"],
      default: "",
    },
    providerResult: { type: String, trim: true, default: "" },
    statusCodes: { type: [String], default: [] },
    reservedAt: { type: Date, required: true, default: Date.now },
    dialStartedAt: { type: Date, default: null },
    ringingAt: { type: Date, default: null },
    answeredAt: { type: Date, default: null },
    endedAt: { type: Date, default: null, index: true },
    classifiedAt: { type: Date, default: null, index: true },
    durationSeconds: { type: Number, min: 0, default: 0 },
    recordingId: { type: String, trim: true, default: "" },
    callStatLogId: { type: String, trim: true, default: "" },
    lastError: { type: String, trim: true, default: "" },
  },
  { timestamps: true }
);

attemptSchema.index({ employeeCode: 1, providerSessionId: 1 });
attemptSchema.index({ employeeCode: 1, classifiedAt: 1, reservedAt: -1 });
attemptSchema.index({ businessId: 1, leadId: 1, reservedAt: -1 });

function getControlConnection() {
  const databaseName = process.env.CONTROL_DATABASE_NAME || "crm_control";
  return mongoose.connection.useDb(databaseName, { useCache: true });
}

export function getCallBridgePairingModel() {
  const connection = getControlConnection();
  return (
    connection.models.CallBridgePairing ||
    connection.model<CallBridgePairingDocument>("CallBridgePairing", pairingSchema)
  );
}

export function getCallBridgeDeviceModel() {
  const connection = getControlConnection();
  return (
    connection.models.CallBridgeDevice ||
    connection.model<CallBridgeDeviceDocument>("CallBridgeDevice", deviceSchema)
  );
}

export function getCallBridgeScheduleModel() {
  const connection = getControlConnection();
  return (
    connection.models.CallBridgeSchedule ||
    connection.model<CallBridgeScheduleDocument>("CallBridgeSchedule", scheduleSchema)
  );
}

export function getCallBridgeAttemptModel() {
  const connection = getControlConnection();
  return (
    connection.models.CallBridgeAttempt ||
    connection.model<CallBridgeAttemptDocument>("CallBridgeAttempt", attemptSchema)
  );
}
