import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";

const require = createRequire(import.meta.url), exported = {};
let data;
const source = readFileSync(new URL("../src/components/CallDashboardPanel.tsx", import.meta.url), "utf8")
    .replaceAll("import.meta.env", "({VITE_CRM_CALL_DASHBOARD_V2:'true',DEV:false})");
runInNewContext(ts.transpileModule(source, { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX,
} }).outputText, { exports: exported, performance: { now: () => 1000 }, Date, require: name => {
    if (name === "@tanstack/react-query") return { useQuery: () => ({ data, isLoading: false, isError: false }), useQueryClient: () => ({}) };
    if (name === "../api/callDashboard") return { getCallDashboard: () => assert.fail("Rendering must not call production") };
    if (name === "../lib/socket") return { socket: { connect: () => assert.fail("SSR must not connect") } };
    if (name === "../lib/dateTime") return { formatPhDate: () => "PH shift", formatPhTime: () => "04:00 AM" };
    return require(name);
} });

function render(coaching, business, stale = false) {
    const now = Date.UTC(2026, 9, 30, 18), generatedAt = new Date(now - (stale ? 60_000 : 0)).toISOString();
    data = { business: { id: "synthetic-" + business, name: "Synthetic business" }, generatedAt,
        serverTime: new Date(now).toISOString(), receivedAt: 1000,
        shift: { start: new Date(now - 3_600_000).toISOString(), end: new Date(now + 3_600_000).toISOString() }, employees: [{
            employeeId: "synthetic", name: "Synthetic Employee", role: "Sales", team: "Test only", businessName: "Synthetic business",
            status: coaching ? "OFF THE PHONE" : "ONLINE", coachingActive: coaching, statusStartedAt: new Date(now - 300_000).toISOString(),
            offPhoneCompletedMs: 0, offPhoneActiveStartedAt: null, offPhoneNonBillable: false, offPhoneNonBillableFrom: null,
        }] };
    return renderToStaticMarkup(React.createElement(exported.default, { businessId: data.business.id }));
}

test("refreshed desktop and mobile Call Dashboard show Coaching and its timer in six businesses without non-billable charges", () => {
    for (let business = 0; business < 6; business++) {
        const html = render(true, business);
        assert.equal((html.match(/>COACHING<\/span>/g) || []).length, 2);
        assert.match(html, />00:05:00<\/(?:td|dd)>/);
        assert.doesNotMatch(html, /NON-BILLABLE OFF PHONE/);
        const returned = render(false, business);
        assert.doesNotMatch(returned, />COACHING<\/span>/);
        assert.equal((returned.match(/>ONLINE<\/span>/g) || []).length, 2);
    }
});

test("stale Call Dashboard snapshots cannot keep presenting Coaching as confirmed", () => {
    const html = render(true, 0, true);
    assert.doesNotMatch(html, />COACHING<\/span>/);
    assert.match(html, />UNVERIFIED<\/span>/);
});
