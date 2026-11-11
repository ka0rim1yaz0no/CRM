import type { ClientSession } from "mongoose";
import { getCallBridgeDeviceModel, getCallBridgeScheduleModel, type CallBridgeScheduleDocument } from "../models/CallBridge";
import { hasUnconfirmedCall, IDLE_CONFIRMATION_MS } from "./callTiming";

export function autoCallControlSnapshot(schedule?: Partial<CallBridgeScheduleDocument> | null) {
  const userPaused = schedule?.autoCallPaused === true, manualCallHold = Boolean(schedule?.manualCallHoldId);
  return { autoCallPaused: userPaused || manualCallHold, autoCallUserPaused: userPaused, manualCallHold,
    autoCallControlVersion: schedule?.autoCallControlVersion || 0 };
}

export function automaticCallControlFilter() {
  return { autoCallPaused: { $ne: true }, manualCallHoldId: { $in: ["", null] } };
}

export function automaticCallVersionCondition(version: number | "$reservedAutoCallControlVersion") {
  return { $expr: { $eq: [{ $ifNull: ["$autoCallControlVersion", 0] },
    typeof version === "number" ? version : { $ifNull: [version, 0] }] } };
}

export async function automaticCallPaused(employeeCode: string, session?: ClientSession) {
  return Boolean(await getCallBridgeScheduleModel().exists({ employeeCode,
    $or: [{ autoCallPaused: true }, { manualCallHoldId: { $nin: ["", null] } }] }).session(session || null));
}

export async function holdAutomaticCallsForManual(employeeCode: string, attemptId: string) {
  const Schedule = getCallBridgeScheduleModel();
  const current = await Schedule.findOne({ employeeCode })
    .select("autoCallPaused manualCallHoldId manualCallHoldUntil manualCallCancelledAttemptId autoCallControlVersion nativeAttemptId nativeCancelledAt").lean();
  if (current?.manualCallCancelledAttemptId === attemptId || current?.nativeAttemptId === attemptId && current.nativeCancelledAt) return null;
  if (current?.manualCallHoldId === attemptId) return autoCallControlSnapshot(current);
  if (!current) {
    try { await Schedule.updateOne({ employeeCode }, { $setOnInsert: { employeeCode } }, { upsert: true }); }
    catch (error) { if ((error as {code?: number}).code !== 11000) throw error; }
  }
  const row = await Schedule.findOneAndUpdate({ employeeCode, manualCallHoldId: { $ne: attemptId }, manualCallCancelledAttemptId: {$ne: attemptId},
    $or: [{ nativeAttemptId: { $ne: attemptId } }, { nativeCancelledAt: null }] },
  { $set: { manualCallHoldId: attemptId, manualCallHoldUntil: new Date(Date.now() + 90000), manualCallHoldCancelledAt: null }, $inc: { autoCallControlVersion: 1 } },
  { returnDocument: "after" });
  const result = row || await Schedule.findOne({employeeCode}).lean();
  return result?.manualCallHoldId === attemptId ? autoCallControlSnapshot(result) : null;
}

export async function clearManualCallHold(employeeCode: string, attemptId: string, cancelled = false) {
  const Schedule = getCallBridgeScheduleModel(), current = await Schedule.findOne({ employeeCode, manualCallHoldId: attemptId }).lean();
  if (!current || hasUnconfirmedCall(current)) return false;
  const now = new Date(), finished = current.lastObservedAttemptId === attemptId && Boolean(current.lastCallEndedAt) &&
    (!current.lastCallStartedAt || current.lastCallStartedAt <= current.lastCallEndedAt!);
  const unclaimed = current.nativeAttemptId !== attemptId || !current.nativeClaimedAt;
  const expired = current.manualCallHoldUntil && current.manualCallHoldUntil <= now &&
    (!current.dialIntentUntil || current.dialIntentUntil <= now) && (!current.callLeaseUntil || current.callLeaseUntil <= now);
  cancelled ||= Boolean(current.manualCallHoldCancelledAt);
  if (!finished && !(cancelled && unclaimed) && !expired) return false;
  const devices = await getCallBridgeDeviceModel().find({employeeCode, bridgeVersion: {$ne: "ringcentral-api-v1"},
    lastSeenAt: {$gte: new Date(+now - 20000)}}).lean();
  if (!devices.length || devices.some(device => device.state !== "idle" || !device.nextivaProcessDetected || device.audioSessionActive)) return false;
  if (expired && !finished && !unclaimed && devices.some(device => +device.lastStateChangedAt > +now - IDLE_CONFIRMATION_MS)) return false;
  const result = await Schedule.updateOne({ employeeCode, manualCallHoldId: attemptId,
    autoCallControlVersion: current.autoCallControlVersion || 0,
    $expr: { $lte: [{ $ifNull: ["$lastCallStartedAt", new Date(0)] }, { $ifNull: ["$lastCallEndedAt", new Date(0)] }] },
    ...(cancelled && !finished && !expired ? { $or: [{nativeAttemptId: {$ne: attemptId}}, {nativeClaimedAt: null}] } : {}) },
  { $set: { manualCallHoldId: "", manualCallHoldUntil: null, manualCallHoldCancelledAt: null }, $inc: {autoCallControlVersion: 1} });
  return result.modifiedCount > 0;
}
