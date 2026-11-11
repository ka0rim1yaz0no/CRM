import { hasReliableTwoWayAudioDetection } from "./callBridgeActiveSignal";
import { hasUnconfirmedCall } from "./callTiming";

type Device = { state?: string; audioSessionActive?: boolean; nextivaProcessDetected?: boolean; bridgeVersion?: string;
  lastSeenAt: Date; lastIdleAt?: Date | null; inactiveSince?: Date | null };

// This permits waiting, never dialing. Only the existing heartbeat transition
// and atomic dispatch guards can confirm an end and authorize the next call.
export function manualCallEndPending(devices: Device[], schedule: { lastCallStartedAt?: Date | null; lastCallEndedAt?: Date | null } | null, now: Date) {
  if (!hasUnconfirmedCall(schedule || {})) return false;
  const fresh = devices.filter(device => +device.lastSeenAt >= +now - 20_000);
  return fresh.length > 0 && fresh.every(device => device.nextivaProcessDetected && !device.audioSessionActive &&
    hasReliableTwoWayAudioDetection(device.bridgeVersion) && (device.state === "idle" && device.lastIdleAt && +device.lastIdleAt >= +schedule!.lastCallStartedAt! && +device.lastIdleAt <= +now ||
      device.state === "active" && device.inactiveSince && +device.inactiveSince >= +schedule!.lastCallStartedAt! && +device.inactiveSince <= +now));
}
