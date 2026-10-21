import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertLocalPortAvailable } from "./local-review-ports.mjs";
import { waitForCrmHealth, localBackendPort, localFrontendEnvironment, missingLocalBackendMessage } from "./local-startup.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
if (!await waitForCrmHealth(`http://127.0.0.1:${localBackendPort}/api/health`)) {
  console.error(missingLocalBackendMessage);
  process.exitCode = 1;
} else if (await waitForCrmHealth("http://localhost:5173/api/health")) {
  console.log("Local CRM is already running: http://localhost:5173/ . No process or database was changed.");
} else {
  try {
    await assertLocalPortAvailable(5173);
  } catch (error) {
    console.error(`${error.message} If this is the CRM, wait for it to finish starting and retry npm run dev.`);
    process.exit(1);
  }
  const frontend = spawn(process.execPath, ["node_modules/vite/bin/vite.js", "--host", "127.0.0.1", "--port", "5173", "--strictPort"], {
    cwd: root,
    env: localFrontendEnvironment(process.env),
    stdio: "inherit",
    windowsHide: true,
  });
  frontend.once("error", (error) => { console.error(error.message); process.exitCode = 1; });
  frontend.once("exit", (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0); });
  for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => frontend.kill(signal));
}
