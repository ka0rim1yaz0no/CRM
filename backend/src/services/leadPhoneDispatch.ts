import { Schema, type ClientSession } from "mongoose";
import { getCurrentBusinessId, tenantModel } from "../config/tenancy";
import { getCallBridgeScheduleModel } from "../models/CallBridge";
import { canReserveCall } from "./callTiming";
import { normalizeLeadPhone } from "../../../shared/leadPhonePolicy";
import { Lead } from "../models/Lead";

type Slot = { _id: string; employeeCode: string; attemptId: string; reservedAt: Date; consumedAt: Date | null };
type Schedule = { lastReservedAt?: Date | null; callLeaseUntil?: Date | null; nextCallAllowedAt?: Date | null;
    dialIntentUntil?: Date | null; lastCallStartedAt?: Date | null; lastCallEndedAt?: Date | null };
const schema = new Schema<Slot>({ _id: { type: String, required: true }, employeeCode: { type: String, required: true },
    attemptId: { type: String, required: true }, reservedAt: { type: Date, required: true }, consumedAt: { type: Date, default: null } }, { versionKey: false });
export const LeadPhoneSlot = tenantModel<Slot>("LeadPhoneSlot", schema);

export async function phoneSlotBusy(slot: Slot, now: Date, session?: ClientSession) {
    const schedule = await getCallBridgeScheduleModel().findOne({ employeeCode: slot.employeeCode }).session(session || null).lean();
    return isPhoneSlotBusy(slot, schedule, now);
}

function isPhoneSlotBusy(slot: Slot, schedule: Schedule | null | undefined, now: Date) {
    // A later reservation proves the employee passed the previous call's existing
    // timing guard. Do not make an unrelated later call block this old phone.
    if (schedule?.lastReservedAt && schedule.lastReservedAt > slot.reservedAt) return false;
    if (!schedule) return Boolean(slot.consumedAt) || +slot.reservedAt + 30000 > +now;
    return !canReserveCall(now, schedule);
}

export async function reservePhoneSlot(phone: string, employeeCode: string, attemptId: string, now: Date, session: ClientSession) {
    const key = normalizeLeadPhone(phone);
    if (!key) return false;
    const previous = await LeadPhoneSlot.findById(key).session(session).lean();
    if (previous?.employeeCode === employeeCode && previous.attemptId === attemptId) return true;
    if (previous && await phoneSlotBusy(previous, now, session)) return false;
    if ((await busyLegacyPhones([key], employeeCode, now, session)).has(key)) return false;
    await LeadPhoneSlot.findOneAndUpdate({ _id: key }, { $set: { employeeCode, attemptId, reservedAt: now, consumedAt: null } }, { session, upsert: true });
    return true;
}

export async function consumePhoneSlot(phone: string, employeeCode: string, attemptId: string, session: ClientSession) {
    const key = normalizeLeadPhone(phone);
    if (!key) return false;
    if (!await LeadPhoneSlot.exists({ _id: key }).session(session)) {
        // Adopt a still-valid lease created immediately before activation, without
        // resetting its call timestamps or adding a second cooldown.
        const schedule = await getCallBridgeScheduleModel().findOne({ employeeCode, reservedAttemptId: attemptId,
            lastDialStartedAt: null, callLeaseUntil: { $gt: new Date() } }).session(session).lean();
        if (!schedule?.lastReservedAt || normalizeLeadPhone(schedule.reservedPhone) !== key ||
            !await reservePhoneSlot(key, employeeCode, attemptId, schedule.lastReservedAt, session)) return false;
    }
    const result = await LeadPhoneSlot.updateOne({ _id: key, employeeCode, attemptId, consumedAt: null }, { $set: { consumedAt: new Date() } }, { session });
    return result.modifiedCount === 1;
}

export async function busyPhonesForEmployee(phones: string[], employeeCode: string, now: Date) {
    const slots = await LeadPhoneSlot.find({ _id: { $in: phones }, employeeCode: { $ne: employeeCode } }).lean();
    const schedules = slots.length ? await getCallBridgeScheduleModel().find({ employeeCode: { $in: [...new Set(slots.map(slot => slot.employeeCode))] } }).lean() : [];
    const byCode = new Map(schedules.map(schedule => [schedule.employeeCode, schedule]));
    const busy = await busyLegacyPhones(phones, employeeCode, now);
    for (const slot of slots) if (isPhoneSlotBusy(slot, byCode.get(slot.employeeCode), now)) busy.add(slot._id);
    return busy;
}

async function busyLegacyPhones(phones: string[], employeeCode: string, now: Date, session?: ClientSession) {
    const schedules = await getCallBridgeScheduleModel().find({ employeeCode: { $ne: employeeCode }, $or: [
        { callLeaseUntil: { $gt: now } }, { dialIntentUntil: { $gt: now } }, { nextCallAllowedAt: { $gt: now } },
        { $expr: { $gt: [{ $ifNull: ["$lastCallStartedAt", new Date(0)] }, { $ifNull: ["$lastCallEndedAt", new Date(0)] }] } },
    ] }).select("reservedBusinessId reservedPhone reservedLeadId lastObservedLeadId").session(session || null).lean();
    const ids = schedules.flatMap(schedule => [schedule.reservedLeadId, schedule.lastObservedLeadId].filter(id => /^[a-f0-9]{24}$/i.test(id || "")));
    const leads = ids.length ? await Lead.find({ _id: { $in: ids } }).select("phone").session(session || null).lean() : [];
    const candidates = new Set(phones), busy = new Set<string>();
    for (const lead of leads) { const phone = normalizeLeadPhone(lead.phone); if (phone && candidates.has(phone)) busy.add(phone); }
    for (const schedule of schedules) {
        const phone = schedule.reservedBusinessId === getCurrentBusinessId() ? normalizeLeadPhone(schedule.reservedPhone) : null;
        if (phone && candidates.has(phone)) busy.add(phone);
    }
    return busy;
}
