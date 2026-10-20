import { accountTime, bucketForAttendanceSource } from "./timeAccounting";
import type { AttendanceSource } from "../models/Attendance";
import { attendanceBreakGapEnabled, attendanceDurationModelEnabled } from "../config/rolloutFlags";

export type AttendanceMode = "ONLINE" | "BREAK" | "LUNCH" | "OFF THE PHONE" | "OFFLINE";
export type AssignedShift = { dayKey: string; start: string; end: string; resetDeadline: string; ambiguous?: boolean };
export type SessionEvent = { id: string; source: AttendanceSource; at: string; sequence: number; commandId: string;
  recordedAt: string; autoTimeOut?: boolean; sessionId?: string; shift?: AssignedShift; origin?: { businessId: string; recordId: string };
  replicaOrigins?: Array<{ businessId: string; recordId: string }>; legacyReviewed?: boolean; legacyBoundary?: boolean };
export type SessionCorrection = { commandId: string; targets: string[]; reason: string; actor: string; at: string };
export type SystemClosure = { id: string; sessionId: string; effectiveAt: string; processedAt: string; commandId: string };
export type AttendanceSession = { id: string; startedAt: string; endedAt: string | null; lifecycle: "open" | "manually-closed" | "system-closed";
  mode: AttendanceMode; modeSince: string; shift: AssignedShift | null; events: SessionEvent[]; closure?: SystemClosure; historicalReview?: boolean };

const returns: Partial<Record<AttendanceSource, AttendanceMode>> = {
  "Break In": "BREAK", "Lunch Break In": "LUNCH", "Off the Phone In": "OFF THE PHONE",
};
const outgoing: Partial<Record<AttendanceSource, AttendanceMode>> = {
  "Break Out": "BREAK", "Lunch Break Out": "LUNCH", "Off the Phone Out": "OFF THE PHONE",
};
export function projectAttendance(events: SessionEvent[], corrections: SessionCorrection[] = [], closures: SystemClosure[] = []) {
  const reversed = new Set(corrections.flatMap((correction) => correction.targets));
  const effectiveEvents = events.filter((event) => !reversed.has(event.id))
    .sort((a, b) => a.at.localeCompare(b.at) || a.sequence - b.sequence || a.id.localeCompare(b.id));
  const sessions: AttendanceSession[] = [];
  const issues: Array<{ eventId: string; message: string; historical?: boolean }> = [];
  const boundaryIndex = effectiveEvents.findIndex((event) => event.legacyBoundary && event.legacyReviewed);
  let active: AttendanceSession | null = null;
  const applyClosure = (before: string) => {
    if (!active) return;
    const closure = closures.find((item) => item.sessionId === active?.id && item.effectiveAt <= before);
    if (closure) {
      active.lifecycle = "system-closed"; active.endedAt = closure.effectiveAt;
      active.mode = "OFFLINE"; active.modeSince = closure.effectiveAt; active.closure = closure; active = null;
    }
  };
  for (const event of effectiveEvents) {
    applyClosure(event.at);
    if (event.source === "Time In" || event.source === "Login") {
      if (active && event.legacyReviewed && event.legacyBoundary) {
        issues.push({ eventId: active.id, message: "Earlier legacy session has no verified checkout; original evidence is retained.", historical: true });
        active.historicalReview = true;
        active = null;
      }
      if (active) { issues.push({ eventId: event.id, message: "A session is already open. Resolve the earlier session." }); continue; }
      active = { id: event.sessionId || event.id, startedAt: event.at, endedAt: null, lifecycle: "open", mode: "ONLINE", modeSince: event.at,
        shift: event.shift || null, events: [event] };
      sessions.push(active); continue;
    }
    if (!active) {
      issues.push({ eventId: event.id, message: "This event has no open session.",
        historical: event.legacyReviewed && Boolean(returns[event.source] || event.source === "Time Out" || event.source === "Logout") });
      continue;
    }
    if (event.source === "Time Out" || event.source === "Logout") {
      if (active.mode !== "ONLINE" && active.mode !== "OFF THE PHONE" && !event.legacyReviewed) {
        issues.push({ eventId: event.id, message: "End the open break or lunch before Time Out." }); continue;
      }
      if (active.mode !== "ONLINE" && active.mode !== "OFF THE PHONE") issues.push({ eventId: event.id,
        message: "Legacy manual checkout has no separate break or lunch return; original checkout is retained.", historical: true });
      active.events.push(event); active.endedAt = event.at; active.modeSince = event.at;
      active.lifecycle = "manually-closed"; active.mode = "OFFLINE"; active = null; continue;
    }
    const outMode = outgoing[event.source];
    const returnMode = returns[event.source];
    if (outMode) {
      if (active.mode !== "ONLINE") { issues.push({ eventId: event.id, message: `Cannot start ${outMode} from ${active.mode}.` }); continue; }
      const slotSessions = attendanceDurationModelEnabled() && active.shift
        ? sessions.filter((session) => session.shift?.dayKey === active!.shift!.dayKey) : [active];
      const previous = slotSessions.flatMap((session) => session.events).filter((item) => item.source === event.source);
      if (outMode === "LUNCH" && previous.length) {
        issues.push({ eventId: event.id, message: "Only one lunch is allowed per session.", historical: event.legacyReviewed });
        if (!event.legacyReviewed) continue;
      }
      if (outMode === "BREAK" && (previous.length >= 2 || (attendanceBreakGapEnabled() && previous.some((item) => Date.parse(event.at) - Date.parse(item.at) < 30 * 60_000)))) {
        issues.push({ eventId: event.id, message: "Only two breaks are allowed, with a 30 minute gap between starts.", historical: event.legacyReviewed });
        if (!event.legacyReviewed) continue;
      }
      active.mode = outMode;
    } else if (returnMode) {
      if (active.mode !== returnMode) { issues.push({ eventId: event.id, message: `No open ${returnMode} matches this return.` }); continue; }
      active.mode = "ONLINE";
    }
    active.modeSince = event.at; active.events.push(event);
  }
  applyClosure("9999");
  const indexes = new Map(effectiveEvents.map((event, index) => [event.id, index]));
  const reviewedIssues = issues.map((issue) => ({ ...issue,
    historical: Boolean(issue.historical || (boundaryIndex >= 0 && (indexes.get(issue.eventId) ?? Infinity) < boundaryIndex)) }));
  return { sessions, active, effectiveEvents, issues: reviewedIssues,
    blockingIssues: reviewedIssues.filter((issue) => !issue.historical), reversedIds: [...reversed] };
}

export function sessionTime(session: AttendanceSession, now: Date) {
  const events = session.events.flatMap((event) => {
    const bucket = bucketForAttendanceSource(event.source);
    return bucket ? [{ at: new Date(event.at), bucket }] : [];
  });
  const end = session.lifecycle === "system-closed" ? new Date(session.events.at(-1)?.at || session.startedAt) : session.endedAt ? new Date(session.endedAt) : now;
  const actual = accountTime(events, new Date(session.startedAt), end, now);
  const scheduled = session.shift ? accountTime(events, new Date(session.shift.start), new Date(session.shift.end),
    session.lifecycle === "system-closed" ? new Date(session.events.at(-1)?.at || session.startedAt) : new Date(Math.min(now.getTime(), end.getTime()))) : actual;
  return { actual: actual.milliseconds, scheduled: scheduled.milliseconds };
}
