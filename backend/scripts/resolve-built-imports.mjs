import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = path.join(root, "dist");
async function files(directory) {
  const result = [];
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const name = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await files(name));
    else result.push(name);
  }
  return result;
}
async function isFile(file) { try { return (await fs.stat(file)).isFile(); } catch { return false; } }

// tsc preserves bundler-style source imports; resolve only emitted local module specifiers.
for (const file of await files(output)) {
  if (!file.endsWith(".js")) continue;
  const source = await fs.readFile(file, "utf8");
  const syntax = ts.createSourceFile(file, source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.JS);
  const literals = [];
  function visit(node) {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) literals.push(node.moduleSpecifier);
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments.length === 1 && ts.isStringLiteral(node.arguments[0])) literals.push(node.arguments[0]);
    ts.forEachChild(node, visit);
  }
  visit(syntax);
  const edits = [];
  for (const literal of literals) {
    const name = literal.text;
    if (!name.startsWith(".")) continue;
    const target = path.resolve(path.dirname(file), name);
    if (!target.startsWith(`${output}${path.sep}`)) throw new Error("Build import escapes the backend output.");
    let resolved = name;
    if (!(await isFile(target))) {
      if (await isFile(`${target}.js`)) resolved += ".js";
      else if (await isFile(path.join(target, "index.js"))) resolved += "/index.js";
      else throw new Error("An emitted backend import could not be resolved.");
    }
    if (resolved !== name) edits.push({ start: literal.getStart(syntax), end: literal.getEnd(), text: JSON.stringify(resolved) });
  }
  let changed = source;
  for (const edit of edits.sort((a, b) => b.start - a.start)) changed = changed.slice(0, edit.start) + edit.text + changed.slice(edit.end);
  if (changed !== source) await fs.writeFile(file, changed);
}
for (const file of await files(path.join(root, "src"))) {
  if (!file.endsWith(".mjs")) continue;
  const target = path.join(output, "backend", "src", path.relative(path.join(root, "src"), file));
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.copyFile(file, target);
}
await fs.writeFile(path.join(output, "server.js"), 'import "./backend/src/server.js";\n');
process.stdout.write("Compiled backend imports resolved for native Node ESM.\n");
