import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import ts from "typescript";
import { getRouteLeadTab } from "../../../shared/leadRoutes";

test("dashboard follow-up links use the supported ALL endpoint, not a nonexistent follow-up route", () => {
  assert.equal(getRouteLeadTab("Follow up"), "ALL");
  assert.equal(getRouteLeadTab("FOLLOWUP"), "ALL");
  assert.equal(getRouteLeadTab("Unassigned"), "Unassigned");
  assert.equal(getRouteLeadTab("Qualified"), "Qualified");
  assert.equal(getRouteLeadTab("unknown"), null);
  assert.equal(getRouteLeadTab("constructor"), null);
  assert.equal(getRouteLeadTab("__proto__"), null);
});
test("dashboard routing changes never alter the existing imported Follow up status normalization", () => {
  const text = fs.readFileSync(new URL("../../../src/pages/admin/leads/index.tsx", import.meta.url), "utf8");
  const source = ts.createSourceFile("leads.tsx", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const fn = source.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === "normalizeImportedStatus");
  assert.ok(fn && ts.isFunctionDeclaration(fn));
  const map = fn.body!.statements.filter(ts.isVariableStatement).flatMap((node) => node.declarationList.declarations).find((node) => node.name.getText(source) === "statusMap")?.initializer;
  assert.ok(map && ts.isObjectLiteralExpression(map));
  for (const key of ["followup", '"follow up"']) {
    const row: ts.ObjectLiteralElementLike | undefined = map.properties.find((node) => ts.isPropertyAssignment(node) && node.name.getText(source) === key);
    assert.ok(row && ts.isPropertyAssignment(row) && ts.isStringLiteral(row.initializer));
    assert.equal(row.initializer.text, "Follow up");
  }
});
