import crypto from "node:crypto";
import type { Request, Response } from "express";
import { getCallProvider, isAutoCallDisabledForEmployee, isSupportedAutoCallClientVersion } from "../config/callProvider";
import { verifyAttendanceHubSession } from "../config/attendanceHubSession";
import { callTimingV2Enabled, leadPhoneDedupEnabled } from "../config/rolloutFlags";
import { signedEmployeeInBusiness } from "../middleware/legacyAuthentication";
import { Employee } from "../models/Employee";
import { Lead } from "../models/Lead";
import { getCallBridgeDeviceModel, getCallBridgeScheduleModel } from "../models/CallBridge";
import { normalizeCallingPhone } from "../services/employeeCallingQueue";
import { prepareDeadlineQueue } from "../services/callDeadlinePreparation";
import { attendanceAllowsCall } from "../services/callAttendanceGuard";
import { withLeadDispatchOwnership } from "../services/leadAssignment";
import { reservePhoneSlot } from "../services/leadPhoneDispatch";
import { callTimingWriteConditions } from "../services/callBridgeReservation";
import { hasReliableTwoWayAudioDetection } from "../services/callBridgeActiveSignal";
import { POST_CALL_WAIT_MS, unconfirmedDialRetryAt } from "../services/callTiming";
import { isLeadEligibleForAutoCall } from "../services/leadAutoCallEligibility";
import { isSalesEmployee } from "../../../shared/leadAssignmentPolicy";
import { callingWindow } from "../../../shared/leadCallingPolicy";
import { getLeadDialBlock } from "./callBridgeController";

export const DEADLINE_PREPARATION_MS = 12000;
const pending = new Map<string, Set<string>>();
class DeadlineConflict extends Error {}
function conflict(code: string): never { throw new DeadlineConflict(code); }
const milliseconds = (value: unknown) => value instanceof Date ? value.getTime() : value ? new Date(String(value)).getTime() : 0;

