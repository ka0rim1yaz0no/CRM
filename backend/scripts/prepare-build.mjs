import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = await fs.realpath(path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."));
const output = path.join(root, "dist");
try {
  if (await fs.realpath(output) !== output) throw new Error("Refusing to clean a redirected build directory.");
} catch (error) { if (error.code !== "ENOENT") throw error; }
if (path.dirname(output) !== root || path.basename(output) !== "dist") throw new Error("Invalid build directory.");
await fs.rm(output, { recursive: true, force: true });
