import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

const require = createRequire(import.meta.url);
const source = readFileSync(new URL("../src/pages/admin/data-check/index.tsx", import.meta.url), "utf8");
const config = { enabled: true, defaultDate: "2026-10-15", businesses: [{ id: "fake-a", name: "Synthetic A" }] };
const report = { date: "2026-10-15", business: "fake-a", businesses: config.businesses, generatedAt: "2026-10-16T01:00:00Z", cached: false, verdict: "WARN", counts: { match: 1, mismatch: 0, "cannot-verify": 1 }, boundaryProof: "Shared boundaries disclosed", checks: [
    { id: "one", section: "Attendance", label: "Synthetic matching figure", status: "match", dashboardValue: 1, recomputedValue: 1, difference: 0, explanation: "Independent pairing", proof: "independent", samples: [] },
    { id: "two", section: "Calls", label: "Historical heartbeat", status: "cannot-verify", dashboardValue: null, recomputedValue: null, difference: null, explanation: "No heartbeat history", proof: "same-code, weaker proof", samples: [] },
] };
function render({ checking = false, error = false, disabled = false, problems = false, employee = false } = {}) {
    const exports = {};
    const mocks = {
        react: { ...React, useState: initial => [initial === false ? problems : initial === null ? { date: "2026-10-15", business: "fake-a", revision: 1, scope: "fake-a" } : initial, () => {}] },
        "@tanstack/react-query": { useQuery: ({ queryKey }) => queryKey[0] === "data-check-config" ? { data: { ...config, enabled: !disabled }, isError: false } : { data: checking || error || disabled ? undefined : report, isFetching: checking, isError: error } },
        "react-router": { useSearchParams: () => [new URLSearchParams("date=2026-10-15&business=fake-a"), () => {}] },
        "../adminLayout": { __esModule: true, default: ({ children }) => children },
        "../../../api/dataCheck": {},
        "../../../api/businessStorage": { getActiveBusinessId: () => "fake-a" },
        "../../../api/authStorage": { getAuthUser: () => ({ userType: employee ? "employee" : "admin", user: { employeeCode: "fake-admin" } }) },
        "../../../../shared/dataCheck": {},
        "./dataCheck.css": {},
    };
    runInNewContext(ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText, {
        exports, URLSearchParams, require: name => mocks[name] || require(name),
    });
    return renderToStaticMarkup(React.createElement(exports.default));
}
test("Data Check renders all sections, honest verdict, accessible columns and expandable proof", () => {
    const html = render();
    for (const word of ["Attendance", "Calls", "Leads", "Consistency", "WARN", "Cannot verify", "same-code, weaker proof"]) assert.ok(html.includes(word));
    assert.match(html, /<details>/); assert.match(html, /scope="col"/);
    assert.match(html, /Copy report/); assert.match(html, /Download mismatches CSV/);
});
test("problems-only hides matching rows without hiding unverifiable evidence", () => {
    const html = render({ problems: true });
    assert.doesNotMatch(html, /Synthetic matching figure/); assert.match(html, /Historical heartbeat/);
});
test("loading and failure never display a fabricated successful report", () => {
    const loading = render({ checking: true }); assert.equal((loading.match(/aria-busy="true"/g) || []).length, 4); assert.doesNotMatch(loading, /Synthetic matching figure/);
    const failed = render({ error: true }); assert.match(failed, /role="alert"/); assert.match(failed, /No records were changed/); assert.doesNotMatch(failed, /Synthetic matching figure/);
    assert.match(render({ disabled: true }), /Data Check is disabled/);
    assert.match(render({ employee: true }), /full administrator session is required/);
});
test("request uses shared signed API with abort signal and a bounded deadline", () => {
    const api = readFileSync(new URL("../src/api/dataCheck.ts", import.meta.url), "utf8");
    assert.match(api, /signal/); assert.match(api, /timeout: 35_000/);
    const nav = readFileSync(new URL("../src/pages/admin/adminLayout/index.tsx", import.meta.url), "utf8");
    assert.match(nav, /dataCheckConfig\?\.enabled/);
    assert.match(nav, /dataCheckConfig\.navigationVisible/);
});
test("socket reconnect refreshes signed tokens as well as business identity", () => {
    const exports = {}; let actor = { userType: "employee", attendanceHubSession: "synthetic-one", user: { employeeCode: "fake-owner" } }; let business = "fake-a"; let disconnects = 0;
    const socket = { auth: {}, connected: false, connect() { this.connected = true; }, disconnect() { disconnects++; this.connected = false; } };
    const socketSource = readFileSync(new URL("../src/lib/socket.ts", import.meta.url), "utf8").replaceAll("import.meta.env", "({})");
    const modules = { "socket.io-client": { io: (_url, options) => { socket.auth = options.auth; return socket; } }, "../api/authStorage": { getAuthUser: () => actor }, "../api/businessStorage": { getActiveBusinessId: () => business }, "./backendUrl": { backendOrigin: "http://synthetic.invalid" } };
    runInNewContext(ts.transpileModule(socketSource, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, { exports, require: name => modules[name] });
    exports.connectAuthenticatedSocket(); assert.equal(socket.auth.attendanceSession, "synthetic-one");
    actor = { ...actor, attendanceHubSession: "synthetic-two" }; exports.connectAuthenticatedSocket(); assert.equal(disconnects, 1); assert.equal(socket.auth.attendanceSession, "synthetic-two");
    business = "fake-b"; exports.refreshSocketBusinessContext(); assert.equal(disconnects, 2); assert.equal(socket.auth.businessId, "fake-b");
});
