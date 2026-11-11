import {callReadPriority} from "../services/callReadPriority";
import type { Request, Response } from "express";
import type { ClientSession } from "mongoose";
import { verifyAttendanceHubSession } from "../config/attendanceHubSession";
import { runWithBusiness } from "../config/tenancy";
import { getCallProvider, isAutoCallDisabledForEmployee, isSupportedAutoCallClientVersion } from "../config/callProvider";
import { callTimingV2Enabled, leadPhoneDedupEnabled } from "../config/rolloutFlags";
import { signedEmployeeInBusiness } from "../middleware/legacyAuthentication";
import { Employee } from "../models/Employee";
import { Lead } from "../models/Lead";
import { getCallBridgeDeviceModel, getCallBridgeScheduleModel } from "../models/CallBridge";
import { attendanceAllowsCall } from "../services/callAttendanceGuard";
import { hasReliableTwoWayAudioDetection } from "../services/callBridgeActiveSignal";
import { callTimingWriteConditions } from "../services/callBridgeReservation";
import { unconfirmedDialRetryAt } from "../services/callTiming";
import { normalizeCallingPhone } from "../services/employeeCallingQueue";
import { isLeadEligibleForAutoCall } from "../services/leadAutoCallEligibility";
import { withLeadDispatchOwnership, type Snapshot } from "../services/leadAssignment";
import { reservePhoneSlot } from "../services/leadPhoneDispatch";
import { boundNativeDevice, nativeSecretHash, supportsNativeDial } from "../services/nativeCallBridge";
import { isSalesEmployee } from "../../../shared/leadAssignmentPolicy";
import { callingWindow } from "../../../shared/leadCallingPolicy";
import { getReadOnlyManualLeadDialBlock, getTransactionalLeadDialBlock } from "./callBridgeController";
import { automaticCallControlFilter, automaticCallPaused, automaticCallVersionCondition, holdAutomaticCallsForManual, clearManualCallHold } from "../services/autoCallControl";

class NativeConflict extends Error {}
function refuse(code: string): never { throw new NativeConflict(code); }
const text = (value: unknown) => String(value || "").trim();
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const manualWorkHash = (lead: Snapshot) => nativeSecretHash(JSON.stringify([lead.status, lead.followUpAt, lead.lastCallOutcomeAt, lead.comments]));

function enabled() {
  if (!callTimingV2Enabled() || getCallProvider() !== "nextiva") refuse("NATIVE_DIAL_UNAVAILABLE");
}
function grantFilter(code: string, business: string, attempt: string, lead: string, now: Date, manual = false) {
  return { employeeCode: code, reservedBusinessId: business, reservedAttemptId: attempt, reservedLeadId: lead,
    ...(manual ? { manualCallHoldId: attempt } : {}),
    ...(manual ? {} : automaticCallControlFilter()),
    $and: [automaticCallVersionCondition("$reservedAutoCallControlVersion")],
    reservationTokenHash: nativeSecretHash(attempt), callLeaseUntil: { $gt: now }, dialIntentUntil: { $gt: now },
    lastDialStartedAt: { $ne: null, $lte: now },
    $expr: { $lte: [{ $ifNull: ["$lastCallStartedAt", new Date(0)] }, { $ifNull: ["$lastCallEndedAt", new Date(0)] }] } };
}
async function devicesReady(code: string, session?: ClientSession) {
  const rows = await getCallBridgeDeviceModel().find({ employeeCode: code, bridgeVersion: { $ne: "ringcentral-api-v1" },
    lastSeenAt: { $gte: new Date(Date.now() - 20000) } }).session(session || null).lean();
  if (!rows.length || rows.some(device => device.state !== "idle" || !device.nextivaProcessDetected ||
    device.audioSessionActive || !hasReliableTwoWayAudioDetection(device.bridgeVersion))) refuse("CALL_BRIDGE_NOT_READY");
  return rows;
}
async function employeeReady(code: string, business: string, manual: boolean, session?: ClientSession) {
  if ((!manual && isAutoCallDisabledForEmployee(code)) || !callingWindow(new Date()).permitted) refuse("CALLING_NOT_AVAILABLE");
  if (!manual && await automaticCallPaused(code, session)) refuse("AUTO_CALL_PAUSED");
  const employee = await signedEmployeeInBusiness(code, business, session);
  if (!employee) refuse("CALL_BUSINESS_CHANGED");
  if (!employee || !isSalesEmployee(employee) || !await attendanceAllowsCall(employee, session, manual ? "manual" : "automatic")) refuse("CALL_ATTENDANCE_CHANGED");
  return employee;
}
const nativeDialMessages: Readonly<Partial<Record<string, string>>> = {
  AUTO_CALL_PAUSED: "Auto Call is held while manual calling or a pause is active.",
  CALL_BRIDGE_UPDATE_REQUIRED: "Update and pair Call Bridge between calls to enable native dialing.",
  CALL_BRIDGE_NOT_READY: "Call Bridge must confirm Nextiva is open and idle before dialing.",
  CALL_ATTENDANCE_CHANGED: "Attendance changed or this activity does not allow the requested call.",
  CALLING_NOT_AVAILABLE: "Calling is unavailable for this session or outside calling hours.",
  CALL_PHONE_IN_USE: "Another call is pending for this phone number.",
  CALL_LAUNCH_EXPIRED: "A previous call or dial may still be pending. Check Nextiva before retrying.",
};
function failure(response: Response, error: unknown) {
  const code = error instanceof NativeConflict ? error.message : "NATIVE_DIAL_UNAVAILABLE";
  response.status(error instanceof NativeConflict ? 409 : 503).set("Cache-Control", "no-store").json({
    code,
    message: nativeDialMessages[code] ?? "The call could not be safely handed to Call Bridge. Check current calling state.",
  });
}

