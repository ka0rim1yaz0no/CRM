import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router";
import { FiBell } from "react-icons/fi";
import { attendanceIntegrityEnabled, getAttendanceSession } from "../api/attendanceSession";
import { getActiveBusinessId } from "../api/businessStorage";
import { attendanceRestReminder } from "../lib/attendanceRestReminder";
import { attendanceShiftReminder } from "../lib/attendanceShiftReminder";
import { getSystemSettings } from "../api/systemSettings";
import { attendanceRestSound } from "../lib/messageSound";
import { socket } from "../lib/socket";
import { offPhoneNonBillableAt } from "../../shared/attendanceOffPhone";
import { attendanceServerNow } from "../lib/attendanceHubState";

export default function EmployeeRestReminder({ employeeId, employeeCode }: { employeeId: string; employeeCode: string }) {
    const businessId = getActiveBusinessId(), [now, setNow] = useState(Date.now);
    const query = useQuery({ queryKey: ["attendance-session", businessId, employeeId], queryFn: () => getAttendanceSession(employeeId, businessId),
        enabled: attendanceIntegrityEnabled && Boolean(employeeId && employeeCode), refetchInterval: 30_000, refetchIntervalInBackground: true, refetchOnWindowFocus: true });
    const settings = useQuery({ queryKey: ["system-settings"], queryFn: getSystemSettings,
        enabled: attendanceIntegrityEnabled && Boolean(employeeId && employeeCode), staleTime: 60_000, refetchInterval: 60_000, refetchOnWindowFocus: true });
    const refetch = query.refetch;
    useEffect(() => {
        const changed = (payload: { employeeId?: string }) => { if (payload.employeeId === employeeId) void refetch(); };
        const connected = () => { void refetch(); };
        socket.on("employee:availability-updated", changed); socket.on("connect", connected);
        return () => { socket.off("employee:availability-updated", changed); socket.off("connect", connected); };
    }, [employeeId, businessId, refetch]);
    useEffect(() => {
        const timer = window.setInterval(() => setNow(Date.now()), 1000);
        const visible = () => setNow(Date.now()); document.addEventListener("visibilitychange", visible);
        return () => { window.clearInterval(timer); document.removeEventListener("visibilitychange", visible); };
    }, []);
    const reminder = query.isError ? null : attendanceRestReminder(query.data, employeeCode, now);
    const shiftReminder = query.isError || settings.isError || reminder ? null : attendanceShiftReminder(query.data, employeeCode, settings.data, now);
    const id = reminder?.id || shiftReminder?.id;
    useEffect(() => {
        if (!id) return;
        void attendanceRestSound.incoming(id);
        const unlock = () => { void attendanceRestSound.unlock(); };
        window.addEventListener("pointerdown", unlock); window.addEventListener("keydown", unlock);
        return () => { attendanceRestSound.cancel(id); window.removeEventListener("pointerdown", unlock); window.removeEventListener("keydown", unlock); };
    }, [id]);
    if (!query.isError && query.data?.state === "OFF THE PHONE" && now - query.data.receivedAt <= 90_000 && offPhoneNonBillableAt(query.data.offPhoneBilling,
        attendanceServerNow(query.data.serverTime, query.data.receivedAt, now))) return <aside className="employee-rest-reminder" aria-label="Non-billable Off the Phone">
        <FiBell aria-hidden="true" /><div><strong role="alert">Non-billable Off the Phone</strong><span>Non-billable time is accruing.</span></div><Link to="/attendance">Attendance</Link>
    </aside>;
    if (shiftReminder) return <aside className="employee-rest-reminder" aria-label="Time In needed">
        <FiBell aria-hidden="true" /><div><strong role="alert">Time In not recorded</strong><span>Your shift started at {shiftReminder.shiftStartLabel} PH.</span></div>
        <Link to="/attendance">Attendance</Link>
    </aside>;
    if (!reminder) return null;
    const seconds = Math.max(1, Math.floor(reminder.overdueMs / 1000)), clock = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
    return <aside className="employee-rest-reminder" aria-label={`${reminder.kind} overdue`}>
        <FiBell aria-hidden="true" /><div><strong role="alert">{reminder.kind} allowance exceeded</strong><span>Over by <time>{clock}</time> ({reminder.allowanceMinutes} min allowance)</span></div>
        <Link to="/attendance">Attendance</Link>
    </aside>;
}
