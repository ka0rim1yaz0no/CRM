export const browserSessionFreshnessMs = 30 * 1000;
const maximumFutureSessionSkewMs = 5 * 60 * 1000;

export type ExistingBrowserSession = {
  browserSessionId?: string;
  browserSessionStartedAt?: Date | null;
  browserSessionLastSeenAt?: Date | null;
};

export function normalizeBrowserSessionStartedAt(value: unknown, now = new Date()) {
  const timestamp = typeof value === "number" ? value : Number(value);

  if (!Number.isFinite(timestamp) || timestamp <= 0) {
    return null;
  }

  return new Date(Math.min(timestamp, now.getTime() + maximumFutureSessionSkewMs));
}

export function shouldRejectOlderBrowserSession(
  existingSession: ExistingBrowserSession,
  incomingSessionId: string,
  incomingSessionStartedAt: Date,
  now = new Date()
) {
  if (!existingSession.browserSessionId || existingSession.browserSessionId === incomingSessionId) {
    return false;
  }

  const existingLastSeenAt = existingSession.browserSessionLastSeenAt
    ? new Date(existingSession.browserSessionLastSeenAt)
    : null;
  const existingStartedAt = existingSession.browserSessionStartedAt
    ? new Date(existingSession.browserSessionStartedAt)
    : null;
  const existingSessionIsFresh = Boolean(
    existingLastSeenAt && existingLastSeenAt.getTime() >= now.getTime() - browserSessionFreshnessMs
  );

  return Boolean(
    existingSessionIsFresh &&
    existingStartedAt &&
    existingStartedAt.getTime() >= incomingSessionStartedAt.getTime()
  );
}

export function latestDate(...values: Array<Date | string | null | undefined>) {
  const timestamps = values
    .map((value) => (value ? new Date(value).getTime() : Number.NaN))
    .filter(Number.isFinite);

  return timestamps.length > 0 ? new Date(Math.max(...timestamps)) : null;
}
