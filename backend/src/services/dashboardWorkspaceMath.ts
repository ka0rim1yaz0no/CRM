import { attendanceSlotKey } from "./attendanceShift";

export function dashboardRange(query: Record<string, unknown>, now = new Date()) {
  const today = attendanceSlotKey(now, "Asia/Manila", "23:00", "08:00");
  const shift = (day: string, amount: number) => new Date(Date.parse(`${day}T00:00:00Z`) + amount * 86_400_000).toISOString().slice(0, 10);
  const preset = String(query.preset || "today");
  const weekday = new Date(`${today}T00:00:00Z`).getUTCDay();
  const choices: Record<string, [string, string]> = { today: [today, today], yesterday: [shift(today, -1), shift(today, -1)],
    "this-week": [shift(today, -(weekday || 7) + 1), today], "this-month": [`${today.slice(0, 7)}-01`, today],
    custom: [String(query.from || ""), String(query.to || "")] };
  const pair = choices[preset];
  const valid = (day: string) => /^\d{4}-\d{2}-\d{2}$/.test(day) && Number.isFinite(Date.parse(`${day}T00:00:00Z`)) && new Date(`${day}T00:00:00Z`).toISOString().slice(0, 10) === day;
  if (!pair || !pair.every(valid) || pair[0] > pair[1]) throw new Error("Invalid dashboard range.");
  const days = Math.round((Date.parse(pair[1]) - Date.parse(pair[0])) / 86_400_000) + 1;
  if (days > 92) throw new Error("Dashboard range must not exceed 92 days.");
  return { preset, from: pair[0], to: pair[1], previousFrom: shift(pair[0], -days), previousTo: shift(pair[0], -1), today };
}
export function metricDelta(current: number, previous: number) {
  return previous === 0 ? null : Math.round((current - previous) / Math.abs(previous) * 100);
}
export { targetProgress } from "../../../shared/dashboardMetrics";
export function leadOverdueHours(lead: { status: string; createdAt?: Date | string; followUpAt?: Date | string | null; comments?: unknown[]; activity?: unknown[] }, now: Date, newHours: number, followUpHours: number) {
  const deadline = lead.status === "NEW" && !lead.comments?.length && !lead.activity?.length
    ? Date.parse(String(lead.createdAt)) + newHours * 3_600_000
    : lead.status === "Follow up" && lead.followUpAt ? Date.parse(String(lead.followUpAt)) + followUpHours * 3_600_000 : NaN;
  return Number.isFinite(deadline) ? Math.max(0, (now.getTime() - deadline) / 3_600_000) : 0;
}
export function changedSentences(current: Record<string, number>, previous: Record<string, number>, over: number) {
  const rows: Array<{ text: string; href: string }> = [];
  const delta = metricDelta(current.callsToday, previous.callsToday);
  if (delta !== null && Number.isFinite(delta)) rows.push({ text: `Calls are ${delta >= 0 ? "up" : "down"} ${Math.abs(delta)}% versus the previous selected day.`, href: "#agent-calls" });
  if (over > 0) rows.push({ text: `${over} recorded break or lunch issues in this range.`, href: "/admin/attendance?issue=over-rest" });
  if (Number.isFinite(current.dueFollowUps)) rows.push({ text: `${current.dueFollowUps} follow-ups need attention now.`, href: "/admin/leads?scope=Follow%20up" });
  return rows.slice(0, 5);
}
export function activityTrend(leads: Array<{ _id: unknown; activity?: Array<{ actorType?: string; createdAt?: Date | string }>; comments?: Array<{ authorType?: string; createdAt?: Date | string }> }>, from: string, to: string) {
  const days = new Map<string, { day: string; count: number; comments: number; touched: Set<string> }>();
  for (let at = Date.parse(`${from}T00:00:00Z`); at <= Date.parse(`${to}T00:00:00Z`); at += 86_400_000) { const day = new Date(at).toISOString().slice(0, 10); days.set(day, { day, count: 0, comments: 0, touched: new Set() }); }
  for (const lead of leads) {
    for (const event of [...(lead.activity || []).filter((item) => item.actorType === "employee").map((item) => ({ at: item.createdAt, comment: false })), ...(lead.comments || []).filter((item) => item.authorType === "employee").map((item) => ({ at: item.createdAt, comment: true }))]) {
      const at = new Date(event.at || ""); if (!Number.isFinite(at.getTime())) continue;
      const row = days.get(attendanceSlotKey(at, "Asia/Manila", "23:00", "08:00")); if (!row) continue;
      row.count++; if (event.comment) row.comments++; row.touched.add(String(lead._id));
    }
  }
  return [...days.values()].map((row) => ({ day: row.day, count: row.count, comments: row.comments, touched: row.touched.size }));
}
