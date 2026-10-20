import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import {
    CredentialRequestError,
    createCredentialRequests,
    createCredentialRevealState,
    credentialMetadata,
    credentialWriteInput,
} from "../src/lib/credentialVault.ts";
import { getCredentialContextRevision, subscribeCredentialContext } from "../src/lib/credentialContext.ts";

const fakePassword = "synthetic-password-only";
const wire = { _id: "fake-id", accountName: "Synthetic account", username: "fake-user", platform: "Fake tool",
    company: "Synthetic business", team: "Synthetic team", status: "Active", hasPassword: true };
const credential = credentialMetadata(wire);
const input = { accountName: wire.accountName, username: wire.username, platform: wire.platform,
    company: wire.company, team: wire.team, password: fakePassword };
function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}
function transport(data, status = 200) {
    const calls = [];
    return { calls, client: createCredentialRequests({ request: async (request) => {
        calls.push(request);
        return { data, status };
    } }) };
}

test("metadata whitelists both vault and legacy responses without retaining secret fields", () => {
    const vault = credentialMetadata({ ...wire, password: fakePassword, passwordCiphertext: "synthetic-ciphertext", extra: { password: fakePassword } });
    assert.equal(vault.hasPassword, true);
    assert.equal(vault.passwordMode, "vault");
    assert.equal("password" in vault, false);
    assert.equal("passwordCiphertext" in vault, false);
    assert.equal("extra" in vault, false);
    const { hasPassword: ignored, ...legacyWire } = wire;
    assert.equal(ignored, true);
    const legacy = credentialMetadata({ ...legacyWire, password: fakePassword });
    assert.equal(legacy.passwordMode, "legacy");
    assert.equal(legacy.hasPassword, true);
    assert.equal(JSON.stringify(legacy).includes(fakePassword), false);
    assert.equal(credentialMetadata({ ...wire, hasPassword: false, password: fakePassword }).hasPassword, false);
});

test("list metadata does not trigger reveal and supplies cancellation/no-store headers", async () => {
    const { calls, client } = transport([{ ...wire, password: fakePassword }]);
    const controller = new AbortController();
    const rows = await client.getCredentials(controller.signal);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, "get");
    assert.equal(calls[0].url, "/credentials");
    assert.equal(calls[0].signal, controller.signal);
    assert.deepEqual(calls[0].headers, { "Cache-Control": "no-store", Pragma: "no-cache" });
    assert.equal(JSON.stringify(rows).includes(fakePassword), false);
});

test("create, update and archive results never retain an old server's password", async () => {
    const { client } = transport({ ...wire, password: fakePassword });
    for (const result of [await client.createCredential(input), await client.updateCredential(wire._id, input), await client.archiveCredential(wire._id)]) {
        assert.equal("password" in result, false);
    }
});

test("blank edit password is omitted, replacement stays exact, create requires a password", async () => {
    const { calls, client } = transport(wire);
    await client.updateCredential(wire._id, { ...input, password: "" });
    assert.equal("password" in calls[0].data, false);
    assert.equal("password" in credentialWriteInput({ ...input, password: "  " }, true), false);
    await client.updateCredential(wire._id, { ...input, password: " replacement with spaces " });
    assert.equal(calls[1].data.password, " replacement with spaces ");
    await assert.rejects(client.createCredential({ ...input, password: "  " }), CredentialRequestError);
    assert.equal(calls.length, 2);
});

test("vault reveal is an explicit POST with no-store, never a GET or fallback", async () => {
    const { calls, client } = transport({ password: fakePassword });
    const controller = new AbortController();
    assert.equal(await client.revealCredential({ ...credential, _id: "fake/id" }, controller.signal), fakePassword);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, "post");
    assert.equal(calls[0].url, "/credentials/fake%2Fid/reveal");
    assert.equal(calls[0].data, undefined);
    assert.equal(calls[0].signal, controller.signal);
    assert.equal(calls[0].headers["Cache-Control"], "no-store");
});

test("legacy plaintext is re-fetched only on explicit Show and only the selected password is returned", async () => {
    const { calls, client } = transport([{ ...wire, password: fakePassword }, { ...wire, _id: "other", password: "synthetic-other" }]);
    const rows = await client.getCredentials();
    assert.equal("password" in rows[0], false);
    assert.equal(calls.length, 1);
    assert.equal(await client.revealCredential({ ...credential, passwordMode: "legacy" }), fakePassword);
    assert.equal(calls.length, 2);
    assert.equal(calls[1].method, "get");
    assert.equal(calls[1].url, "/credentials");
});

