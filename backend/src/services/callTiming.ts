export const POST_CALL_WAIT_MS = 30_000;
export const IDLE_CONFIRMATION_MS = 8_000;
export const HEARTBEAT_INTERVAL_MS = 5_000;

// The first server-observed idle heartbeat anchors the wait. Confirmation
// happens later, but must never add another eight seconds to the deadline.
export function confirmedCallEnd(firstIdleAt: Date, now: Date) {
  if (now.getTime() - firstIdleAt.getTime() < IDLE_CONFIRMATION_MS) return null;
  return {
    endedAt: firstIdleAt,
    nextCallAllowedAt: new Date(firstIdleAt.getTime() + POST_CALL_WAIT_MS),
  };
}

// An unconfirmed dial has no observed call end. Give it one 30-second window
// from dial start; expiration and release do not stack extra delays.
export function unconfirmedDialRetryAt(dialStartedAt: Date) {
  return new Date(dialStartedAt.getTime() + POST_CALL_WAIT_MS);
}

export function canReserveCall(now: Date, schedule: {
  callLeaseUntil?: Date | null;
  nextCallAllowedAt?: Date | null;
  dialIntentUntil?: Date | null;
  lastCallStartedAt?: Date | null;
  lastCallEndedAt?: Date | null;
}, bridge?: { state: string; nextivaProcessDetected: boolean; fresh: boolean }) {
  return (!schedule.callLeaseUntil || schedule.callLeaseUntil <= now) &&
    (!schedule.nextCallAllowedAt || schedule.nextCallAllowedAt <= now) &&
    (!schedule.dialIntentUntil || schedule.dialIntentUntil <= now) &&
    (!schedule.lastCallStartedAt || (schedule.lastCallEndedAt || new Date(0)) >= schedule.lastCallStartedAt) &&
    (!bridge || (bridge.fresh && bridge.state === "idle" && bridge.nextivaProcessDetected));
}
