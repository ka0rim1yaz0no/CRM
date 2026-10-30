import type { CoachingBillingSnapshot } from "../../shared/attendanceCoaching";
import type { OffPhoneBillingSnapshot } from "../../shared/attendanceOffPhone";

export function coachingRemainingMs(billing: CoachingBillingSnapshot | null | undefined, now: number) {
    if (!billing) return null;
    if (now >= Date.parse(billing.endsAt)) return 0;
    return Math.max(0, billing.active ? Date.parse(billing.active.returnAt) - now : billing.remainingPaidMs);
}

export function offPhoneRemainingMs(billing: OffPhoneBillingSnapshot | null | undefined, now: number) {
    if (!billing?.limited) return null;
    if (billing.endsAt && now >= Date.parse(billing.endsAt)) return 0;
    return Math.max(0, billing.active?.nonBillableFrom ? Date.parse(billing.active.nonBillableFrom) - now : billing.remainingPaidMs ?? 0);
}

export function allowanceClock(milliseconds: number | null) {
    if (milliseconds === null) return "--:--";
    const seconds = Math.ceil(Math.max(0, milliseconds) / 1000);
    return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}