export async function dispatchCallAtDeadline(request: Request, response: Response) {
    const code = String(request.body.employeeCode || "").trim(), business = request.business?.id || "";
    const attemptId = String(request.body.attemptId || ""), deadline = milliseconds(request.body.notBefore);
    const browserKey = String(request.body.browserDeviceKey || "").slice(0, 201);
    const browserSessionId = String(request.body.browserSessionId || "").slice(0, 121);
    if (verifyAttendanceHubSession(request.header("x-crm-attendance-session")) !== code ||
        request.header("x-crm-user-code") !== code || request.header("x-crm-user-type") !== "employee" || !await signedEmployeeInBusiness(code, business)) {
        response.status(403).json({code: "SIGNED_EMPLOYEE_REQUIRED", message: "A signed employee session in this business is required."}); return;
    }
    if (!isSupportedAutoCallClientVersion(request.header("x-crm-auto-call-version")) || !callTimingV2Enabled() || getCallProvider() !== "nextiva") {
        response.status(409).json({code: "DEADLINE_CALLING_UNAVAILABLE", message: "Refresh the CRM to verify calling configuration."}); return;
    }
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(attemptId) || !Number.isFinite(deadline)) {
        response.status(400).json({code: "INVALID_DEADLINE_ATTEMPT", message: "A valid deadline and unique attempt are required."}); return;
    }
    const Schedule = getCallBridgeScheduleModel(), now = new Date();
    const original = await Schedule.findOne({employeeCode: code}).lean();
    const replay = async () => {
        const row = await Schedule.findOne({employeeCode: code, reservedBusinessId: business, reservedAttemptId: attemptId,
            lastDialStartedAt: {$ne: null}, dialIntentUntil: {$gt: new Date()}}).lean();
        if (!row?.lastDialStartedAt) return false;
        const lead = await Lead.findById(row.reservedLeadId).slice("comments", -10).slice("activity", 20).populate("assignedAgent", "name employeeCode aliases").populate("assignedTeam", "name").lean();
        response.json({startedAt: row.lastDialStartedAt, serverTime: new Date(), dialIntentUntil: row.dialIntentUntil, alreadyStarted: true,
            reservationToken: attemptId, leadId: row.reservedLeadId, normalizedPhone: row.reservedPhone, lead}); return true;
    };
    if (await replay()) return;
    const endedAt = milliseconds(original?.lastCallEndedAt), remaining = deadline - +now;
    if (!endedAt || deadline !== endedAt + POST_CALL_WAIT_MS || milliseconds(original?.nextCallAllowedAt) !== deadline ||
        remaining > DEADLINE_PREPARATION_MS + 1000 || remaining < -45000) {
        response.status(409).json({code: "CALL_DEADLINE_CHANGED", message: "The call deadline changed. Checking current server state.", serverTime: new Date(), nextCallAllowedAt: original?.nextCallAllowedAt}); return;
    }
    const employee = await Employee.findOne({employeeCode: code, status: {$ne: "Archived"}}).select("name employeeCode aliases role team availabilityStatus").lean();
    if (!employee || !isSalesEmployee(employee) || isAutoCallDisabledForEmployee(code) || !await attendanceAllowsCall(employee)) {
        response.status(409).json({code: "CALL_ATTENDANCE_CHANGED", message: "Employee is not available for a new call."}); return;
    }
    const waiting = pending.get(code) || new Set<string>();
    if (waiting.size >= 2 || waiting.has(attemptId)) { response.status(409).json({code: "CALL_PREPARATION_PENDING", message: "A call preparation is already pending."}); return; }
    waiting.add(attemptId); pending.set(code, waiting);
    let disconnected = false;
    const closed = () => { disconnected = true; }; response.on("close", closed);
    const connected = () => { if (disconnected || response.destroyed) conflict("CALL_PREPARATION_CANCELLED"); };
    let preparation: Awaited<ReturnType<typeof prepareDeadlineQueue>> | undefined;
    try {
        preparation = await prepareDeadlineQueue(employee, business, deadline);
        while (true) {
            connected();
            if (await preparation.refresh()) continue;
            if (Date.now() >= deadline) break;
            await new Promise(resolve => setTimeout(resolve, Math.min(100, deadline - Date.now())));
        }
        if (!callingWindow(new Date()).permitted) conflict("OUTSIDE_CALLING_HOURS");
        // A previously busy higher-priority phone may have become free during preparation.
        if (preparation.queue.entries.some(entry => entry.reason === "PHONE_IN_USE")) await preparation.refresh(true);
        if (await preparation.refresh()) conflict("CALL_PREPARATION_CHANGED");
        const queue = preparation.queue;
        const head = queue.entries.find(entry => entry.leadId === queue.nextLeadId);
        if (!head?.normalizedPhone || !head.callable) conflict("NO_ELIGIBLE_LEADS");
        const targetPhone = head.normalizedPhone;
        connected();
        if (!preparation.lead) conflict("CALL_QUEUE_CHANGED");
        const schedule = await withLeadDispatchOwnership(head.leadId, String(employee._id), async session => {
            connected(); const at = new Date();
            if (+at < deadline || !callingWindow(at).permitted) conflict("CALL_DEADLINE_CHANGED");
            const row = await Schedule.findOneAndUpdate({employeeCode: code, lastCallEndedAt: new Date(endedAt), nextCallAllowedAt: new Date(deadline),
                $and: [{ $or: [{callLeaseUntil: null}, {callLeaseUntil: {$lte: at}}] }, ...callTimingWriteConditions(at)]}, {$set: {
                reservedAttemptId: attemptId, reservedBusinessId: business, reservedLeadId: head.leadId, reservedPhone: head.normalizedPhone,
                reservationTokenHash: crypto.createHash("sha256").update(attemptId).digest("hex"), lastReservedAt: at, callLeaseUntil: new Date(+at + 45000),
                lastDialStartedAt: at, dialIntentUntil: new Date(+at + 30000), nextCallAllowedAt: unconfirmedDialRetryAt(at),
            }}, {returnDocument: "after", session});
            return row;
        }, {employeeCode: code, attemptId}, async (session, lead) => {
            connected(); const at = new Date();
            const currentEmployee = await Employee.findOne({_id: employee._id, employeeCode: code, status: {$ne: "Archived"}})
                .select("name aliases role team employeeCode availabilityStatus").session(session).lean();
            if (!currentEmployee || !isSalesEmployee(currentEmployee) || isAutoCallDisabledForEmployee(code) || normalizeCallingPhone(lead.phone) !== targetPhone ||
                !isLeadEligibleForAutoCall(lead, at) || !await attendanceAllowsCall(currentEmployee, session)) conflict("CALL_ATTENDANCE_OR_LEAD_CHANGED");
            if (await getLeadDialBlock(head.leadId, String(currentEmployee._id), [currentEmployee.name, currentEmployee.employeeCode, ...(currentEmployee.aliases || [])], session)) conflict("CALL_LEAD_NOT_ELIGIBLE");
            const devices = await getCallBridgeDeviceModel().find({employeeCode: code, lastSeenAt: {$gte: new Date(+at - 20000)}, bridgeVersion: {$ne: "ringcentral-api-v1"}}).session(session).lean();
            if (!devices.length || devices.some(device => device.state !== "idle" || !device.nextivaProcessDetected || !hasReliableTwoWayAudioDetection(device.bridgeVersion))) conflict("CALL_BRIDGE_NOT_READY");
            if (devices.some(device => device.accountSwitchingEnabled)) {
                const bound = devices.find(device => device.accountSwitchingEnabled && device.businessIds.includes(business) &&
                    browserKey.length >= 24 && browserKey.length <= 200 && browserSessionId.length >= 16 && browserSessionId.length <= 120 &&
                    device.browserDeviceKeyHash === crypto.createHash("sha256").update(browserKey).digest("hex") && device.browserSessionId === browserSessionId);
                if (!bound) conflict("CALL_BROWSER_SESSION_CHANGED");
                // Fence account activation against the same transaction that authorizes the dial.
                const owned = await getCallBridgeDeviceModel().updateOne({_id: bound._id, employeeCode: code,
                    browserDeviceKeyHash: bound.browserDeviceKeyHash, browserSessionId}, {$set: {browserSessionLastSeenAt: at}}, {session});
                if (!owned.matchedCount) conflict("CALL_BROWSER_SESSION_CHANGED");
            }
            if (leadPhoneDedupEnabled() && !await reservePhoneSlot(targetPhone, code, attemptId, at, session)) conflict("CALL_PHONE_IN_USE");
            return true;
        });
        if (!schedule) { if (await replay()) return; conflict("CALL_DEADLINE_CHANGED"); }
        response.json({startedAt: schedule.lastDialStartedAt, serverTime: new Date(), dialIntentUntil: schedule.dialIntentUntil,
            alreadyStarted: false, reservationToken: attemptId, leadId: head.leadId, normalizedPhone: head.normalizedPhone, lead: preparation.lead});
    } catch (error) {
        if (!response.destroyed && !response.headersSent) response.status(error instanceof DeadlineConflict ? 409 : 503).json({
            code: error instanceof DeadlineConflict ? error.message : "CALL_PREPARATION_UNVERIFIED", message: "Call preparation changed or could not be verified. Checking current server state.", serverTime: new Date(),
        });
    } finally {
        response.off("close", closed); await preparation?.close(); waiting.delete(attemptId); if (!waiting.size) pending.delete(code);
    }
}
