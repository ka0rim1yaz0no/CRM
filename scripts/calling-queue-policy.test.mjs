import assert from "node:assert/strict";
import test from "node:test";
import { evaluateCallingLead, compareCallingLeads, callingWindow, AUTO_CALL_COMMENT_COOLDOWN_MS } from "../shared/leadCallingPolicy.ts";
import { isLeadEligibleForAutoCall as frontend } from "../src/lib/employeeAutoCall.ts";
import { isLeadEligibleForAutoCall as backend } from "../backend/src/services/leadAutoCallEligibility.ts";
import { parseLeadScheduleDateTimeInput, formatLeadScheduleDateTimeInput } from "../src/lib/dateTime.ts";
const now = new Date("2026-10-22T17:00:00Z");
const lead = (id, fields = {}) => ({ _id: id, status: "NEW", createdAt: now, comments: [], ...fields });
const employeeComment = time => ({ authorType: "employee", createdAt: time });

test("precomputed policy ranks preserve exact ordering for every eligibility state and due boundary", () => {
    const rows = Array.from({ length: 400 }, (_, i) => lead(`synthetic-${i}`, {
        status: ["NEW", "Follow up", "Dead", "Qualified"][i % 4],
        createdAt: new Date(+now - (i % 11) * 1000),
        followUpAt: [null, new Date(+now - 1), new Date(+now + 1), "invalid"][i % 4],
        comments: i % 3 === 0 ? [employeeComment(new Date(+now - (i % 2 ? 1 : AUTO_CALL_COMMENT_COOLDOWN_MS)))] : [],
    }));
    for (const at of [now, new Date(+now + 1)]) {
        const ranks = new Map(rows.map(row => [row._id, evaluateCallingLead(row, at)]));
        const baseline = rows.slice().sort((a, b) => compareCallingLeads(a, b, at));
        const cached = rows.slice().sort((a, b) => compareCallingLeads(a, b, at, ranks.get(a._id), ranks.get(b._id)));
        assert.deepEqual(cached, baseline);
    }
});

test("due callbacks precede NEW then unscheduled follow-ups, with stable UTC/ID tie breaking", () => {
    const rows = [lead("new-b"), lead("follow-up", { status: "Follow up" }), lead("new-a"),
        lead("due-later", { status: "Follow up", followUpAt: new Date(+now - 1) }),
        lead("due-earlier-b", { status: "Follow up", followUpAt: new Date(+now - 1000) }),
        lead("due-earlier-a", { status: "Follow up", followUpAt: new Date(+now - 1000) })];
    assert.deepEqual(rows.sort((a, b) => compareCallingLeads(a, b, now)).map(row => row._id), ["due-earlier-a", "due-earlier-b", "due-later", "new-a", "new-b", "follow-up"]);
});

test("one millisecond before and at due time use the exact instant, including future-scheduled NEW", () => {
    for (const status of ["NEW", "Follow up"]) {
        const value = lead("scheduled", { status, followUpAt: new Date(+now + 1) });
        assert.equal(evaluateCallingLead(value, now).reason, "NOT_DUE");
        assert.equal(evaluateCallingLead(value, new Date(+now + 1)).reason, status === "NEW" ? "NEW" : "SCHEDULED_DUE");
    }
});

test("UI and backend share full rolling comment rules, due exception, invalid data and admin treatment", () => {
    const cases = [
        [lead("empty"), true],
        [lead("recent", { comments: [employeeComment(new Date(+now - 1))] }), false],
        [lead("boundary", { comments: [employeeComment(new Date(+now - AUTO_CALL_COMMENT_COOLDOWN_MS))] }), true],
        [lead("admin", { comments: [{ authorType: "admin", createdAt: now }] }), true],
        [lead("invalid-comment", { comments: [employeeComment(null)] }), false],
        [lead("invalid-schedule", { followUpAt: "invalid" }), false],
        [lead("invalid-calendar", { followUpAt: "2026-02-31T12:00:00Z" }), false],
        [lead("ambiguous-date-only", { followUpAt: "2026-10-21" }), false],
        [lead("qualified", { status: "Qualified" }), false],
        [lead("callback", { status: "Follow up", followUpAt: new Date(+now - 1), comments: [employeeComment(new Date(+now - 2))] }), true],
        [lead("comment-at-callback", { status: "Follow up", followUpAt: now, comments: [employeeComment(now)] }), false],
        [lead("comment-after-callback", { status: "Follow up", followUpAt: new Date(+now - 1), comments: [employeeComment(now)] }), false],
    ];
    for (const [value, expected] of cases) {
        assert.equal(frontend(value, now), expected, `${value._id}: frontend`);
        assert.equal(backend(value, now), expected, `${value._id}: backend`);
        assert.equal(evaluateCallingLead(value, now).callable, expected, `${value._id}: shared policy`);
    }
});

test("timezone date boundaries never change due status and Manila window is 23:00 inclusive to 08:00 exclusive", () => {
    for (const at of ["2026-07-01T03:59:59Z", "2026-07-01T04:00:00Z", "2026-11-01T05:59:59Z", "2026-11-01T06:00:00Z"]) {
        const time = new Date(at), value = lead("due", { status: "Follow up", followUpAt: time });
        assert.equal(evaluateCallingLead(value, time).reason, "SCHEDULED_DUE");
    }
    assert.equal(callingWindow(new Date("2026-10-22T14:59:59.999Z")).permitted, false);
    assert.equal(callingWindow(new Date("2026-10-22T15:00:00Z")).permitted, true);
    assert.equal(callingWindow(new Date("2026-10-22T23:59:59.999Z")).permitted, true);
    assert.equal(callingWindow(new Date("2026-10-23T00:00:00Z")).permitted, false);
});

test("Eastern schedule input handles DST, rejects nonexistent times, and documents earliest occurrence in the fall fold", () => {
    assert.equal(parseLeadScheduleDateTimeInput("2026-02-31T12:00"), null);
    assert.equal(parseLeadScheduleDateTimeInput("2026-10-22T24:00"), null);
    assert.equal(parseLeadScheduleDateTimeInput("2026-03-08T02:30"), null);
    assert.equal(parseLeadScheduleDateTimeInput("2026-03-08T03:30").toISOString(), "2026-03-08T07:30:00.000Z");
    assert.equal(parseLeadScheduleDateTimeInput("2026-11-01T01:30").toISOString(), "2026-11-01T05:30:00.000Z");
    for (const value of ["2026-03-08T01:30", "2026-03-08T03:30", "2026-11-01T01:30", "2026-11-01T02:30"]) {
        assert.equal(formatLeadScheduleDateTimeInput(parseLeadScheduleDateTimeInput(value)), value);
    }
});
