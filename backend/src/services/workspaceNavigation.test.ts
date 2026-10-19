import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import ts from "typescript";

function source(path: string) {
  const text = fs.readFileSync(new URL(`../../../${path}`, import.meta.url), "utf8");
  return ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
}

function walk(node: ts.Node, visit: (node: ts.Node) => void) {
  visit(node);
  ts.forEachChild(node, (child) => walk(child, visit));
}

function property(node: ts.ObjectLiteralExpression, name: string) {
  const item = node.properties.find((item): item is ts.PropertyAssignment =>
    ts.isPropertyAssignment(item) && item.name.getText() === name);
  if (!item) return undefined;
  const value = ts.isAsExpression(item.initializer) ? item.initializer.expression : item.initializer;
  return ts.isStringLiteral(value) ? value.text : undefined;
}

function attribute(node: ts.JsxOpeningElement | ts.JsxSelfClosingElement, name: string) {
  const item = node.attributes.properties.find((item): item is ts.JsxAttribute =>
    ts.isJsxAttribute(item) && item.name.getText() === name);
  return item?.initializer && ts.isStringLiteral(item.initializer) ? item.initializer.text : undefined;
}

const routes = new Map<string, { feature: string; scope: string }>();
walk(source("src/App.tsx"), (node) => {
  if (!ts.isJsxSelfClosingElement(node) || node.tagName.getText() !== "Route") return;
  const path = attribute(node, "path");
  if (!path) return;
  walk(node, (child) => {
    if (!ts.isJsxOpeningElement(child) || child.tagName.getText() !== "FeatureRoute") return;
    const feature = attribute(child, "feature");
    const scope = attribute(child, "scope");
    if (feature && scope) routes.set(path, { feature, scope });
  });
});

for (const [file, expectedCount] of [
  ["src/pages/admin/adminLayout/index.tsx", 15],
  ["src/pages/layout/sidebar.tsx", 12],
] as const) {
  test(`${file}: every sidebar destination exists and uses the same feature and role gate`, () => {
    const destinations: Array<{ path: string; feature: string }> = [];
    walk(source(file), (node) => {
      if (!ts.isObjectLiteralExpression(node)) return;
      const path = property(node, "path");
      const feature = property(node, "feature");
      if (path && feature) destinations.push({ path, feature });
    });
    assert.equal(destinations.length, expectedCount, "include all normal and POC navigation items");
    assert.equal(new Set(destinations.map((item) => item.path)).size, destinations.length);
    if (file === "src/pages/layout/sidebar.tsx") {
      assert.ok(!destinations.some((item) => /\/(employees|credentials)(\/|$)/.test(item.path)),
        "employee navigation must not expose Employees or Credentials in any business, including POC");
      assert.ok(destinations.some((item) => item.path === "/poc/tasks"), "POC Tasks remains available");
    } else {
      for (const path of ["/admin/employees", "/admin/credentials"]) {
        assert.ok(destinations.some((item) => item.path === path), `admin navigation keeps ${path}`);
      }
    }
    for (const item of destinations) {
      assert.deepEqual(routes.get(item.path), {
        feature: item.feature,
        scope: item.path.startsWith("/admin/") || item.path.startsWith("/poc/") ? "admin" : "employee",
      }, `navigation must not redirect, 404, or disagree with feature access: ${item.path}`);
    }
  });
}
