import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import EmployeeLiveShare from "../../components/EmployeeLiveShare";
import Navbar from "./navbar";
import SideBar from "./sidebar";
import "./employeeWorkspace.css";
import { useQueryClient } from "@tanstack/react-query";
import { getAuthUser } from "../../api/authStorage";
import { connectAuthenticatedSocket, socket } from "../../lib/socket";
import { refreshEmployeeWorkspace } from "../../lib/employeeWorkspaceCache";
import { useAttendanceWorkspaceRefresh } from "../../hooks/useAttendanceWorkspaceRefresh";

type Props = {
    children: ReactNode;
};

export default function MainLayout({ children }: Props) {
    const queryClient = useQueryClient();
    const auth = getAuthUser();
    const employeeId = auth?.userType === "employee" ? auth.user._id : "";
    useAttendanceWorkspaceRefresh(Boolean(employeeId), employeeId);
    useEffect(() => {
        if (!employeeId) return;
        let timer: number | undefined;
        const refresh = () => {
            window.clearTimeout(timer);
            timer = window.setTimeout(() => refreshEmployeeWorkspace(queryClient, employeeId), 250);
        };
        const ownUpdate = (payload: { employeeId?: string }) => {
            if (payload.employeeId === employeeId) refresh();
        };
        const visible = () => { if (document.visibilityState === "visible") refresh(); };
        socket.on("employee:availability-updated", ownUpdate);
        socket.on("lead:changed", refresh);
        socket.on("lead-call-stat:updated", refresh);
        socket.on("connect", refresh);
        connectAuthenticatedSocket();
        document.addEventListener("visibilitychange", visible);
        return () => { window.clearTimeout(timer); socket.off("employee:availability-updated", ownUpdate); socket.off("lead:changed", refresh); socket.off("lead-call-stat:updated", refresh); socket.off("connect", refresh); document.removeEventListener("visibilitychange", visible); };
    }, [employeeId, queryClient]);
    const [isScrolling, setIsScrolling] = useState(false);
    const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(() => window.localStorage.getItem("crm:sidebar-collapsed") === "true");
    const scrollTimer = useRef<number | undefined>(undefined);

    const handleScroll = () => {
        setIsScrolling(true);
        window.clearTimeout(scrollTimer.current);
        scrollTimer.current = window.setTimeout(() => setIsScrolling(false), 700);
    };

    useEffect(() => {
        const syncSidebar = () => setIsSidebarCollapsed(window.localStorage.getItem("crm:sidebar-collapsed") === "true");
        window.addEventListener("crm:sidebar-toggle", syncSidebar);
        return () => window.removeEventListener("crm:sidebar-toggle", syncSidebar);
    }, []);

    return (
        <div className="theme-app-bg employee-workspace h-screen overflow-hidden text-white">
            <div className="pointer-events-none fixed inset-0 bg-[radial-gradient(circle_at_0%_20%,color-mix(in_srgb,var(--primary)_18%,transparent),transparent_28%),radial-gradient(circle_at_95%_0%,color-mix(in_srgb,var(--secondary)_14%,transparent),transparent_24%),linear-gradient(135deg,rgba(255,255,255,0.035),transparent_26%)]" />
            <div className="pointer-events-none fixed inset-0 bg-[linear-gradient(90deg,rgba(255,255,255,0.025)_1px,transparent_1px),linear-gradient(180deg,rgba(255,255,255,0.018)_1px,transparent_1px)] bg-[size:4rem_4rem] opacity-20" />
            <SideBar />
            <main className={["relative flex h-screen flex-col transition-[padding] duration-200", isSidebarCollapsed ? "pl-[5rem]" : "pl-[16rem]"].join(" ")}>
                <Navbar />
                <div
                    className={[
                        "content-scroll min-h-0 flex-1 overflow-y-auto p-6",
                        isScrolling ? "is-scrolling" : "",
                    ].join(" ")}
                    onScroll={handleScroll}
                >
                    <EmployeeLiveShare />
                    {children}
                </div>
            </main>
        </div>
    );
}
