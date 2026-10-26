const decimalHours = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });

export function formatPayrollHours(value: number | null | undefined) {
    const hours = value ?? 0;
    return Number.isFinite(hours) ? `${decimalHours.format(hours)}h` : "--";
}
