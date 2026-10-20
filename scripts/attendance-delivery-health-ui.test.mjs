import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
test("delivery health tables separate headers/values and keep narrow viewports scrollable", () => {
  const css = readFileSync(new URL("../src/components/AttendanceHub.css", import.meta.url), "utf8");
  assert.match(css, /\.attendance-hub-delivery-health\s*\{[^}]*overflow-x:\s*auto/);
  assert.match(css, /\.attendance-hub-delivery-health table\s*\{[^}]*display:\s*table[^}]*width:\s*100%[^}]*min-width:\s*640px/);
  assert.match(css, /\.attendance-hub-delivery-health th,\s*\.attendance-hub-delivery-health td\s*\{[^}]*padding:\s*8px 12px/);
});
