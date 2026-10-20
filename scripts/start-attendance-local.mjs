import { spawn } from "node:child_process";
import { assertLocalPortAvailable } from "./local-review-ports.mjs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
for (const port of [4101, 5173]) await assertLocalPortAvailable(port);
const children = [];
const review = process.argv.includes("--local-review");
const durationModel = process.argv.includes("--duration-model");
const autoTimeOut = process.argv.includes("--auto-time-out");
if (autoTimeOut && review) throw new Error("Automatic time-out testing is restricted to the disposable seeded database.");
const reviewEnvironment = Object.fromEntries(Object.entries(process.env).filter(([name]) => /^(PATH|PATHEXT|SystemRoot|WINDIR|TEMP|TMP|LOCALAPPDATA|APPDATA|USERPROFILE|ComSpec|NUMBER_OF_PROCESSORS|PROCESSOR_ARCHITECTURE|ProgramFiles|ProgramFiles\(x86\)|HOMEDRIVE|HOMEPATH|USERNAME)$/i.test(name)));
const backend = spawn(process.execPath, ["--import", "tsx", review ? "src/localReview.ts" : "src/localAttendance.ts", ...(review && process.argv.includes("--adopt-legacy") ? ["--adopt-legacy"] : [])], { cwd: path.join(root, "backend"), env: { ...(review ? reviewEnvironment : process.env), CRM_ATTENDANCE_DURATION_MODEL: String(durationModel), CRM_ATTENDANCE_AUTO_TIMEOUT: String(autoTimeOut) }, windowsHide: true, stdio: ["inherit", "pipe", "inherit"] });
children.push(backend);
let started = false;
backend.stdout.on("data", (chunk) => {
  process.stdout.write(chunk);
  if (started || !String(chunk).includes("Isolated attendance backend ready")) return;
  started = true;
  children.push(spawn(process.execPath, ["node_modules/vite/bin/vite.js", "--host", "127.0.0.1", "--port", "5173", "--strictPort"], {
    cwd: root, windowsHide: true, stdio: "inherit", env: { ...process.env, CRM_VITE_CACHE_DIR: "node_modules/.vite-local-review", VITE_API_URL: "/api", VITE_SOCKET_URL: "/", VITE_BACKEND_PORT: "4101", VITE_CRM_LOCAL_REVIEW: String(review), VITE_CRM_ATTENDANCE_INTEGRITY: "true", VITE_CRM_ATTENDANCE_HUB: "true", VITE_CRM_ATTENDANCE_DURATION_MODEL: String(durationModel) },
  }));
});
const stop = () => { for (const child of children) child.kill("SIGTERM"); };
process.on("SIGINT", stop); process.on("SIGTERM", stop);
backend.on("exit", (code) => { stop(); process.exitCode = code || 0; });
