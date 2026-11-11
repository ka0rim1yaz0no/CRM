import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import { allowanceClock, attendanceAwayDisabledReason, coachingRemainingMs, offPhoneRemainingMs } from "../src/lib/attendanceAllowances.ts";

const require = createRequire(import.meta.url), root = path.resolve(import.meta.dirname, "..");
const workspacePath = path.join(root, "src/components/WorkspaceDashboard.tsx"), workspace = readFileSync(workspacePath, "utf8");
const at = "2026-10-30T17:00:00.000Z", now = Date.parse(at);
const employee = { _id: "synthetic", employeeCode: "synthetic", name: "Synthetic Employee", role: "Sales", team: "Test only", availabilityStatus: "ONLINE", aliases: [] };
const tasks = [
    { _id: "due", title: "Call back the appointment lead", dueAt: "2020-01-01T00:00:00Z", priority: "High", status: "Todo", relatedLead: { businessName: "Synthetic Clinic" } },
    { _id: "next", title: "Prepare follow-up notes", dueAt: "2099-01-01T00:00:00Z", priority: "Medium", status: "In Progress" },
    { _id: "done", title: "Completed task", dueAt: "2020-01-01T00:00:00Z", priority: "Low", status: "Done" },
];
function snapshot(extra = {}) {
    return { revision: 1, fingerprint: "synthetic", state: "ONLINE", reviewState: "verified", serverTime: at, receivedAt: Date.now(), coachingEnabled: true,
        assignedShift: { dayKey: "2026-10-30", start: "2026-10-30T15:00:00Z", end: "2026-10-31T00:00:00Z", resetDeadline: "2026-10-31T14:59:00Z" },
        coachingBilling: { limited: true, remainingPaidMs: 1200000, paidUsedMs: 0, totalMs: 0, active: null, endsAt: "2026-10-31T00:00:00Z" },
        offPhoneBilling: { limited: true, remainingPaidMs: 900000, active: null },
        allowedActions: ["Coaching Out", "Off the Phone Out"], records: [], sessions: [], dashboardDays: [], sessionId: null,
        review: [], audit: [], syncPending: false, lifecycle: "none", ...extra };
}
let scenario = {}, business = "synthetic-0", mutations = [];
const apiMocks = {
    getAuthUser: () => ({ userType: "employee", user: employee, attendanceHubSession: "synthetic-only" }),
    getActiveBusinessId: () => business,
    attendanceIntegrityEnabled: true,
    normalizeEmployeeAvailabilityStatus: value => value || "OFFLINE",
    sessionEventRecord: event => ({ _id: event.id, source: event.source, timeIn: event.at }),
    performAttendanceAction: () => assert.fail("SSR cannot mutate attendance"),
};
const calls = [{ employeeId: employee._id, employeeName: employee.name, totalCalls: 7, totalNotConnectedCalls: 3, totalVoicemails: 2,
    totalAttempts: 12, lastCallAt: at, leads: [{ leadId: "lead-1", callLogs: [], totalCalls: 7 }, { leadId: "lead-2", callLogs: [], totalCalls: 0 }] }];
