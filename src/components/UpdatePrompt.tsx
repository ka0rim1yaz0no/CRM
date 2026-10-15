import { useEffect, useState } from "react";
import { FiRefreshCw, FiX } from "react-icons/fi";

const refreshCheckMs = 120_000;
const enabled = import.meta.env.VITE_CRM_UPDATE_PROMPT === "true" ||
  (import.meta.env.DEV && import.meta.env.VITE_CRM_UPDATE_PROMPT !== "false");

function appScriptPath(documentRoot: Document) {
  const source = documentRoot.querySelector<HTMLScriptElement>('script[type="module"][src]')?.getAttribute("src");
  if (!source) return "";
  return new URL(source, window.location.origin).pathname;
}

export function UpdatePrompt() {
  const [availableVersion, setAvailableVersion] = useState("");

  useEffect(() => {
    if (!enabled) return;
    const currentVersion = appScriptPath(document);
    if (!currentVersion.startsWith("/assets/")) return;

    let stopped = false;
    let checking = false;
    const check = async () => {
      if (stopped || checking || document.visibilityState === "hidden") return;
      checking = true;
      try {
        const response = await fetch(window.location.origin + "/", { cache: "no-store" });
        if (!response.ok) return;
        const nextDocument = new DOMParser().parseFromString(await response.text(), "text/html");
        const nextVersion = appScriptPath(nextDocument);
        if (!stopped && nextVersion.startsWith("/assets/") && nextVersion !== currentVersion) {
          setAvailableVersion(nextVersion);
        }
      } catch {
        // A transient network failure should not interrupt the open CRM tab.
      } finally {
        checking = false;
      }
    };

    const onVisible = () => {
      if (document.visibilityState === "visible") void check();
    };
    const timer = window.setInterval(() => void check(), refreshCheckMs);
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    void check();
    return () => {
      stopped = true;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
    };
  }, []);

  if (!availableVersion || window.sessionStorage.getItem("crm-dismissed-version") === availableVersion) return null;

  return (
    <div className="theme-toast theme-toast-info fixed bottom-4 right-4 z-[10000] flex w-[min(22rem,calc(100vw-2rem))] items-start gap-3 rounded-lg border p-3 shadow-xl" role="status">
      <FiRefreshCw className="mt-1 size-4 shrink-0" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold">Update available</p>
        <p className="mt-0.5 text-xs">Refresh when you are ready.</p>
        <button type="button" className="mt-2 rounded-md border border-current/30 px-2.5 py-1 text-xs font-semibold" onClick={() => window.location.reload()}>
          Refresh
        </button>
      </div>
      <button type="button" className="flex size-7 shrink-0 items-center justify-center rounded-md" aria-label="Dismiss update" onClick={() => {
        window.sessionStorage.setItem("crm-dismissed-version", availableVersion);
        setAvailableVersion("");
      }}>
        <FiX className="size-4" />
      </button>
    </div>
  );
}
