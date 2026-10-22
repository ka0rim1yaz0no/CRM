import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";

function load(file, sandbox) {
    const source = readFileSync(new URL(`../${file}`, import.meta.url), "utf8")
        .replace(/^import .*;\r?$/gm, "").replaceAll("import.meta.env", "({})");
    const exports = {};
    runInNewContext(ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText, { exports, ...sandbox });
    return exports;
}
const admin = token => ({ userType: "admin", user: { employeeCode: "fake-admin" }, sessionToken: token });
const employee = token => ({ userType: "employee", user: { employeeCode: "fake-employee" }, attendanceHubSession: token });
const failure = (token, options = {}) => ({ response: { status: 401, data: { code: "CRM_SESSION_REQUIRED" } },
    config: { url: "/system-settings", headers: { "X-CRM-Admin-Session": token } }, ...options });

function apiFixture() {
    let auth = admin("fake-old-session");
    let cleared = 0;
    let reject;
    let applyRequest;
    const notices = [];
    const guards = load("src/lib/sessionAuthorization.ts", {});
    const toastErrors = load("src/lib/requestErrorToast.ts", { emitToast: notice => notices.push(notice) });
    load("src/lib/api.ts", { axios: { create: () => ({ interceptors: { request: { use(apply) { applyRequest = apply; } }, response: { use(_resolve, fail) { reject = fail; } } } }) },
        backendOrigin: "http://synthetic.invalid", getActiveBusinessId: () => "fake-a", getAuthUser: () => auth,
        clearAuthUser: () => { cleared++; auth = null; }, ...toastErrors, ...guards });
    return { reject: error => reject(error).catch(value => value), applyRequest: config => applyRequest(config), cleared: () => cleared, notices, setAuth: value => { auth = value; } };
}

test("captured assignment credentials cannot be upgraded to a newer browser account by the interceptor", () => {
    const state = apiFixture();
    state.setAuth(admin("fake-new-admin"));
    const employeeRequest = state.applyRequest({ headers: { "X-Business-Id": "fake-old-business", "X-CRM-Admin-Session": "", "X-CRM-Attendance-Session": "fake-captured-employee" } });
    assert.equal(employeeRequest.headers["X-CRM-Admin-Session"], "");
    assert.equal(employeeRequest.headers["X-CRM-Attendance-Session"], "fake-captured-employee");
    assert.equal(employeeRequest.headers["X-Business-Id"], "fake-old-business");
    state.setAuth(employee("fake-new-employee"));
    const adminRequest = state.applyRequest({ headers: { "X-CRM-Admin-Session": "fake-captured-admin", "X-CRM-Attendance-Session": "" } });
    assert.equal(adminRequest.headers["X-CRM-Admin-Session"], "fake-captured-admin");
    assert.equal(adminRequest.headers["X-CRM-Attendance-Session"], "");
});

test("a current signed session failure logs out once, without replaying the failed request", async () => {
    const state = apiFixture();
    const error = failure("fake-old-session");
    assert.equal(await state.reject(error), error);
    await state.reject(error);
    assert.equal(state.cleared(), 1);
    assert.equal(state.notices.length, 1);
});

test("late old-session failures, login rejection and forbidden actions do not discard a valid login", async () => {
    const state = apiFixture();
    state.setAuth(admin("fake-new-session"));
    await state.reject(failure("fake-old-session"));
    await state.reject(failure("fake-new-session", { config: { url: "/auth/login", headers: { "X-CRM-Admin-Session": "fake-new-session" } } }));
    await state.reject(failure("fake-new-session", { response: { status: 403, data: { message: "Not allowed" } } }));
    await state.reject(failure("fake-new-session", { response: { status: 401, data: { message: "Invalid bridge credential" } } }));
    assert.equal(state.cleared(), 0);
});

