export const attendanceBreaksPerShift = 2;

export function attendanceBreakAllowanceLabel(minutesPerBreak: number) {
    return `${attendanceBreaksPerShift} x ${minutesPerBreak}m (${attendanceBreaksPerShift * minutesPerBreak}m total)`;
}

export function attendanceIssueLabel(issue: string) {
    return issue === "UNDER TIME" ? "UNDERTIME" : issue;
}