export async function beginManualCallHold(request: Request, response: Response) {
  const code = text(request.body.employeeCode), business = request.business?.id || "", attempt = text(request.body.attemptId);
  const leadId = text(request.body.leadId), phone = text(request.body.normalizedPhone);
  if (verifyAttendanceHubSession(request.header("x-crm-attendance-session")) !== code || request.header("x-crm-user-code") !== code ||
    request.header("x-crm-user-type") !== "employee" || !await signedEmployeeInBusiness(code, business)) {
    response.status(403).json({code: "SIGNED_EMPLOYEE_REQUIRED"}); return;
  }
  if (!uuid.test(attempt) || !/^[a-f0-9]{24}$/i.test(leadId) || !isSupportedAutoCallClientVersion(request.header("x-crm-auto-call-version")) ||
    request.body.paused === false || request.body.manualTakeover === false) {
    response.status(400).json({code: "INVALID_MANUAL_CALL_HOLD"}); return;
  }
  try {
    enabled(); const employee = await employeeReady(code, business, true);
    const lead = await Lead.findById(leadId).select("assignedAgent assignedAgentName status phone").lean();
    if (!lead || normalizeCallingPhone(lead.phone) !== phone || await getReadOnlyManualLeadDialBlock(lead, String(employee._id),
      [employee.name, employee.employeeCode, ...(employee.aliases || [])])) refuse("CALL_LEAD_NOT_ELIGIBLE");
    const devices = await getCallBridgeDeviceModel().find({employeeCode: code, lastSeenAt: {$gte: new Date(Date.now() - 20000)}}).lean();
    if (!boundNativeDevice(devices, business, text(request.body.browserDeviceKey), text(request.body.browserSessionId))) refuse("CALL_BROWSER_SESSION_CHANGED");
    const result = await holdAutomaticCallsForManual(code, attempt);
    if (!result) refuse("NATIVE_ATTEMPT_CANCELLED");
    response.set("Cache-Control", "no-store").json(result);
  } catch (error) { failure(response, error); }
}

