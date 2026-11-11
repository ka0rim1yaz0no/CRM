import { isOffPhoneStart, offPhoneShiftBilling, type OffPhoneRecord } from "./attendanceOffPhone";

export const coachingOutSource = "Coaching Out" as const;
export const coachingInSource = "Coaching In" as const;
export type CoachingBillingSnapshot = {
    limited: boolean;
    endsAt: string;
    paidUsedMs: number;
    remainingPaidMs: number | null;
    totalMs: number;
    active: { startedAt: string; returnAt: string | null } | null;
};

export function attendanceAwayReturnSource(events: Array<{ source: string }>) {
    const latest = [...events].reverse().find(event => isOffPhoneStart(event.source) || event.source === coachingOutSource);
    return latest?.source === coachingOutSource ? coachingInSource : "Off the Phone In" as const;
}

export function coachingShiftBilling(records: OffPhoneRecord[], start: Date, end: Date, now: Date): CoachingBillingSnapshot {
    const mapped = records.filter(record => +record.timeIn >= +start).flatMap(record => {
        if (record.source === coachingOutSource) return [{ ...record, source: "Off the Phone Out" }];
        if (record.source === coachingInSource) return [{ ...record, source: "Off the Phone In" }];
        return ["Time In", "Login", "Time Out", "Logout"].includes(record.source) ? [record] : [];
    });
    // Reuse the existing interval parser with the whole accounting window paid.
    // That window still bounds shift totals; it is not a Coaching allowance.
    const paidWindow = (until: Date) => ({ paidMinutes: Math.max(0, Math.ceil((+until - +start) / 60_000)), effectiveFrom: "1970-01-01T00:00:00Z" });
    const billing = offPhoneShiftBilling(mapped, start, end, now, paidWindow(end));
    const openUntil = new Date(Math.max(+end, +now + 1));
    const current = offPhoneShiftBilling(mapped, start, openUntil, now, paidWindow(openUntil)).active;
    return { limited: false, endsAt: billing.endsAt, paidUsedMs: billing.paidUsedMs || 0,
        remainingPaidMs: null, totalMs: billing.paidUsedMs || 0,
        active: current ? { startedAt: current.startedAt, returnAt: null } : null };
}
