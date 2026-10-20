import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { mock, test } from "node:test";
import { securityBodyParser, securityMiddleware } from "./securityHardening";
import { isDeniedEmployeeCode, isTrackerOnlyAdminCode, getConfiguredAdmins } from "../config/adminUsers";
import { securityHardeningEnabled, securityUploadsEnabled, securityDataMinimizationEnabled, securityEnvironmentCodesEnabled } from "../config/rolloutFlags";

process.env.NODE_ENV = "test";
async function fixture(run: (base: string) => Promise<void>) {
  const app = express();
  const security = securityMiddleware();
  app.use(security.headers);
  app.use(securityBodyParser());
  app.post("/login", security.loginIpLimit, security.loginCodeLimit, (req, res) => res.status(req.body.employeeCode === "valid-fake" ? 200 : 401).json({ ok: req.body.employeeCode === "valid-fake" }));
  app.post("/api/general", (_req, res) => res.json({ ok: true }));
  app.post("/api/employees/fake/profile", (_req, res) => res.json({ ok: true }));
  app.use(((error: { status?: number }, _req: express.Request, res: express.Response, next: express.NextFunction) => { void next; res.status(error.status || 500).json({ message: "Request rejected" }); }) as express.ErrorRequestHandler);
  const server = http.createServer(app);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try { await run(`http://127.0.0.1:${(server.address() as { port: number }).port}`); }
  finally { await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }); }
}
function post(base: string, route: string, body: unknown) { return fetch(`${base}${route}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }); }

test("hardening: secure headers, 2 MB normal body and only exact upload exceptions", async () => {
  process.env.CRM_SECURITY_HARDENING = "true";
  await fixture(async base => {
    const small = await post(base, "/api/general", {});
    assert.equal(small.status, 200); assert.equal(small.headers.get("x-content-type-options"), "nosniff");
    assert.equal(small.headers.get("x-powered-by"), null);
    const big = { synthetic: "a".repeat(2 * 1024 * 1024 + 32) };
    assert.equal((await post(base, "/api/general", big)).status, 413);
    assert.equal((await fetch(`${base}/api/employees/fake/profile`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(big) })).status, 404, "the enlarged parser accepts the body; this test has no PATCH handler");
    assert.equal((await post(base, "/api/general?path=/api/media", big)).status, 413);
  });
});
test("hardening: login has a temporary per-IP failure lockout, success does not consume attempts", async () => {
  process.env.CRM_SECURITY_HARDENING = "true";
  process.env.CRM_SECURITY_LOGIN_MAX = "2";
  await fixture(async base => {
    for (let n = 0; n < 5; n++) assert.equal((await post(base, "/login", { employeeCode: "valid-fake" })).status, 200);
    for (let n = 0; n < 2; n++) assert.equal((await post(base, "/login", { employeeCode: `invalid-${n}` })).status, 401);
    const blocked = await post(base, "/login", { employeeCode: "valid-fake" });
    assert.equal(blocked.status, 429); assert.ok(blocked.headers.get("retry-after"));
    mock.timers.enable({ apis: ["Date"], now: Date.now() + 16 * 60_000 });
    try { assert.equal((await post(base, "/login", { employeeCode: "valid-fake" })).status, 200); }
    finally { mock.timers.reset(); }
  });
  delete process.env.CRM_SECURITY_LOGIN_MAX;
});
test("hardening: per-code limiter works independently of client IP and never exposes codes", async () => {
  const middleware = securityMiddleware();
  const app = express(); app.use(express.json());
  app.post("/", middleware.loginCodeLimit, (_req, res) => res.status(401).json({ message: "Invalid login" }));
  const server = http.createServer(app); await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    for (let n = 0; n < 10; n++) assert.equal((await post(base, "/", { employeeCode: "same-synthetic-code" })).status, 401);
    const blocked = await post(base, "/", { employeeCode: "same-synthetic-code" });
    assert.equal(blocked.status, 429); assert.ok(!(await blocked.text()).includes("same-synthetic-code"));
    assert.equal((await post(base, "/", { employeeCode: "another-synthetic-code" })).status, 401);
  } finally { await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }); }
});
test("hardening flags default on only in dev/test, and rollback retains large bodies without Helmet", async () => {
  for (const env of ["production", "test", "development"]) {
    process.env.NODE_ENV = env;
    for (const [name, flag] of [["CRM_SECURITY_HARDENING", securityHardeningEnabled], ["CRM_SECURITY_UPLOAD_AUTH", securityUploadsEnabled], ["CRM_SECURITY_DATA_MINIMIZATION", securityDataMinimizationEnabled], ["CRM_SECURITY_ENV_CODES", securityEnvironmentCodesEnabled]] as const) {
      delete process.env[name]; assert.equal(flag(), env !== "production");
    }
  }
  process.env.NODE_ENV = "test"; process.env.CRM_SECURITY_HARDENING = "false";
  try { await fixture(async base => { const response = await post(base, "/api/general", { fake: "a".repeat(2 * 1024 * 1024 + 32) }); assert.equal(response.status, 200); assert.equal(response.headers.get("x-content-type-options"), null); }); }
  finally { process.env.CRM_SECURITY_HARDENING = "true"; }
});
test("environment codes: no built-in tracker/deny identity; explicit production roles never elevate silently", () => {
  const names = ["NODE_ENV", "CRM_SECURITY_ENV_CODES", "CRM_ADMIN_ONE_CODE", "CRM_ADMIN_TWO_CODE", "CRM_ADMIN_ONE_ACCESS", "CRM_TRACKER_ADMIN_CODES", "CRM_DENIED_EMPLOYEE_CODES"];
  const saved = new Map(names.map(name => [name, process.env[name]]));
  try {
    process.env.CRM_ADMIN_ONE_CODE = "synthetic-config-admin";
    process.env.CRM_ADMIN_TWO_CODE = "synthetic-config-tracker";
    process.env.CRM_TRACKER_ADMIN_CODES = "synthetic-config-tracker";
    process.env.CRM_DENIED_EMPLOYEE_CODES = "synthetic-denied";
    assert.equal(isTrackerOnlyAdminCode("synthetic-config-tracker"), true);
    assert.equal(isTrackerOnlyAdminCode(""), false);
    assert.equal(isDeniedEmployeeCode("synthetic-denied"), true);
    assert.equal(isDeniedEmployeeCode("synthetic-allowed"), false);
    process.env.NODE_ENV = "production"; process.env.CRM_SECURITY_ENV_CODES = "true";
    delete process.env.CRM_ADMIN_ONE_ACCESS;
    assert.equal(getConfiguredAdmins().find(admin => admin.employeeCode === "synthetic-config-admin")?.access, "tracker");
    process.env.CRM_ADMIN_ONE_ACCESS = "full";
    assert.equal(getConfiguredAdmins().find(admin => admin.employeeCode === "synthetic-config-admin")?.access, "full");
  } finally { for (const [name, value] of saved) { if (value === undefined) delete process.env[name]; else process.env[name] = value; } }
});
