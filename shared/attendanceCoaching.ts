import { isOffPhoneStart, offPhoneShiftBilling, type OffPhoneRecord } from "./attendanceOffPhone";

export const coachingOutSource = "Coaching Out" as const;
export const coachingInSource = "Coaching In" as const;
export const coachingPaidMinutes = 20;

export function attendanceAwayReturnSource(events: Array<{ source: string }>) {
    const latest = [...events].reverse().find(event => isOffPhoneStart(event.source) || event.source === coachingOutSource);
    return latest?.source === coachingOutSource ? coachingInSource : "Off the Phone In" as const;
}

export function coachingShiftBilling(records: OffPhoneRecord[], start: Date, end: Date, now: Date) {
    const mapped = records.filter(record => +record.timeIn >= +start).flatMap(record => {
        if (record.source === coachingOutSource) return [{ ...record, source: "Off the Phone Out" }];
        if (record.source === coachingInSource) return [{ ...record, source: "Off the Phone In" }];
        return ["Time In", "Login", "Time Out", "Logout"].includes(record.source) ? [record] : [];
    });
    const billing = offPhoneShiftBilling(mapped, start, end, now, { paidMinutes: coachingPaidMinutes, effectiveFrom: "1970-01-01T00:00:00Z" });
    const current = offPhoneShiftBilling(mapped, start, new Date(Math.max(+end, +now + 1)), now,
        { paidMinutes: coachingPaidMinutes, effectiveFrom: "1970-01-01T00:00:00Z" }).active;
    return { limited: true as const, endsAt: billing.endsAt, paidUsedMs: billing.paidUsedMs || 0,
        remainingPaidMs: billing.remainingPaidMs || 0, totalMs: billing.paidUsedMs || 0,
        active: current ? { startedAt: current.startedAt,
            returnAt: new Date(Math.min(+end, Date.parse(current.nonBillableFrom!))).toISOString() } : null };
}

export type CoachingBillingSnapshot = ReturnType<typeof coachingShiftBilling>;
