export type CallDashboardAttendanceEvent = {
  source: string;
  timeIn: Date;
};

export type CallDashboardDevice = {
  state: string;
  audioSessionActive: boolean;
  nextivaProcessDetected: boolean;
  lastSeenAt: Date;
  lastStateChangedAt: Date;
  lastIdleAt?: Date | null;
};

export type CallDashboardSchedule = {
  callLeaseUntil?: Date | null;
  lastCallEndedAt?: Date | null;
  nextCallAllowedAt?: Date | null;
  lastDialStartedAt?: Date | null;
  dialIntentUntil?: Date | null;
  lastCallStartedAt?: Date | null;
};

const heartbeatFreshnessMs = 20_000;
// Windows can leave a Nextiva audio session open after a call ends. A bridge
// signal that never transitions must not hold the dashboard ON CALL forever.
const maximumActiveCallSignalMs = 2 * 60 * 60 * 1000;

function zonedDateParts(date: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const value = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((part) => part.type === type)?.value || 0);
  return { year: value("year"), month: value("month"), day: value("day"), hour: value("hour"), minute: value("minute") };
}

function zonedTimeToUtc(year: number, month: number, day: number, hour: number, minute: number, timeZone: string) {
  let time = Date.UTC(year, month - 1, day, hour, minute);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const actual = zonedDateParts(new Date(time), timeZone);
    time += Date.UTC(year, month - 1, day, hour, minute) -
      Date.UTC(actual.year, actual.month - 1, actual.day, actual.hour, actual.minute);
  }
  return new Date(time);
}

export function currentAttendanceShift(now: Date, timeZone: string, startTime: string, endTime: string) {
  const local = zonedDateParts(now, timeZone);
  const [startHour, startMinute] = startTime.split(":").map(Number);
  const [endHour, endMinute] = endTime.split(":").map(Number);
  const todayStart = zonedTimeToUtc(local.year, local.month, local.day, startHour, startMinute, timeZone);
  const shiftDay = todayStart <= now ? local.day : local.day - 1;
  const start = zonedTimeToUtc(local.year, local.month, shiftDay, startHour, startMinute, timeZone);
  const overnight = endHour * 60 + endMinute <= startHour * 60 + startMinute;
  const end = zonedTimeToUtc(local.year, local.month, shiftDay + (overnight ? 1 : 0), endHour, endMinute, timeZone);
  return { start, end };
}

export function offPhoneTimeInShift(events: CallDashboardAttendanceEvent[], shiftStart: Date, shiftEnd: Date, now: Date) {
  const end = Math.min(now.getTime(), shiftEnd.getTime());
  const start = shiftStart.getTime();
  let openAt: number | null = null;
  let completedMs = 0;

  for (const event of [...events].sort((a, b) => a.timeIn.getTime() - b.timeIn.getTime())) {
    const time = event.timeIn.getTime();
    if (time > end) break;
    if (event.source === "Off the Phone Out") {
      if (openAt !== null) completedMs += Math.max(0, time - Math.max(openAt, start));
      openAt = time;
    } else if (["Off the Phone In", "Time Out", "Logout"].includes(event.source) && openAt !== null) {
      completedMs += Math.max(0, time - Math.max(openAt, start));
      openAt = null;
    }
  }

  if (openAt !== null && now.getTime() >= shiftEnd.getTime()) {
    completedMs += Math.max(0, end - Math.max(openAt, start));
    openAt = null;
  }
  const activeStartedAt = openAt !== null && end > start ? new Date(Math.max(openAt, start)) : null;
  return {
    completedMs,
    activeStartedAt,
    totalMs: completedMs + (activeStartedAt ? Math.max(0, end - activeStartedAt.getTime()) : 0),
  };
}

function latestAttendanceTransition(events: CallDashboardAttendanceEvent[], sources: string[]) {
  return [...events].reverse().find((event) => sources.includes(event.source))?.timeIn || null;
}

