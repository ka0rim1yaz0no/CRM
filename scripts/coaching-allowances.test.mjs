import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import { allowanceClock, coachingRemainingMs, offPhoneRemainingMs } from "../src/lib/attendanceAllowances.ts";

const source = readFileSync(new URL("../src/components/AttendanceAwayControls.tsx", import.meta.url), "utf8");
const require = createRequire(import.meta.url);
const exported = {};
let pendingMutation = false;
runInNewContext(ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText,
    { exports: exported, Date, setInterval, clearInterval, require: name => {
        if (name === "@tanstack/react-query") return { useQueryClient: () => ({}), useMutation: () => ({ isPending: pendingMutation, isError: false }) };
        if (name === "../api/attendanceSession") return { performAttendanceAction: () => assert.fail("render cannot write attendance") };
        if (name === "../api/businessStorage") return { getActiveBusinessId: () => "synthetic" };
        if (name === "../lib/attendanceAllowances") return { allowanceClock, coachingRemainingMs, offPhoneRemainingMs };
        if (name === "../lib/attendanceUndo") return { attendanceCorrectionError: () => "Synthetic error" };
        return require(name);
    } });

function snapshot(remaining = 1_200_000, active = false) {
    const now = Date.now();
    return { state: active ? "OFF THE PHONE" : "ONLINE", reviewState: "verified", serverTime: new Date(now).toISOString(), receivedAt: now,
        coachingBilling: { endsAt: new Date(now + 3_600_000).toISOString(), limited: true, remainingPaidMs: remaining, paidUsedMs: 1_200_000 - remaining,
            totalMs: 1_200_000 - remaining, active: active ? { startedAt: new Date(now - 1000).toISOString(), returnAt: new Date(now + remaining).toISOString() } : null },
        offPhoneBilling: { limited: true, remainingPaidMs: 900_000, active: null },
        allowedActions: active ? ["Coaching In"] : remaining ? ["Coaching Out", "Off the Phone Out"] : ["Off the Phone Out"] };
}

test("remaining clocks use server deadlines, survive refresh and cannot go below zero", () => {
    const view = snapshot(300_000, true), now = Date.parse(view.serverTime);
    assert.equal(coachingRemainingMs(view.coachingBilling, now), 300_000);
    assert.equal(coachingRemainingMs(JSON.parse(JSON.stringify(view.coachingBilling)), now + 1000), 299_000);
    assert.equal(coachingRemainingMs(view.coachingBilling, now + 300_000), 0);
    assert.equal(coachingRemainingMs(view.coachingBilling, now + 400_000), 0);
    assert.equal(offPhoneRemainingMs(view.offPhoneBilling, now), 900_000);
    assert.equal(allowanceClock(299_001), "05:00");
    assert.equal(allowanceClock(0), "00:00");
    assert.equal(allowanceClock(null), "--:--");
});

test("all six business dashboards retain independent Off the Phone and billable Coaching controls after refresh", () => {
    for (let business = 0; business < 6; business++) {
        const view = snapshot();
        const html = renderToStaticMarkup(React.createElement(exported.default, { employeeId: "synthetic", snapshot: JSON.parse(JSON.stringify(view)) }));
        assert.match(html, /Off the Phone remaining/);
        assert.match(html, /Coaching remaining/);
        assert.match(html, />20:00<\/output>/);
        assert.match(html, />15:00<\/output>/);
        assert.doesNotMatch(html, /non.billable/i);
        assert.doesNotMatch(html.match(/<button[^>]+data-attendance-action="COACHING"[^>]*>/)[0], /disabled=""/);
    }
});

test("Coaching is disabled at zero, while returning Online, during another rest and without confirmed allowance data", () => {
    for (const view of [snapshot(0), snapshot(0, true), { ...snapshot(), allowedActions: ["Break In"] }, { ...snapshot(), coachingBilling: null }]) {
        const html = renderToStaticMarkup(React.createElement(exported.default, { employeeId: "synthetic", snapshot: view }));
        assert.match(html.match(/<button[^>]+data-attendance-action="COACHING"[^>]*>/)[0], /disabled=""/);
    }
    assert.match(source, /performAttendanceAction\(employeeId, source\)/);
    assert.match(source, /snapshot\.reviewState !== "verified"/);
});

