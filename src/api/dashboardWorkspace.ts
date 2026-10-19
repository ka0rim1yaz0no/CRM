import { api } from "../lib/api";
import type { AgentLeadDashboard } from "./leads";
import type { HubResponse } from "./attendanceHub";
export type DashboardTarget = { metric: "calls" | "talkMinutes" | "qualified"; period: "daily" | "monthly"; team: string; amount: number };
export type DashboardSettings = { revision: number; targets: DashboardTarget[]; newLeadHours: number; followUpHours: number };
export type HandoverNote = { _id: string; text: string; author: string; authorName: string; pinned: boolean; createdAt: string };
export type DashboardWorkspaceData = { dashboard: AgentLeadDashboard; serverTime: string;
  pace: { daily: number; monthly: number };
  trend: Array<{ day: string; count: number; comments: number; touched: number }>;
  range: { preset: string; from: string; to: string; previousFrom: string; previousTo: string; today: string; fromTime: string; toTime: string };
  previous: Record<string, number>; deltas: Record<string, number | null>; config: DashboardSettings; notes: HandoverNote[];
  attention: Array<{ key: string; label: string; count: number; href: string; severity: string }>;
  overdue: Array<{ id: string; name: string; employeeId: string; hours: number }>; overdueTotal: number;
  calls: Array<{ _id: { day: string; hour: number; employee: string }; count: number; seconds: number }>;
  changes: Array<{ text: string; href: string }>; attendance: Record<string, number>;
};
export type DashboardFilters = { preset: string; from?: string; to?: string };
export async function getDashboardWorkspace(filters: DashboardFilters, business: string) {
  const { data: workspace } = await api.get<DashboardWorkspaceData>("/dashboard-workspace/summary", { params: filters, headers: { "X-Business-Id": business } });
  return { ...workspace.dashboard, workspace };
}
export async function getDashboardEmployee(code: string, filters: DashboardFilters) {
  return (await api.get<{ employee: { _id: string; name: string; employeeCode: string; team: string; role: string; availabilityStatus: string }; attendance: Pick<HubResponse, "summary"> }>(`/dashboard-workspace/employee/${encodeURIComponent(code)}`, { params: filters })).data;
}
export async function saveDashboardSettings(settings: DashboardSettings) { return (await api.put<DashboardSettings>("/dashboard-workspace/settings", settings)).data; }
export async function saveHandoverNote(note: { text: string; pinned: boolean }, id?: string) { return (await (id ? api.patch(`/dashboard-workspace/notes/${id}`, note) : api.post("/dashboard-workspace/notes", note))).data; }
export async function removeHandoverNote(id: string) { await api.delete(`/dashboard-workspace/notes/${id}`); }