function query(options) {
    const key = options.queryKey[0];
    const data = key === "employee" ? employee : key === "employee-dashboard-tasks" ? tasks
        : key === "employee-dashboard-lead-counts" ? { ALL: 25, ContactedToday: 9, "Follow up": 6 }
            : key === "employee-dashboard-lead-queue" ? { leads: [{ _id: "lead-1", businessName: "Synthetic Clinic", status: "Follow up", source: "Synthetic", followUpAt: at }] }
                : key === "employee-notices" ? [{ _id: "notice-1", isRead: false, title: "Shift message", message: "Synthetic message", severity: "Info", createdAt: at }]
                    : key === "employee-dashboard-announcements" ? [{ _id: "announcement", status: "Active", title: "Shift update", description: "Synthetic update" }]
                        : key === "attendance-session" ? scenario.snapshot || snapshot()
                            : key === "employee-agent-lead-dashboard" ? { agents: [], monthlyAgents: [], monthOptions: [] }
                                : key === "lead-call-summary" ? scenario.calls ?? calls : [];
    const fail = scenario.errorKey === key;
    return { data: scenario.loadingKey === key || fail && scenario.noCache ? undefined : data, isError: fail,
        isLoading: scenario.loadingKey === key, isFetching: scenario.loadingKey === key || scenario.fetchingKey === key,
        dataUpdatedAt: now, refetch: () => mutations.push(["read", key]) };
}
const modules = new Map();
function load(file) {
    if (modules.has(file)) return modules.get(file).exports;
    const module = { exports: {} }; modules.set(file, module);
    const source = readFileSync(file, "utf8").replaceAll("import.meta.env", "({ DEV: false })");
    const output = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
    runInNewContext(output, { exports: module.exports, module, Date, Intl, URLSearchParams, setInterval, clearInterval,
        require: name => {
            if (name.endsWith(".css")) return {};
            if (name === "react") return { ...React, useState: initial => {
                let value = typeof initial === "function" ? initial() : initial;
                if (value && typeof value === "object" && "scope" in value && "view" in value) value = { scope: scenario.scope || value.scope, view: scenario.view || value.view };
                return React.useState(value);
            } };
            if (name === "react-router") return { Link: ({ to, children, ...props }) => React.createElement("a", { href: to, ...props }, children), useNavigate: () => () => assert.fail("SSR cannot navigate") };
            if (name === "@tanstack/react-query") return { useQuery: query, useQueryClient: () => ({ invalidateQueries: input => mutations.push(["invalidate", input.queryKey]) }),
                useMutation: () => ({ isPending: Boolean(scenario.saving), isError: false, mutate: () => assert.fail("SSR cannot save") }) };
            if (!name.startsWith(".")) return require(name);
            const resolved = path.resolve(path.dirname(file), name);
            if (resolved.startsWith(path.join(root, "src/api") + path.sep)) return apiMocks;
            if (resolved === path.join(root, "src/lib/api")) return { API_BASE_URL: "http://synthetic.invalid", api: new Proxy({}, { get: () => () => assert.fail("SSR cannot request HTTP") }) };
            const local = [resolved, resolved + ".ts", resolved + ".tsx"].find(existsSync);
            assert.ok(local, "local module exists: " + name);
            return load(local);
        } });
    return module.exports;
}
const Dashboard = load(workspacePath).default;
function render(options = {}) { scenario = options; mutations = []; return renderToStaticMarkup(React.createElement(Dashboard, { userName: employee.name, employee })); }
const panelOpening = (html, view) => html.match(new RegExp('<div(?=[^>]*id="employee-dashboard-view-' + view + '")[^>]*>'))?.[0];

