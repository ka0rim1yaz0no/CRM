import type { AttendanceSource } from "../models/Attendance";

export type DashboardEvent = { source: AttendanceSource; timeIn: Date; eventId?: string };
export type DashboardSnapshot = {
  employee: { _id: string; name: string; employeeCode: string; role: string; team: string };
  business: { id: string; name: string };
  events: DashboardEvent[];
};

export function groupDashboardSnapshots(snapshots: DashboardSnapshot[], businessId?: string) {
  const grouped = new Map<string, {
    employee: DashboardSnapshot["employee"];
    businesses: DashboardSnapshot["business"][];
    events: DashboardEvent[];
    eventsByBusiness: Map<string, DashboardEvent[]>;
  }>();
  for (const snapshot of snapshots) {
    const code = snapshot.employee.employeeCode;
    if (!code) continue;
    const group = grouped.get(code) || { employee: snapshot.employee, businesses: [], events: [],
      eventsByBusiness: new Map<string, DashboardEvent[]>() };
    group.businesses.push(snapshot.business);
    group.eventsByBusiness.set(snapshot.business.id, snapshot.events);
    const seen = new Set(group.events.map((event) => event.eventId || `${event.source}|${event.timeIn.toISOString()}`));
    for (const event of snapshot.events) {
      const key = event.eventId || `${event.source}|${event.timeIn.toISOString()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      group.events.push(event);
    }
    grouped.set(code, group);
  }
  if (businessId) {
    for (const [code, group] of grouped) {
      if (!group.businesses.some((business) => business.id === businessId)) grouped.delete(code);
    }
  }
  return grouped;
}