test("employee and tracker sessions match their own signed token, including AxiosHeaders", () => {
    const { shouldExpireCrmSession, retryAuthorizedQuery } = load("src/lib/sessionAuthorization.ts", {});
    for (const actor of [employee("fake-employee-token"), { ...admin(null), attendanceHubSession: "fake-tracker-token", access: "tracker" }]) {
        const token = actor.attendanceHubSession;
        const error = failure("", { config: { url: "/system-settings", headers: { get: name => name === "X-CRM-Attendance-Session" ? token : null } } });
        assert.equal(shouldExpireCrmSession(error, actor), true);
        assert.equal(shouldExpireCrmSession(error, employee("different-token")), false);
    }
    assert.equal(retryAuthorizedQuery(0, failure("fake")), false);
    assert.equal(retryAuthorizedQuery(0, { response: { status: 403 } }), false);
    assert.equal(retryAuthorizedQuery(0, { response: { status: 503 } }), true);
    assert.equal(retryAuthorizedQuery(1, new Error("network")), false);
});

test("legacy cached users without signed tokens return to login without expiring a newer session", () => {
    const { shouldExpireCrmSession } = load("src/lib/sessionAuthorization.ts", {});
    const legacy = employee(null);
    const error = failure("", { config: { url: "/system-settings", headers: { "X-CRM-User-Code": legacy.user.employeeCode } } });
    assert.equal(shouldExpireCrmSession(error, legacy), true);
    assert.equal(shouldExpireCrmSession(error, employee("fresh-signed-login")), false);
    assert.equal(shouldExpireCrmSession(error, null), false);
    error.response.data = { message: "Sign in again. A signed CRM session is required." };
    assert.equal(shouldExpireCrmSession(error, legacy), true, "older protected API responses are also handled");
});

test("theme never requests private settings while logged out, including business and logout events", async () => {
    let auth = null, requests = 0;
    const listeners = new Map();
    const theme = load("src/components/ThemeProvider.tsx", { useEffect: callback => callback(), getStoredThemeKey: () => "theme-1", setAppTheme() {},
        hasAppThemeOverride: () => false, getActiveBusinessId: () => "fake-a", getAuthUser: () => auth,
        require: () => ({ getSystemSettings: async () => { requests++; return { themeKey: "theme-1" }; } }),
        window: { addEventListener: (name, listener) => listeners.set(name, listener), removeEventListener() {} } });
    theme.ThemeProvider({ children: null });
    listeners.get("crm:business-changed")();
    listeners.get("crm:auth-changed")();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(requests, 0);
    auth = employee("fake-employee-token"); listeners.get("crm:auth-changed")();
    await new Promise(resolve => setImmediate(resolve)); assert.equal(requests, 1);
    auth = null; listeners.get("crm:auth-changed")();
    await new Promise(resolve => setImmediate(resolve)); assert.equal(requests, 1);
});

test("session invalidation cancels polling, clears cache and disconnects sockets once across tabs", async () => {
    let auth = admin("fake-session"), cancelled = 0, cleared = 0, disconnected = 0;
    const listeners = new Map();
    const { registerSessionInvalidation } = load("src/lib/sessionLifecycle.ts", { getAuthUser: () => auth,
        window: { addEventListener: (name, listener) => listeners.set(name, listener), removeEventListener: name => listeners.delete(name) } });
    const stop = registerSessionInvalidation({ cancelQueries: async () => { cancelled++; }, clear: () => { cleared++; } }, () => { disconnected++; });
    listeners.get("crm:auth-changed")(); assert.equal(cleared, 0);
    auth = null; listeners.get("storage")({ key: "authUser" }); listeners.get("crm:auth-changed")();
    assert.deepEqual([cancelled, cleared, disconnected], [1, 1, 1]);
    auth = employee("new-login"); listeners.get("crm:auth-changed")();
    auth = null; listeners.get("storage")({ key: "unrelated" }); assert.equal(cleared, 1);
    listeners.get("storage")({ key: null }); assert.equal(cleared, 2);
    stop(); assert.equal(listeners.size, 0);
});

test("app auth events rerender protected routes and global query retries reject authorization failures", () => {
    const app = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
    const main = readFileSync(new URL("../src/main.tsx", import.meta.url), "utf8");
    assert.match(app, /useSyncExternalStore\(subscribeCredentialContext, getCredentialContextRevision\)/);
    assert.match(main, /retry: retryAuthorizedQuery/);
    assert.match(main, /registerSessionInvalidation\(queryClient,.*socket\.disconnect/);
});
