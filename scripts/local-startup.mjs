export const localBackendPort = 4101;

export function localFrontendEnvironment(environment) {
  return {
    ...environment,
    CRM_VITE_CACHE_DIR: "node_modules/.vite-local-review",
    VITE_API_URL: "/api",
    VITE_SOCKET_URL: "/",
    VITE_BACKEND_PORT: String(localBackendPort),
    VITE_CRM_LOCAL_REVIEW: "false",
    VITE_CRM_ATTENDANCE_INTEGRITY: "true",
    VITE_CRM_ATTENDANCE_HUB: "true",
    VITE_CRM_ATTENDANCE_DURATION_MODEL: "true",
  };
}

export async function isCrmHealthy(url, request = fetch) {
  try {
    const response = await request(url, { signal: AbortSignal.timeout(3000) });
    if (!response.ok) return false;
    const body = await response.json();
    return body?.status === "ok";
  } catch {
    return false;
  }
}

export async function waitForCrmHealth(url, request = fetch, pause = () => new Promise(resolve => setTimeout(resolve, 750))) {
  for (let attempt = 0; attempt < 3; attempt++) {
    if (await isCrmHealthy(url, request)) return true;
    if (attempt < 2) await pause();
  }
  return false;
}

export const missingLocalBackendMessage = [
  "The local CRM backend is not ready on 127.0.0.1:4101. Vite was not started.",
  "Restart your preserved local fixture launcher to keep your existing test records.",
  "For a NEW disposable sample database only: npm run dev:attendance -- --duration-model --auto-time-out",
  "That command starts MongoDB, the API and localhost:5173 together. Do not also run dev:backend.",
  "dev:backend is for a separately configured database and requires MONGODB_URI; no database address is guessed.",
].join("\n");
