type DateValue = Date | string | number | null | undefined;

type ActiveSignalDevice = {
  state?: string;
  audioSessionActive?: boolean;
  bridgeVersion?: string;
  lastStateChangedAt?: DateValue;
  lastIdleAt?: DateValue;
};

type ActiveSignalSchedule = {
  lastDialStartedAt?: DateValue;
  lastCallStartedAt?: DateValue;
  lastCallEndedAt?: DateValue;
};

function timestamp(value: DateValue) {
  if (value === null || value === undefined || value === "") return 0;
  const result = new Date(value).getTime();
  return Number.isFinite(result) ? result : 0;
}

export function hasReliableTwoWayAudioDetection(version?: string) {
  if (version === "ringcentral-api-v1") return true;
  const match = String(version || "").trim().match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!match) return false;
  const [, major, minor, patch] = match.map(Number);
  return major > 0 || minor > 4 || (minor === 4 && patch >= 1);
}

export function isTrustedBridgeActiveSignal(
  device: ActiveSignalDevice | undefined,
  schedule: ActiveSignalSchedule | null
) {
  const stateChangedAt = timestamp(device?.lastStateChangedAt);
  const lastIdleAt = timestamp(device?.lastIdleAt);
  if (!device || device.state !== "active" || !device.audioSessionActive ||
    !lastIdleAt || !stateChangedAt || lastIdleAt > stateChangedAt) return false;
  if (hasReliableTwoWayAudioDetection(device.bridgeVersion)) return true;

  const dialStartedAt = timestamp(schedule?.lastDialStartedAt);
  const callEndedAt = timestamp(schedule?.lastCallEndedAt);
  if (!dialStartedAt || (callEndedAt && dialStartedAt <= callEndedAt)) return false;
  return stateChangedAt >= dialStartedAt - 5_000 && stateChangedAt <= dialStartedAt + 2 * 60_000;
}

export function hasTrackedActiveCall(schedule: ActiveSignalSchedule | null) {
  const dialStartedAt = timestamp(schedule?.lastDialStartedAt);
  const callStartedAt = timestamp(schedule?.lastCallStartedAt);
  const callEndedAt = timestamp(schedule?.lastCallEndedAt);
  return Boolean(
    dialStartedAt &&
    callStartedAt &&
    (!callEndedAt || dialStartedAt > callEndedAt) &&
    callStartedAt >= dialStartedAt - 5_000 &&
    callStartedAt <= dialStartedAt + 2 * 60_000
  );
}

export function shouldStartNewObservedCall(previousState: string, schedule: ActiveSignalSchedule | null) {
  if (previousState === "active") return false;
  if (previousState === "idle") return true;
  const startedAt = timestamp(schedule?.lastCallStartedAt);
  const endedAt = timestamp(schedule?.lastCallEndedAt);
  return !startedAt || endedAt >= startedAt;
}
