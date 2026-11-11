import assert from "node:assert/strict";
import { test } from "node:test";
import { attendanceAppendHasBlockingIssues, projectAttendance, type SessionEvent, type SessionCorrection, type SystemClosure } from "./attendanceSessionState";
import { attendanceSnapshot } from "./attendanceLedgerService";
import { attendanceDashboardPresentation } from "./attendanceDashboardPresentation";
import { attendanceChangedDays } from "./attendanceReadPresentation";
import { assignAttendanceShift } from "./attendanceShift";
import type { AttendanceLedgerDocument } from "../models/AttendanceLedger";

const sources: SessionEvent["source"][] = ["Login", "Logout", "Time In", "Time Out", "Break Out", "Break In", "Lunch Break Out", "Lunch Break In",
  "Off the Phone Out", "Non-Billable Off the Phone Out", "Off the Phone In", "Coaching Out", "Coaching In"];
const event = (source: SessionEvent["source"], at: number, sequence: number, extra: Partial<SessionEvent> = {}): SessionEvent => ({
  id: `synthetic-${sequence}`, commandId: `command-${sequence}`, source, sequence, at: new Date(at).toISOString(), recordedAt: new Date(at).toISOString(),
  ...(["Time In", "Login"].includes(source) ? { shift: assignAttendanceShift(new Date(at)) } : {}), ...extra,
});
const policy = { revision: 1, shiftStart: "23:00", shiftEnd: "08:00", graceMinutes: 0, breakMinutes: 15, lunchMinutes: 60, autoTimeOutTime: "08:05" };

test("suffix action previews match full replay across six scopes, corrections, closures, legacy boundaries and clock ordering", () => {
  const oldDuration = process.env.CRM_ATTENDANCE_DURATION_MODEL, oldGap = process.env.CRM_ATTENDANCE_BREAK_GAP;
  try {
    for (const duration of ["true", "false"]) for (const gap of ["true", "false"]) {
      process.env.CRM_ATTENDANCE_DURATION_MODEL = duration; process.env.CRM_ATTENDANCE_BREAK_GAP = gap;
      for (let scope = 0; scope < 6; scope++) for (let scenario = 0; scenario < 30; scenario++) {
        const start = Date.parse("2026-10-20T15:00:00Z") + scope * 86400000;
        const events: SessionEvent[] = [event("Time In", start, 0), event("Break Out", start + 60000, 1), event("Break In", start + 960000, 2),
          event("Time Out", start + 1200000, 3), event("Time In", start + 1800000, 4)];
        for (let index = 0; index < scenario; index++) events.push(event(sources[(index * 7 + scenario) % sources.length], start + 2000000 + index * 60000, 5 + index,
          scenario % 3 === 0 ? { legacyReviewed: true, legacyBoundary: sources[(index * 7 + scenario) % sources.length] === "Time In" } : {}));
        const corrections: SessionCorrection[] = scenario % 4 === 0 ? [{ commandId: "undo", targets: ["synthetic-2"], reason: "Fixture", actor: "test", at: new Date(start).toISOString() }] : [];
        const closures: SystemClosure[] = scenario % 5 === 0 ? [{ id: "close", sessionId: "synthetic-4", effectiveAt: new Date(start + 7200000).toISOString(), processedAt: new Date(start + 7300000).toISOString(), commandId: "close" }] : [];
        const projection = projectAttendance(events, corrections, closures), before = JSON.stringify({ events, corrections, closures, projection });
        for (const at of [start, Date.parse(events.at(-1)!.at), start + 10000000]) for (const source of sources) {
          const additions = [event(source, at, 10000)];
          assert.equal(attendanceAppendHasBlockingIssues(events, corrections, closures, projection, additions),
            projectAttendance([...events, ...additions], corrections, closures).blockingIssues.length > 0, `${duration}/${gap}/${scope}/${scenario}/${source}/${at}`);
        }
        assert.equal(JSON.stringify({ events, corrections, closures, projection }), before);
      }
    }
  } finally {
    if (oldDuration === undefined) delete process.env.CRM_ATTENDANCE_DURATION_MODEL; else process.env.CRM_ATTENDANCE_DURATION_MODEL = oldDuration;
    if (oldGap === undefined) delete process.env.CRM_ATTENDANCE_BREAK_GAP; else process.env.CRM_ATTENDANCE_BREAK_GAP = oldGap;
  }
});

test("compact snapshots preserve fresh control fields without serializing historical events or audit", () => {
  const events: SessionEvent[] = [];
  const start = Date.parse("2026-06-01T15:00:00Z");
  for (let day = 0; day < 100; day++) {
    const at = start + day * 86400000;
    for (const [source, offset] of [["Time In", 0], ["Break Out", 3600000], ["Break In", 4500000], ["Time Out", 32400000]] as const)
      events.push(event(source, at + offset, events.length));
  }
  const ledger = { _id: "synthetic-ledger", events, corrections: [], closures: [], audit: Array.from({ length: 100 }, (_, index) => ({ operation: "fixture", index, reason: "Synthetic historical evidence" })),
    revision: 3, jobs: [], derived: [], commands: [] } as unknown as AttendanceLedgerDocument;
  const now = new Date(start + 101 * 86400000), before = JSON.stringify(ledger);
  const full = attendanceSnapshot(ledger, now, policy), compact = attendanceSnapshot(ledger, now, policy, { includeHistory: false });
  for (const key of ["state", "stateSince", "revision", "fingerprint", "reviewState", "allowedActions", "assignedShift", "coachingBilling", "offPhoneBilling", "syncPending", "time"] as const)
    assert.deepEqual(compact[key], full[key]);
  assert.equal(compact.records.length, 0); assert.equal(compact.audit.length, 0);
  assert.ok(compact.sessions.every(session => session.events.length === 0));
  assert.ok(JSON.stringify(compact).length < JSON.stringify(full).length * 0.6);
  assert.equal(JSON.stringify(ledger), before);
});

