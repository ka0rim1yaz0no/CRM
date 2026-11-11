import { getCallBridgeScheduleModel } from "../models/CallBridge";
import mongoose, { type ClientSession } from "mongoose";
import { leadPhoneDedupEnabled } from "../config/rolloutFlags";
import { reservePhoneSlot } from "./leadPhoneDispatch";
import { POST_CALL_WAIT_MS } from "./callTiming";
import { automaticCallControlFilter, automaticCallVersionCondition } from "./autoCallControl";

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
export function callTimingWriteConditions(now: Date, manual = false) {
  const postCallWait = { $expr: { $and: [
    { $ne: [{ $ifNull: ["$lastCallEndedAt", null] }, null] },
    { $eq: ["$nextCallAllowedAt", { $add: ["$lastCallEndedAt", POST_CALL_WAIT_MS] }] },
    { $lte: [{ $ifNull: ["$lastDialStartedAt", new Date(0)] }, "$lastCallEndedAt"] },
  ] } };
  return [
    ...(manual ? [] : [automaticCallControlFilter()]),
    { $or: [{ nextCallAllowedAt: null }, { nextCallAllowedAt: { $lte: now } }, ...(manual ? [postCallWait] : [])] },
    { $or: [{ dialIntentUntil: null }, { dialIntentUntil: { $lte: now } }] },
    { $expr: { $lte: [{ $ifNull: ["$lastCallStartedAt", new Date(0)] }, { $ifNull: ["$lastCallEndedAt", new Date(0)] }] } },
  ];
}

export async function acquireCallBridgeLease(input: LeaseRequest) {
  const Schedule = getCallBridgeScheduleModel();
  let controlVersion = 0;
  try {
    const container = await Schedule.findOneAndUpdate(
      { employeeCode: input.employeeCode },
      { $setOnInsert: { employeeCode: input.employeeCode } },
      { upsert: true, setDefaultsOnInsert: true, returnDocument: "after" }
    );
    controlVersion = container?.autoCallControlVersion || 0;
  } catch (error) {
    // Two first-use tabs may race to insert the same indexed schedule row.
    if ((error as { code?: number })?.code !== 11000) throw error;
  }

  const acquire = (session?: ClientSession) => Schedule.findOneAndUpdate(
    {
      employeeCode: input.employeeCode,
      ...automaticCallControlFilter(),
      $and: [
        automaticCallVersionCondition(controlVersion),
        { $or: [{ callLeaseUntil: null }, { callLeaseUntil: { $lte: input.now } }] },
        ...(input.timingV2 ? callTimingWriteConditions(input.now) : [
          { $or: [{ nextCallAllowedAt: null }, { nextCallAllowedAt: { $lte: input.now } }] },
        ]),
      ],
    },
    {
      $set: {
        reservedAutoCallControlVersion: controlVersion,
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