// Only a signed browser may queue a command. A paired desktop claims it once, after a second canonical guard check.
export async function requestNativeDial(request: Request, response: Response) {
  const code = text(request.body.employeeCode), business = request.business?.id || "";
  const attempt = text(request.body.attemptId), leadId = text(request.body.leadId);
  const browserKey = text(request.body.browserDeviceKey), browserSession = text(request.body.browserSessionId);
  const manual = request.body.manual === true;
  const manualHoldVersion = request.body.manualHoldVersion;
  if (verifyAttendanceHubSession(request.header("x-crm-attendance-session")) !== code ||
    request.header("x-crm-user-code") !== code || request.header("x-crm-user-type") !== "employee" ||
    !await signedEmployeeInBusiness(code, business)) {
    response.status(403).json({ code: "SIGNED_EMPLOYEE_REQUIRED", message: "A signed employee session is required." }); return;
  }
  if (!uuid.test(attempt) || !/^[a-f0-9]{24}$/i.test(leadId) || !isSupportedAutoCallClientVersion(request.header("x-crm-auto-call-version")) ||
    manual && manualHoldVersion !== undefined && (!Number.isSafeInteger(manualHoldVersion) || manualHoldVersion < 0)) {
    response.status(400).json({ code: "INVALID_NATIVE_ATTEMPT", message: "Refresh the CRM before calling." }); return;
  }
  let priority: ReturnType<typeof callReadPriority.reserve> | undefined;
  try {
    enabled();
    const employee = await employeeReady(code, business, manual), Schedule = getCallBridgeScheduleModel();
    const devices = await devicesReady(code), target = boundNativeDevice(devices, business, browserKey, browserSession);
    if (!target) refuse("CALL_BRIDGE_UPDATE_REQUIRED");
    let manualVersion: number | undefined;
    if (manual) {
      if (manualHoldVersion !== undefined) manualVersion = manualHoldVersion;
      else {
        const held = await holdAutomaticCallsForManual(code, attempt);
        if (!held) refuse("NATIVE_ATTEMPT_CANCELLED");
        manualVersion = held.autoCallControlVersion;
      }
    }
    priority = callReadPriority.reserve(Date.now());
    // Create only the schedule container; original attendance and financial records are never written.
    if (manual) await Schedule.updateOne({ employeeCode: code }, { $setOnInsert: { employeeCode: code } }, { upsert: true });
    const revalidation = !manual || Boolean(await Schedule.exists({ employeeCode: code, nativeAttemptId: attempt }));
    let leadWorkHash = "";
    const result = await withLeadDispatchOwnership(leadId, String(employee._id), async session => {
      const now = new Date();
      const existing = await Schedule.findOne({ employeeCode: code }).session(session).lean();
      if (existing?.nativeAttemptId === attempt) {
        if (existing.nativeCancelledAt) refuse("NATIVE_ATTEMPT_CANCELLED");
        if (Boolean(existing.nativeManual) !== manual) refuse("NATIVE_ATTEMPT_CHANGED");
        if (manual && existing.reservedAutoCallControlVersion !== manualVersion) refuse("NATIVE_ATTEMPT_CHANGED");
        if (manual && existing.nativeLeadWorkHash !== leadWorkHash) refuse("CALL_LEAD_CHANGED");
        if (existing.nativeDeviceId !== target.deviceId || existing.nativeBrowserSessionId !== browserSession ||
          existing.nativeBrowserKeyHash !== nativeSecretHash(browserKey) || existing.reservedBusinessId !== business ||
          existing.reservedLeadId !== leadId) refuse("NATIVE_ATTEMPT_CHANGED");
        if (!existing.nativeClaimedAt && !await Schedule.exists(grantFilter(code, business, attempt, leadId, now, manual)).session(session)) refuse("CALL_LAUNCH_EXPIRED");
        return existing;
      }
      const fields = { nativeAttemptId: attempt, nativeManual: manual, nativeLeadWorkHash: leadWorkHash, nativeDeviceId: target.deviceId, nativeBrowserSessionId: browserSession,
        nativeBrowserKeyHash: nativeSecretHash(browserKey), nativeClaimedAt: null, nativeCancelledAt: null };
      if (manual) return Schedule.findOneAndUpdate({ employeeCode: code, manualCallHoldId: attempt, autoCallControlVersion: manualVersion, $and: [
        { $or: [{ callLeaseUntil: null }, { callLeaseUntil: { $lte: now } }] }, ...callTimingWriteConditions(now, true),
      ] }, { $set: { ...fields, reservedBusinessId: business, reservedAttemptId: attempt, reservedLeadId: leadId,
        reservedPhone: text(request.body.normalizedPhone), reservationTokenHash: nativeSecretHash(attempt), lastReservedAt: now,
        callLeaseUntil: new Date(+now + 45000), manualCallHoldUntil: new Date(+now + 45000), reservedAutoCallControlVersion: manualVersion,
        lastDialStartedAt: now, dialIntentUntil: new Date(+now + 30000), nextCallAllowedAt: unconfirmedDialRetryAt(now) } },
      { returnDocument: "after", session });
      return Schedule.findOneAndUpdate({ ...grantFilter(code, business, attempt, leadId, now, manual), nativeAttemptId: { $ne: attempt } },
        { $set: fields }, { returnDocument: "after", session });
    }, { employeeCode: code, attemptId: attempt, revalidateConsumed: revalidation }, async (session, lead) => {
      const current = await employeeReady(code, business, manual, session);
      leadWorkHash = manual ? manualWorkHash(lead) : "";
      if (normalizeCallingPhone(lead.phone) !== text(request.body.normalizedPhone) || (!manual && !isLeadEligibleForAutoCall(lead, new Date())) ||
        await getTransactionalLeadDialBlock(lead, String(current._id), [current.name, current.employeeCode, ...(current.aliases || [])], session, manual)) refuse("CALL_LEAD_NOT_ELIGIBLE");
      const fresh = await devicesReady(code, session), bound = boundNativeDevice(fresh, business, browserKey, browserSession);
      if (!bound || bound.deviceId !== target.deviceId) refuse("CALL_BROWSER_SESSION_CHANGED");
      if (!await getCallBridgeDeviceModel().updateOne({ _id: bound._id, employeeCode: code, browserSessionId: browserSession,
        browserDeviceKeyHash: nativeSecretHash(browserKey) }, { $set: { browserSessionLastSeenAt: new Date() } }, { session }).then(row => row.matchedCount)) refuse("CALL_BROWSER_SESSION_CHANGED");
      if (manual && !revalidation && leadPhoneDedupEnabled() && !await reservePhoneSlot(normalizeCallingPhone(lead.phone)!, code, attempt, new Date(), session, true)) refuse("CALL_PHONE_IN_USE");
      return true;
    });
    if (!result) refuse("CALL_LAUNCH_EXPIRED");
    response.set("Cache-Control", "no-store").json({ queued: true, claimed: Boolean(result.nativeClaimedAt), attemptId: attempt,
      leadId, serverTime: new Date(), dialIntentUntil: result.dialIntentUntil });
  } catch (error) { failure(response, error); } finally {priority?.close();}
}

