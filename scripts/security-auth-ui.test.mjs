import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";

function fixture(fetch) {
    const timers = new Map();
    let nextTimer = 0;
    let removed = 0;
    const source = readFileSync(new URL("../src/api/authStorage.ts", import.meta.url), "utf8")
        .replace(/^import .*;\r?$/gm, "")
        .replaceAll("import.meta.env", "({})");
    const exports = {};
    const sandbox = {
        exports, AbortController, Event, backendOrigin: "http://synthetic.invalid",
        localStorage: { removeItem: () => { removed++; } },
        window: { fetch, dispatchEvent() {} },
        setTimeout: callback => { timers.set(++nextTimer, callback); return nextTimer; },
        clearTimeout: id => timers.delete(id),
    };
    runInNewContext(ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText, sandbox);
    return { auth: exports, timers, removed: () => removed };
}

test("logout cannot indefinitely block the next login when the file-session request stalls", async () => {
    let signal;
    let requests = 0;
    const state = fixture((_url, options) => { requests++; signal = options.signal; return new Promise(() => {}); });
    state.auth.clearAuthUser();
    state.auth.clearAuthUser();
    await Promise.resolve();
    assert.equal(state.removed(), 2, "local logout is immediate");
    assert.equal(requests, 1, "duplicate logout calls share one pending request");
    assert.equal(state.timers.size, 1, "a bounded network deadline is required");
    for (const callback of state.timers.values()) callback();
    await state.auth.waitForFileLogout();
    assert.equal(signal.aborted, true);
    assert.equal(state.timers.size, 0);
});

for (const failure of [false, true]) test(`logout clears its deadline after ${failure ? "network failure" : "success"}`, async () => {
    const state = fixture(async () => { if (failure) throw new Error("synthetic network failure"); return {}; });
    state.auth.clearAuthUser();
    await state.auth.waitForFileLogout();
    assert.equal(state.timers.size, 0);
    assert.equal(state.removed(), 1);
});
