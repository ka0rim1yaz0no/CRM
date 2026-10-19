import type { Request } from "express";
type Window = { start: Date; end: Date; dateFrom: string; dateTo: string; recordActivity: (employeeId: string, leadId: string, at: Date | string, comment: boolean) => void };
const windows = new WeakMap<Request, Window>();
export const dashboardReadWindow = (request: Request) => windows.get(request);
export async function withDashboardReadWindow<T>(request: Request, window: Window, action: () => Promise<T>) {
  windows.set(request, window);
  try { return await action(); } finally { windows.delete(request); }
}
