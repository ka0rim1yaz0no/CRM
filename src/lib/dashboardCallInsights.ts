export function dashboardHourOrder(shiftStart = "23:00", shiftEnd = "08:00") {
    const parse = (time: string, fallback: number) => /^([01]\d|2[0-3]):[0-5]\d$/.test(time)
        ? Number(time.slice(0, 2)) * 60 + Number(time.slice(3)) : fallback;
    const start = parse(shiftStart, 23 * 60), end = parse(shiftEnd, 8 * 60);
    const duration = (end - start + 1440) % 1440 || 1440;
    return Array.from({ length: 24 }, (_, index) => ({ hour: (Math.floor(start / 60) + index) % 24, offset: index * 60 - start % 60 }))
        .filter(row => row.offset < duration && row.offset + 60 > 0).map(row => row.hour);
}

export function phHourLabel(hour: number) {
    return `${hour % 12 || 12} ${hour < 12 ? "AM" : "PM"}`;
}

export function phShiftTimeLabel(time: string) {
    const hour = Number(time.slice(0, 2)), minutes = time.slice(3);
    return `${hour % 12 || 12}${minutes !== "00" ? `:${minutes}` : ""} ${hour < 12 ? "AM" : "PM"}`;
}

export function recordedTalkTime(seconds: number, calls: number) {
    if (!Number.isFinite(seconds) || seconds <= 0) return calls > 0 ? "Talk time not recorded" : "No recorded talk time";
    const whole = Math.floor(seconds), minutes = Math.floor(whole / 60), remainder = whole % 60;
    return `${minutes ? `${minutes}m${remainder ? ` ${remainder}s` : ""}` : `${Math.max(1, whole)}s`} recorded talk time`;
}
