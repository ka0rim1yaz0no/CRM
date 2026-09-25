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
};

export type CallBridgeScheduleDocument = {
  employeeCode: string;
  callLeaseUntil: Date | null;
  nextCallAllowedAt: Date | null;
  lastReservedAt: Date | null;
  lastCallEndedAt: Date | null;
  lastDialStartedAt: Date | null;
  dialIntentUntil: Date | null;
  lastCallStartedAt: Date | null;
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
    nextCallAllowedAt: { type: Date, default: null },
    lastReservedAt: { type: Date, default: null },
    lastCallEndedAt: { type: Date, default: null },
    lastDialStartedAt: { type: Date, default: null },
    dialIntentUntil: { type: Date, default: null },
    lastCallStartedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

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
