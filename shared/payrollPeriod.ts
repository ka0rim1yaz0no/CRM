const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const fullMonths = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

function monthIndex(value: string) {
    const index = months.findIndex((month, i) => [month.toLowerCase(), fullMonths[i].toLowerCase()].includes(value.toLowerCase()));
    return value.toLowerCase() === "sept" ? 8 : index;
}
function dateKey(year: number, month: number, day: number) {
    if (year < 1900 || year > 9999 || month < 0 || month > 11 || day < 1 || day > 31) return null;
    const date = new Date(Date.UTC(year, month, day));
    return date.getUTCFullYear() === year && date.getUTCMonth() === month && date.getUTCDate() === day ? date.toISOString().slice(0, 10) : null;
}
function parseDate(value: string) {
    const iso = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (iso) return dateKey(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]));
    const named = value.match(/^([A-Za-z]+) (\d{1,2}), (\d{4})$/);
    return named ? dateKey(Number(named[3]), monthIndex(named[1]), Number(named[2])) : null;
}
function label(key: string) {
    const [year, month, day] = key.split("-").map(Number);
    return `${months[month - 1]} ${day}, ${year}`;
}

// Calendar keys are timezone-independent. Unknown labels must never become "this month".
export function savedPayrollPeriod(value: string) {
    const text = value.trim().replace(/\s+/g, " ");
    const explicit = text.split(" - ");
    let start: string | null = null, end: string | null = null;
    if (explicit.length === 2) { start = parseDate(explicit[0]); end = parseDate(explicit[1]); }
    else {
        const monthly = text.match(/^([A-Za-z]+) (\d{4})(?: (\d{1,2})-(End|\d{1,2}))?$/i);
        if (monthly) {
            const year = Number(monthly[2]), month = monthIndex(monthly[1]);
            if (month < 0) return null;
            const last = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
            const firstDay = monthly[3] ? Number(monthly[3]) : 1;
            const lastDay = monthly[4] && monthly[4].toLowerCase() !== "end" ? Number(monthly[4]) : last;
            const startMonth = firstDay > lastDay ? new Date(Date.UTC(year, month - 1, 1)) : new Date(Date.UTC(year, month, 1));
            start = dateKey(startMonth.getUTCFullYear(), startMonth.getUTCMonth(), firstDay);
            end = dateKey(year, month, lastDay);
        }
    }
    if (!start || !end || start > end) return null;
    return { start, end, label: `${label(start)} - ${label(end)}` };
}

export function isConfiguredSavedPayrollPeriod(period: NonNullable<ReturnType<typeof savedPayrollPeriod>>, settings: {
    payrollBillingCycle?: string; payrollFirstCutoffStartDay?: number; payrollFirstCutoffEndDay?: number;
    payrollSecondCutoffStartDay?: number; payrollSecondCutoffEndDay?: number;
}) {
    const start = new Date(`${period.start}T00:00:00Z`);
    const day = (value: number | undefined, fallback: number) => Number.isFinite(value) ? Math.min(31, Math.max(1, Math.round(value!))) : fallback;
    const ranges = (settings.payrollBillingCycle || "Semi-monthly") === "Semi-monthly"
        ? [[day(settings.payrollFirstCutoffStartDay, 6), day(settings.payrollFirstCutoffEndDay, 20)],
            [day(settings.payrollSecondCutoffStartDay, 21), day(settings.payrollSecondCutoffEndDay, 5)]] : [[6, 5]];
    return ranges.some(([first, last]) => {
        const lastStartDay = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 0)).getUTCDate();
        if (start.getUTCDate() !== Math.min(first, lastStartDay)) return false;
        const endMonth = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + (first > last ? 1 : 0), 1));
        const lastEndDay = new Date(Date.UTC(endMonth.getUTCFullYear(), endMonth.getUTCMonth() + 1, 0)).getUTCDate();
        return dateKey(endMonth.getUTCFullYear(), endMonth.getUTCMonth(), Math.min(last, lastEndDay)) === period.end;
    });
}
