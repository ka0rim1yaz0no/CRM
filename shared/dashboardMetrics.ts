export function targetProgress(actual: number, target: number, elapsed: number) {
  if (target <= 0) return { percent: 0, state: "Set a target" };
  return { percent: Math.min(100, Math.max(0, actual / target * 100)), state: actual >= target * Math.max(0, Math.min(1, elapsed)) ? "On track" : "Behind" };
}

export function targetPeriodMatches(period: "daily" | "monthly", from: string, to: string, today: string) {
  if (period === "daily") return from === to;
  if (!from.endsWith("-01") || from.slice(0, 7) !== to.slice(0, 7)) return false;
  const next = new Date(`${from}T00:00:00Z`);
  next.setUTCMonth(next.getUTCMonth() + 1);
  next.setUTCDate(0);
  const monthEnd = next.toISOString().slice(0, 10);
  return to === monthEnd || (from.slice(0, 7) === today.slice(0, 7) && to === today);
}
