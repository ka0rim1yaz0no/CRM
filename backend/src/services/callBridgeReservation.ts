import { getCallBridgeScheduleModel } from "../models/CallBridge";
import mongoose, { type ClientSession } from "mongoose";
import { leadPhoneDedupEnabled } from "../config/rolloutFlags";
import { reservePhoneSlot } from "./leadPhoneDispatch";

type LeaseRequest = {
  employeeCode: string;
  now: Date;
  leaseUntil: Date;
  reservationTokenHash: string;
  attemptId: string;
  businessId: string;
  leadId: string;
  normalizedPhone?: string;
  timingV2: boolean;
};

// These conditions must be part of the write, not only an earlier readiness read.
export function callTimingWriteConditions(now: Date) {
  return [
    { $or: [{ nextCallAllowedAt: null }, { nextCallAllowedAt: { $lte: now } }] },
    { $or: [{ dialIntentUntil: null }, { dialIntentUntil: { $lte: now } }] },
    { $expr: { $lte: [{ $ifNull: ["$lastCallStartedAt", new Date(0)] }, { $ifNull: ["$lastCallEndedAt", new Date(0)] }] } },
  ];
}

export async function acquireCallBridgeLease(input: LeaseRequest) {
  const Schedule = getCallBridgeScheduleModel();
  try {
    await Schedule.findOneAndUpdate(
      { employeeCode: input.employeeCode },
      { $setOnInsert: { employeeCode: input.employeeCode } },
      { upsert: true, setDefaultsOnInsert: true }
    );
  } catch (error) {
    // Two first-use tabs may race to insert the same indexed schedule row.
    if ((error as { code?: number })?.code !== 11000) throw error;
  }

  const acquire = (session?: ClientSession) => Schedule.findOneAndUpdate(
    {
      employeeCode: input.employeeCode,
      $and: [
        { $or: [{ callLeaseUntil: null }, { callLeaseUntil: { $lte: input.now } }] },
        ...(input.timingV2 ? callTimingWriteConditions(input.now) : [
          { $or: [{ nextCallAllowedAt: null }, { nextCallAllowedAt: { $lte: input.now } }] },
        ]),
      ],
    },
    {
      $set: {
        callLeaseUntil: input.leaseUntil,
        reservedAttemptId: input.attemptId,
        reservedBusinessId: input.businessId,
        reservedLeadId: input.leadId,
        reservedPhone: input.normalizedPhone || "",
        reservationTokenHash: input.reservationTokenHash,
        lastReservedAt: input.now,
        lastDialStartedAt: null,
        dialIntentUntil: null,
      },
    },
    { returnDocument: "after", session }
  );
  if (!leadPhoneDedupEnabled()) return acquire();
  try {
    return await mongoose.connection.transaction(async session => {
      if (!input.normalizedPhone || !await reservePhoneSlot(input.normalizedPhone, input.employeeCode, input.attemptId, input.now, session)) return null;
      const schedule = await acquire(session);
      if (!schedule) throw Object.assign(new Error("PHONE_LEASE_REJECTED"), { leaseRejected: true });
      return schedule;
    });
  } catch (error) {
    if ((error as { code?: number }).code === 11000 || (error as { leaseRejected?: boolean }).leaseRejected) return null;
    throw error;
  }
}