test("the other away button stays disabled during Coaching, Off the Phone and a pending save even with stale actions", () => {
    const render = view => renderToStaticMarkup(React.createElement(exported.default, { employeeId: "synthetic", snapshot: view }));
    const button = (html, action) => html.match(new RegExp('<button[^>]+data-attendance-action="' + action + '"[^>]*>'))[0];
    const coaching = { ...snapshot(600_000, true), allowedActions: ["Coaching In", "Off the Phone Out"] };
    assert.match(render(coaching), />Coaching Out<\/button>/);
    assert.doesNotMatch(render(coaching), /End Coaching/);
    assert.match(render(snapshot()), />Coaching<\/button>/);
    assert.match(button(render(coaching), "OFF THE PHONE"), /disabled=""/);
    const offPhone = { ...snapshot(), state: "OFF THE PHONE", allowedActions: ["Off the Phone In", "Coaching Out"] };
    assert.match(button(render(offPhone), "COACHING"), /disabled=""/);
    pendingMutation = true;
    try {
        const html = render(snapshot());
        for (const action of ["COACHING", "OFF THE PHONE"]) assert.match(button(html, action), /disabled=""/);
    } finally { pendingMutation = false; }
});

test("one allowance strip appears before dashboard stats and Announcements instead of below the long tables", () => {
    const workspace = readFileSync(new URL("../src/components/WorkspaceDashboard.tsx", import.meta.url), "utf8");
    const ast = ts.createSourceFile("WorkspaceDashboard.tsx", workspace, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const positions = { controls: [], announcements: [], stats: [] };
    function visit(node) {
        if (ts.isJsxSelfClosingElement(node)) {
            if (node.tagName.getText(ast) === "AttendanceAwayControls") positions.controls.push(node.getStart(ast));
            if (node.tagName.getText(ast) === "AnnouncementsPanel") positions.announcements.push(node.getStart(ast));
        }
        if (ts.isJsxOpeningElement(node) && node.attributes.properties.some(attribute => ts.isJsxAttribute(attribute) &&
            attribute.name.getText(ast) === "className" && attribute.initializer && ts.isStringLiteral(attribute.initializer) &&
            attribute.initializer.text.includes("employee-dashboard-stats"))) positions.stats.push(node.getStart(ast));
        ts.forEachChild(node, visit);
    }
    visit(ast);
    assert.equal(positions.controls.length, 1);
    assert.equal(positions.announcements.length, 1);
    assert.equal(positions.stats.length, 1);
    assert.ok(positions.controls[0] < positions.stats[0]);
    assert.ok(positions.controls[0] < positions.announcements[0]);
});

const attendanceSource = readFileSync(new URL("../src/pages/attendance/index.tsx", import.meta.url), "utf8");
const attendanceAst = ts.createSourceFile("Attendance.tsx", attendanceSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function attendanceInitializer(name) {
    let result;
    function visit(node) {
        if (ts.isVariableDeclaration(node) && node.name.getText(attendanceAst) === name) result = node.initializer.getText(attendanceAst);
        ts.forEachChild(node, visit);
    }
    visit(attendanceAst);
    assert.ok(result, name + " must remain testable");
    return result;
}
function attendanceControlScope(coachingActive, durationModel) {
    const calls = [];
    const scope = {
        coachingActive, attendanceDurationModelEnabled: durationModel, attendanceIntegrityEnabled: true,
        employeeId: "synthetic", isLoading: false, isEmployeeLoading: false, isSaving: false,
        sessionQuery: { isError: false }, currentStatus: "OFF THE PHONE", displayedShiftDay: {},
        confirmedSession: { reviewState: "verified", allowedActions: ["Time Out", "Coaching In", "Off the Phone In", "Off the Phone Out", "Break Out", "Lunch Break Out"] },
        coachingInSource: "Coaching In", canSetOnline: true, canSetOffline: true, canSetLunch: true, canSetBreak: true, canSetOffPhone: true,
        setMessage: () => {}, setShowOfflineConfirm: () => calls.push("offline-confirm"),
    };
    for (const name of ["timeInMutation", "timeOutMutation", "breakOutMutation", "breakInMutation", "lunchBreakOutMutation", "lunchBreakInMutation", "coachingMutation", "activityStatusMutation"])
        scope[name] = { mutate: () => calls.push(name) };
    runInNewContext(ts.transpileModule("statusDisabled = " + attendanceInitializer("statusDisabled") + "; handleStatusChange = " + attendanceInitializer("handleStatusChange"),
        { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, scope);
    return { scope, calls };
}

test("all attendance status buttons are disabled during Coaching in every business and both control layouts", () => {
    for (let business = 0; business < 6; business++) for (const durationModel of [false, true]) {
        const { scope } = attendanceControlScope(true, durationModel);
        for (const status of ["ONLINE", "OFFLINE", "BREAK", "LUNCH", "OFF THE PHONE"])
            assert.equal(scope.statusDisabled(status), true, "Coaching must disable " + status);
    }
    const { scope } = attendanceControlScope(false, true);
    assert.equal(scope.statusDisabled("ONLINE"), false, "ordinary Off the Phone can still end");
    assert.equal(scope.statusDisabled("OFFLINE"), false, "ordinary attendance can still check out");
});

test("stale generic attendance clicks cannot end Coaching or open Offline confirmation", () => {
    for (const durationModel of [false, true]) {
        const { scope, calls } = attendanceControlScope(true, durationModel);
        for (const status of ["ONLINE", "OFFLINE", "BREAK", "LUNCH", "OFF THE PHONE"]) scope.handleStatusChange(status);
        assert.deepEqual(calls, []);
    }
});

test("Coaching leaves the generic Online and Offline buttons disabled without a duplicate End off the phone action", () => {
    const { scope } = attendanceControlScope(true, true);
    scope.statusOrder = ["ONLINE", "OFFLINE", "LUNCH", "BREAK", "OFF THE PHONE"];
    scope.statusLabels = Object.fromEntries(scope.statusOrder.map(status => [status, status]));
    scope.statusIcon = Object.fromEntries(scope.statusOrder.map(status => [status, () => null]));
    scope.statusButtonStyles = {};
    scope.attendanceOnlineActionLabel = () => "End off the phone";
    scope.require = require;
    scope.exports = {};
    scope.buttons = [];
    runInNewContext(ts.transpileModule("buttons = " + attendanceInitializer("actionButtons"), {
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
    }).outputText, scope);
    const html = renderToStaticMarkup(React.createElement(React.Fragment, null, ...scope.buttons));
    assert.doesNotMatch(html, /End off the phone/);
    for (const status of ["ONLINE", "OFFLINE", "OFF THE PHONE"]) {
        const button = html.match(new RegExp('<button[^>]+data-attendance-action="' + status + '"[^>]*>'))[0];
        assert.match(button, /disabled=""/);
    }
});

test("an already-open Offline confirmation cannot check out active Coaching", () => {
    let confirm;
    function visit(node) {
        if (ts.isJsxElement(node) && node.children.some(child => ts.isJsxExpression(child) && child.expression?.getText(attendanceAst).includes('"Confirm Offline"'))) confirm = node;
        ts.forEachChild(node, visit);
    }
    visit(attendanceAst);
    assert.ok(confirm);
    const attributes = confirm.openingElement.attributes.properties;
    const disabled = attributes.find(attribute => attribute.name?.getText(attendanceAst) === "disabled");
    const click = attributes.find(attribute => attribute.name?.getText(attendanceAst) === "onClick");
    const { scope, calls } = attendanceControlScope(true, true);
    scope.timeOutMutation.isPending = false;
    runInNewContext("confirmDisabled = (" + disabled.initializer.expression.getText(attendanceAst) + "); confirmClick = (" + click.initializer.expression.getText(attendanceAst) + ");", scope);
    assert.equal(scope.confirmDisabled, true);
    scope.confirmClick();
    assert.deepEqual(calls, []);
});
