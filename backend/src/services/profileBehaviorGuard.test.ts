import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import crypto from "node:crypto";
import ts from "typescript";

test("profile upgrade preserves existing query, mutation, validation and photo-upload handlers", () => {
  const root = new URL("../../../", import.meta.url);
  const current = fs.readFileSync(new URL("src/pages/profile/index.tsx", root), "utf8");
  const baseline = JSON.parse(fs.readFileSync(new URL("./profileBehaviorBaseline.json", import.meta.url), "utf8")) as Record<string, string>;
  const names = ["updateProfileMutation", "createLeaveRequestMutation", "updateLeaveRequestMutation", "replyLeaveRequestMutation", "markNoticeReadMutation", "markAllNoticesReadMutation", "acknowledgeNoticeMutation", "replyNoticeMutation", "updateProfileImage", "updateProfileForm", "submitLeaveRequest", "startEditLeaveRequest", "toggleLeaveDate"];
  const declarations = (text: string) => {
    const source = ts.createSourceFile("profile.tsx", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX); const found = new Map<string, string>();
    let query = 0;
    const hash = (value: string) => crypto.createHash("sha256").update(value.replace(/\s+/g, " ")).digest("hex");
    function visit(node: ts.Node) { if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) found.set(node.name.text, hash(node.initializer.getText(source)));
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && ["useQuery", "useInfiniteQuery"].includes(node.expression.text)) found.set(`query${++query}`, hash(node.getText(source)));
      ts.forEachChild(node, visit); }
    visit(source); return found;
  };
  const after = declarations(current);
  for (const name of [...names, ...Object.keys(baseline).filter((key) => key.startsWith("query"))]) { assert.ok(baseline[name], name); assert.equal(after.get(name), baseline[name], `${name} must keep its original behavior`); }
});
