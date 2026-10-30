import type { Request, Response } from "express";
import mongoose, { Types, type ClientSession } from "mongoose";
import { Employee } from "../models/Employee";
import { Lead, type LeadDocument } from "../models/Lead";
import { getCallBridgeScheduleModel } from "../models/CallBridge";
import { getAttendanceBusinessIdentities } from "../models/BusinessUserAccess";
import { getCurrentBusinessId } from "../config/tenancy";
import { signedCrmIdentity, signedEmployeeInBusiness } from "../middleware/legacyAuthentication";
import { isEligibleLeadRecipient } from "../../../shared/leadAssignmentPolicy";
import { leadPhoneDedupEnabled } from "../config/rolloutFlags";
import { consumePhoneSlot } from "./leadPhoneDispatch";

export async function leadRecipients() {
    const employees = await Employee.find({ status: { $in: ["Active", "Training"] }, $or: [{ role: /sales/i }, { team: /sales/i }] })
        .select("_id name employeeCode aliases role team status businessAccessIds createdAt").sort({ createdAt: 1 }).lean();
    const access = await getAttendanceBusinessIdentities(employees.map(employee => employee.employeeCode));
    const businessId = getCurrentBusinessId();
    return employees.filter(employee => {
        const identity = access.get(employee.employeeCode);
        return isEligibleLeadRecipient(employee) && Boolean(employee.employeeCode) && (identity
            ? identity.businessIds.includes(businessId)
            : !employee.businessAccessIds?.length || employee.businessAccessIds.includes(businessId));
    });
}

export async function assignmentActor(request: Request, response: Response, adminOnly = false) {
    const actor = signedCrmIdentity(request.header("x-crm-admin-session"), request.header("x-crm-attendance-session"));
    if (!actor) { response.status(401).json({ code: "CRM_SESSION_REQUIRED", message: "Sign in again before assigning leads." }); return null; }
    if (actor.access === "tracker" || (adminOnly && actor.type !== "admin")) {
        response.status(403).json({ message: "An authorized administrator is required." }); return null;
    }
    const employee = actor.type === "employee" ? await signedEmployeeInBusiness(actor.code, getCurrentBusinessId()) : null;
    if (actor.type === "employee" && !employee) { response.status(403).json({ message: "You do not have access to this business." }); return null; }
    return { ...actor, name: employee?.name || actor.name, employee };
}

export async function uniquelyOwnedLegacyNames(employeeId: string, names: string[]) {
    const uniqueNames = [...new Set(names.map(name => String(name || "").trim()).filter(Boolean))];
    if (!uniqueNames.length) return [];
    const patterns = uniqueNames.map(name => new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i"));
    const employees = await Employee.find({ $or: [{ name: { $in: patterns } }, { aliases: { $in: patterns } }, { employeeCode: { $in: patterns } }] })
        .select("_id name employeeCode aliases").maxTimeMS(3000).lean();
    return uniqueNames.filter(name => {
        const matches = employees.filter(employee => [employee.name, employee.employeeCode, ...(employee.aliases || [])].some(value => String(value).trim().toLowerCase() === name.toLowerCase()));
        return matches.length === 1 && String(matches[0]._id) === employeeId;
    });
}

type Snapshot = { _id: Types.ObjectId; assignedAgent?: Types.ObjectId | null; assignedAgentName?: string; assignmentRevision?: number; status?: LeadDocument["status"];
    phone?: string; followUpAt?: LeadDocument["followUpAt"]; comments?: LeadDocument["comments"] };
export function assignmentSnapshotFilter(lead: Snapshot) {
    return { _id: lead._id, assignedAgent: lead.assignedAgent || null, assignedAgentName: lead.assignedAgentName === undefined ? { $exists: false } : lead.assignedAgentName,
        status: lead.status,
        ...(lead.assignmentRevision ? { assignmentRevision: lead.assignmentRevision } : { $or: [{ assignmentRevision: 0 }, { assignmentRevision: { $exists: false } }] }) };
}

export async function writeLeadAssignment(lead: Snapshot, recipient: { _id: Types.ObjectId; name: string } | null,
    autoAssignedAt: Date | null, activity: Record<string, unknown>) {
    const id = recipient?._id || null;
    const name = recipient?.name || "";
    if (String(lead.assignedAgent || "") === String(id || "") && (lead.assignedAgentName || "") === name) return 0;
    const result = await Lead.updateOne(assignmentSnapshotFilter(lead), {
        $set: { assignedAgent: id, assignedAgentName: name, autoAssignedAt }, $inc: { assignmentRevision: 1 }, $push: activity,
    });
    if (result.modifiedCount) await invalidateUnstartedLeadReservations([String(lead._id)]);
    return result.modifiedCount;
}

export async function invalidateUnstartedLeadReservations(leadIds: string[]) {
    await getCallBridgeScheduleModel().updateMany({ reservedBusinessId: getCurrentBusinessId(), reservedLeadId: { $in: leadIds }, lastDialStartedAt: null,
        $expr: { $lte: [{ $ifNull: ["$lastCallStartedAt", new Date(0)] }, { $ifNull: ["$lastCallEndedAt", new Date(0)] }] } },
    { $set: { reservedAttemptId: "", reservedLeadId: "", reservedBusinessId: "", reservedPhone: "", reservationTokenHash: "", callLeaseUntil: null } });
}

// Dispatch and reassignment contend on the same lead document. A transfer after
// dispatch has committed must not terminate that already-authorized telephone call.
class DispatchGuardRejected extends Error {}
export async function withLeadDispatchOwnership<T>(leadId: string, employeeId: string, operation: (session: ClientSession) => Promise<T>, phoneReservation?: { employeeCode: string; attemptId: string }, attendanceGuard?: (session: ClientSession, lead: Snapshot) => Promise<boolean>) {
    try { return await mongoose.connection.transaction(async session => {
        const lead = await Lead.findById(leadId).session(session).lean();
        if (!lead || lead.status === "Archived") return null;
        const owner = lead.assignedAgent ? String(lead.assignedAgent) === employeeId : await (async () => {
            const employee = await Employee.findById(employeeId).select("name employeeCode aliases").session(session).lean();
            return employee && (await uniquelyOwnedLegacyNames(employeeId, [employee.name, employee.employeeCode, ...(employee.aliases || [])])).includes(lead.assignedAgentName);
        })();
        if (!owner) return null;
        if (attendanceGuard && !await attendanceGuard(session, lead)) throw new DispatchGuardRejected();
        if (leadPhoneDedupEnabled() && (!phoneReservation || !await consumePhoneSlot(lead.phone, phoneReservation.employeeCode, phoneReservation.attemptId, session))) throw new DispatchGuardRejected();
        const locked = await Lead.updateOne(assignmentSnapshotFilter(lead), { $inc: { callingDispatchRevision: 1 } }, { session, timestamps: false });
        if (!locked.modifiedCount) throw new DispatchGuardRejected();
        const result = await operation(session);
        if (result === null) throw new DispatchGuardRejected();
        return result;
    }); } catch (error) { if (error instanceof DispatchGuardRejected) return null; throw error; }
}
