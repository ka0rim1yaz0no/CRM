import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
function transpile(source, context = {}) {
    const exports = {};
    runInNewContext(ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText, { exports, ...context });
    return exports;
}
const calendar = transpile(read("src/lib/profileAttendanceCalendar.ts"));
function snapshot() {
    const events = [
        { id: "in", source: "Time In", at: "2026-10-26T15:00:00Z", sequence: 1 },
        { id: "break", source: "Break Out", at: "2026-10-26T17:00:00Z", sequence: 2 },
        { id: "return", source: "Break In", at: "2026-10-26T17:15:00Z", sequence: 3 },
        { id: "out", source: "Time Out", at: "2026-10-27T00:05:00Z", sequence: 4, autoTimeOut: true },
    ];
    const shift = { dayKey: "2026-10-26", start: "2026-10-26T15:00:00Z", end: "2026-10-27T00:00:00Z" };
    return { serverTime: "2026-10-28T16:00:00Z", currentShiftDay: "2026-10-28", sessionId: null, revision: 4,
        records: events, sessions: [{ id: "session", shift, startedAt: events[0].at, lifecycle: "manually-closed", events }],
        dashboardDays: [{ dayKey: shift.dayKey, shiftStart: shift.start, shiftEnd: shift.end, eventIds: events.map(event => event.id),
            timeIn: events[0].at, timeOut: events[3].at, milliseconds: { online: 8 * 3600000, break: 900000, lunch: 3600000, offPhone: 0, late: 0, underTime: 0 } }] };
}
function adapter() {
    let business = "synthetic-a", auth = { userType: "employee", user: { _id: "synthetic-own" }, attendanceHubSession: "synthetic-session" }, resolve;
    const calls = [], modules = { "../lib/api": { api: { get(url, config) { calls.push({ url, config }); return new Promise(done => { resolve = done; }); } } },
        "./authStorage": { getAuthUser: () => auth }, "./businessStorage": { getActiveBusinessId: () => business } };
    const exports = transpile(read("src/api/employeeProfileAttendance.ts"), { require: name => { assert.ok(modules[name]); return modules[name]; } });
    return { request: exports.getEmployeeProfileAttendance, calendar: exports.getEmployeeProfileAttendanceCalendar, calls, finish: (data = snapshot()) => resolve({ data }),
        changeBusiness: value => { business = value; }, changeAuth: value => { auth = value; }, auth: () => auth };
}
test("own attendance reads pin signed employee, business and cancellation without mutation requests", async () => {
    const fixture = adapter(), controller = new AbortController(), request = fixture.request("synthetic-own", "synthetic-a", controller.signal);
    assert.equal(fixture.calls.length, 1);
    const call = fixture.calls[0]; assert.equal(call.url, "/employees/synthetic-own/attendance/session");
    for (const [key, value] of Object.entries({ "X-CRM-Attendance-Session": "synthetic-session", "X-CRM-Admin-Session": "", "X-Business-Id": "synthetic-a", "Cache-Control": "no-store" })) assert.equal(call.config.headers[key], value);
    assert.equal(call.config.signal, controller.signal); assert.equal(call.config.timeout, 15000);
    fixture.finish(); assert.equal((await request).revision, 4);
});
test("late calendar responses cannot cross logout, employee, business or signed-session changes", async () => {
    for (const change of [value => value.changeBusiness("synthetic-b"), value => value.changeAuth(null),
        value => value.changeAuth({ ...value.auth(), user: { _id: "synthetic-other" } }), value => value.changeAuth({ ...value.auth(), attendanceHubSession: "replacement" })]) {
        const fixture = adapter(), request = fixture.request("synthetic-own", "synthetic-a"); change(fixture); fixture.finish(); await assert.rejects(request, /Attendance session changed/);
    }
});
test("admin, foreign employee, unsigned and foreign-business reads are rejected before HTTP", async () => {
    for (const change of [value => value.changeAuth({ userType: "admin", user: { _id: "synthetic-own" }, sessionToken: "synthetic-admin" }),
        value => value.changeAuth({ ...value.auth(), attendanceHubSession: "" }), value => value.changeBusiness("synthetic-b")]) {
        const fixture = adapter(); change(fixture); await assert.rejects(fixture.request("synthetic-own", "synthetic-a"), /Sign in again/); assert.equal(fixture.calls.length, 0);
    }
    const fixture = adapter(); await assert.rejects(fixture.request("synthetic-other", "synthetic-a"), /Sign in again/); assert.equal(fixture.calls.length, 0);
});
test("missing canonical history fails explicitly rather than showing an invented empty calendar", async () => {
    for (const data of [{ ...snapshot(), dashboardDays: undefined }, { ...snapshot(), sessions: undefined }, { ...snapshot(), records: undefined }, { ...snapshot(), serverTime: "invalid" }]) {
        const fixture = adapter(), request = fixture.request("synthetic-own", "synthetic-a"); fixture.finish(data); await assert.rejects(request, /Attendance history is unavailable/);
    }
});
test("calendar uses six stable weeks, valid leap days and month/year navigation", () => {
    for (const [month, length] of [["2026-10", 31], ["2024-02", 29], ["2026-02", 28]]) {
        const cells = calendar.attendanceCalendarCells(month); assert.equal(cells.length, 42); assert.equal(cells.filter(Boolean).length, length);
    }
    assert.equal(calendar.moveAttendanceCalendarMonth("2026-12", 1), "2027-01"); assert.equal(calendar.moveAttendanceCalendarMonth("2026-01", -1), "2025-12");
    for (const month of ["2026-13", "2026-2", "invalid", "0001-01"]) assert.throws(() => calendar.attendanceCalendarCells(month));
});
test("08:05 checkouts retain overnight ownership and later open sessions never inherit an earlier checkout", () => {
    const value = snapshot(), before = JSON.stringify(value), day = calendar.profileAttendanceDay(value, "2026-10-26");
    assert.equal(day.timeOut, "2026-10-27T00:05:00Z"); assert.equal(day.events.length, 4); assert.equal(day.status, "Completed");
    assert.equal(calendar.profileAttendanceDay(value, "2026-10-27"), null); assert.equal(JSON.stringify(value), before);
    value.records.push({ id: "foreign", source: "Time In", at: "2026-10-27T15:00:00Z", sequence: 5 }); assert.equal(calendar.profileAttendanceDay(value, "2026-10-26").events.length, 4);
    value.sessions[0].lifecycle = "open"; value.currentShiftDay = "2026-10-26"; value.sessionId = "session";
    assert.equal(calendar.profileAttendanceDay(value, "2026-10-26").status, "In progress"); assert.equal(calendar.profileAttendanceDay(value, "2026-10-26").timeOut, null);
    value.currentShiftDay = "2026-10-28"; assert.equal(calendar.profileAttendanceDay(value, "2026-10-26").status, "Needs review");
    value.sessions[0].lifecycle = "system-closed"; assert.equal(calendar.profileAttendanceDay(value, "2026-10-26").status, "Needs review");
    const completed = snapshot(); completed.sessions.unshift({ ...completed.sessions[0], id: "legacy-session", startedAt: "2026-10-26T14:00:00Z", lifecycle: "open" });
    assert.equal(calendar.profileAttendanceDay(completed, "2026-10-26").status, "Needs review");
    assert.equal(calendar.profileAttendanceDay(completed, "2026-10-26").timeOut, "2026-10-27T00:05:00Z");
    const missingIn = snapshot(); missingIn.dashboardDays[0].timeIn = null;
    assert.equal(calendar.profileAttendanceDay(missingIn, "2026-10-26").status, "Needs review");
});
test("six business calendars render read-only slots and server durations without changing attendance", () => {
    const component = read("src/components/EmployeeAttendanceCalendar.tsx"), ast = ts.createSourceFile("calendar.tsx", component, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const declaration = ast.statements.find(node => node.name?.text === "AttendanceCalendarView"); assert.ok(declaration);
    const dates = transpile(read("src/lib/dateTime.ts")), records = ts.createSourceFile("records.ts", read("src/lib/attendanceRecords.ts"), ts.ScriptTarget.Latest, true);
    const duration = records.statements.find(node => node.name?.text === "formatAttendanceDuration"); assert.ok(duration);
    const presentation = transpile(read("src/lib/attendancePresentation.ts"), { require: () => dates });
    const icons = { FiCalendar: () => null, FiChevronLeft: () => null, FiChevronRight: () => null, FiClock: () => null };
    const view = transpile(declaration.getText(ast), { require: createRequire(import.meta.url), ...calendar, ...dates, ...presentation, ...transpile(duration.getText(records)), ...icons,
        profileDayKey: value => new Date(value).toLocaleDateString("en-CA", { timeZone: "Asia/Manila" }) });
    for (let business = 0; business < 6; business++) {
        const value = snapshot(), before = JSON.stringify(value), html = renderToStaticMarkup(React.createElement(view.AttendanceCalendarView,
            { snapshot: value, month: "2026-10", selectedDay: "2026-10-26", onMonth() {}, onSelect() {} }));
        for (const text of ["Attendance calendar", "Attendance slots", "Time In", "Time Out", "8:05:00 AM", "Automatic", "8h 00m", "October 26, 2026", "Selected Slot", "Total Records", "Days Tracked", "Latest", "Ontime-Present"]) assert.ok(html.includes(text), text);
        assert.match(html, /employee-attendance-event/); assert.match(html, /employee-attendance-layout/);
        assert.ok(!html.includes("Undo")); assert.ok(!html.includes("Add Time Out")); assert.equal(JSON.stringify(value), before);
    }
    const render = value => renderToStaticMarkup(React.createElement(view.AttendanceCalendarView,
        { snapshot: value, month: "2026-10", selectedDay: "2026-10-26", onMonth() {}, onSelect() {} }));
    const late = snapshot(); late.dashboardDays[0].milliseconds.late = 120000; late.dashboardDays[0].milliseconds.underTime = 300000;
    const selected = render(late).split('aria-label="Selected attendance shift"')[1];
    assert.match(selected, /data-tone="late"/); assert.match(selected, /data-tone="undertime"/); assert.doesNotMatch(selected, /data-tone="ontime"|data-tone="overtime"/);
    const missing = snapshot(); missing.dashboardDays[0].timeIn = null;
    const missingSelected = render(missing).split('aria-label="Selected attendance shift"')[1];
    assert.match(missingSelected, /Needs review/); assert.doesNotMatch(missingSelected, /Ontime-Present/);
    assert.match(render(snapshot()), /data-tone="absent">Absent/);
    assert.doesNotMatch(render(snapshot()).split('aria-label="Selected attendance shift"')[1], /data-tone="absent"/);
    const historicalOvertime = snapshot(); historicalOvertime.dashboardDays[0].milliseconds.overtime = 3600000;
    const historicalBefore = JSON.stringify(historicalOvertime);
    assert.doesNotMatch(render(historicalOvertime), /Overtime|data-tone="overtime"/);
    assert.equal(JSON.stringify(historicalOvertime), historicalBefore);
    const confirmed = { month: "2026-10", serverTime: snapshot().serverTime, days: [{ dayKey: "2026-10-27", shiftEnd: "2026-10-28T00:00:00Z", absent: true, excused: false, attendanceRevision: 4 }] };
    const absentHtml = renderToStaticMarkup(React.createElement(view.AttendanceCalendarView,
        { snapshot: snapshot(), calendar: confirmed, month: "2026-10", selectedDay: "2026-10-27", onMonth() {}, onSelect() {} }));
    assert.match(absentHtml, /data-status="Absent"/);
    assert.match(absentHtml.split('aria-label="Selected attendance shift"')[1], /data-tone="absent"/);
    assert.match(absentHtml, /No Time In recorded for this completed shift/);
    assert.match(component, /queryKey: \["employee-profile-attendance", businessId, employeeId\]/); assert.match(component, /refetchInterval: 30000/);
    assert.match(component, /gcTime: 0/); assert.doesNotMatch(component, /useMutation|submitAttendance|performAttendanceAction/);
    assert.match(read("src/lib/employeeWorkspaceCache.ts"), /employee-profile-attendance/);
});

test("absence reads capture signed ownership, validate the requested month and reject stale or malformed replies", async () => {
    const value = { month: "2026-10", serverTime: "2026-10-28T16:00:00Z", days: [{ dayKey: "2026-10-27", shiftEnd: "2026-10-28T00:00:00Z", absent: true, excused: false, attendanceRevision: 4 }] };
    const fixture = adapter(), controller = new AbortController(), request = fixture.calendar("synthetic-own", "synthetic-a", "2026-10", controller.signal);
    assert.equal(fixture.calls[0].url, "/employees/synthetic-own/attendance/calendar?month=2026-10");
    assert.equal(fixture.calls[0].config.signal, controller.signal);
    assert.equal(fixture.calls[0].config.headers["X-CRM-Attendance-Session"], "synthetic-session");
    fixture.finish(value); assert.equal((await request).days.length, 1);
    for (const month of ["2026-13", "2026-2", "0001-01", "invalid"]) {
        const invalid = adapter(); await assert.rejects(invalid.calendar("synthetic-own", "synthetic-a", month), /valid attendance month/); assert.equal(invalid.calls.length, 0);
    }
    for (const data of [null, { ...value, month: "2026-09" }, { ...value, days: [null] },
        { ...value, days: [value.days[0], value.days[0]] }, { ...value, days: [{ ...value.days[0], dayKey: "2026-09-27" }] },
        { ...value, days: [{ ...value.days[0], excused: true }] }, { ...value, days: [{ ...value.days[0], attendanceRevision: -1 }] }]) {
        const invalid = adapter(), pending = invalid.calendar("synthetic-own", "synthetic-a", "2026-10"); invalid.finish(data);
        await assert.rejects(pending, /Absence status is unavailable/);
    }
    const changed = adapter(), pending = changed.calendar("synthetic-own", "synthetic-a", "2026-10"); changed.changeBusiness("synthetic-b"); changed.finish(value);
    await assert.rejects(pending, /Attendance session changed/);
    const foreign = adapter(); await assert.rejects(foreign.calendar("synthetic-other", "synthetic-a", "2026-10"), /Sign in again/); assert.equal(foreign.calls.length, 0);
});

test("daily Absent badges require fresh HR confirmation and never replace records, exemptions or a current shift", () => {
    const value = snapshot(), confirmation = { month: "2026-10", serverTime: value.serverTime,
        days: [{ dayKey: "2026-10-27", shiftEnd: "2026-10-28T00:00:00Z", absent: true, excused: false, attendanceRevision: 4 }] };
    assert.equal(calendar.profileAttendanceAbsent(value, "2026-10-27"), false);
    assert.equal(calendar.profileAttendanceAbsent(value, "2026-10-27", confirmation), true);
    for (const change of [{ absent: false }, { excused: true }, { attendanceRevision: 3 }, { shiftEnd: "2026-10-29T00:00:00Z" }]) {
        assert.equal(calendar.profileAttendanceAbsent(value, "2026-10-27", { ...confirmation, days: [{ ...confirmation.days[0], ...change }] }), false);
    }
    assert.equal(calendar.profileAttendanceAbsent(value, "2026-09-27", confirmation), false);
    assert.equal(calendar.profileAttendanceAbsent(value, "2026-10-26", { ...confirmation, days: [{ ...confirmation.days[0], dayKey: "2026-10-26" }] }), false);
    value.records.push({ id: "new-in", source: "Time In", at: "2026-10-27T15:00:00Z", sequence: 5, shiftDayKey: "2026-10-27" });
    assert.equal(calendar.profileAttendanceAbsent(value, "2026-10-27", confirmation), false);
    assert.deepEqual(confirmation.days[0].absent, true);
});

test("failed background refresh retains confirmed attendance instead of hiding every slot", () => {
    const source = read("src/components/EmployeeAttendanceCalendar.tsx"), ast = ts.createSourceFile("calendar.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const declaration = ast.statements.find(node => node.name?.text === "AttendanceCalendarLedger"); assert.ok(declaration);
    let query;
    const dates = transpile(read("src/lib/dateTime.ts"));
    const exports = transpile(declaration.getText(ast) + "\nexports.Ledger = AttendanceCalendarLedger;", {
        require: createRequire(import.meta.url), useState: React.useState, useQuery: () => query, ...dates,
        profileDayKey: () => "2026-10-28", getEmployeeProfileAttendance() {}, FiRefreshCw: () => null,
        AttendanceCalendarView: () => React.createElement("div", { "aria-label": "Confirmed attendance slots" }, "Time In / Time Out / Break / Lunch"),
    });
    const render = () => renderToStaticMarkup(React.createElement(exports.Ledger, { employeeId: "synthetic-own", businessId: "synthetic-a" }));
    query = { data: snapshot(), isError: true, isPending: false, isFetching: false, refetch() {} };
    const failedRefresh = render();
    assert.match(failedRefresh, /Showing records last confirmed/); assert.match(failedRefresh, /Confirmed attendance slots/);
    query = { ...query, data: undefined };
    assert.match(render(), /Attendance could not load/); assert.doesNotMatch(render(), /Confirmed attendance slots|No attendance recorded/);
    query = { ...query, data: snapshot(), isError: false };
    assert.match(render(), /Confirmed attendance slots/); assert.doesNotMatch(render(), /Showing records last confirmed/);
    assert.doesNotMatch(read("src/components/employeeAttendanceCalendar.css"), /employee-attendance-events\s*\{[^}]*max-height/);
});
