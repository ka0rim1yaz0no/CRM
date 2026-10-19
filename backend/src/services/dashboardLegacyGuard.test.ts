import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import crypto from "node:crypto";
import ts from "typescript";

test("dashboard extraction preserves all 87 existing legacy declarations without a second attendance implementation", () => {
  const baseline = JSON.parse(fs.readFileSync(new URL("./dashboardLegacyBaseline.json", import.meta.url), "utf8")) as Record<string, string>;
  const text = fs.readFileSync(new URL("../../../src/pages/admin/dashboard/legacyMath.ts", import.meta.url), "utf8");
  const source = ts.createSourceFile("legacyMath.ts", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const actual: Record<string, string> = {};
  for (const node of source.statements) {
    const name = (ts.isFunctionDeclaration(node) || ts.isTypeAliasDeclaration(node)) ? node.name?.text :
      ts.isVariableStatement(node) ? node.declarationList.declarations[0]?.name.getText(source) : "";
    if (!name) continue;
    const value = node.getText(source).replace(/^export /, "").replace(/\r\n/g, "\n").replace(/[\u0080-\u{10ffff}]/gu, (char) => `\\u{${char.codePointAt(0)!.toString(16)}}`);
    actual[name] = crypto.createHash("sha256").update(value).digest("hex");
  }
  assert.equal(Object.keys(baseline).length, 87);
  assert.deepEqual(actual, baseline);
  const page = fs.readFileSync(new URL("../../../src/pages/admin/dashboard/index.tsx", import.meta.url), "utf8");
  assert.ok(!page.includes("function buildAttendanceShiftRows"));
  assert.ok(page.includes('<CallDashboardPanel businessId={activeBusinessId} businessName={activeBusinessName} />'));
});
