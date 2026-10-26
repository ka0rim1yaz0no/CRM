import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { registerAttendanceWorkspaceRefresh } from "../lib/attendanceWorkspaceLive";
import { connectAuthenticatedSocket, socket } from "../lib/socket";

export function useAttendanceWorkspaceRefresh(enabled = true, employeeId?: string) {
    const client = useQueryClient();
    useEffect(() => {
        if (!enabled) return;
        const stop = registerAttendanceWorkspaceRefresh(client, socket, document, employeeId);
        connectAuthenticatedSocket();
        return stop;
    }, [client, enabled, employeeId]);
}
