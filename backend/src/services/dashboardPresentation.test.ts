import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const css = fs.readFileSync(new URL("../../../src/components/DashboardWorkspace.css", import.meta.url), "utf8");
const theme = fs.readFileSync(new URL("../../../src/index.css", import.meta.url), "utf8");

test("dashboard header and metric cards grow with their content rather than clipping wrapped text", () => {
  for (const match of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (!match[1].trim().match(/^\.dv2-page\s*>?\s*\.(dw-header|dashboard-kpi-card)$/)) continue;
    assert.doesNotMatch(match[2], /(?:^|;)\s*height\s*:\s*[\d.]+(?:px|rem)/);
  }
  assert.ok(css.includes(".dv2-page>.dw-header { display:flex; flex-wrap:wrap;"));
  assert.ok(css.includes(".dv2-page .dashboard-kpi-card { display:flex; flex-direction:column;"));
});

test("legacy Command White typography cannot override responsive dashboard greeting and metric sizing", () => {
  assert.ok(theme.includes('.admin-dashboard-page:not(.dv2-page) h2'));
  for (const suffix of ["", " .text-2xl", " .text-xs", " .text-sm"]) {
    assert.ok(theme.includes(`.admin-dashboard-page:not(.dv2-page) .dashboard-kpi-card${suffix}`));
  }
});
