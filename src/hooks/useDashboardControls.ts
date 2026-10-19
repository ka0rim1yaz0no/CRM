import { useEffect, useState, useSyncExternalStore } from "react";
import { useSearchParams } from "react-router";
import { getActiveBusinessId } from "../api/businessStorage";
import { dashboardView } from "../../shared/dashboardLayout";
export const dashboardSectionNames = ["Agent Productivity", "Monthly Data", "Employee Attendance", "Lead Status", "Online Status", "Agent Calls", "Top Agents", "Recent Lead Activity"];
function subscribe(callback: () => void) { document.addEventListener("visibilitychange", callback); return () => document.removeEventListener("visibilitychange", callback); }
export function useDashboardControls(enabled: boolean) {
  const [params, setParams] = useSearchParams();
  const [paused, setPaused] = useState(false);
  const visible = useSyncExternalStore(subscribe, () => document.visibilityState === "visible", () => true);
  const business = getActiveBusinessId();
  const ready = true;
  useEffect(() => {
    if (!enabled) return;
    if (business && params.get("business") !== business) setParams((previous) => { const next = new URLSearchParams(previous); next.set("business", business); return next; }, { replace: true });
  }, [enabled, business, params, setParams]);
  const filters = { preset: params.get("preset") || "today", from: params.get("from") || undefined, to: params.get("to") || undefined };
  function setFilter(key: string, value: string) { setParams((previous) => { const next = new URLSearchParams(previous); if (value) next.set(key, value); else next.delete(key); return next; }); }
  return { business, filters, view: dashboardView(params.get("view")), setFilter, paused, setPaused, refreshing: visible && !paused, visible, ready };
}
export type DashboardControls = ReturnType<typeof useDashboardControls>;
