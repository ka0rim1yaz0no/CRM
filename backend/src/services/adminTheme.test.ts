/// <reference types="vite/client" />
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { getStoredThemeKey, setAppTheme } from "../../../src/lib/appTheme";
import { clearAuthUser, setAuthUser } from "../../../src/api/authStorage";
import { colorContrast } from "../../../src/lib/profilePresentation";
import { readFileSync } from "node:fs";

const values = new Map<string, string>();
const events = new EventTarget();
const root = { dataset: {} as Record<string, string>, style: { setProperty() {} } };
Object.assign(globalThis, {
  localStorage: { getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } },
  document: { documentElement: root }, window: events,
});
beforeEach(() => { values.clear(); root.dataset = {}; });

const signIn = (business = "synthetic-a") => setAuthUser({ userType: "admin",
  user: { id: "fake-admin", employeeCode: "90000001", name: "Fixture Admin", role: "Admin" },
  business: { id: business, name: business } });

test("admin starts light in a clean browser and ignores every old dark theme and override", () => {
  signIn();
  assert.equal(getStoredThemeKey(), "light-command");
  for (const theme of ["theme-1", "flat-amethyst", "flat-river", "invalid"]) {
    values.set("crmThemeKey", theme); values.set("crmThemeUserOverride", "true");
    setAppTheme(theme, { userOverride: true });
    assert.equal(getStoredThemeKey(), "light-command");
    assert.equal(root.dataset.theme, "light-command");
  }
});

test("business defaults and logout/login cannot override admin light or destroy employee preferences", () => {
  values.set("crmThemeKey", "flat-emerald"); values.set("crmThemeUserOverride", "true");
  for (const business of ["synthetic-a", "synthetic-b", "new-business"]) {
    signIn(business); setAppTheme("theme-1", { userOverride: false });
    assert.equal(root.dataset.theme, "light-command");
    assert.equal(values.get("crmThemeKey"), "flat-emerald");
    assert.equal(values.get("crmThemeUserOverride"), "true");
    clearAuthUser();
    assert.equal(getStoredThemeKey(), "flat-emerald");
  }
  signIn(); setAppTheme(getStoredThemeKey());
  assert.equal(root.dataset.theme, "light-command");
});

test("same-tab authentication changes notify the theme provider, including logout", () => {
  let notified = 0;
  const listener = () => { notified++; };
  events.addEventListener("crm:auth-changed", listener);
  try { signIn(); clearAuthUser(); assert.equal(notified, 2); }
  finally { events.removeEventListener("crm:auth-changed", listener); }
});

test("a late employee theme response cannot darken a newly signed-in admin", async () => {
  const response = Promise.resolve("flat-river");
  signIn();
  setAppTheme(await response, { userOverride: false });
  assert.equal(root.dataset.theme, "light-command");
});

test("employee theme selection remains available after an admin session", () => {
  signIn(); setAppTheme("theme-1"); clearAuthUser();
  values.set("authUser", JSON.stringify({ userType: "employee", user: { employeeCode: "99009991" } }));
  setAppTheme("flat-amethyst", { userOverride: true });
  assert.equal(getStoredThemeKey(), "flat-amethyst");
  assert.equal(root.dataset.themeRole, "employee");
});

test("admin secondary labels, placeholders and purple actions retain readable contrast", () => {
  const css = readFileSync(new URL("../../../src/index.css", import.meta.url), "utf8");
  assert.ok(css.includes(':root[data-theme-role="admin"][data-theme="light-command"]'));
  assert.ok(css.includes("color: #475569 !important"));
  assert.ok(css.includes("color: #64748b !important"));
  for (const surface of ["#ffffff", "#f1f5f9", "#eef3f9", "#efc5fa"]) assert.ok(colorContrast("#475569", surface) >= 4.5);
  assert.ok(colorContrast("#64748b", "#ffffff") >= 4.5);
  assert.ok(colorContrast("#ffffff", "#5f27cd") >= 4.5);
  assert.ok(colorContrast("#ffffff", "#1d4ed8") >= 4.5);
});
