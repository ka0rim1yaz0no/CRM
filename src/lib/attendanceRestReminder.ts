import type { AttendanceSessionSnapshot } from "../api/attendanceSession";
import { attendanceServerNow } from "./attendanceHubState";

export function attendanceRestReminder(snapshot: AttendanceSessionSnapshot | undefined, employeeCode: string, localNow: number) {
    if (!snapshot?.sessionId || !employeeCode || !["BREAK", "LUNCH"].includes(snapshot.state) || !snapshot.stateSince || !snapshot.allowances ||
        !Number.isFinite(snapshot.receivedAt) || localNow - snapshot.receivedAt > 90_000) return null;
    const session = snapshot.sessions.find(item => item.id === snapshot.sessionId);
    if (!session || session.endedAt || session.lifecycle !== "open" || session.mode !== snapshot.state) return null;
    const minutes = snapshot.state === "BREAK" ? snapshot.allowances.breakMinutes : snapshot.allowances.lunchMinutes;
    const start = Date.parse(snapshot.stateSince), now = attendanceServerNow(snapshot.serverTime, snapshot.receivedAt, localNow);
    if (!Number.isFinite(start) || !Number.isFinite(now) || !Number.isFinite(minutes) || minutes < 0 || now <= start + minutes * 60_000) return null;
    return { id: `${employeeCode}:${snapshot.sessionId}:${snapshot.state}:${snapshot.stateSince}`, kind: snapshot.state === "BREAK" ? "Break" : "Lunch",
        overdueMs: now - start - minutes * 60_000, allowanceMinutes: minutes };
}