function latestDate(...dates: Array<Date | null | undefined>) {
  const valid = dates.filter((date): date is Date => Boolean(date && !Number.isNaN(date.getTime())));
  return valid.length ? new Date(Math.max(...valid.map((date) => date.getTime()))) : null;
}

export function callDashboardStatus(input: {
  availabilityStatus: string;
  devices: CallDashboardDevice[];
  schedule?: CallDashboardSchedule | null;
  attendance: CallDashboardAttendanceEvent[];
  offPhoneStartedAt?: Date | null;
  now: Date;
  shift: { start: Date; end: Date };
  provider?: "nextiva" | "ringcentral";
}) {
  const { availabilityStatus, devices, schedule, attendance, offPhoneStartedAt, now, shift } = input;
  const providerName = input.provider === "ringcentral" ? "RingCentral" : "Nextiva";
  const inShift = now >= shift.start && now < shift.end;
  const withinShift = (date: Date | null | undefined) => date && inShift
    ? new Date(Math.min(now.getTime(), Math.max(shift.start.getTime(), date.getTime())))
    : null;
  if (!inShift) {
    const presenceStatus = availabilityStatus === "ONLINE" || availabilityStatus === "BREAK" || availabilityStatus === "LUNCH" || availabilityStatus === "OFF THE PHONE"
      ? availabilityStatus
      : "OFFLINE";
    return { status: presenceStatus as "ONLINE" | "BREAK" | "LUNCH" | "OFF THE PHONE" | "OFFLINE", statusStartedAt: null, transitionUntil: null, detail: "Outside call shift" };
  }

  const sortedEvents = [...attendance].sort((a, b) => a.timeIn.getTime() - b.timeIn.getTime());
  const fresh = devices
    .filter((device) => device.lastSeenAt.getTime() >= now.getTime() - heartbeatFreshnessMs)
    .sort((a, b) => b.lastSeenAt.getTime() - a.lastSeenAt.getTime());
  const latestDevice = [...devices].sort((a, b) => b.lastSeenAt.getTime() - a.lastSeenAt.getTime())[0];
  // A previous bridge installation can continue heartbeating from the same
  // employee. Only the newest session is authoritative; otherwise an older
  // device can keep ON CALL visible while the current device is idle.
  const authoritativeDevice = fresh[0];
  const activeSignalStartedAt = authoritativeDevice
    ? latestDate(schedule?.lastCallStartedAt, authoritativeDevice.lastStateChangedAt)
    : null;
  const hasObservedIdleBaseline = Boolean(
    authoritativeDevice?.lastIdleAt &&
    authoritativeDevice.lastIdleAt <= authoritativeDevice.lastStateChangedAt
  );
  const hasDialIntent = Boolean(
    schedule?.lastDialStartedAt &&
    authoritativeDevice &&
    schedule.lastDialStartedAt <= authoritativeDevice.lastStateChangedAt
  );
  const active = authoritativeDevice?.state === "active" &&
    authoritativeDevice.audioSessionActive &&
    (hasObservedIdleBaseline || hasDialIntent) &&
    activeSignalStartedAt &&
    now.getTime() - activeSignalStartedAt.getTime() <= maximumActiveCallSignalMs
    ? authoritativeDevice
    : undefined;
  const ready = authoritativeDevice && (input.provider === "ringcentral"
    ? authoritativeDevice.state !== "unknown"
    : authoritativeDevice.nextivaProcessDetected && authoritativeDevice.state !== "unknown")
    ? authoritativeDevice
    : undefined;
  const lastOnlineAt = latestAttendanceTransition(sortedEvents, ["Time In", "Login", "Break In", "Lunch Break In", "Off the Phone In"]);
  const lastOfflineAt = latestAttendanceTransition(sortedEvents, ["Time Out", "Logout", "Break Out", "Lunch Break Out", "Off the Phone Out"]);
  const onlineAt = lastOnlineAt && (!lastOfflineAt || lastOnlineAt >= lastOfflineAt) ? lastOnlineAt : null;
  const offlineAt = lastOfflineAt && (!lastOnlineAt || lastOfflineAt >= lastOnlineAt) ? lastOfflineAt : null;

  if (active) {
    const activeStartedAt = activeSignalStartedAt;
    if (!activeStartedAt || activeStartedAt < shift.start) {
      return {
        status: "ONLINE" as const,
        statusStartedAt: withinShift(latestDate(ready?.lastStateChangedAt, onlineAt)),
        transitionUntil: null,
        detail: ready ? "Ready to dial" : `${providerName} session needs a fresh call event`,
      };
    }

    return {
      status: "ON CALL" as const,
      // A stale schedule can outlive the current device session. The newest
      // timestamp is the actual start of the currently active call.
      statusStartedAt: activeStartedAt,
      transitionUntil: null,
      detail: `${providerName} call active`,
    };
  }

  if (availabilityStatus === "OFF THE PHONE") {
    return {
      status: "OFF THE PHONE" as const,
      statusStartedAt: withinShift(offPhoneStartedAt),
      transitionUntil: null,
      detail: "Off the phone",
    };
  }

  if (availabilityStatus === "BREAK" || availabilityStatus === "LUNCH") {
    return {
      status: availabilityStatus,
      statusStartedAt: withinShift(offlineAt),
      transitionUntil: null,
      detail: availabilityStatus === "BREAK" ? "On break" : "At lunch",
    };
  }

  if (availabilityStatus !== "ONLINE") {
    return {
      status: "OFFLINE" as const,
      statusStartedAt: withinShift(offlineAt),
      transitionUntil: null,
      detail: availabilityStatus === "OFFLINE" ? "Not timed in" : availabilityStatus,
    };
  }

  if (ready && schedule?.lastDialStartedAt && schedule.dialIntentUntil && schedule.dialIntentUntil > now) {
    return {
      status: "ONLINE" as const,
      statusStartedAt: withinShift(schedule.lastDialStartedAt),
      transitionUntil: schedule.dialIntentUntil,
      detail: `Opening ${providerName} · call not confirmed`,
    };
  }

  const waitingUntil = schedule?.lastCallEndedAt && schedule.nextCallAllowedAt
    ? new Date(Math.min(schedule.nextCallAllowedAt.getTime(), schedule.lastCallEndedAt.getTime() + 30_000))
    : null;
  if (ready && schedule?.lastCallEndedAt && schedule.lastCallEndedAt >= shift.start && waitingUntil && waitingUntil > now) {
    return {
      status: "CALL WAITING" as const,
      statusStartedAt: withinShift(schedule.lastCallEndedAt),
      transitionUntil: waitingUntil,
      detail: "30-second redial pause",
    };
  }

  if (ready) {
    return {
      status: "ONLINE" as const,
      statusStartedAt: withinShift(latestDate(
        schedule?.dialIntentUntil && schedule.dialIntentUntil <= now ? schedule.dialIntentUntil : null,
        waitingUntil && waitingUntil <= now ? waitingUntil : null,
        ready.lastStateChangedAt,
        onlineAt
      )),
      transitionUntil: null,
      detail: "Ready to dial",
    };
  }

  const disconnectedAt = latestDevice && latestDevice.lastSeenAt.getTime() < now.getTime() - heartbeatFreshnessMs
    ? new Date(latestDevice.lastSeenAt.getTime() + heartbeatFreshnessMs)
    : null;
  return {
    status: "ONLINE" as const,
    statusStartedAt: withinShift(latestDate(disconnectedAt, latestDevice && fresh.length ? latestDevice.lastStateChangedAt : null, offlineAt)),
    transitionUntil: null,
    detail: fresh.length
      ? `Online · ${providerName} unavailable`
      : input.provider === "ringcentral"
        ? "Online · RingCentral API disconnected"
        : "Online · Call Bridge disconnected",
  };
}
