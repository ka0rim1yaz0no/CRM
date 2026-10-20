/// <reference types="vite/client" />
import assert from "node:assert/strict";
import { test } from "node:test";
import { fileBusinessUrl } from "../../../src/lib/fileBusinessUrl";
import { clearAuthUser, waitForFileLogout } from "../../../src/api/authStorage";

test("file URLs follow the selected business without carrying sessions or changing external/data/blob links", () => {
  const previous = globalThis.localStorage;
  let business = "synthetic-a";
  Object.assign(globalThis, { localStorage: { getItem: () => business } });
  try {
    for (const id of ["synthetic-a", "synthetic-b"]) {
      business = id;
      const url = new URL(fileBusinessUrl("http://127.0.0.1:4000/api/knowledge-base/photos/file/fake.png"));
      assert.equal(url.searchParams.get("businessId"), id);
      assert.deepEqual([...url.searchParams.keys()], ["businessId"]);
      const legacy = new URL(fileBusinessUrl("/uploads/knowledge-base/fake.png"));
      assert.equal(legacy.pathname, "/api/knowledge-base/photos/file/fake.png");
      assert.equal(legacy.searchParams.get("businessId"), id);
    }
    for (const url of ["https://external.invalid/picture.png", "data:image/png;base64,fake", "blob:synthetic", "http://127.0.0.1:4000/api/health"]) assert.equal(fileBusinessUrl(url), url);
  } finally { if (previous === undefined) Reflect.deleteProperty(globalThis, "localStorage"); else Object.assign(globalThis, { localStorage: previous }); }
});

test("logout clears local auth immediately and login can await the file-cookie clear without a race", async () => {
  const oldWindow = globalThis.window;
  const oldStorage = globalThis.localStorage;
  let removed = false, notified = false, completed = false;
  let finish!: () => void;
  const pending = new Promise<Response>(resolve => { finish = () => resolve(new Response("{}")); });
  const window = Object.assign(new EventTarget(), { fetch: async (url: string, options: RequestInit) => {
    assert.ok(url.endsWith("/api/auth/file-session/logout")); assert.equal(options.credentials, "include"); return pending;
  } });
  window.addEventListener("crm:auth-changed", () => { notified = true; });
  Object.assign(globalThis, { window, localStorage: { removeItem: () => { removed = true; } } });
  try {
    clearAuthUser(); assert.equal(removed, true); assert.equal(notified, true);
    const waiting = waitForFileLogout().then(() => { completed = true; });
    await Promise.resolve(); assert.equal(completed, false);
    finish(); await waiting; assert.equal(completed, true);
  } finally {
    if (oldWindow === undefined) Reflect.deleteProperty(globalThis, "window"); else Object.assign(globalThis, { window: oldWindow });
    if (oldStorage === undefined) Reflect.deleteProperty(globalThis, "localStorage"); else Object.assign(globalThis, { localStorage: oldStorage });
  }
});
