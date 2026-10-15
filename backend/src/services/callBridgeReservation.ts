import { getCallBridgeScheduleModel } from "../models/CallBridge";

type LeaseRequest = {
  employeeCode: string;
  now: Date;
  leaseUntil: Date;
  reservationTokenHash: string;
  attemptId: string;
  businessId: string;
  leadId: string;
  timingV2: boolean;
};

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

  return Schedule.findOneAndUpdate(
    {
      employeeCode: input.employeeCode,
      $and: [
        { $or: [{ callLeaseUntil: null }, { callLeaseUntil: { $lte: input.now } }] },
        { $or: [{ nextCallAllowedAt: null }, { nextCallAllowedAt: { $lte: input.now } }] },
        ...(input.timingV2 ? [{ $or: [{ dialIntentUntil: null }, { dialIntentUntil: { $lte: input.now } }] }] : []),
      ],
    },
    {
      $set: {
        callLeaseUntil: input.leaseUntil,
        reservedAttemptId: input.timingV2 ? input.attemptId : "",
        reservedBusinessId: input.businessId,
        reservedLeadId: input.leadId,
        reservationTokenHash: input.reservationTokenHash,
        lastReservedAt: input.now,
        lastDialStartedAt: null,
        dialIntentUntil: null,
        lastCallStartedAt: null,
      },
    },
    { returnDocument: "after" }
  );
}
