import type { QueryClient } from "@tanstack/react-query";
import { refreshAttendanceWorkspace } from "./employeeWorkspaceCache";

type AttendanceSocket = { on: (event: string, listener: (payload?: { employeeId?: string }) => void) => unknown; off: (event: string, listener: (payload?: { employeeId?: string }) => void) => unknown };
type Visibility = Pick<Document, "visibilityState" | "addEventListener" | "removeEventListener">;

export function registerAttendanceWorkspaceRefresh(client: QueryClient, socket: AttendanceSocket, page: Visibility = document, employeeId?: string) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let refreshing = false, queued = false, disposed = false;
    const refresh = () => {
        if (disposed || page.visibilityState !== "visible") return;
        if (refreshing) { queued = true; return; }
        if (timer !== undefined) return;
        timer = setTimeout(() => {
            timer = undefined;
            if (disposed) return;
            refreshing = true;
            void refreshAttendanceWorkspace(client).catch(() => { /* Queries retain their own refresh error state. */ }).finally(() => {
                refreshing = false;
                if (queued) { queued = false; refresh(); }
            });
        }, 250);
    };
    const attendance = (payload?: { employeeId?: string }) => { if (!employeeId || payload?.employeeId === employeeId) refresh(); };
    socket.on("employee:availability-updated", attendance);
    socket.on("connect", refresh);
    page.addEventListener("visibilitychange", refresh);
    return () => {
        disposed = true;
        if (timer !== undefined) clearTimeout(timer);
        socket.off("employee:availability-updated", attendance);
        socket.off("connect", refresh);
        page.removeEventListener("visibilitychange", refresh);
    };
}
