import "dotenv/config";
import mongoose from "mongoose";
import { connectDatabase } from "../config/db";
import { getCallBridgeAttemptModel, getCallBridgeScheduleModel } from "../models/CallBridge";

await connectDatabase(process.env.MONGODB_URI || "");

const attempts = await getCallBridgeAttemptModel()
  .find({ endedAt: { $ne: null } })
  .sort({ employeeCode: 1, reservedAt: 1 })
  .limit(1000)
  .lean();
const samples: Array<{ employeeCode: string; delayMs: number; endedAt: Date; reservedAt: Date }> = [];

for (let index = 0; index < attempts.length - 1; index += 1) {
  const current = attempts[index];
  const next = attempts[index + 1];
  if (current.employeeCode !== next.employeeCode || !current.endedAt || !next.reservedAt) continue;
  samples.push({
    employeeCode: current.employeeCode,
    delayMs: next.reservedAt.getTime() - current.endedAt.getTime(),
    endedAt: current.endedAt,
    reservedAt: next.reservedAt,
  });
}

const schedules = await getCallBridgeScheduleModel().find({ lastCallEndedAt: { $ne: null } }).lean();
const scheduleOffsets = schedules.flatMap((schedule) =>
  schedule.lastCallEndedAt && schedule.nextCallAllowedAt
    ? [{ employeeCode: schedule.employeeCode, offsetMs: schedule.nextCallAllowedAt.getTime() - schedule.lastCallEndedAt.getTime() }]
    : []
);
const latestNextivaReservations = schedules.flatMap((schedule) =>
  schedule.lastCallEndedAt && schedule.lastReservedAt && schedule.lastReservedAt > schedule.lastCallEndedAt
    ? [{
        employeeCode: schedule.employeeCode,
        callEndedAt: schedule.lastCallEndedAt,
        reservedAt: schedule.lastReservedAt,
        delayMs: schedule.lastReservedAt.getTime() - schedule.lastCallEndedAt.getTime(),
      }]
    : []
);
const delays = samples.map((sample) => sample.delayMs).filter((delay) => delay >= 0);
const sortedDelays = [...delays].sort((left, right) => left - right);

console.log(JSON.stringify({
  attempts: attempts.length,
  samples: delays.length,
  minimumDelayMs: sortedDelays[0] ?? null,
  medianDelayMs: sortedDelays.length ? sortedDelays[Math.floor(sortedDelays.length / 2)] : null,
  maximumDelayMs: sortedDelays.at(-1) ?? null,
  callsBeforeThirtySeconds: delays.filter((delay) => delay < 30_000).length,
  callsWithinThirtyFiveSeconds: delays.filter((delay) => delay >= 30_000 && delay <= 35_000).length,
  callsOverSixtySeconds: delays.filter((delay) => delay > 60_000).length,
  incorrectScheduleOffsets: scheduleOffsets.filter((schedule) => schedule.offsetMs !== 30_000),
  latestNextivaReservations,
  recentSamples: samples.slice(-20),
}, null, 2));

await mongoose.disconnect();