for (const [status, message] of [[401, /session has expired/], [403, /full-access administrator/], [404, /no longer available/], [409, /already exist/], [500, /Unable to complete/]]) {
    test(`credential HTTP ${status} is safe, visible and cannot echo response secrets`, async () => {
        const { calls, client } = transport({ message: fakePassword, password: fakePassword }, status);
        await assert.rejects(client.revealCredential(credential), (error) => {
            assert.match(error.message, message);
            assert.equal(error.message.includes(fakePassword), false);
            assert.equal("config" in error, false);
            assert.equal("response" in error, false);
            return true;
        });
        assert.equal(calls.length, 1);
        assert.equal(calls[0].validateStatus(status), true);
    });
}

test("network failures discard raw Axios request/response objects", async () => {
    const client = createCredentialRequests({ request: async () => { throw { message: fakePassword, config: { data: input } }; } });
    await assert.rejects(client.createCredential(input), (error) => {
        assert.equal(error instanceof CredentialRequestError, true);
        assert.equal(error.message.includes(fakePassword), false);
        assert.equal("config" in error, false);
        return true;
    });
});

test("Copy never fetches and stays blocked until explicit Show completes", async () => {
    const pending = deferred();
    let fetches = 0;
    const copied = [];
    const state = createCredentialRevealState(async () => { fetches += 1; return pending.promise; });
    assert.equal(await state.copy(async (value) => { copied.push(value); }), false);
    assert.equal(fetches, 0);
    const showing = state.show(credential);
    assert.equal(state.getSnapshot().loading, true);
    assert.equal(await state.copy(async (value) => { copied.push(value); }), false);
    pending.resolve(fakePassword);
    await showing;
    assert.equal(await state.copy(async (value) => { copied.push(value); }), true);
    assert.equal(fetches, 1);
    assert.deepEqual(copied, [fakePassword]);
    state.clear();
    assert.equal(state.getSnapshot().password, null);
    assert.equal(await state.copy(async (value) => { copied.push(value); }), false);
});

for (const reason of ["Hide", "selection/filter change", "unmount"]) {
    test(`${reason} aborts pending reveal and a transport ignoring abort cannot resurrect it`, async () => {
        const pending = deferred();
        let signal;
        const state = createCredentialRevealState(async (_credential, currentSignal) => { signal = currentSignal; return pending.promise; });
        const showing = state.show(credential);
        state.clear();
        assert.equal(signal.aborted, true);
        pending.resolve(fakePassword);
        await showing;
        assert.deepEqual(state.getSnapshot(), { id: null, password: null, loading: false, error: null });
    });
}

test("selecting another credential replaces secrets and ignores both old success and failure", async () => {
    for (const fails of [false, true]) {
        const old = deferred();
        const state = createCredentialRevealState(async (selected) => selected._id === credential._id ? old.promise : "synthetic-second");
        const first = state.show(credential);
        await state.show({ ...credential, _id: "second" });
        if (fails) old.reject(new CredentialRequestError(403));
        else old.resolve(fakePassword);
        await first;
        assert.equal(state.getSnapshot().password, "synthetic-second");
        assert.equal(state.getSnapshot().id, "second");
        assert.equal(state.getSnapshot().error, null);
        state.clear();
    }
});

for (const reason of ["business", "auth"]) {
    test(`${reason} changes block late responses and clipboard access even before React unmount`, async () => {
        const pending = deferred();
        let current = true;
        const state = createCredentialRevealState(async () => pending.promise, () => current);
        const showing = state.show(credential);
        current = false;
        pending.resolve(fakePassword);
        await showing;
        assert.equal(state.getSnapshot().password, null);
        assert.equal(await state.copy(async () => assert.fail("Clipboard must not be called")), false);
        state.clear();
    });
}

test("permission failures are shown safely, and missing passwords never fetch", async () => {
    let calls = 0;
    const state = createCredentialRevealState(async () => { calls += 1; throw new CredentialRequestError(403); });
    await state.show({ ...credential, hasPassword: false });
    assert.equal(calls, 0);
    await state.show(credential);
    assert.equal(calls, 1);
    assert.match(state.getSnapshot().error, /full-access administrator/);
    assert.equal(state.getSnapshot().password, null);
    assert.equal(state.getSnapshot().loading, false);
});

