import path from "node:path";
import { fileURLToPath } from "node:url";
import { preview } from "vite";
import { assertLocalPortAvailable, localReviewHosts } from "./local-review-ports.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const backendPort = process.argv.includes("--existing-local-review") ? 4103 : 4101;
const info = await fetch(`http://127.0.0.1:${backendPort}/__local/review-info`).then((response) => response.json());
if (info.isolatedCopy !== true) throw new Error("Start the isolated local review backend first.");
if (backendPort === 4103 && info.existingReview !== true) throw new Error("The existing isolated review copy could not be verified.");
await assertLocalPortAvailable(5173);
process.env.VITE_BACKEND_PORT = String(backendPort);
const servers = [];
const close = async () => {
  for (const server of servers) await new Promise((resolve) => server.httpServer.close(resolve));
};
try {
  for (const host of localReviewHosts) servers.push(await preview({ root,
    build: { outDir: "dist-local-employee-review" }, preview: { host, port: 5173, strictPort: true, open: false } }));
} catch (error) {
  await close();
  throw error;
}
process.stdout.write("Updated isolated CRM preview: http://localhost:5173/ and http://127.0.0.1:5173/ (same build and local backend).\n");
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => { void close().finally(() => process.exit(0)); });