test("six employee workspaces retain exact counts, distinct notices and a work-first overview", () => {
    for (let index = 0; index < 6; index++) {
        business = `synthetic-${index}`;
        const html = render();
        assert.match(html, /employee-dashboard-v2 dv2-page/);
        assert.match(html, /Assigned Leads<\/p><p[^>]*>25<\/p>/);
        assert.match(html, /Contacted Today<\/p><p[^>]*>9<\/p>/);
        assert.match(html, /Open Tasks<\/p><p[^>]*>2<\/p>/);
        assert.match(html, /Due Tasks<\/p><p[^>]*>1<\/p>/);
        assert.match(html, /Notices <span>1<\/span>/);
        assert.doesNotMatch(html, /Due \/ Unread/);
        assert.doesNotMatch(panelOpening(html, "overview"), /hidden/);
        assert.ok(html.indexOf('aria-label="Next leads to work"') < html.indexOf("Latest updates from admin"));
        assert.deepEqual(mutations, []);
        assert.doesNotMatch(html, /href="(?:\/admin|tel:)/);
    }
});
test("tabs have complete accessible bindings and keep every panel mounted", () => {
    for (const view of ["overview", "calls", "performance", "attendance"]) {
        const html = render({ view });
        for (const other of ["overview", "calls", "performance", "attendance"]) {
            assert.match(html, new RegExp('id="employee-dashboard-tab-' + other + '"[^>]*aria-selected="' + (view === other) + '"[^>]*aria-controls="employee-dashboard-view-' + other + '"'));
            assert.equal(panelOpening(html, other)?.includes('hidden=""'), other !== view);
        }
    }
    assert.doesNotMatch(panelOpening(render({ view: "calls", scope: "another-business:another-employee" }), "overview"), /hidden/);
});

test("admin-style metric shortcuts and work-item links remain in the employee workspace", () => {
    for (let index = 0; index < 6; index++) {
        business = `synthetic-${index}`;
        const html = render();
        assert.equal((html.match(/<a(?=[^>]*class="employee-stat-link")(?=[^>]*href="\/leads")[^>]*>/g) || []).length, 2);
        assert.equal((html.match(/<a(?=[^>]*class="employee-stat-link")(?=[^>]*href="\/tasks")[^>]*>/g) || []).length, 2);
        assert.match(html, /href="\/leads\?lead=lead-1"/);
        assert.match(html, /href="\/tasks\/due"/);
        assert.match(html, /href="\/tasks\/next"/);
        assert.doesNotMatch(html, /href="(?:\/admin|tel:)/);
        assert.deepEqual(mutations, []);
    }
});

test("metric placeholders do not invent zero counts before a successful read", () => {
    for (const key of ["employee-dashboard-lead-counts", "employee-dashboard-tasks"]) {
        for (const options of [{ loadingKey: key }, { errorKey: key, noCache: true }]) {
            const html = render(options);
            for (const label of key.endsWith("tasks") ? ["Open Tasks", "Due Tasks"] : ["Assigned Leads", "Contacted Today"]) {
                assert.match(html, new RegExp(label + '<\\/p><p[^>]*>--<\\/p>'));
            }
        }
    }
    assert.match(render({ loadingKey: "employee-notices" }), /Notices <span>--<\/span>/);
});

test("allowance indicators use confirmed remaining time and omit unconfirmed values", () => {
    const html = render();
    assert.match(html, /<progress[^>]*aria-label="Off the Phone allowance remaining"[^>]*max="1200000"[^>]*value="900000"/);
    assert.match(html, /<progress[^>]*aria-label="Coaching allowance remaining"[^>]*max="1200000"[^>]*value="1200000"/);
    const missing = render({ snapshot: snapshot({ offPhoneBilling: null, coachingBilling: null }) });
    assert.doesNotMatch(missing, /<progress/);
    assert.match(missing, />--:--<\/output>/);
    const used = render({ snapshot: snapshot({ coachingBilling: { ...snapshot().coachingBilling, remainingPaidMs: 0 } }) });
    assert.match(used, /<progress[^>]*aria-label="Coaching allowance remaining"[^>]*value="0"/);
    assert.match(used.match(/<button[^>]*data-attendance-action="COACHING"[^>]*>/)?.[0] || "", /disabled=""/);
    assert.deepEqual(mutations, []);
});
test("call summaries reconcile and cached rows remain visible during background refresh", () => {
    const html = render({ view: "calls", fetchingKey: "lead-call-summary" });
    assert.match(html, /Connected<\/dt><dd>7<\/dd>/);
    assert.match(html, /Not connected<\/dt><dd>3<\/dd>/);
    assert.match(html, /Voicemails<\/dt><dd>2<\/dd>/);
    assert.match(html, /Leads<\/dt><dd>2<\/dd>/);
    assert.match(html, /12 total attempts/);
    assert.match(html, /View logged calls/);
    assert.doesNotMatch(html, /Getting your logged calls/);
    assert.match(html, /Call counts from date/); assert.match(html, /Call counts to time/);
});
test("loading and failed reads do not invent confirmed zero totals or expose attendance actions", () => {
    for (const options of [{ loadingKey: "lead-call-summary" }, { errorKey: "lead-call-summary", noCache: true }]) {
        const html = render({ view: "calls", ...options });
        assert.match(html, /Connected<\/dt><dd>--<\/dd>/);
    }
    const attendanceError = render({ errorKey: "attendance-session", view: "attendance" });
    assert.match(attendanceError, /Attendance could not be confirmed/);
    assert.doesNotMatch(attendanceError, /aria-label="Shift allowances"/);
});
test("Coaching is named in the employee header and only its return remains available", () => {
    const active = snapshot({ state: "OFF THE PHONE", allowedActions: ["Coaching In"],
        coachingBilling: { ...snapshot().coachingBilling, remainingPaidMs: 600000, active: { startedAt: at, returnAt: new Date(now + 600000).toISOString() } } });
    const html = render({ snapshot: active });
    assert.match(html, /data-coaching="true"/); assert.match(html, />Coaching<\/span>/);
    assert.match(html.match(/<button[^>]*data-attendance-action="OFF THE PHONE"[^>]*>/)?.[0] || "", /disabled=""/);
    assert.doesNotMatch(html.match(/<button[^>]*data-attendance-action="COACHING"[^>]*>/)?.[0] || "", /disabled=""/);
    assert.match(html, />Coaching Out<\/button>/);
});

test("attendance presents canonical shift hours and punches without hard-coded 11PM-8AM captions", () => {
    const day = { dayKey: "2026-10-30", shiftStart: "2026-10-30T12:00:00Z", shiftEnd: "2026-10-30T21:00:00Z",
        eventIds: ["time-in"], timeIn: "2026-10-30T12:03:00Z", timeOut: null, milliseconds: { overBreak: 0, overLunch: 0 },
        breakMinutes: 15, lunchMinutes: 60, overBreakRows: [] };
    const html = render({ view: "attendance", snapshot: snapshot({ dashboardDays: [day],
        records: [{ id: "time-in", source: "Time In", at: day.timeIn }],
        assignedShift: { ...snapshot().assignedShift, start: day.shiftStart, end: day.shiftEnd } }) });
    assert.match(html, /Oct 30, 2026, 8:00 PM to Oct 31, 2026, 5:00 AM/);
    assert.match(html, /8:03:00 PM/);
    assert.doesNotMatch(html, /11PM|11:00 PM to 8:00 AM|One row equals/);
    assert.deepEqual(mutations, []);
});
test("disabled reasons explain pre-shift, exhausted, review, saving and active-mode states", () => {
    const before = snapshot({ assignedShift: { ...snapshot().assignedShift, start: "2026-10-30T18:00:00Z" } });
    assert.equal(attendanceAwayDisabledReason(before, "coaching", now), "Available at 2:00 AM PH");
    assert.equal(attendanceAwayDisabledReason(snapshot({ coachingBilling: { ...snapshot().coachingBilling, remainingPaidMs: 0 } }), "coaching", now), "20-minute allowance used");
    assert.equal(attendanceAwayDisabledReason(snapshot({ reviewState: "needs-correction" }), "coaching", now), "Attendance needs review");
    assert.equal(attendanceAwayDisabledReason(snapshot(), "coaching", now, true), "Saving attendance");
    assert.equal(attendanceAwayDisabledReason(snapshot({ state: "OFFLINE" }), "coaching", now), "Time In required");
    assert.equal(attendanceAwayDisabledReason(snapshot({ state: "BREAK" }), "coaching", now), "Return from break first");
});
test("unconfirmed or malformed countdowns stay unavailable instead of displaying NaN or an invented zero", () => {
    const billing = snapshot().coachingBilling;
    assert.equal(coachingRemainingMs({ ...billing, endsAt: "invalid" }, now), null);
    assert.equal(coachingRemainingMs({ ...billing, remainingPaidMs: NaN }, now), null);
    assert.equal(coachingRemainingMs({ ...billing, active: { startedAt: at, returnAt: "invalid" } }, now), null);
    assert.equal(offPhoneRemainingMs({ limited: true, remainingPaidMs: NaN }, now), null);
    assert.equal(offPhoneRemainingMs({ limited: true, active: { nonBillableFrom: "invalid" } }, now), null);
    assert.equal(allowanceClock(NaN), "--:--"); assert.equal(allowanceClock(Infinity), "--:--");
});

const ast = ts.createSourceFile("WorkspaceDashboard.tsx", workspace, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
test("tab keyboard navigation uses the same arrow, Home and End behavior as admin", () => {
    let handler;
    function visit(node) {
        if (ts.isJsxAttribute(node) && node.name.getText(ast) === "onKeyDown" && node.getText(ast).includes("setDashboardSelection")) handler = node.initializer.expression.getText(ast);
        ts.forEachChild(node, visit);
    }
    visit(ast); assert.ok(handler);
    const views = ["overview", "calls", "performance", "attendance"];
    for (const [view, key, expected] of [["overview", "ArrowLeft", "attendance"], ["attendance", "ArrowRight", "overview"], ["calls", "Home", "overview"], ["calls", "End", "attendance"]]) {
        const changes = [], focused = [];
        const callback = runInNewContext("(" + handler + ")", { view, employeeDashboardViews: views, dashboardScope: "scope", setDashboardSelection: value => changes.push(value), document: { getElementById: id => ({ focus: () => focused.push(id) }) } });
        let prevented = false; callback({ key, preventDefault: () => { prevented = true; } });
        assert.equal(changes[0].view, expected); assert.equal(changes[0].scope, "scope");
        assert.equal(focused[0], `employee-dashboard-tab-${expected}`); assert.equal(prevented, true);
    }
});