test("clipboard failure reports an error without echoing clipboard or secret details", async () => {
    const state = createCredentialRevealState(async () => fakePassword);
    await state.show(credential);
    assert.equal(await state.copy(async () => { throw new Error(fakePassword); }), false);
    assert.equal(state.getSnapshot().error, "Unable to copy password.");
    state.clear();
});

test("auth/business events and cross-tab storage reset scope; subscriptions clean up", () => {
    const previousWindow = globalThis.window;
    const fakeWindow = new EventTarget();
    globalThis.window = fakeWindow;
    try {
        const before = getCredentialContextRevision();
        let changes = 0;
        const unsubscribe = subscribeCredentialContext(() => { changes += 1; });
        fakeWindow.dispatchEvent(new Event("crm:auth-changed"));
        fakeWindow.dispatchEvent(new Event("crm:business-changed"));
        for (const key of ["authUser", "activeBusinessId", null, "unrelated"]) {
            const event = new Event("storage");
            Object.defineProperty(event, "key", { value: key });
            fakeWindow.dispatchEvent(event);
        }
        assert.equal(changes, 5);
        assert.equal(getCredentialContextRevision(), before + 5);
        unsubscribe();
        fakeWindow.dispatchEvent(new Event("crm:auth-changed"));
        assert.equal(changes, 5);
    } finally {
        if (previousWindow === undefined) delete globalThis.window;
        else globalThis.window = previousWindow;
    }
});

test("actual central API interceptor attaches signed admin and business headers without logging", () => {
    // Execute only this small module with synthetic dependencies; no browser storage/network/env is read.
    const source = readFileSync(new URL("../src/lib/api.ts", import.meta.url), "utf8")
        .replace(/^import .*;\r?$/gm, "")
        .replace("export const api =", "const api =")
        .replace("import.meta.env.VITE_API_URL", "undefined");
    const callbacks = {};
    const fakeApi = { interceptors: {
        request: { use: (callback) => { callbacks.request = callback; } },
        response: { use: (_success, failure) => { callbacks.failure = failure; } },
    } };
    const fakeAuth = { userType: "admin", sessionToken: "synthetic-session-token", access: "full",
        user: { employeeCode: "synthetic-admin", name: "Synthetic admin" } };
    const sandbox = {
        axios: { create: () => fakeApi }, backendOrigin: "https://synthetic.invalid",
        emitToast: () => assert.fail("No toast expected"),
        getActiveBusinessId: () => "synthetic-business", getAuthUser: () => fakeAuth,
        console: new Proxy({}, { get: () => () => assert.fail("API must not log secrets") }),
    };
    runInNewContext(ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText, sandbox);
    const request = callbacks.request({ headers: {}, url: "/credentials/fake/reveal", method: "post" });
    assert.equal(request.headers["X-CRM-Admin-Session"], fakeAuth.sessionToken);
    assert.equal(request.headers["X-Business-Id"], "synthetic-business");
    assert.equal(request.headers["X-CRM-User-Type"], "admin");
    const override = callbacks.request({ headers: { "X-CRM-Admin-Session": "synthetic-override" } });
    assert.equal(override.headers["X-CRM-Admin-Session"], "synthetic-override");
    fakeAuth.userType = "employee";
    assert.equal(callbacks.request({ headers: {} }).headers["X-CRM-Admin-Session"], undefined);
    fakeAuth.attendanceHubSession = "synthetic-owner-session";
    assert.equal(callbacks.request({ headers: {} }).headers["X-CRM-Attendance-Session"], "synthetic-owner-session");
});

test("page wiring has no secret query/mutation cache, edit prefill, password sort or automatic reveal", () => {
    const page = readFileSync(new URL("../src/pages/admin/credentials/index.tsx", import.meta.url), "utf8");
    assert.doesNotMatch(page, /useMutation|credential\.password|field="password"|console\./);
    assert.match(page, /password: ""/);
    assert.match(page, /Leave blank to keep existing password/);
    assert.match(page, /disabled=\{!isPasswordVisible\}/);
    assert.match(page, /onChangeCapture=\{\(\) => reveal\.clear\(\)\}/);
    assert.match(page, /reveal\.clear\(\);\s*\};\s*\}, \[reveal\]\)/);
    assert.match(page, /key=\{contextRevision\}/);
    assert.match(page, /gcTime: 0/);
    const api = readFileSync(new URL("../src/api/credentials.ts", import.meta.url), "utf8");
    assert.match(api, /createCredentialRequests\(api\)/);
    assert.doesNotMatch(api, /console\.|localStorage|sessionStorage|VITE_/);
});
