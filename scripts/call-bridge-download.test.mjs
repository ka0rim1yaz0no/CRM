import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";
import { CALLING_QUEUE_POLICY_VERSION } from "../shared/leadCallingPolicy.ts";

const source = readFileSync(new URL("../src/api/callBridge.ts", import.meta.url), "utf8")
    .replace(/^import .*;\r?$/gm, "").replaceAll("import.meta.env", "({})");
function fixture(origin = "https://synthetic.invalid") {
    let business = "test-b";
    const exports = {};
    runInNewContext(ts.transpileModule(source, { compilerOptions: {
        target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS,
    } }).outputText, { exports, CALLING_QUEUE_POLICY_VERSION, URL, backendOrigin: origin, getActiveBusinessId: () => business });
    return { url: exports.getCallBridgePackageUrl, switchTo: id => { business = id; } };
}

test("bridge download carries the current business and never captures the initial selection", () => {
    const state = fixture();
    for (const business of ["test-b", "test-c", "test-a", "test-b"]) {
        state.switchTo(business);
        const url = new URL(state.url());
        assert.equal(url.pathname, "/api/call-bridge/package");
        assert.deepEqual([...url.searchParams], [["businessId", business]]);
        assert.equal(url.origin, "https://synthetic.invalid");
    }
});

test("bridge link uses an explicit selected business, safely encodes it and supports localhost", () => {
    const state = fixture("http://localhost:4000");
    const url = new URL(state.url(" test-b&other=value "));
    assert.equal(url.origin, "http://localhost:4000");
    assert.deepEqual([...url.searchParams], [["businessId", "test-b&other=value"]]);
    assert.equal(new URL(state.url(" ")).search, "");
});

test("Settings updates the download link on same-tab and cross-tab business changes", () => {
    const settings = readFileSync(new URL("../src/pages/settings/index.tsx", import.meta.url), "utf8");
    assert.match(settings, /useSyncExternalStore\(subscribeCredentialContext, getActiveBusinessId\)/);
    assert.match(settings, /href=\{getCallBridgePackageUrl\(activeBusinessId\)\}/);
    assert.doesNotMatch(settings, /href=\{callBridgePackageUrl\}/);
    const listeners = new Map();
    const exports = {};
    runInNewContext(ts.transpileModule(readFileSync(new URL("../src/lib/credentialContext.ts", import.meta.url), "utf8"), {
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    }).outputText, { exports, window: {
        addEventListener: (name, listener) => listeners.set(name, listener),
        removeEventListener: name => listeners.delete(name),
    } });
    let updates = 0;
    const unsubscribe = exports.subscribeCredentialContext(() => { updates++; });
    listeners.get("crm:business-changed")();
    listeners.get("storage")({ key: "activeBusinessId" });
    listeners.get("storage")({ key: "unrelated" });
    assert.equal(updates, 2);
    unsubscribe();
    assert.equal(listeners.size, 0);
});
