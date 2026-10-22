import type { Request, Response } from "express";
import mongoose from "mongoose";
import { z } from "zod";
import { Lead } from "../models/Lead";
import { getCurrentBusinessId } from "../config/tenancy";
import { signedCrmIdentity, signedEmployeeInBusiness } from "../middleware/legacyAuthentication";
import { assignmentSnapshotFilter, invalidateUnstartedLeadReservations, uniquelyOwnedLegacyNames } from "../services/leadAssignment";
import { logicalLeadKey } from "../../../shared/leadPhonePolicy";
import { leadBelongsToEmployee } from "../../../shared/leadAssignmentPolicy";
import { getCallBridgeScheduleModel } from "../models/CallBridge";
import { emitLeadChanged } from "../socket";
import { leadPhoneDedupEnabled } from "../config/rolloutFlags";

const id = z.string().regex(/^[a-fA-F0-9]{24}$/);
const bodySchema = z.object({ leadIds: z.array(id).min(1).max(100),
    expectedAssignmentRevisions: z.record(z.string(), z.number().int().nonnegative()).optional() });

export async function employeeBulkArchive(request: Request, response: Response) {
    if (!leadPhoneDedupEnabled()) { response.status(503).json({ message: "The lead workspace update is not activated yet." }); return; }
    const actor = signedCrmIdentity(request.header("x-crm-admin-session"), request.header("x-crm-attendance-session"));
    if (!actor) { response.status(401).json({ message: "Sign in again before archiving leads." }); return; }
    if (actor.type !== "employee") { response.status(403).json({ message: "Use the administrator archive controls." }); return; }
    const employee = await signedEmployeeInBusiness(actor.code, getCurrentBusinessId());
    if (!employee) { response.status(403).json({ message: "You do not have access to this business." }); return; }
    const parsed = bodySchema.safeParse(request.body);
    if (!parsed.success) { response.status(400).json({ message: "Select between 1 and 100 valid leads." }); return; }
    const ids = [...new Set(parsed.data.leadIds.map(value => value.toLowerCase()))];
    const names = await uniquelyOwnedLegacyNames(String(employee._id), [employee.name, employee.employeeCode, ...(employee.aliases || [])]);
    const owns = (lead: { assignedAgent?: unknown; assignedAgentName?: string }) => leadBelongsToEmployee(lead, String(employee._id), names);
    const selected = await Lead.find({ _id: { $in: ids } }).select("status assignedAgent assignedAgentName assignmentRevision phone googlePlaceId providerPlaceId placeProvider businessName businessAddress").lean();
    if (selected.length !== ids.length || selected.some(lead => !owns(lead))) {
        response.status(403).json({ message: "You can archive only your own leads in this business." }); return;
    }
    if (selected.some(lead => parsed.data.expectedAssignmentRevisions?.[String(lead._id)] !== undefined &&
        parsed.data.expectedAssignmentRevisions[String(lead._id)] !== (lead.assignmentRevision || 0))) {
        response.status(409).json({ code: "LEAD_ASSIGNMENT_CHANGED", message: "A selected lead changed. Refresh before archiving." }); return;
    }
    const keys = new Set(selected.filter(lead => lead.status !== "Archived").map(logicalLeadKey));
    const active = keys.size ? await Lead.find({ status: { $ne: "Archived" } })
        .select("status assignedAgent assignedAgentName assignmentRevision callingDispatchRevision phone googlePlaceId providerPlaceId placeProvider businessName businessAddress").lean() : [];
    // Same-owner copies disappear together. A different owner's history and
    // callback remain untouched, even if that leaves a different authorized queue.
    const candidates = active.filter(lead => owns(lead) && keys.has(logicalLeadKey(lead)));
    const archivedIds: string[] = [], conflictIds: string[] = [], busyIds: string[] = [];
    for (const lead of candidates) {
        const changed = await mongoose.connection.transaction(async session => {
            const busy = await getCallBridgeScheduleModel().exists({ employeeCode: actor.code, $and: [
                { $or: [{ reservedBusinessId: getCurrentBusinessId(), reservedLeadId: String(lead._id) }, { lastObservedLeadId: String(lead._id) }] },
                { $or: [{ dialIntentUntil: { $gt: new Date() } }, { $expr: { $gt: [{ $ifNull: ["$lastCallStartedAt", new Date(0)] }, { $ifNull: ["$lastCallEndedAt", new Date(0)] }] } }] },
            ] }).session(session);
            if (busy) return "busy";
            const revision = lead.callingDispatchRevision || 0;
            const result = await Lead.updateOne({ ...assignmentSnapshotFilter(lead),
                $and: [{ $or: [{ callingDispatchRevision: revision }, ...(revision === 0 ? [{ callingDispatchRevision: { $exists: false } }] : [])] }] },
            { $set: { status: "Archived" }, $unset: { activePhoneKey: 1 }, $push: { activity: { $each: [{ label: "Archived", detail: "Employee archived selected owned lead group.",
                status: "Archived", actorName: employee.name, actorType: "employee", createdAt: new Date() }], $position: 0 } } }, { session });
            return result.modifiedCount ? "archived" : "conflict";
        });
        (changed === "archived" ? archivedIds : changed === "busy" ? busyIds : conflictIds).push(String(lead._id));
    }
    if (archivedIds.length) {
        await invalidateUnstartedLeadReservations(archivedIds);
        emitLeadChanged({ action: "bulk-archived", leadIds: archivedIds });
    }
    response.json({ archivedCount: archivedIds.length, archivedIds, conflictIds, busyIds,
        alreadyArchivedCount: selected.filter(lead => lead.status === "Archived").length,
        selectedCount: ids.length, preservedOtherOwnerCount: active.filter(lead => !owns(lead) && keys.has(logicalLeadKey(lead))).length });
}
