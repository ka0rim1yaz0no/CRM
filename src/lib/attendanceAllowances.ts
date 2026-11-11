import type { CoachingBillingSnapshot } from "../../shared/attendanceCoaching";
import type { OffPhoneBillingSnapshot } from "../../shared/attendanceOffPhone";
import type { AttendanceSessionSnapshot } from "../api/attendanceSession";

export function coachingRemainingMs(billing: CoachingBillingSnapshot | null | undefined, now: number) {
    if (!billing || billing.limited === false || !Number.isFinite(now) || !Number.isFinite(Date.parse(billing.endsAt))) return null;
    if (now >= Date.parse(billing.endsAt)) return 0;
    const remaining = billing.active ? billing.active.returnAt ? Date.parse(billing.active.returnAt) - now : null : billing.remainingPaidMs;
    return typeof remaining === "number" && Number.isFinite(remaining) ? Math.max(0, remaining) : null;
}

export function coachingElapsedMs(billing: CoachingBillingSnapshot | null | undefined, now: number, serverTime: number) {
    if (!billing || !Number.isFinite(billing.totalMs) || !Number.isFinite(now) || !Number.isFinite(serverTime) ||
        !Number.isFinite(Date.parse(billing.endsAt))) return null;
    const end = Date.parse(billing.endsAt);
    return Math.max(0, billing.totalMs) + (billing.active ? Math.max(0, Math.min(now, end) - Math.min(serverTime, end)) : 0);
}

export function offPhoneRemainingMs(billing: OffPhoneBillingSnapshot | null | undefined, now: number) {
    if (!billing?.limited || !Number.isFinite(now) || billing.endsAt && !Number.isFinite(Date.parse(billing.endsAt))) return null;
    if (billing.endsAt && now >= Date.parse(billing.endsAt)) return 0;
    const remaining = billing.active?.nonBillableFrom ? Date.parse(billing.active.nonBillableFrom) - now : billing.remainingPaidMs;
    return typeof remaining === "number" && Number.isFinite(remaining) ? Math.max(0, remaining) : null;
}

export function allowanceClock(milliseconds: number | null) {
    if (milliseconds === null || !Number.isFinite(milliseconds)) return "--:--";
    const seconds = Math.ceil(Math.max(0, milliseconds) / 1000);
    return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

export function attendanceAwayDisabledReason(snapshot: AttendanceSessionSnapshot, activity: "coaching" | "off-phone", now: number, saving = false) {
    if (saving) return "Saving attendance";
    if (snapshot.reviewState !== "verified") return "Attendance needs review";
    const coaching = snapshot.state === "OFF THE PHONE" && Boolean(snapshot.coachingBilling?.active);
    if (activity === "off-phone" && coaching) return "Coaching is active";
    if (snapshot.state === "OFFLINE") return "Time In required";
    if (activity === "coaching") {
        const unlimited = snapshot.coachingBilling?.limited === false;
        const remaining = coachingRemainingMs(snapshot.coachingBilling, now);
        if (coaching && remaining === 0) return "Returning Online";
        if (snapshot.assignedShift && now < Date.parse(snapshot.assignedShift.start)) {
            const start = new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Manila", hour: "numeric", minute: "2-digit" }).format(new Date(snapshot.assignedShift.start));
            return `Available at ${start} PH`;
        }
        if (snapshot.coachingBilling && now >= Date.parse(snapshot.coachingBilling.endsAt)) return "Shift ended";
        if (!unlimited && remaining === null) return "Allowance unavailable";
        if (!unlimited && remaining !== null && remaining <= 0) return "20-minute allowance used";
    }
    if (snapshot.state === "BREAK") return "Return from break first";
    if (snapshot.state === "LUNCH") return "Return from lunch first";
    if (snapshot.state === "OFF THE PHONE" && !coaching && activity === "coaching") return "Off the Phone is active";
    return "Unavailable for current attendance";
}
