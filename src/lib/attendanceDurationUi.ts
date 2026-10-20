type DurationEvent = { source: string; timeIn: string; sequence?: number; _id?: string };
export type AttendanceDurationControl = {
    label: "Break 1" | "Break 2" | "Lunch";
    state: "available" | "active" | "done" | "review";
    durationMs: number;
    excessMs: number | null;
    allowanceMinutes: number;
};

export function attendanceDurationControls(records: DurationEvent[], nowMs: number,
    allowances = { breakMinutes: 15, lunchMinutes: 60 },
    serverExcessRows?: Array<{ startedAt: string; endedAt: string | null; durationMs: number; overMs: number }>,
    closedEventIds: ReadonlySet<string> = new Set()): AttendanceDurationControl[] {
    const ordered = [...records].sort((a, b) => Date.parse(a.timeIn) - Date.parse(b.timeIn) || (a.sequence ?? 0) - (b.sequence ?? 0));
    const intervals = (out: string, incoming: string) => {
        const result: Array<{ start: number; end: number | null; needsReview: boolean; closedSession: boolean }> = [];
        let open: (typeof result)[number] | null = null;
        for (const record of ordered) {
            const at = Date.parse(record.timeIn);
            if (!Number.isFinite(at)) continue;
            if (record.source === out && !open) {
                open = { start: at, end: null, needsReview: false, closedSession: closedEventIds.has(record._id || "") };
                result.push(open);
            } else if (open && record.source === incoming) {
                open.end = at;
                open = null;
            } else if (open && ["Time Out", "Logout", "Time In", "Login"].includes(record.source)) {
                open.needsReview = true;
                open = null;
            }
        }
        if (open?.closedSession) open.needsReview = true;
        return result;
    };
    const breaks = intervals("Break Out", "Break In");
    const lunches = intervals("Lunch Break Out", "Lunch Break In");
    return (["Break 1", "Break 2", "Lunch"] as const).map((label, index) => {
        const interval = index === 2 ? lunches[0] : breaks[index];
        const allowanceMinutes = index === 2 ? allowances.lunchMinutes : allowances.breakMinutes;
        const serverRow = interval && interval.end !== null ? serverExcessRows?.find((row) =>
            Date.parse(row.startedAt) === interval.start && row.endedAt !== null && Date.parse(row.endedAt) === interval.end) : undefined;
        const durationMs = serverRow?.durationMs ?? (interval && !interval.needsReview ? Math.max(0, (interval.end ?? nowMs) - interval.start) : 0);
        const excessMs = interval?.needsReview ? null : interval?.end != null
            ? serverExcessRows ? serverRow?.overMs ?? 0 : null
            : Math.max(0, durationMs - allowanceMinutes * 60_000);
        return { label, state: interval ? interval.needsReview ? "review" : interval.end === null ? "active" : "done" : "available",
            durationMs, excessMs, allowanceMinutes };
    });
}

export function validAttendanceCutoff(value: string) {
    return /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
}

export function attendanceBreakControl(controls: AttendanceDurationControl[]) {
    const breaks = controls.filter((control) => control.label !== "Lunch");
    const control = breaks.find((item) => item.state === "active") || breaks.find((item) => item.state === "available")
        || breaks.find((item) => item.state === "review") || breaks[breaks.length - 1];
    return { control, breakNumber: breaks.indexOf(control) + 1,
        used: breaks.filter((item) => item.state !== "available").length,
        completed: breaks.filter((item) => item.state === "done").length,
        exhausted: breaks.length === 2 && breaks.every((item) => item.state === "done") };
}

export function hasAutoTimeOut(day: { autoTimeOut?: boolean; events: Array<{ source: string; autoTimeOut?: boolean }> }) {
    return day.autoTimeOut === true || day.events.some((event) =>
        event.autoTimeOut === true && (event.source === "Time Out" || event.source === "Logout"));
}