export async function claimNativeDial(request: Request, response: Response) {
  const token = text(request.header("authorization")).replace(/^Bearer\s+/i, "");
  const Device = getCallBridgeDeviceModel(), Schedule = getCallBridgeScheduleModel();
  const device = token && await Device.findOne({ tokenHash: nativeSecretHash(token), deviceId: text(request.body.deviceId) }).lean();
  if (!device || !supportsNativeDial(device)) { response.status(403).json({ code: "NATIVE_DEVICE_REQUIRED" }); return; }
  const code = device.employeeCode;
  let priority: ReturnType<typeof callReadPriority.reserve> | undefined;
  try {
    enabled();
    const pending = await Schedule.findOne({ employeeCode: code, nativeDeviceId: device.deviceId,
      nativeClaimedAt: null, nativeCancelledAt: null, nativeAttemptId: { $ne: "" }, callLeaseUntil: { $gt: new Date() }, dialIntentUntil: { $gt: new Date() } }).lean();
    if (!pending || pending.nativeAttemptId !== pending.reservedAttemptId) { response.status(204).end(); return; }
    priority = callReadPriority.reserve(Date.now());
    const business = pending.reservedBusinessId, manual = pending.nativeManual === true;
    if (!device.businessIds.includes(business)) refuse("CALL_BUSINESS_CHANGED");
    await runWithBusiness(business, async () => {
    const employee = await Employee.findOne({employeeCode: code, status: {$ne: "Archived"}}).select("_id").lean();
    if (!employee) refuse("CALL_ATTENDANCE_CHANGED");
    const claimed = await withLeadDispatchOwnership(pending.reservedLeadId, String(employee._id), async session => {
      const now = new Date();
      return Schedule.findOneAndUpdate({ ...grantFilter(code, business, pending.nativeAttemptId!, pending.reservedLeadId, now, manual),
        nativeDeviceId: device.deviceId, nativeAttemptId: pending.nativeAttemptId, nativeClaimedAt: null, nativeCancelledAt: null,
        nativeManual: manual ? true : { $ne: true },
        nativeBrowserSessionId: pending.nativeBrowserSessionId, nativeBrowserKeyHash: pending.nativeBrowserKeyHash,
      }, { $set: { nativeClaimedAt: now } }, { returnDocument: "after", session });
    }, { employeeCode: code, attemptId: pending.nativeAttemptId!, revalidateConsumed: true }, async (session, lead) => {
      const current = await employeeReady(code, business, manual, session), fresh = await devicesReady(code, session);
      const bound = fresh.find(row => String(row._id) === String(device._id) && row.tokenHash === device.tokenHash && supportsNativeDial(row) &&
        row.businessIds.includes(business) && row.browserSessionId === pending.nativeBrowserSessionId && row.browserDeviceKeyHash === pending.nativeBrowserKeyHash);
      if (!bound) refuse("CALL_BROWSER_SESSION_CHANGED");
      if (normalizeCallingPhone(lead.phone) !== pending.reservedPhone || (!manual && !isLeadEligibleForAutoCall(lead, new Date())) ||
        await getTransactionalLeadDialBlock(lead, String(current._id), [current.name, current.employeeCode, ...(current.aliases || [])], session, manual)) refuse("CALL_LEAD_NOT_ELIGIBLE");
      if (manual && manualWorkHash(lead) !== pending.nativeLeadWorkHash) refuse("CALL_LEAD_CHANGED");
      const fence = await Device.updateOne({ _id: bound._id, employeeCode: code, tokenHash: device.tokenHash,
        browserSessionId: pending.nativeBrowserSessionId, browserDeviceKeyHash: pending.nativeBrowserKeyHash },
      { $set: { browserSessionLastSeenAt: new Date() } }, { session });
      if (!fence.matchedCount) refuse("CALL_BROWSER_SESSION_CHANGED");
      return true;
    });
    if (!claimed) { response.status(204).end(); return; }
    // Never replay a consumed command after response loss. A missed handoff is safer than dialing twice.
    response.set("Cache-Control", "no-store").json({ attemptId: claimed.nativeAttemptId, phone: claimed.reservedPhone,
      validForMs: Math.max(0, Math.min(1500, Number(claimed.dialIntentUntil) - Date.now())), serverTime: new Date() });
    });
  } catch (error) { failure(response, error); } finally {priority?.close();}
}

