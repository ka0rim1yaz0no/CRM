const backendPort = String(import.meta.env.VITE_BACKEND_PORT || "4000");

function isIpAddress(hostname: string) {
  return /^(?:\d{1,3}\.){3}\d{1,3}$/.test(hostname);
}

function getBackendOrigin() {
  if (typeof window === "undefined") {
    return `http://127.0.0.1:${backendPort}`;
  }

  const { protocol, hostname } = window.location;
  const isLocal = hostname === "localhost" || hostname === "127.0.0.1";

  if (!isLocal && !isIpAddress(hostname)) {
    return window.location.origin;
  }

  return `${protocol}//${hostname}:${backendPort}`;
}

export const backendOrigin = getBackendOrigin();
