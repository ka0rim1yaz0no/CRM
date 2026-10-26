export const nonBillableOffPhoneSource = "Non-Billable Off the Phone Out" as const;

export function isOffPhoneStart(source?: string) {
    return source === "Off the Phone Out" || source === nonBillableOffPhoneSource;
}

// Both kinds return through the same existing Back on Phone event.
export function nonBillableOffPhoneIntervals(records: Array<{ source: string; timeIn: Date }>, start: Date, end: Date, now: Date) {
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