export async function cancelNativeDial(request: Request, response: Response) {
  const code = text(request.body.employeeCode), business = request.business?.id || "", attempt = text(request.body.attemptId);
  if (verifyAttendanceHubSession(request.header("x-crm-attendance-session")) !== code || request.header("x-crm-user-code") !== code ||
    request.header("x-crm-user-type") !== "employee" || !await signedEmployeeInBusiness(code, business)) {
    response.status(403).json({ code: "SIGNED_EMPLOYEE_REQUIRED" }); return;
  }
  if (!uuid.test(attempt)) { response.status(400).json({ code: "INVALID_NATIVE_ATTEMPT" }); return; }
  await getCallBridgeScheduleModel().updateOne({ employeeCode: code, reservedBusinessId: business,
    reservedAttemptId: attempt, reservedLeadId: text(request.body.leadId), reservationTokenHash: nativeSecretHash(attempt),
    $or: [{ nativeAttemptId: attempt, nativeClaimedAt: null }, { nativeAttemptId: { $ne: attempt } }] },
  { $set: { nativeAttemptId: attempt, nativeClaimedAt: null, nativeCancelledAt: new Date() } });
  await getCallBridgeScheduleModel().updateOne({employeeCode: code, manualCallHoldId: attempt},
    {$set: {manualCallHoldCancelledAt: new Date(), manualCallCancelledAttemptId: attempt}});
  await clearManualCallHold(code, attempt, true);
  response.status(204).end();
}