test("changed-day presentation reconciles exactly with a full refresh at rest, shift and overnight boundaries", () => {
  const start = Date.parse("2026-10-20T15:00:00Z");
  const events: SessionEvent[] = [event("Time In", start - 86400000, 0), event("Time Out", start - 54000000, 1),
    event("Time In", start, 2), event("Break Out", start + 60000, 3), event("Break In", start + 1020000, 4),
    event("Lunch Break Out", start + 3600000, 5), event("Lunch Break In", start + 7260000, 6),
    event("Coaching Out", start + 8000000, 7), event("Coaching In", start + 9200000, 8)];
  const projection = projectAttendance(events);
  for (const [since, until] of [[start + 10000000, start + 10010000], [start + 32399000, start + 32401000], [start + 32500000, start + 86400000]]) {
    const old = attendanceDashboardPresentation({ records: projection.effectiveEvents, sessions: projection.sessions }, policy, new Date(since));
    const delta = attendanceChangedDays(projection, policy, new Date(since), new Date(until));
    const expected = attendanceDashboardPresentation({ records: projection.effectiveEvents, sessions: projection.sessions }, policy, new Date(until));
    const days = new Map(old.dashboardDays.filter(day => !delta.changedDayKeys.includes(day.dayKey)).map(day => [day.dayKey, day]));
    for (const day of delta.dashboardDays) days.set(day.dayKey, day);
    assert.deepEqual([...days.values()].sort((a, b) => a.dayKey.localeCompare(b.dayKey)), expected.dashboardDays);
    assert.equal(delta.currentShiftDay, expected.currentShiftDay);
  }
});

test("status-only snapshots retain one canonical session and exact live guards across six scopes and every attendance mode", () => {
  const previous = process.env.CRM_ATTENDANCE_DURATION_MODEL;
  process.env.CRM_ATTENDANCE_DURATION_MODEL = "true";
  try {
    for (let scope = 0; scope < 6; scope++) for (const mode of ["ONLINE", "BREAK", "LUNCH", "OFF THE PHONE", "COACHING", "OFFLINE", "CLOSURE", "UNDO"] as const) {
      const start = Date.parse("2026-10-20T15:00:00Z") + scope * 86400000, events: SessionEvent[] = [];
      for (let day = 100; day > 0; day--) {
        const at = start - day * 86400000;
        events.push(event("Time In", at, events.length), event("Time Out", at + 32400000, events.length + 1));
      }
      events.push(event("Time In", start, events.length));
      const activeId = events.at(-1)!.id;
      const outgoing: Record<string, SessionEvent["source"] | undefined> = { BREAK: "Break Out", LUNCH: "Lunch Break Out", "OFF THE PHONE": "Off the Phone Out", COACHING: "Coaching Out", OFFLINE: "Time Out", UNDO: "Break Out" };
      const source = outgoing[mode];
      if (source) events.push(event(source, start + 3600000, events.length));
      const corrections: SessionCorrection[] = mode === "UNDO" ? [{ commandId: "undo", targets: [events.at(-1)!.id], reason: "Fixture correction", actor: "fixture", at: new Date(start + 3610000).toISOString() }] : [];
      const closures: SystemClosure[] = mode === "CLOSURE" ? [{ id: "closure", sessionId: activeId, commandId: "closure", effectiveAt: new Date(start + 3600000).toISOString(), processedAt: new Date(start + 3610000).toISOString() }] : [];
      const ledger = { _id: `synthetic-${scope}`, events, corrections, closures, audit: [], revision: 17, jobs: [], derived: [], commands: [] } as unknown as AttendanceLedgerDocument;
      const original = JSON.stringify(ledger);
      for (const at of [start + 3600001, start + 4800000, start + 4800001, start + 32400000]) {
        const now = new Date(at), full = attendanceSnapshot(ledger, now, policy), compact = attendanceSnapshot(ledger, now, policy, { statusOnly: true });
        for (const key of ["state", "stateSince", "sessionId", "lifecycle", "revision", "fingerprint", "reviewState", "review", "allowedActions", "assignedShift", "coachingBilling", "offPhoneBilling", "systemClosure", "syncPending", "time"] as const)
          assert.deepEqual(compact[key], full[key], `${scope}/${mode}/${key}/${at}`);
        assert.equal(compact.sessions.length, 1);
        const last = full.sessions.at(-1)!;
        assert.deepEqual(compact.sessions[0], { ...last, events: [] });
        assert.deepEqual(compact.records, []); assert.deepEqual(compact.audit, []);
        assert.ok(JSON.stringify(compact).length < JSON.stringify(full).length * 0.15);
      }
      assert.equal(JSON.stringify(ledger), original);
    }
  } finally {
    if (previous === undefined) delete process.env.CRM_ATTENDANCE_DURATION_MODEL; else process.env.CRM_ATTENDANCE_DURATION_MODEL = previous;
  }
});
