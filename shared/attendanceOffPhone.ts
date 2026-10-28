export const nonBillableOffPhoneSource = "Non-Billable Off the Phone Out" as const;

export function isOffPhoneStart(source?: string) {
    return source === "Off the Phone Out" || source === nonBillableOffPhoneSource;
}

export type OffPhoneLimitPolicy = { paidMinutes: number; effectiveFrom: string };
export type OffPhoneRecord = { source: string; timeIn: Date };
export type OffPhoneBillingSnapshot = { limited: boolean; paidUsedMs: number | null; remainingPaidMs: number | null;
    endsAt?: string;
    active: { startedAt: string; nonBillableFrom: string | null; automatic: boolean } | null };
export function offPhoneNonBillableAt(billing: OffPhoneBillingSnapshot | null | undefined, now: number) {
    if (billing?.endsAt && now >= Date.parse(billing.endsAt)) return false;
    const since = billing?.active?.nonBillableFrom;
    return Boolean(since && Number.isFinite(Date.parse(since)) && now >= Date.parse(since));
}

// The allowance belongs to the assigned shift, not to a browser, business copy or Time In session.
export function offPhoneShiftBilling(records: OffPhoneRecord[], start: Date, end: Date, now: Date, policy?: OffPhoneLimitPolicy) {
    const until = Math.max(+start, Math.min(+end, +now));
    const limited = Boolean(policy && Number.isFinite(Date.parse(policy.effectiveFrom)) && +start >= Date.parse(policy.effectiveFrom) &&
        Number.isFinite(policy.paidMinutes) && policy.paidMinutes >= 0);
    let remaining = limited ? policy!.paidMinutes * 60_000 : Infinity;
    const intervals: Array<{ start: Date; end: Date; milliseconds: number; open: boolean; minutes: number; automatic?: boolean }> = [];
    let active: { at: number; nonBillable: boolean } | null = null;
    let current: { startedAt: string; nonBillableFrom: string | null; automatic: boolean } | null = null;
    const close = (at: number, open: boolean) => {
        if (!active) return;
        const from = Math.max(+start, active.at), to = Math.max(from, Math.min(until, at));
        const duration = Math.max(0, to - from), paid = active.nonBillable ? 0 : Math.min(remaining, duration);
        const nonBillableFrom = active.nonBillable ? from : limited ? from + remaining : null;
        if (open && +now < +end) current = { startedAt: new Date(active.at).toISOString(),
            nonBillableFrom: nonBillableFrom !== null && Number.isFinite(nonBillableFrom) ? new Date(nonBillableFrom).toISOString() : null, automatic: !active.nonBillable };
        if (active.nonBillable || limited && duration > paid) {
            const milliseconds = active.nonBillable ? duration : duration - paid;
            intervals.push({ start: new Date(active.nonBillable ? from : from + paid), end: new Date(to), milliseconds,
                open, minutes: Math.ceil(milliseconds / 60_000), ...(!active.nonBillable ? { automatic: true } : {}) });
        }
        if (!active.nonBillable) remaining -= paid;
        active = null;
    };
    const ordered = records.map((record, index) => ({ ...record, index }))
        .filter(record => Number.isFinite(+record.timeIn) && +record.timeIn <= +now)
        .sort((a, b) => +a.timeIn - +b.timeIn || a.index - b.index);
    for (const record of ordered) {
        if (isOffPhoneStart(record.source)) {
            if (!active) active = { at: +record.timeIn, nonBillable: record.source === nonBillableOffPhoneSource };
        } else if (["Off the Phone In", "Time Out", "Logout", "Time In", "Login"].includes(record.source)) close(+record.timeIn, false);
    }
    close(until, true);
    return { intervals, endsAt: end.toISOString(), active: current as { startedAt: string; nonBillableFrom: string | null; automatic: boolean } | null,
        paidUsedMs: limited ? policy!.paidMinutes * 60_000 - remaining : null, remainingPaidMs: limited ? remaining : null, limited };
}

// Both kinds return through the same existing Back on Phone event.
export function nonBillableOffPhoneIntervals(records: Array<{ source: string; timeIn: Date }>, start: Date, end: Date, now: Date, policy?: OffPhoneLimitPolicy) {
    if (policy) return offPhoneShiftBilling(records, start, end, now, policy).intervals;
    const until = Math.max(+start, Math.min(+end, +now));
    const intervals: Array<{ start: Date; end: Date; milliseconds: number; open: boolean; minutes: number }> = [];
    let active: { at: number; nonBillable: boolean } | null = null;
    const close = (at: number, open: boolean) => {
        if (active?.nonBillable) {
            const from = Math.max(+start, active.at), to = Math.max(from, Math.min(until, at));
            const milliseconds = Math.max(0, to - from);
            intervals.push({ start: new Date(from), end: new Date(to), milliseconds, open, minutes: Math.ceil(milliseconds / 60_000) });
        }
        active = null;
    };
    const ordered = records.map((record, index) => ({ ...record, index }))
        .filter(record => Number.isFinite(+record.timeIn) && +record.timeIn <= +now)
        .sort((a, b) => +a.timeIn - +b.timeIn || a.index - b.index);
    for (const record of ordered) {
        if (isOffPhoneStart(record.source)) {
            if (!active) active = { at: +record.timeIn, nonBillable: record.source === nonBillableOffPhoneSource };
        } else if (["Off the Phone In", "Time Out", "Logout", "Time In", "Login"].includes(record.source)) {
            close(+record.timeIn, false);
        }
    }
    close(until, true);
    return intervals;
}
