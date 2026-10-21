import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { isCrmHealthy, waitForCrmHealth, localBackendPort, localFrontendEnvironment, missingLocalBackendMessage } from "./local-startup.mjs";

test("local frontend pins API and socket to the same local backend and retains updated attendance flags", () => {
  const inherited = { PATH: "test-path", VITE_API_URL: "https://example.invalid/api", VITE_SOCKET_URL: "https://example.invalid", VITE_BACKEND_PORT: "4000", VITE_CRM_ATTENDANCE_HUB: "false" };
  const environment = localFrontendEnvironment(inherited);
  assert.equal(localBackendPort, 4101);
  assert.equal(environment.VITE_BACKEND_PORT, "4101");
  assert.equal(environment.VITE_API_URL, "/api");
  assert.equal(environment.VITE_SOCKET_URL, "/");
  assert.equal(environment.VITE_CRM_ATTENDANCE_HUB, "true");
  assert.equal(environment.VITE_CRM_ATTENDANCE_DURATION_MODEL, "true");
  assert.equal(environment.PATH, "test-path");
  assert.equal(inherited.VITE_BACKEND_PORT, "4000");
});

test("health check accepts only a successful CRM health response and supplies a timeout", async () => {
  assert.equal(await isCrmHealthy("http://127.0.0.1:4101/api/health", async (url, options) => {
    assert.equal(url, "http://127.0.0.1:4101/api/health");
    assert.ok(options.signal instanceof AbortSignal);
    return { ok: true, json: async () => ({ status: "ok" }) };
  }), true);
  for (const response of [
    { ok: false, json: async () => ({ status: "ok" }) },
    { ok: true, json: async () => ({ status: "starting" }) },
    { ok: true, json: async () => { throw new Error("not JSON"); } },
  ]) assert.equal(await isCrmHealthy("http://localhost/", async () => response), false);
  assert.equal(await isCrmHealthy("http://localhost/", async () => { throw new Error("ECONNREFUSED"); }), false);
});

test("missing backend instructions distinguish preserving data from creating disposable data", () => {
  assert.match(missingLocalBackendMessage, /Vite was not started/);
  assert.match(missingLocalBackendMessage, /preserved local fixture/);
  assert.match(missingLocalBackendMessage, /NEW disposable/);
  assert.match(missingLocalBackendMessage, /Do not also run dev:backend/);
});

test("startup tolerates a briefly recompiling frontend but bounds connection retries", async () => {
  let requests = 0;
  let pauses = 0;
  const pause = async () => { pauses++; };
  assert.equal(await waitForCrmHealth("http://localhost/", async () => {
    requests++;
    return { ok: true, json: async () => ({ status: requests === 3 ? "ok" : "starting" }) };
  }, pause), true);
  assert.equal(requests, 3);
  assert.equal(pauses, 2);
  requests = 0;
  pauses = 0;
  assert.equal(await waitForCrmHealth("http://localhost/", async () => { requests++; throw new Error("ECONNREFUSED"); }, pause), false);
  assert.equal(requests, 3);
  assert.equal(pauses, 2);
});

test("default npm dev uses preflight and keeps production database validation in place", async () => {
  const root = new URL("../", import.meta.url);
  const pkg = JSON.parse(await fs.readFile(new URL("package.json", root), "utf8"));
  assert.equal(pkg.scripts.dev, "node scripts/start-local-frontend.mjs");
  const db = await fs.readFile(new URL("backend/src/config/db.ts", root), "utf8");
  assert.match(db, /if \(!uri\)/);
  assert.match(db, /throw new Error\("MONGODB_URI is required/);
  assert.doesNotMatch(db, /mongodb:\/\//);
});

for (const healthy of [true, false]) test(`launcher exits without starting or replacing servers when health is ${healthy}`, () => {
  const launcher = new URL("./start-local-frontend.mjs", import.meta.url).href;
  const script = `globalThis.fetch = async () => ({ ok: ${healthy}, json: async () => ({ status: 'ok' }) }); await import(${JSON.stringify(launcher)});`;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8", timeout: 10000, windowsHide: true });
  assert.equal(result.error, undefined);
  assert.equal(result.status, healthy ? 0 : 1);
  assert.match(healthy ? result.stdout : result.stderr, healthy ? /already running/ : /Vite was not started/);
  assert.doesNotMatch(result.stderr, /at Server|ECONNREFUSED/);
});
