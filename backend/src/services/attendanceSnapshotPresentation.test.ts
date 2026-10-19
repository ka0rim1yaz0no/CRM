import test from "node:test";
import assert from "node:assert/strict";
import { withAttendanceStatuses } from "./attendanceSnapshotPresentation";
import { assignAttendanceShift } from "./attendanceShift";
import { projectAttendance, type SessionEvent } from "./attendanceSessionState";

function present(at: string, grace: number) {
    const event: SessionEvent = { id: "fake-event", commandId: "fake-command", source: "Time In", at, recordedAt: at, sequence: 0, shift: assignAttendanceShift(new Date(at)) };
    const projection = projectAttendance([event]);
    return withAttendanceStatuses({ records: projection.effectiveEvents, sessions: projection.sessions }, grace);
}
test("snapshot presentation preserves the full start minute and configured grace through the shared classifier", () => {
    assert.equal(present("2026-10-15T15:00:59Z", 0).records[0].attendanceStatus, "On time");
    assert.equal(present("2026-10-15T15:01:00Z", 0).records[0].attendanceStatus, "Late");
    assert.equal(present("2026-10-15T15:05:59Z", 5).records[0].attendanceStatus, "On time");
    assert.equal(present("2026-10-15T15:06:00Z", 5).records[0].attendanceStatus, "Late");
});
test("status decoration is read-only and never invents a checkout", () => {
    const snapshot = present("2026-10-15T16:00:00Z", 0);
    const before = JSON.stringify(snapshot);
    const repeated = withAttendanceStatuses(snapshot, 0);
    assert.equal(JSON.stringify(snapshot), before);
    assert.equal(repeated.records.length, 1);
    assert.equal(repeated.sessions[0].events[0].attendanceStatus, "Late");
    assert.equal(repeated.records.some((event) => event.source === "Time Out"), false);
});
