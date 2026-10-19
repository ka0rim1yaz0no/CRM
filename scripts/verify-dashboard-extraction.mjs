import fs from "node:fs";
import { execFileSync } from "node:child_process";
import ts from "typescript";
import crypto from "node:crypto";
const before = execFileSync("git", ["show", "a645fa3:src/pages/admin/dashboard/index.tsx"], { encoding: "utf8", maxBuffer: 2_000_000 });
const after = fs.readFileSync("src/pages/admin/dashboard/legacyMath.ts", "utf8");
function declarations(text) {
  const source = ts.createSourceFile("dashboard.tsx", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  return new Map(source.statements.flatMap((node) => {
    const name = (ts.isFunctionDeclaration(node) || ts.isTypeAliasDeclaration(node)) ? node.name?.text :
      ts.isVariableStatement(node) ? node.declarationList.declarations[0]?.name.getText(source) : "";
    return name ? [[name, node.getText(source).replace(/^export /, "").replace(/\r\n/g, "\n")
      .replace(/[\u0080-\u{10ffff}]/gu, (char) => `\\u{${char.codePointAt(0).toString(16)}}`)]] : [];
  }));
}
const originals = declarations(before);
const hashes = {};
for (const [name, value] of declarations(after)) {
  if (value !== originals.get(name)) throw new Error(`Unexpected calculation change while extracting ${name}`);
  hashes[name] = crypto.createHash("sha256").update(value).digest("hex");
}
fs.writeFileSync("backend/src/services/dashboardLegacyBaseline.json", `${JSON.stringify(hashes, null, 2)}\n`);
process.stdout.write(`Verified ${Object.keys(hashes).length} legacy declarations against the pre-upgrade local checkpoint.\n`);
